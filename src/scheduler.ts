// Pure scheduling engine. No I/O, no clock: everything it needs is passed in,
// which is what makes it testable. All times are epoch milliseconds.

export interface SchedTask {
  id: number;
  /** 1 is most important, 4 is least. */
  priority: number;
  /** Minutes still to be placed on the calendar. */
  remainingMin: number;
  /** Smallest piece this task may be split into. */
  minChunkMin: number;
  /** Names of the blocks of hours this task may go in. Null or empty means any. */
  blocks: string[] | null;
  /** Tie-breaker within a priority: older tasks go first. */
  createdAt: number;
  /** Do not place this task before this instant (set when a block is skipped). */
  notBefore?: number | null;
  /**
   * When the task is due. Unlike notAfter this does not fence the task in: it
   * decides whether the task jumps the queue, and late work is still planned.
   */
  dueBy?: number | null;
  /** Every block must end by this instant. Used by habits: a day's or week's end. */
  notAfter?: number | null;
  /** Largest single block. Habits with a fixed session set this equal to the smallest piece. */
  maxChunkMin?: number | null;
  /** Most minutes to place on any one day. */
  maxPerDayMin?: number | null;
  /** Minutes already done or under way per day (keyed like Window.day), counted against the daily cap. */
  usedByDay?: Record<string, number>;
}

export interface Window {
  start: number;
  end: number;
  /** The block's name (e.g. "focus"), or null when it has none. */
  name: string | null;
  /** A strict block is reserved: it takes only tasks that list its name. */
  strict?: boolean;
  /** Local calendar date of the window ("YYYY-MM-DD"). Needed only for per-day caps. */
  day?: string;
}

export interface Interval {
  start: number;
  end: number;
}

export interface PlannedBlock {
  taskId: number;
  start: number;
  end: number;
}

export interface ScheduleInput {
  now: number;
  tasks: SchedTask[];
  /** Workable time, already expanded to concrete instants. */
  windows: Window[];
  /** Calendar events and anything else that blocks time. */
  busy: Interval[];
  /** Round block edges to this many minutes. */
  granularityMin?: number;
  /** Gap to leave after each block. */
  bufferMin?: number;
  /** Aim to finish due tasks this many minutes before they are due. */
  cushionMin?: number;
}

export interface ScheduleResult {
  blocks: PlannedBlock[];
  /** Tasks that did not fully fit inside the horizon, with minutes left over. */
  unscheduled: { taskId: number; minutes: number }[];
  /** Due tasks that were running out of time and so were planned ahead of everything else. */
  urgent: number[];
  /** Due tasks that will not be finished by their due time even so. */
  late: number[];
}

const MIN = 60_000;

const ceilTo = (t: number, step: number) => Math.ceil(t / step) * step;
const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

/** Normalize a block name so "Focus" and " focus" are the same block. */
export const normName = (s: string | null | undefined): string | null => {
  const v = String(s ?? "").replace(/,/g, " ").trim().toLowerCase();
  return v === "" ? null : v;
};

/**
 * Normalize a task's list of allowed blocks. Accepts an array or the
 * comma-separated form the database stores; returns sorted, unique names.
 */
export const normBlocks = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return [...new Set(list.map((x) => normName(String(x))).filter((x): x is string => x !== null))].sort();
};

/** Remove every `cut` interval from `base`. */
export function subtract(base: Interval, cuts: Interval[]): Interval[] {
  let pieces: Interval[] = [base];
  for (const c of cuts) {
    const next: Interval[] = [];
    for (const p of pieces) {
      if (c.end <= p.start || c.start >= p.end) {
        next.push(p);
        continue;
      }
      if (c.start > p.start) next.push({ start: p.start, end: c.start });
      if (c.end < p.end) next.push({ start: c.end, end: p.end });
    }
    pieces = next;
  }
  return pieces;
}

/**
 * A task that lists blocks fits only windows whose name is on its list. A
 * task that lists none fits any window except a strict one, which is reserved
 * for tasks that name it.
 */
export function fits(task: SchedTask, w: { name: string | null; strict?: boolean }): boolean {
  const allowed = normBlocks(task.blocks);
  const name = normName(w.name);
  if (allowed.length === 0) return !(w.strict && name !== null);
  return name !== null && allowed.includes(name);
}

/**
 * Pick the size of the piece to place in a slot of `slotMin` minutes, or 0 to
 * skip the slot. Guarantees no piece is shorter than the minimum chunk, and
 * that the piece left for later is not shorter than it either.
 */
export function chunkFor(remaining: number, minChunk: number, slotMin: number): number {
  if (slotMin <= 0 || remaining <= 0) return 0;
  if (remaining <= slotMin) return remaining; // the whole rest fits
  const floor = Math.min(minChunk, remaining);
  if (slotMin < floor) return 0;
  let chunk = slotMin;
  const leftover = remaining - chunk;
  if (leftover > 0 && leftover < floor) {
    chunk = remaining - floor; // leave a usable piece for later
    if (chunk < floor) return 0;
  }
  return chunk;
}

