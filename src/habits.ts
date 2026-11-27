// Habits: work that repeats. Each habit is turned into ordinary task rows, one
// per day or per week, so the scheduler, the calendar sync and the Done / Not
// now buttons all work on them unchanged. What makes them habits is the
// deadline: an occurrence not finished by the end of its day or week lapses
// instead of piling up.
import { DateTime } from "luxon";
import { db, removeBlock, tx, type BlockRow, type HabitKind, type HabitRow, type Settings, type TaskRow } from "./db.js";
import { deleteTask, finishTask, touchTask, UserError } from "./planner.js";
import { normLoc } from "./scheduler.js";

const MIN = 60_000;

interface Period {
  start: number;
  end: number;
}

/** The days (daily habits) or Monday-to-Sunday weeks (the rest) from now to the horizon. */
export function periodsFor(kind: HabitKind, now: number, zone: string, horizonDays: number): Period[] {
  const today = DateTime.fromMillis(now, { zone }).startOf("day");
  const horizonEnd = today.plus({ days: horizonDays });
  const unit = kind === "daily" ? "day" : "week";
  const out: Period[] = [];
  for (let p = today.startOf(unit); p < horizonEnd; p = p.plus({ [unit]: 1 })) {
    out.push({ start: p.toMillis(), end: p.plus({ [unit]: 1 }).toMillis() });
  }
  return out;
}

/**
 * Minutes a habit asks for in one period. A weekly habit created partway
 * through a week asks for a proportional share of that first week.
 */
export function targetFor(h: HabitRow, period: Period, zone: string): number {
  if (h.kind === "daily") return h.session_min;
  let daysLeft = 7;
  if (h.created_at > period.start) {
    const created = DateTime.fromMillis(h.created_at, { zone }).startOf("day");
    daysLeft = Math.max(0, Math.round(DateTime.fromMillis(period.end, { zone }).diff(created, "days").days));
  }
  const share = Math.min(1, daysLeft / 7);
  if (h.kind === "days") {
    return Math.min(h.days_per_week, daysLeft, Math.round(h.days_per_week * share)) * h.session_min;
  }
  const total = Math.round((h.weekly_min * share) / 5) * 5;
  return total < Math.min(h.min_chunk_min, h.weekly_min) ? 0 : total;
}

/** How one occurrence of the habit is constrained when it is planned. */
function shape(h: HabitRow) {
  if (h.kind === "hours") return { minChunk: h.min_chunk_min, maxChunk: null, maxPerDay: h.max_per_day_min };
  // daily and days: one sitting of exactly the session length, at most once a day
  return { minChunk: h.session_min, maxChunk: h.session_min, maxPerDay: h.session_min };
}

/** Retire an occurrence: forget it if untouched, otherwise keep it as a record. */
function retire(t: TaskRow, at: number): void {
  if (t.done_min === 0) return deleteTask(t.id);
  const planned = db.prepare("SELECT * FROM blocks WHERE task_id = ? AND status = 'planned'").all(t.id) as BlockRow[];
  for (const b of planned) removeBlock(b);
  db.prepare("UPDATE tasks SET status = 'lapsed', completed_at = ? WHERE id = ?").run(at, t.id);
}

/**
 * Bring task rows in line with the habits: create occurrences out to the
 * horizon, carry edits over to open ones, and lapse those whose time is up.
 * Runs inside the planning step.
 */
