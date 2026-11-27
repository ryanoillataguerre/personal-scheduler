// SQLite storage. One file on disk, no server to run. Uses the SQLite that
// ships inside Node, so there is nothing native to compile.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_HOURS, type Hours } from "./hours.js";

export interface TaskRow {
  id: number;
  title: string;
  priority: number;
  duration_min: number;
  done_min: number;
  min_chunk_min: number;
  location: string | null;
  notes: string;
  /** "lapsed": a habit occurrence whose day or week ended before it was done. */
  status: "open" | "done" | "lapsed";
  missed_count: number;
  created_at: number;
  completed_at: number | null;
  /** Set when a block is skipped: do not plan this task before then. */
  not_before: number | null;
  /** Date the task is due ("YYYY-MM-DD"), meaning by the end of that day. Null for no deadline. */
  due_date: string | null;
  /** Set on rows generated from a habit: which habit, and the day or week they belong to. */
  habit_id: number | null;
  period_start: number | null;
  period_end: number | null;
  max_chunk_min: number | null;
  max_per_day_min: number | null;
}

export type HabitKind = "daily" | "days" | "hours";

export interface HabitRow {
  id: number;
  title: string;
  /** daily: every day. days: some days each week. hours: a weekly total. */
  kind: HabitKind;
  priority: number;
  /** Length of one sitting, for daily and days. */
  session_min: number;
  /** How many days each week, for days. */
  days_per_week: number;
  /** Weekly total, for hours. */
  weekly_min: number;
  /** Smallest piece, for hours. */
  min_chunk_min: number;
  /** Most in one day, for hours. Null for no limit. */
  max_per_day_min: number | null;
  location: string | null;
  active: number;
  created_at: number;
}

export interface BlockRow {
  id: number;
  task_id: number;
  start: number;
  end: number;
  status: "planned" | "done";
  event_id: string | null;
  synced: number;
  /** Minutes credited to the task when the block was marked done (it may have been cut short). */
  credit_min: number | null;
}

export interface Settings {
  /** IANA time zone your work hours are written in. */
  zone: string;
  /** Minutes after a block ends before an unmarked block counts as missed. */
  graceMin: number;
  /** How many days ahead to plan. */
  horizonDays: number;
  /** Gap to leave between blocks. */
  bufferMin: number;
  /** Phone alert this many minutes before each block; null for none. */
  reminderMin: number | null;
  /** Google calendars whose events block time. */
  busyCalendars: string[];
  /** Aim to finish tasks with a deadline this many hours before they are due. */
  deadlineCushionHours: number;
}

const DEFAULT_SETTINGS: Settings = {
  zone: process.env.TZ || "America/Los_Angeles",
  graceMin: 15,
  horizonDays: 14,
  bufferMin: 0,
  reminderMin: 0,
  busyCalendars: ["primary"],
  deadlineCushionHours: 24,
};

const dataDir = process.env.DATA_DIR || path.resolve("data");
fs.mkdirSync(dataDir, { recursive: true });
const raw = new DatabaseSync(path.join(dataDir, "dayloop.db"));
raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

type Param = string | number | null;
interface Statement {
  get(...params: Param[]): unknown;
  all(...params: Param[]): unknown[];
  run(...params: Param[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
const statements = new Map<string, Statement>();
/** Small wrapper so callers get reusable statements and can name their row types. */
export const db = {
  exec: (sql: string) => raw.exec(sql),
  prepare(sql: string): Statement {
    let st = statements.get(sql);
    if (!st) statements.set(sql, (st = raw.prepare(sql) as unknown as Statement));
    return st;
  },
};

let depth = 0;
/** Run `fn` as one all-or-nothing change. Nested calls join the outer one. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  db.exec("BEGIN IMMEDIATE");
  depth++;
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth--;
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 2,
    duration_min INTEGER NOT NULL,
    done_min INTEGER NOT NULL DEFAULT 0,
    min_chunk_min INTEGER NOT NULL,
    location TEXT,
    notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open',
    missed_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    completed_at INTEGER,
    not_before INTEGER
  );
  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    start INTEGER NOT NULL,
    end INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'planned',
    event_id TEXT,
    synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS blocks_by_start ON blocks(start);
  CREATE TABLE IF NOT EXISTS habits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 2,
    session_min INTEGER NOT NULL DEFAULT 30,
    days_per_week INTEGER NOT NULL DEFAULT 3,
    weekly_min INTEGER NOT NULL DEFAULT 300,
    min_chunk_min INTEGER NOT NULL DEFAULT 30,
    max_per_day_min INTEGER,
    location TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_deletes (event_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// Columns added after the first release. Existing databases gain them here.
const taskColumns = new Set((db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name));
for (const col of ["habit_id", "period_start", "period_end", "max_chunk_min", "max_per_day_min"]) {
  if (!taskColumns.has(col)) db.exec(`ALTER TABLE tasks ADD COLUMN ${col} INTEGER`);
}
if (!taskColumns.has("due_date")) db.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
const blockColumns = new Set((db.prepare("PRAGMA table_info(blocks)").all() as { name: string }[]).map((c) => c.name));
if (!blockColumns.has("credit_min")) db.exec("ALTER TABLE blocks ADD COLUMN credit_min INTEGER");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS tasks_by_habit_period ON tasks(habit_id, period_start) WHERE habit_id IS NOT NULL");

const kvGet = db.prepare("SELECT value FROM kv WHERE key = ?");
const kvSet = db.prepare(
  "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
);
const kvDel = db.prepare("DELETE FROM kv WHERE key = ?");

export function getKv<T>(key: string, fallback: T): T {
  const row = kvGet.get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}
export const setKv = (key: string, value: unknown) => void kvSet.run(key, JSON.stringify(value));
export const delKv = (key: string) => void kvDel.run(key);

export const getSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...getKv<Partial<Settings>>("settings", {}) });
export const saveSettings = (s: Settings) => setKv("settings", s);
export const getHours = (): Hours => getKv<Hours>("hours", DEFAULT_HOURS);
export const saveHours = (h: Hours) => setKv("hours", h);

/** Forget a block's calendar event; the sync step deletes it from Google later. */
const queueDelete = db.prepare("INSERT OR IGNORE INTO pending_deletes (event_id) VALUES (?)");
const deleteBlockStmt = db.prepare("DELETE FROM blocks WHERE id = ?");
export function removeBlock(b: Pick<BlockRow, "id" | "event_id">) {
  if (b.event_id) queueDelete.run(b.event_id);
  deleteBlockStmt.run(b.id);
}