export function schedule(input: ScheduleInput): ScheduleResult {
  const gran = Math.max(1, input.granularityMin ?? 5) * MIN;
  const buffer = Math.max(0, input.bufferMin ?? 0) * MIN;
  const cushion = Math.max(0, input.cushionMin ?? 0) * MIN;
  const from = ceilTo(input.now, gran);
  const granMin = gran / MIN;
  const horizonEnd = input.windows.reduce((end, w) => Math.max(end, w.end), 0);
  const tasks = input.tasks.filter((t) => t.remainingMin > 0);

  // Free slots: windows minus busy time, clipped to the future, edges rounded.
  const freeSlots = (): Window[] => {
    const slots: Window[] = [];
    for (const w of [...input.windows].sort((a, b) => a.start - b.start)) {
      const clipped = { start: Math.max(w.start, from), end: w.end };
      if (clipped.end <= clipped.start) continue;
      for (const p of subtract(clipped, input.busy)) {
        const start = ceilTo(p.start, gran);
        const end = floorTo(p.end, gran);
        if (end > start) slots.push({ start, end, name: w.name, strict: w.strict, day: w.day });
      }
    }
    return slots.sort((a, b) => a.start - b.start);
  };

  /** Place tasks in the given order, each into the earliest time that fits. */
  const place = (order: SchedTask[]) => {
    const slots = freeSlots();
    const blocks: PlannedBlock[] = [];
    const unscheduled: { taskId: number; minutes: number }[] = [];

    for (const task of order) {
      let remaining = Math.ceil(task.remainingMin / granMin) * granMin;
      const minChunk = Math.max(granMin, Math.ceil(task.minChunkMin / granMin) * granMin);

      const notBefore = task.notBefore ? ceilTo(task.notBefore, gran) : 0;
      const notAfter = task.notAfter ? floorTo(task.notAfter, gran) : Infinity;
      const maxChunk = task.maxChunkMin ? Math.max(minChunk, task.maxChunkMin) : Infinity;
      const perDay = task.maxPerDayMin ?? Infinity;
      const used: Record<string, number> = { ...(task.usedByDay ?? {}) };

      for (let i = 0; i < slots.length && remaining > 0; i++) {
        const slot = slots[i];
        if (slot.start >= notAfter) break; // slots are in time order
        if (!fits(task, slot)) continue;
        const start = Math.max(slot.start, notBefore);
        const limit = Math.min(slot.end, notAfter);
        if (start >= limit) continue;
        const day = slot.day ?? "";
        const dayLeft = perDay - (used[day] ?? 0);
        if (dayLeft <= 0) continue;
        const room = Math.min((limit - start) / MIN, dayLeft, maxChunk);
        const chunk = chunkFor(remaining, minChunk, room);
        if (chunk <= 0) continue;
        const end = start + chunk * MIN;
        blocks.push({ taskId: task.id, start, end });
        remaining -= chunk;
        used[day] = (used[day] ?? 0) + chunk;
        // Keep whatever is left of the slot on either side of the new block.
        const after = { start: Math.min(slot.end, end + buffer), end: slot.end, name: slot.name, strict: slot.strict, day: slot.day };
        if (start > slot.start) {
          slot.end = start;
          slots.splice(i + 1, 0, after);
          i++; // skip the piece just added; this task already used the time before it
        } else {
          slot.start = after.start;
        }
      }
      if (remaining > 0) unscheduled.push({ taskId: task.id, minutes: remaining });
    }
    return { blocks, unscheduled };
  };

  // Priority first. Within a priority, work with a deadline goes before open-ended work.
  const byPriority = (a: SchedTask, b: SchedTask) =>
    a.priority - b.priority ||
    (a.notAfter ?? a.dueBy ?? Infinity) - (b.notAfter ?? b.dueBy ?? Infinity) ||
    a.createdAt - b.createdAt ||
    a.id - b.id;
  const byDueTime = (a: SchedTask, b: SchedTask) => a.dueBy! - b.dueBy! || byPriority(a, b);

  /** Would this plan leave the task unfinished at `by`? */
  const misses = (plan: ReturnType<typeof place>, task: SchedTask, by: number) => {
    // Work left over only counts when the deadline falls inside the planned period.
    if (plan.unscheduled.some((u) => u.taskId === task.id)) return by <= horizonEnd;
    const finish = plan.blocks.reduce((end, b) => (b.taskId === task.id ? Math.max(end, b.end) : end), 0);
    return finish > by;
  };

  // Plan by priority. Any due task that this would leave unfinished in time is
  // running out of time: move it ahead of everything else, earliest due first,
  // and plan again. Moving one forward can squeeze out another, so repeat
  // until no more are caught.
  const urgent = new Set<number>();
  let plan: ReturnType<typeof place>;
  for (;;) {
    plan = place([
      ...tasks.filter((t) => urgent.has(t.id)).sort(byDueTime),
      ...tasks.filter((t) => !urgent.has(t.id)).sort(byPriority),
    ]);
    const caught = tasks.filter((t) => t.dueBy != null && !urgent.has(t.id) && misses(plan, t, t.dueBy - cushion));
    if (!caught.length) break;
    for (const t of caught) urgent.add(t.id);
  }

  const late = tasks.filter((t) => t.dueBy != null && misses(plan, t, t.dueBy)).map((t) => t.id);
  plan.blocks.sort((a, b) => a.start - b.start);
  return { blocks: plan.blocks, unscheduled: plan.unscheduled, urgent: [...urgent], late };
}
