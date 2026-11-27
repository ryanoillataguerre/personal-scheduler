// A database written by an earlier version, where tasks, habits and hours had
// a single "location", must open with those values as block names.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";

const ZONE = "America/Los_Angeles";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();

test("upgrades location to block names without losing anything", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dayloop-migrate-"));
  const old = new DatabaseSync(path.join(dir, "dayloop.db"));
  old.exec(`
    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2,
      duration_min INTEGER NOT NULL, done_min INTEGER NOT NULL DEFAULT 0, min_chunk_min INTEGER NOT NULL,
      location TEXT, notes TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'open',
      missed_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, completed_at INTEGER, not_before INTEGER
    );
    CREATE TABLE blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      start INTEGER NOT NULL, end INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'planned', event_id TEXT,
      synced INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE habits (
      id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, kind TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 2,
      session_min INTEGER NOT NULL DEFAULT 30, days_per_week INTEGER NOT NULL DEFAULT 3,
      weekly_min INTEGER NOT NULL DEFAULT 300, min_chunk_min INTEGER NOT NULL DEFAULT 30, max_per_day_min INTEGER,
      location TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
    );
    CREATE TABLE pending_deletes (event_id TEXT PRIMARY KEY);
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO tasks (title, duration_min, min_chunk_min, location, created_at) VALUES ('At home', 60, 60, 'home', 1);
    INSERT INTO tasks (title, duration_min, min_chunk_min, location, created_at) VALUES ('Anywhere', 60, 60, NULL, 2);
    INSERT INTO habits (title, kind, session_min, location, created_at) VALUES ('Review', 'daily', 15, 'review', 1);
  `);
  const day = [
    { start: "10:00", end: "17:00", location: "home" },
    { start: "17:00", end: "18:00", location: "review" },
  ];
  const hours = { weekly: { "1": day, "2": day, "3": day, "4": day, "5": day, "6": [], "7": [] }, overrides: {} };
  old.prepare("INSERT INTO kv (key, value) VALUES ('hours', ?)").run(JSON.stringify(hours));
  old.close();

  process.env.DATA_DIR = dir;
  process.env.TZ = ZONE;
  const dbm = await import("../src/db.js");
  const planner = await import("../src/planner.js");

  const tasks = dbm.db.prepare("SELECT title, blocks FROM tasks ORDER BY id").all() as { title: string; blocks: string | null }[];
  assert.deepEqual(tasks.map((t) => [t.title, t.blocks]), [["At home", "home"], ["Anywhere", null]]);
  const habit = dbm.db.prepare("SELECT blocks FROM habits").get() as { blocks: string };
  assert.equal(habit.blocks, "review");
  assert.deepEqual(dbm.getHours().weekly["1"], [
    { start: "10:00", end: "17:00", name: "home" },
    { start: "17:00", end: "18:00", name: "review" },
  ]);

  // And it still plans the same way: the habit is held for the review hour.
  planner.planNow(at("2026-12-07T08:00"), []); // a Monday
  const hm = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toFormat("ccc HH:mm");
  const first = dbm.db
    .prepare("SELECT t.title, b.start FROM blocks b JOIN tasks t ON t.id = b.task_id ORDER BY b.start LIMIT 3")
    .all() as { title: string; start: number }[];
  assert.deepEqual(first.map((b) => `${b.title} ${hm(b.start)}`), ["At home Mon 10:00", "Anywhere Mon 11:00", "Review Mon 17:00"]);
});
