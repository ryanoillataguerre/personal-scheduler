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
  status: "open" | "done";
  missed_count: number;
  created_at: number;
  completed_at: number | null;
  /** Set when a block is skipped: do not plan this task before then. */
  not_before: number | null;
}

export interface BlockRow {
  id: number;
  task_id: number;
  start: number;
  end: number;
  status: "planned" | "done";
  event_id: string | null;
  synced: number;
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
}

const DEFAULT_SETTINGS: Settings = {
  zone: process.env.TZ || "America/Los_Angeles",
  graceMin: 15,
  horizonDays: 14,
  bufferMin: 0,
  reminderMin: 0,
  busyCalendars: ["primary"],
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
  CREATE TABLE IF NOT EXISTS pending_deletes (event_id TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

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
