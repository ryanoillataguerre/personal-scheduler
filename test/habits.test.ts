// Habits against a real (temporary) database with a controlled clock.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DateTime } from "luxon";

const ZONE = "America/Los_Angeles";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const hm = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toFormat("ccc d HH:mm");

let dbm: typeof import("../src/db.js");
let planner: typeof import("../src/planner.js");
let habits: typeof import("../src/habits.js");
type TaskRow = import("../src/db.js").TaskRow;
type BlockRow = import("../src/db.js").BlockRow;

before(async () => {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dayloop-habits-"));
  process.env.TZ = ZONE;
  dbm = await import("../src/db.js");
  planner = await import("../src/planner.js");
  habits = await import("../src/habits.js");
  const day = [
    { start: "09:00", end: "12:00", name: null },
    { start: "19:00", end: "21:00", name: null },
  ];
  dbm.saveHours({ weekly: { "1": day, "2": day, "3": day, "4": day, "5": day, "6": day, "7": day }, overrides: {} });
});

const base = { priority: 2, sessionMin: 30, daysPerWeek: 3, weeklyMin: 300, minChunkMin: 30, maxPerDayMin: null, blocks: [] as string[], tags: [] as string[], days: [] as number[], timeFrom: null as string | null, timeTo: null as string | null };
const blocks = (habitId: number, status?: string) =>
  (
    dbm.db
      .prepare("SELECT b.* FROM blocks b JOIN tasks t ON t.id = b.task_id WHERE t.habit_id = ? ORDER BY b.start")
      .all(habitId) as BlockRow[]
  ).filter((b) => !status || b.status === status);
const show = (bs: BlockRow[]) => bs.map((b) => `${hm(b.start)}-${hm(b.end).split(" ")[2]}`);
const occurrences = (habitId: number) =>
  dbm.db.prepare("SELECT * FROM tasks WHERE habit_id = ? ORDER BY period_start").all(habitId) as TaskRow[];
const wipe = () => {
  for (const h of dbm.db.prepare("SELECT id FROM habits").all() as { id: number }[]) habits.deleteHabit(h.id);
  for (const t of dbm.db.prepare("SELECT id FROM tasks").all() as { id: number }[]) planner.deleteTask(t.id);
};

test("a daily habit is planned every day, retried the same day, and lapses at midnight", () => {
  const id = habits.createHabit({ ...base, title: "Stretch", kind: "daily" }, at("2026-12-07T08:00"));
  planner.planNow(at("2026-12-07T08:00"), []);
  const planned = show(blocks(id));
  assert.equal(planned.length, 14); // one per day across the 14-day horizon
  assert.deepEqual(planned.slice(0, 3), ["Mon 7 09:00-09:30", "Tue 8 09:00-09:30", "Wed 9 09:00-09:30"]);

  // Missed this morning: planned again today, and tomorrow's is untouched.
  planner.planNow(at("2026-12-07T09:50"), []);
  assert.deepEqual(show(blocks(id)).slice(0, 2), ["Mon 7 09:50-10:20", "Tue 8 09:00-09:30"]);

  // Missed all day: Monday lapses instead of carrying over; Tuesday still stands alone.
  planner.planNow(at("2026-12-07T22:00"), []);
  planner.planNow(at("2026-12-08T00:20"), []);
  const [mon, tue] = occurrences(id);
  assert.equal(mon.status, "lapsed");
  assert.equal(tue.status, "open");
  assert.deepEqual(show(blocks(id)).slice(0, 2), ["Tue 8 09:00-09:30", "Wed 9 09:00-09:30"]);
  wipe();
});

