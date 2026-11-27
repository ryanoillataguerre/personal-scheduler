// The loop: sweep missed blocks back into the queue, rebuild the plan from
// now, save it, and push the difference to Google Calendar.
import { db, getHours, getKv, getSettings, removeBlock, setKv, tx, type BlockRow, type TaskRow } from "./db.js";
import { fetchBusy, syncEvents } from "./google.js";
import { DateTime } from "luxon";
import { syncHabits } from "./habits.js";
import { expandWindows } from "./hours.js";
import { schedule, type Interval, type SchedTask } from "./scheduler.js";

const MIN = 60_000;
const GRANULARITY_MIN = 5;

/** A mistake in the request rather than a fault in the server. */
export class UserError extends Error {}

export interface PlanInfo {
  at: number;
  /** Tasks that did not fully fit in the planning horizon. */
  unscheduled: { taskId: number; minutes: number }[];
  /** Tasks with a deadline that were running out of time and were planned ahead of everything else. */
  urgent: number[];
  /** Tasks that will not be finished by their deadline even so. */
  late: number[];
  /** Blocks swept as missed during the most recent run that found any. */
  lastMissed: { at: number; count: number } | null;
}

export const getPlanInfo = (): PlanInfo => ({
  ...{ at: 0, unscheduled: [], urgent: [], late: [], lastMissed: null },
  ...getKv<Partial<PlanInfo>>("plan", {}),
});

/** A due date means by the end of that day, in the user's time zone. */
export const dueTime = (date: string, zone: string): number =>
  DateTime.fromISO(date, { zone }).plus({ days: 1 }).startOf("day").toMillis();

/** The planning step itself. Synchronous, so the database is never half-updated. */
export function planNow(now: number, busy: Interval[]): PlanInfo {
  const s = getSettings();
  const prev = getPlanInfo();
  let lastMissed = prev.lastMissed;

  const result = tx(() => {
    // 1. A block that ended, plus the grace period, without being marked done
    //    was missed. Remove it; its minutes go back to the task automatically
    //    because only done blocks count as progress.
    const missed = db
      .prepare("SELECT * FROM blocks WHERE status = 'planned' AND end + ? <= ?")
      .all(s.graceMin * MIN, now) as BlockRow[];
    const bump = db.prepare("UPDATE tasks SET missed_count = missed_count + 1 WHERE id = ?");
    for (const b of missed) {
      bump.run(b.task_id);
      removeBlock(b);
    }
    if (missed.length) lastMissed = { at: now, count: missed.length };

    // 2. Habits: create the coming days' and weeks' occurrences, and lapse the
    //    ones whose day or week has ended.
    syncHabits(now, s);

    // 3. Blocks already under way (or ended but still in grace) stay put.
    const pinned = db
      .prepare("SELECT * FROM blocks WHERE status = 'planned' AND start <= ?")
      .all(now) as BlockRow[];
    const pinnedMin = new Map<number, number>();
    for (const b of pinned) pinnedMin.set(b.task_id, (pinnedMin.get(b.task_id) ?? 0) + (b.end - b.start) / MIN);

    // 4. Plan everything that is left.
    const tasks = db.prepare("SELECT * FROM tasks WHERE status = 'open'").all() as TaskRow[];
    const counted = db.prepare("SELECT * FROM blocks WHERE task_id = ? AND (status = 'done' OR start <= ?)");
    const schedTasks: SchedTask[] = tasks.map((t) => {
      // A daily cap has to count what was already done or is under way today.
      let usedByDay: Record<string, number> | undefined;
      if (t.max_per_day_min) {
        usedByDay = {};
        for (const b of counted.all(t.id, now) as BlockRow[]) {
          const day = DateTime.fromMillis(b.start, { zone: s.zone }).toISODate()!;
          usedByDay[day] = (usedByDay[day] ?? 0) + (b.credit_min ?? (b.end - b.start) / MIN);
        }
      }
      return {
        id: t.id,
        priority: t.priority,
        remainingMin: Math.max(0, t.duration_min - t.done_min - (pinnedMin.get(t.id) ?? 0)),
        minChunkMin: t.min_chunk_min,
        location: t.location,
        createdAt: t.created_at,
        notBefore: Math.max(t.not_before ?? 0, t.period_start ?? 0) || null,
        dueBy: t.due_date ? dueTime(t.due_date, s.zone) : null,
        notAfter: t.period_end,
        maxChunkMin: t.max_chunk_min,
        maxPerDayMin: t.max_per_day_min,
        usedByDay,
      };
    });
    const windows = expandWindows(getHours(), now, s.zone, s.horizonDays);
    const blocked: Interval[] = [...busy, ...pinned.map((b) => ({ start: b.start, end: b.end + s.bufferMin * MIN }))];
    const result = schedule({
      now,
      tasks: schedTasks,
      windows,
      busy: blocked,
      granularityMin: GRANULARITY_MIN,
      bufferMin: s.bufferMin,
      cushionMin: s.deadlineCushionHours * 60,
    });

    // 5. Save the difference, so unchanged blocks keep their calendar events.
    const future = db
      .prepare("SELECT * FROM blocks WHERE status = 'planned' AND start > ?")
      .all(now) as BlockRow[];
    const key = (b: { task_id?: number; taskId?: number; start: number; end: number }) =>
      `${b.task_id ?? b.taskId}:${b.start}:${b.end}`;
    const wanted = new Map(result.blocks.map((b) => [key(b), b]));
    for (const b of future) {
      if (wanted.has(key(b))) wanted.delete(key(b));
      else removeBlock(b);
    }
    const insert = db.prepare("INSERT INTO blocks (task_id, start, end) VALUES (?, ?, ?)");
    for (const b of wanted.values()) insert.run(b.taskId, b.start, b.end);

    return result;
  });

  const info: PlanInfo = { at: now, unscheduled: result.unscheduled, urgent: result.urgent, late: result.late, lastMissed };
  setKv("plan", info);
  return info;
}

