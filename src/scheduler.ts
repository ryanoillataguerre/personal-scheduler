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
  /** Required location tag, or null when the task can be done anywhere. */
  location: string | null;
  /** Tie-breaker within a priority: older tasks go first. */
  createdAt: number;
  /** Do not place this task before this instant (set when a block is skipped). */
  notBefore?: number | null;
}

export interface Window {
  start: number;
  end: number;
  /** Where you are during this window, or null when untagged. */
  location: string | null;
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
}

export interface ScheduleResult {
  blocks: PlannedBlock[];
  /** Tasks that did not fully fit inside the horizon, with minutes left over. */
  unscheduled: { taskId: number; minutes: number }[];
}

const MIN = 60_000;

const ceilTo = (t: number, step: number) => Math.ceil(t / step) * step;
const floorTo = (t: number, step: number) => Math.floor(t / step) * step;

/** Normalize a location tag so "Home" and " home" are the same place. */
export const normLoc = (s: string | null | undefined): string | null => {
  const v = (s ?? "").trim().toLowerCase();
  return v === "" ? null : v;
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
 * A task fits a window when it needs no particular place, or when the window
 * is tagged with the place it needs. Untagged windows take only untagged tasks.
 */
export function fits(task: SchedTask, w: { location: string | null }): boolean {
  const need = normLoc(task.location);
  return need === null || need === normLoc(w.location);
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
  const from = ceilTo(input.now, gran);

  // Free slots: windows minus busy time, clipped to the future, edges rounded.
  const slots: Window[] = [];
  for (const w of [...input.windows].sort((a, b) => a.start - b.start)) {
    const clipped = { start: Math.max(w.start, from), end: w.end };
    if (clipped.end <= clipped.start) continue;
    for (const p of subtract(clipped, input.busy)) {
      const start = ceilTo(p.start, gran);
      const end = floorTo(p.end, gran);
      if (end > start) slots.push({ start, end, location: w.location });
    }
  }
  slots.sort((a, b) => a.start - b.start);

  const order = [...input.tasks]
    .filter((t) => t.remainingMin > 0)
    .sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || a.id - b.id);

  const blocks: PlannedBlock[] = [];
  const unscheduled: { taskId: number; minutes: number }[] = [];
  const granMin = gran / MIN;

  for (const task of order) {
    let remaining = Math.ceil(task.remainingMin / granMin) * granMin;
    const minChunk = Math.max(granMin, Math.ceil(task.minChunkMin / granMin) * granMin);

    const notBefore = task.notBefore ? ceilTo(task.notBefore, gran) : 0;
    for (let i = 0; i < slots.length && remaining > 0; i++) {
      const slot = slots[i];
      if (!fits(task, slot)) continue;
      const start = Math.max(slot.start, notBefore);
      if (start >= slot.end) continue;
      const chunk = chunkFor(remaining, minChunk, (slot.end - start) / MIN);
      if (chunk <= 0) continue;
      const end = start + chunk * MIN;
      blocks.push({ taskId: task.id, start, end });
      remaining -= chunk;
      // Keep whatever is left of the slot on either side of the new block.
      const after = { start: Math.min(slot.end, end + buffer), end: slot.end, location: slot.location };
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

  blocks.sort((a, b) => a.start - b.start);
  return { blocks, unscheduled };
}