test("days a week: one sitting a day, on separate days", () => {
  const id = habits.createHabit({ ...base, title: "Gym", kind: "days", sessionMin: 60, daysPerWeek: 3 }, at("2026-12-07T08:00"));
  planner.planNow(at("2026-12-07T08:00"), []);
  assert.deepEqual(show(blocks(id)), [
    "Mon 7 09:00-10:00", "Tue 8 09:00-10:00", "Wed 9 09:00-10:00",
    "Mon 14 09:00-10:00", "Tue 15 09:00-10:00", "Wed 16 09:00-10:00",
  ]);

  // Monday done: no second sitting on Monday, the other two stay put.
  planner.completeBlock(blocks(id)[0].id, at("2026-12-07T10:00"));
  planner.planNow(at("2026-12-07T10:00"), []);
  assert.deepEqual(show(blocks(id, "planned")).slice(0, 2), ["Tue 8 09:00-10:00", "Wed 9 09:00-10:00"]);
  assert.equal(occurrences(id)[0].done_min, 60);

  // Tuesday goes by unmarked: it is tried again that evening, never doubled up on Wednesday.
  planner.planNow(at("2026-12-08T12:30"), []);
  assert.deepEqual(show(blocks(id, "planned")).slice(0, 2), ["Tue 8 19:00-20:00", "Wed 9 09:00-10:00"]);

  // Finishing all three completes the week.
  planner.completeBlock(blocks(id, "planned")[0].id, at("2026-12-08T20:00"));
  planner.planNow(at("2026-12-09T10:00"), []);
  planner.completeBlock(blocks(id, "planned")[0].id, at("2026-12-09T10:00"));
  planner.planNow(at("2026-12-09T10:05"), []);
  assert.equal(occurrences(id)[0].status, "done");
  // Next week is planned as usual (and the horizon has moved on to show the week after).
  assert.deepEqual(show(blocks(id, "planned")).slice(0, 3), ["Mon 14 09:00-10:00", "Tue 15 09:00-10:00", "Wed 16 09:00-10:00"]);
  wipe();
});

test("a sitting marked done ahead of time still counts as that day's", () => {
  const id = habits.createHabit({ ...base, title: "Gym", kind: "days", sessionMin: 60, daysPerWeek: 3 }, at("2026-12-07T08:00"));
  planner.planNow(at("2026-12-07T08:00"), []);
  // 08:30, before the 09:00 block starts: "Done already".
  planner.completeBlock(blocks(id)[0].id, at("2026-12-07T08:30"));
  planner.planNow(at("2026-12-07T08:30"), []);
  assert.deepEqual(show(blocks(id, "done")), ["Mon 7 07:30-08:30"]); // logged as just finished
  assert.deepEqual(show(blocks(id, "planned")).slice(0, 2), ["Tue 8 09:00-10:00", "Wed 9 09:00-10:00"]);
  wipe();
});

test("hours a week respects the daily limit and reports progress", () => {
  const id = habits.createHabit(
    { ...base, title: "Spanish", kind: "hours", weeklyMin: 300, minChunkMin: 30, maxPerDayMin: 90 },
    at("2026-12-07T08:00"),
  );
  const info = planner.planNow(at("2026-12-07T08:00"), []);
  assert.deepEqual(show(blocks(id)).slice(0, 4), [
    "Mon 7 09:00-10:30", "Tue 8 09:00-10:30", "Wed 9 09:00-10:30", "Thu 10 09:00-09:30",
  ]);

  planner.completeBlock(blocks(id)[0].id, at("2026-12-07T10:30"));
  planner.planNow(at("2026-12-07T10:30"), []);
  // 90 minutes are in for today, so nothing more lands on Monday.
  assert.equal(show(blocks(id, "planned"))[0], "Tue 8 09:00-10:30");
  const p = habits.habitProgress(habits.getHabit(id)!, at("2026-12-07T10:30"), ZONE, new Map(info.unscheduled.map((u) => [u.taskId, u.minutes])));
  assert.deepEqual(
    { done: p.weekDoneMin, target: p.weekTargetMin, current: p.current, next: hm(p.nextStart!) },
    { done: 90, target: 300, current: "open", next: "Tue 8 09:00" },
  );
  wipe();
});

test("a weekly habit started late in the week asks for a share of that week", () => {
  const gym = habits.createHabit({ ...base, title: "Gym", kind: "days", sessionMin: 60, daysPerWeek: 3 }, at("2026-12-11T08:00"));
  const spanish = habits.createHabit({ ...base, title: "Spanish", kind: "hours", weeklyMin: 300 }, at("2026-12-11T08:00"));
  planner.planNow(at("2026-12-11T08:00"), []); // a Friday: 3 of 7 days left
  assert.deepEqual(occurrences(gym).map((t) => t.duration_min), [60, 180, 180]);
  assert.deepEqual(occurrences(spanish).map((t) => t.duration_min), [130, 300, 300]);
  wipe();
});