// Replans run one at a time; requests that arrive mid-run share the next one.
let running: Promise<PlanInfo> | null = null;
let queued: Promise<PlanInfo> | null = null;

async function replanOnce(): Promise<PlanInfo> {
  const now = Date.now();
  const s = getSettings();
  const busy = await fetchBusy(now, now + s.horizonDays * 24 * 60 * MIN);
  const info = planNow(Date.now(), busy);
  await syncEvents();
  return info;
}

export function replan(): Promise<PlanInfo> {
  if (!running) {
    running = replanOnce().finally(() => (running = null));
    return running;
  }
  if (!queued) {
    queued = running
      .catch(() => undefined)
      .then(() => {
        queued = null;
        return replan();
      });
  }
  return queued;
}

// ---- Actions on tasks and blocks -------------------------------------------

const getBlock = (id: number) => db.prepare("SELECT * FROM blocks WHERE id = ?").get(id) as BlockRow | undefined;
const getTask = (id: number) => db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | undefined;
const touchTask = (id: number) => db.prepare("UPDATE blocks SET synced = 0 WHERE task_id = ?").run(id);

/** Credit a block's minutes to its task. */
export function completeBlock(id: number, now = Date.now()): void {
  const b = getBlock(id);
  if (!b || b.status !== "planned") throw new UserError("That block is no longer on the plan.");
  const minutes = Math.round((b.end - b.start) / MIN);
  tx(() => {
    const step = GRANULARITY_MIN * MIN;
    if (b.start > now) {
      // Done ahead of time: free the slot, and record the work as just finished
      // so it shows as done today and counts toward a habit's daily limit.
      const end = Math.floor(now / step) * step;
      db.prepare("UPDATE blocks SET status = 'done', start = ?, end = ?, credit_min = ?, synced = 0 WHERE id = ?").run(
        end - minutes * MIN,
        end,
        minutes,
        b.id,
      );
    } else {
      // Finished early: give the rest of the slot back.
      const end = Math.min(b.end, Math.max(b.start + step, Math.ceil(now / step) * step));
      db.prepare("UPDATE blocks SET status = 'done', end = ?, credit_min = ?, synced = 0 WHERE id = ?").run(end, minutes, b.id);
    }
    db.prepare("UPDATE tasks SET done_min = done_min + ? WHERE id = ?").run(minutes, b.task_id);
    const t = getTask(b.task_id)!;
    if (t.done_min >= t.duration_min) finishTask(t.id, now);
    else touchTask(t.id);
  });
}

/**
 * "Not now" / "Didn't do it": put the block's time back in the queue. The task
 * is held until the skipped block would have ended, so it is not simply put
 * straight back into the same slot.
 */
export function skipBlock(id: number): void {
  const b = getBlock(id);
  if (!b || b.status !== "planned") throw new UserError("That block is no longer on the plan.");
  tx(() => {
    db.prepare("UPDATE tasks SET missed_count = missed_count + 1, not_before = ? WHERE id = ?").run(b.end, b.task_id);
    removeBlock(b);
  });
}

/** Mark the whole task done and clear whatever was still planned for it. */
export function finishTask(id: number, now = Date.now()): void {
  tx(() => {
    const planned = db
      .prepare("SELECT * FROM blocks WHERE task_id = ? AND status = 'planned'")
      .all(id) as BlockRow[];
    for (const b of planned) removeBlock(b);
    db.prepare("UPDATE tasks SET status = 'done', completed_at = ? WHERE id = ?").run(now, id);
    touchTask(id);
  });
}

export function reopenTask(id: number): void {
  const t = getTask(id);
  if (!t) throw new UserError("Task not found.");
  // A task finished in full reopens with its whole length to do again.
  const done = t.done_min >= t.duration_min ? 0 : t.done_min;
  db.prepare("UPDATE tasks SET status = 'open', completed_at = NULL, done_min = ? WHERE id = ?").run(done, id);
}

export function deleteTask(id: number): void {
  tx(() => {
    const blocks = db.prepare("SELECT * FROM blocks WHERE task_id = ?").all(id) as BlockRow[];
    for (const b of blocks) removeBlock(b);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  });
}

export { touchTask };
