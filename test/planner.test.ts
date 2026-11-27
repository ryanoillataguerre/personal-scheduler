// Exercises the loop against a real (temporary) database with a controlled clock.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";

const ZONE = "America/Los_Angeles";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const hm = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toFormat("ccc HH:mm");

let dbm: typeof import("../src/db.js");
let planner: typeof import("../src/planner.js");

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dayloop-test-"));
  process.env.TZ = ZONE;
  dbm = await import("../src/db.js");
  planner = await import("../src/planner.js");
  dbm.saveHours({
    weekly: {
      "1": [
        { start: "09:00", end: "12:00", location: null },
        { start: "19:00", end: "21:00", location: null },
      ],
      "2": [{ start: "09:00", end: "12:00", location: null }],
      "3": [], "4": [], "5": [], "6": [], "7": [],
    },
    overrides: {},
  });
});

const addTask = (title: string, duration: number, minChunk = 30, priority = 2) =>
  Number(
    dbm.db
      .prepare("INSERT INTO tasks (title, priority, duration_min, min_chunk_min, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(title, priority, duration, minChunk, Date.now()).lastInsertRowid,
  );
const blocks = () =>
  (dbm.db.prepare("SELECT * FROM blocks ORDER BY start").all() as import("../src/db.js").BlockRow[]).map(
    (b) => `${b.task_id}:${hm(b.start)}-${hm(b.end).slice(4)}:${b.status}`,
  );
const task = (id: number) => dbm.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as import("../src/db.js").TaskRow;

test("a block that passes unmarked goes back in the loop and lands that night", () => {
  const id = addTask("Taxes", 60);
  planner.planNow(at("2026-11-30T08:00"), []);
  assert.deepEqual(blocks(), [`${id}:Mon 09:00-10:00:planned`]);

  // Under way: the block stays where it is.
  planner.planNow(at("2026-11-30T09:30"), []);
  assert.deepEqual(blocks(), [`${id}:Mon 09:00-10:00:planned`]);

  // Ended, still inside the 15-minute grace period: not missed yet.
  planner.planNow(at("2026-11-30T10:10"), []);
  assert.deepEqual(blocks(), [`${id}:Mon 09:00-10:00:planned`]);
  assert.equal(task(id).missed_count, 0);

  // Grace over, never marked done: missed, and rescheduled into what is left today.
  const info = planner.planNow(at("2026-11-30T10:16"), []);
  assert.deepEqual(blocks(), [`${id}:Mon 10:20-11:20:planned`]);
  assert.equal(task(id).missed_count, 1);
  assert.equal(info.lastMissed?.count, 1);

  // Missed again with the morning gone: it moves to tonight's hours.
  planner.planNow(at("2026-11-30T11:40"), []);
  assert.deepEqual(blocks(), [`${id}:Mon 19:00-20:00:planned`]);
  assert.equal(task(id).missed_count, 2);

  // And if tonight is missed too, tomorrow morning.
  planner.planNow(at("2026-11-30T22:00"), []);
  assert.deepEqual(blocks(), [`${id}:Tue 09:00-10:00:planned`]);
  assert.equal(task(id).missed_count, 3);
  assert.equal(task(id).status, "open");
  planner.deleteTask(id);
});

test("marking blocks done credits the task and finishes it", () => {
  const id = addTask("Deck", 90, 45);
  planner.planNow(at("2026-12-07T08:00"), [{ start: at("2026-12-07T09:45"), end: at("2026-12-07T10:15") }]);
  assert.deepEqual(blocks(), [`${id}:Mon 09:00-09:45:planned`, `${id}:Mon 10:15-11:00:planned`]);

  const first = (dbm.db.prepare("SELECT id FROM blocks ORDER BY start").get() as { id: number }).id;
  planner.completeBlock(first, at("2026-12-07T09:50"));
  planner.planNow(at("2026-12-07T09:50"), [{ start: at("2026-12-07T09:45"), end: at("2026-12-07T10:15") }]);
  assert.equal(task(id).done_min, 45);
  assert.deepEqual(blocks(), [`${id}:Mon 09:00-09:45:done`, `${id}:Mon 10:15-11:00:planned`]);

  // Finish the second block ten minutes in: the task completes, the slot is trimmed.
  const second = (dbm.db.prepare("SELECT id FROM blocks WHERE status = 'planned'").get() as { id: number }).id;
  planner.completeBlock(second, at("2026-12-07T10:25"));
  assert.equal(task(id).status, "done");
  assert.deepEqual(blocks(), [`${id}:Mon 09:00-09:45:done`, `${id}:Mon 10:15-10:25:done`]);

  // Done blocks are a record: later replans leave them alone.
  planner.planNow(at("2026-12-07T20:00"), []);
  assert.deepEqual(blocks(), [`${id}:Mon 09:00-09:45:done`, `${id}:Mon 10:15-10:25:done`]);
  planner.deleteTask(id);
});

test("unchanged blocks keep their calendar event; removed ones queue a delete", () => {
  const a = addTask("A", 60, 30, 2);
  planner.planNow(at("2026-12-14T08:00"), []);
  dbm.db.prepare("UPDATE blocks SET event_id = 'evt-a', synced = 1").run();

  // Nothing changed: same block, still synced.
  planner.planNow(at("2026-12-14T08:05"), []);
  const kept = dbm.db.prepare("SELECT event_id, synced FROM blocks").get() as { event_id: string; synced: number };
  assert.deepEqual({ ...kept }, { event_id: "evt-a", synced: 1 });

  // A more important task arrives and takes 09:00, pushing A back.
  const b = addTask("B", 60, 30, 1);
  planner.planNow(at("2026-12-14T08:10"), []);
  assert.deepEqual(blocks(), [`${b}:Mon 09:00-10:00:planned`, `${a}:Mon 10:00-11:00:planned`]);
  const pending = dbm.db.prepare("SELECT event_id FROM pending_deletes").all() as { event_id: string }[];
  assert.deepEqual(pending.map((p) => p.event_id), ["evt-a"]);

  // Skipping B frees 09:00 for A again at once.
  const bBlock = (dbm.db.prepare("SELECT id FROM blocks WHERE task_id = ?").get(b) as { id: number }).id;
  planner.skipBlock(bBlock);
  planner.finishTask(b, at("2026-12-14T08:11"));
  planner.planNow(at("2026-12-14T08:11"), []);
  assert.deepEqual(blocks(), [`${a}:Mon 09:00-10:00:planned`]);
});