test("habits rank against tasks by priority, and edits carry to open occurrences", () => {
  const id = habits.createHabit({ ...base, title: "Read", kind: "daily", priority: 2 }, at("2026-12-07T08:00"));
  const taskId = Number(
    dbm.db
      .prepare("INSERT INTO tasks (title, priority, duration_min, min_chunk_min, created_at) VALUES ('Urgent', 1, 60, 60, 1)")
      .run().lastInsertRowid,
  );
  planner.planNow(at("2026-12-07T08:00"), []);
  assert.equal(show(blocks(id))[0], "Mon 7 10:00-10:30"); // the priority 1 task took 09:00

  habits.updateHabit(id, habits.parseHabit({ title: "Read a book", priority: 1, sessionMin: 45 }, habits.getHabit(id)!));
  planner.planNow(at("2026-12-07T08:05"), []);
  const first = occurrences(id)[0];
  assert.deepEqual([first.title, first.priority, first.duration_min], ["Read a book", 1, 45]);
  assert.equal(show(blocks(id))[0], "Mon 7 09:00-09:45"); // same priority now, and it has a deadline

  assert.throws(() => habits.parseHabit({ kind: "hours" }, habits.getHabit(id)!), /can't be changed/);
  planner.deleteTask(taskId);
  wipe();
});

test("pausing clears the plan, resuming restores it, deleting keeps finished work", () => {
  const id = habits.createHabit({ ...base, title: "Stretch", kind: "daily" }, at("2026-12-07T08:00"));
  planner.planNow(at("2026-12-07T08:00"), []);
  planner.completeBlock(blocks(id)[0].id, at("2026-12-07T09:30"));
  planner.planNow(at("2026-12-07T09:30"), []);

  habits.setHabitActive(id, false, at("2026-12-07T09:35"));
  planner.planNow(at("2026-12-07T09:35"), []);
  assert.deepEqual(show(blocks(id, "planned")), []);
  assert.equal(occurrences(id).length, 1); // Monday's finished one remains

  habits.setHabitActive(id, true);
  planner.planNow(at("2026-12-07T09:40"), []);
  assert.equal(show(blocks(id, "planned")).length, 13); // Tuesday onward; Monday is already done

  habits.deleteHabit(id, at("2026-12-07T09:45"));
  planner.planNow(at("2026-12-07T09:45"), []);
  assert.deepEqual(show(blocks(id, "planned")), []);
  assert.deepEqual(occurrences(id).map((t) => t.status), ["done"]);
});

test("a habit kept to certain days and a set time lands exactly there, even outside working hours", () => {
  // Hours are 09:00-12:00 and 19:00-21:00. The gym slot is 07:00-08:30, before them.
  const id = habits.createHabit(
    { ...base, title: "Gym", kind: "days", sessionMin: 60, daysPerWeek: 3, days: [1, 3, 5], timeFrom: "07:00", timeTo: "08:30" },
    at("2026-12-07T06:00"),
  );
  planner.planNow(at("2026-12-07T06:00"), []);
  assert.deepEqual(show(blocks(id)).slice(0, 4), [
    "Mon 7 07:00-08:00", "Wed 9 07:00-08:00", "Fri 11 07:00-08:00", "Mon 14 07:00-08:00",
  ]);

  // A calendar event over part of the slot pushes it later inside the slot, or off that day.
  planner.planNow(at("2026-12-07T06:05"), [
    { start: at("2026-12-07T06:30"), end: at("2026-12-07T07:20") }, // leaves 07:20-08:30: still fits
    { start: at("2026-12-09T07:30"), end: at("2026-12-09T08:30") }, // leaves 07:00-07:30: too short
  ]);
  assert.deepEqual(show(blocks(id)).slice(0, 2), ["Mon 7 07:20-08:20", "Fri 11 07:00-08:00"]);
  wipe();
});

test("a set time inside working hours takes that time away from other work", () => {
  const review = habits.createHabit(
    { ...base, title: "Weekly review", kind: "days", sessionMin: 45, daysPerWeek: 1, days: [5], timeFrom: "11:15", timeTo: "12:00", priority: 1 },
    at("2026-12-07T08:00"),
  );
  const taskId = Number(
    dbm.db
      .prepare("INSERT INTO tasks (title, priority, duration_min, min_chunk_min, created_at) VALUES ('Big', 2, 1500, 60, 1)")
      .run().lastInsertRowid,
  );
  planner.planNow(at("2026-12-07T08:00"), []);
  assert.deepEqual(show(blocks(review)).slice(0, 1), ["Fri 11 11:15-12:00"]);
  const friday = (dbm.db.prepare("SELECT b.* FROM blocks b WHERE b.task_id = ? ORDER BY b.start").all(taskId) as BlockRow[])
    .map((b) => `${hm(b.start)}-${hm(b.end).split(" ")[2]}`)
    .filter((b) => b.startsWith("Fri 11"));
  assert.equal(friday[0], "Fri 11 09:00-11:15"); // the other work stops where the review starts
  planner.deleteTask(taskId);
  wipe();
});

test("days without a set time keep the habit to those days within working hours", () => {
  const daily = habits.createHabit({ ...base, title: "Journal", kind: "daily", days: [6, 7] }, at("2026-12-07T08:00"));
  const hours = habits.createHabit(
    { ...base, title: "Spanish", kind: "hours", weeklyMin: 180, minChunkMin: 30, maxPerDayMin: 90, days: [2, 4] },
    at("2026-12-07T08:00"),
  );
  planner.planNow(at("2026-12-07T08:00"), []);
  assert.deepEqual(show(blocks(daily)).slice(0, 3), ["Sat 12 09:00-09:30", "Sun 13 09:00-09:30", "Sat 19 09:00-09:30"]);
  assert.equal(occurrences(daily).length, 4); // weekends only: no rows for weekdays
  assert.deepEqual(show(blocks(hours)).slice(0, 2), ["Tue 8 09:00-10:30", "Thu 10 09:00-10:30"]);
  wipe();
});

test("a weekly habit's first week is shared out over the days it can still be done on", () => {
  // Created Thursday. Its days are Mon, Wed, Fri: one of three is left.
  const gym = habits.createHabit({ ...base, title: "Gym", kind: "days", sessionMin: 60, daysPerWeek: 3, days: [1, 3, 5] }, at("2026-12-10T08:00"));
  planner.planNow(at("2026-12-10T08:00"), []);
  assert.deepEqual(occurrences(gym).map((t) => t.duration_min), [60, 180, 180]);
  wipe();
});

test("a habit's tags are carried by its occurrences, and edits reach the open ones", () => {
  const id = habits.createHabit({ ...base, title: "LeetCode", kind: "daily", tags: ["interview prep", "job"] }, at("2026-12-07T08:00"));
  planner.planNow(at("2026-12-07T08:00"), []);
  assert.equal(occurrences(id)[0].tags, "interview prep,job");

  // Finish Monday's, then retag the habit: the finished one keeps what it had.
  planner.completeBlock(blocks(id)[0].id, at("2026-12-07T09:30"));
  habits.updateHabit(id, habits.parseHabit({ tags: ["Prep", " prep ", "#Job"] }, habits.getHabit(id)!));
  planner.planNow(at("2026-12-07T09:35"), []);
  const rows = occurrences(id);
  assert.deepEqual([rows[0].status, rows[0].tags], ["done", "interview prep,job"]);
  assert.equal(rows[1].tags, "job,prep");
  // The calendar event shows tags, so the change is queued for Google.
  assert.equal(blocks(id, "planned")[0].synced, 0);

  habits.updateHabit(id, habits.parseHabit({ tags: [] }, habits.getHabit(id)!));
  planner.planNow(at("2026-12-07T09:40"), []);
  assert.equal(occurrences(id)[1].tags, null);
  wipe();
});

test("validation catches limits that cannot work", () => {
  const ok = { title: "x", kind: "days", sessionMin: 60, daysPerWeek: 3 };
  assert.throws(() => habits.parseHabit({ ...ok, days: [1, 3] }), /at least 3 days/);
  assert.throws(() => habits.parseHabit({ ...ok, timeFrom: "07:00" }), /both a start and an end/);
  assert.throws(() => habits.parseHabit({ ...ok, timeFrom: "08:00", timeTo: "07:00" }), /after the start/);
  assert.throws(() => habits.parseHabit({ ...ok, timeFrom: "07:00", timeTo: "07:30" }), /shorter than one sitting/);
  assert.throws(
    () => habits.parseHabit({ title: "x", kind: "hours", weeklyMin: 600, minChunkMin: 30, days: [1, 2], timeFrom: "07:00", timeTo: "09:00" }),
    /can't reach the weekly total/,
  );
  // A set time replaces named blocks.
  const timed = habits.parseHabit({ ...ok, blocks: ["focus"], days: [5, 1, 3, 1], timeFrom: "07:00", timeTo: "08:30" });
  assert.deepEqual([timed.blocks, timed.days, timed.timeFrom, timed.timeTo], [[], [1, 3, 5], "07:00", "08:30"]);
  assert.throws(() => habits.parseHabit({ title: "", kind: "daily" }), /name/);
  assert.throws(() => habits.parseHabit({ title: "x", kind: "weekly" }), /repeats/);
  assert.throws(
    () => habits.parseHabit({ title: "x", kind: "hours", weeklyMin: 600, minChunkMin: 30, maxPerDayMin: 60 }),
    /can't reach the weekly total/,
  );
});