export function syncHabits(now: number, s: Settings): void {
  const habits = db.prepare("SELECT * FROM habits WHERE active = 1").all() as HabitRow[];
  const find = db.prepare("SELECT * FROM tasks WHERE habit_id = ? AND period_start = ?");
  const insert = db.prepare(
    `INSERT INTO tasks (title, priority, duration_min, min_chunk_min, max_chunk_min, max_per_day_min, location,
                        created_at, habit_id, period_start, period_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const update = db.prepare(
    `UPDATE tasks SET title = ?, priority = ?, duration_min = ?, min_chunk_min = ?, max_chunk_min = ?,
                      max_per_day_min = ?, location = ? WHERE id = ?`,
  );

  for (const h of habits) {
    const c = shape(h);
    for (const period of periodsFor(h.kind, now, s.zone, s.horizonDays)) {
      if (period.end <= now) continue;
      const target = targetFor(h, period, s.zone);
      const row = find.get(h.id, period.start) as TaskRow | undefined;
      if (!row) {
        if (target > 0) {
          insert.run(h.title, h.priority, target, c.minChunk, c.maxChunk, c.maxPerDay, h.location, h.created_at, h.id, period.start, period.end);
        }
        continue;
      }
      if (row.status !== "open") continue;
      if (target <= 0) {
        retire(row, now);
        continue;
      }
      update.run(h.title, h.priority, target, c.minChunk, c.maxChunk, c.maxPerDay, h.location, row.id);
      if (row.title !== h.title || row.location !== h.location || row.priority !== h.priority) touchTask(row.id);
      if (row.done_min >= target) finishTask(row.id, now);
    }
  }

  // Time is up: the day or week ended (plus the grace period) with work left.
  const overdue = db
    .prepare("SELECT * FROM tasks WHERE habit_id IS NOT NULL AND status = 'open' AND period_end + ? <= ?")
    .all(s.graceMin * MIN, now) as TaskRow[];
  for (const t of overdue) {
    const planned = db.prepare("SELECT * FROM blocks WHERE task_id = ? AND status = 'planned'").all(t.id) as BlockRow[];
    for (const b of planned) removeBlock(b);
    db.prepare("UPDATE tasks SET status = 'lapsed', completed_at = ? WHERE id = ?").run(t.period_end, t.id);
  }
}

// ---- Creating and changing habits ------------------------------------------

export interface HabitInput {
  title: string;
  kind: HabitKind;
  priority: number;
  sessionMin: number;
  daysPerWeek: number;
  weeklyMin: number;
  minChunkMin: number;
  maxPerDayMin: number | null;
  location: string | null;
}

function int(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

export function parseHabit(body: Record<string, unknown>, existing?: HabitRow): HabitInput {
  const title = String(body.title ?? existing?.title ?? "").trim();
  if (!title) throw new UserError("Give the habit a name.");
  if (title.length > 200) throw new UserError("Keep the name under 200 characters.");
  const kind = String(body.kind ?? existing?.kind ?? "") as HabitKind;
  if (!["daily", "days", "hours"].includes(kind)) throw new UserError("Choose how the habit repeats.");
  if (existing && kind !== existing.kind) {
    throw new UserError("How a habit repeats can't be changed. Delete it and add a new one.");
  }
  const priority = int(body.priority ?? existing?.priority ?? 2, "Priority", 1, 4);
  const sessionMin = int(body.sessionMin ?? existing?.session_min ?? 30, "Time each day", 5, 720);
  const daysPerWeek = int(body.daysPerWeek ?? existing?.days_per_week ?? 3, "Days a week", 1, 7);
  const weeklyMin = int(body.weeklyMin ?? existing?.weekly_min ?? 300, "Weekly total", 5, 6000);
  const minChunkMin = Math.min(weeklyMin, int(body.minChunkMin ?? existing?.min_chunk_min ?? 30, "Smallest piece", 5, 720));
  const rawMax = body.maxPerDayMin === undefined ? existing?.max_per_day_min : body.maxPerDayMin;
  const maxPerDayMin = rawMax === null || rawMax === undefined || rawMax === "" ? null : int(rawMax, "Most in one day", 5, 1440);
  if (kind === "hours" && maxPerDayMin !== null) {
    if (maxPerDayMin < minChunkMin) throw new UserError("Most in one day can't be less than the smallest piece.");
    if (maxPerDayMin * 7 < weeklyMin) throw new UserError("That daily limit can't reach the weekly total in seven days.");
  }
  const location = normLoc((body.location === undefined ? existing?.location : body.location) as string | null);
  return { title, kind, priority, sessionMin, daysPerWeek, weeklyMin, minChunkMin, maxPerDayMin, location };
}

export function createHabit(h: HabitInput, now = Date.now()): number {
  const r = db
    .prepare(
      `INSERT INTO habits (title, kind, priority, session_min, days_per_week, weekly_min, min_chunk_min,
                           max_per_day_min, location, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(h.title, h.kind, h.priority, h.sessionMin, h.daysPerWeek, h.weeklyMin, h.minChunkMin, h.maxPerDayMin, h.location, now);
  return Number(r.lastInsertRowid);
}

export const getHabit = (id: number) => db.prepare("SELECT * FROM habits WHERE id = ?").get(id) as HabitRow | undefined;

export function updateHabit(id: number, h: HabitInput): void {
  db.prepare(
    `UPDATE habits SET title = ?, priority = ?, session_min = ?, days_per_week = ?, weekly_min = ?,
                       min_chunk_min = ?, max_per_day_min = ?, location = ? WHERE id = ?`,
  ).run(h.title, h.priority, h.sessionMin, h.daysPerWeek, h.weeklyMin, h.minChunkMin, h.maxPerDayMin, h.location, id);
}

/** Take a habit's unfinished occurrences off the plan. */
function clearOpen(id: number, now: number): void {
  const open = db.prepare("SELECT * FROM tasks WHERE habit_id = ? AND status = 'open'").all(id) as TaskRow[];
  for (const t of open) retire(t, now);
}

export function setHabitActive(id: number, active: boolean, now = Date.now()): void {
  if (!getHabit(id)) throw new UserError("Habit not found.");
  tx(() => {
    db.prepare("UPDATE habits SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
    if (!active) clearOpen(id, now);
  });
}

export function deleteHabit(id: number, now = Date.now()): void {
  tx(() => {
    clearOpen(id, now);
    db.prepare("DELETE FROM habits WHERE id = ?").run(id);
  });
}

// ---- Progress, for the Habits tab ------------------------------------------

export interface HabitProgress {
  /** Minutes done and asked for in the current Monday-to-Sunday week. */
  weekDoneMin: number;
  weekTargetMin: number;
  /** Start of the next planned block, if any. */
  nextStart: number | null;
  /** State of today's (daily) or this week's occurrence. */
  current: "open" | "done" | "lapsed" | "none";
  /** Minutes of the current occurrence that found no room. */
  noRoomMin: number;
}

export function habitProgress(h: HabitRow, now: number, zone: string, unscheduled: Map<number, number>): HabitProgress {
  const week = DateTime.fromMillis(now, { zone }).startOf("week");
  const rows = db
    .prepare("SELECT * FROM tasks WHERE habit_id = ? AND period_start >= ? AND period_start < ?")
    .all(h.id, week.toMillis(), week.plus({ weeks: 1 }).toMillis()) as TaskRow[];
  const current = rows.find((r) => r.period_start! <= now && now < r.period_end!);
  const next = db
    .prepare(
      `SELECT MIN(b.start) AS start FROM blocks b JOIN tasks t ON t.id = b.task_id
       WHERE t.habit_id = ? AND b.status = 'planned' AND b.end > ?`,
    )
    .get(h.id, now) as { start: number | null };
  return {
    weekDoneMin: rows.reduce((sum, r) => sum + Math.min(r.done_min, r.duration_min), 0),
    weekTargetMin: rows.reduce((sum, r) => sum + r.duration_min, 0),
    nextStart: next.start,
    current: current?.status ?? "none",
    noRoomMin: current ? (unscheduled.get(current.id) ?? 0) : 0,
  };
}
