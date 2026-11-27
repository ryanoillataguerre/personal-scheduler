import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { schedule, chunkFor, subtract, type SchedTask, type Window } from "../src/scheduler.js";
import { expandWindows, parseHours, type Hours } from "../src/hours.js";

const ZONE = "America/Los_Angeles";
const at = (iso: string) => DateTime.fromISO(iso, { zone: ZONE }).toMillis();
const hm = (ms: number) => DateTime.fromMillis(ms, { zone: ZONE }).toFormat("ccc HH:mm");
const task = (id: number, o: Partial<SchedTask> = {}): SchedTask => ({
  id,
  priority: 2,
  remainingMin: 60,
  minChunkMin: 30,
  location: null,
  createdAt: id,
  ...o,
});
const win = (start: string, end: string, location: string | null = null): Window => ({
  start: at(start),
  end: at(end),
  location,
  day: start.slice(0, 10),
});
const show = (r: ReturnType<typeof schedule>) =>
  r.blocks.map((b) => `${b.taskId}@${hm(b.start)}-${hm(b.end).slice(4)}`);

test("higher priority gets the earliest time", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { priority: 3 }), task(2, { priority: 1 })],
    windows: [win("2026-11-30T09:00", "2026-11-30T12:00")],
    busy: [],
  });
  assert.deepEqual(show(r), ["2@Mon 09:00-10:00", "1@Mon 10:00-11:00"]);
  assert.deepEqual(r.unscheduled, []);
});

test("within a priority, older tasks go first", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(5, { createdAt: 50 }), task(4, { createdAt: 10 })],
    windows: [win("2026-11-30T09:00", "2026-11-30T12:00")],
    busy: [],
  });
  assert.deepEqual(r.blocks.map((b) => b.taskId), [4, 5]);
});

test("works around calendar events and splits across them", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { remainingMin: 120, minChunkMin: 30 })],
    windows: [win("2026-11-30T09:00", "2026-11-30T13:00")],
    busy: [{ start: at("2026-11-30T10:00"), end: at("2026-11-30T11:00") }],
  });
  assert.deepEqual(show(r), ["1@Mon 09:00-10:00", "1@Mon 11:00-12:00"]);
});

test("never places a piece shorter than the minimum chunk", () => {
  // 45 free minutes before a meeting, but the task needs 60-minute pieces.
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { remainingMin: 120, minChunkMin: 60 })],
    windows: [win("2026-11-30T09:00", "2026-11-30T14:00")],
    busy: [{ start: at("2026-11-30T09:45"), end: at("2026-11-30T10:30") }],
  });
  assert.deepEqual(show(r), ["1@Mon 10:30-12:30"]);
});

test("does not strand a leftover smaller than the minimum chunk", () => {
  // 90 min task, 60 min chunks... a 75 min slot must not leave 15 behind.
  assert.equal(chunkFor(90, 60, 75), 0);
  // 100 min task, 30 min chunks, 80 min slot: place 70 so 30 remain.
  assert.equal(chunkFor(100, 30, 80), 70);
  assert.equal(chunkFor(40, 30, 120), 40);
  assert.equal(chunkFor(20, 30, 20), 20); // short task, placed whole
  assert.equal(chunkFor(20, 30, 15), 0);
});

test("a lower priority task fills a gap the higher one could not use", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [
      task(1, { priority: 1, remainingMin: 120, minChunkMin: 120 }),
      task(2, { priority: 4, remainingMin: 30, minChunkMin: 30 }),
    ],
    windows: [win("2026-11-30T09:00", "2026-11-30T14:00")],
    busy: [{ start: at("2026-11-30T09:45"), end: at("2026-11-30T10:30") }],
  });
  assert.deepEqual(show(r), ["2@Mon 09:00-09:30", "1@Mon 10:30-12:30"]);
});

test("a task with a location only lands in windows tagged with it", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { priority: 1, location: "Office" }), task(2, { priority: 2 })],
    windows: [
      win("2026-11-30T09:00", "2026-11-30T12:00", "home"),
      win("2026-11-30T13:00", "2026-11-30T17:00", "office"),
    ],
    busy: [],
  });
  assert.deepEqual(show(r), ["2@Mon 09:00-10:00", "1@Mon 13:00-14:00"]);
});

test("untagged windows do not take location-bound tasks", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { location: "gym" })],
    windows: [win("2026-11-30T09:00", "2026-11-30T12:00")],
    busy: [],
  });
  assert.deepEqual(r.blocks, []);
  assert.deepEqual(r.unscheduled, [{ taskId: 1, minutes: 60 }]);
});

test("starts from now, rounded up, when the window is already under way", () => {
  const r = schedule({
    now: at("2026-11-30T10:07"),
    tasks: [task(1, { remainingMin: 30 })],
    windows: [win("2026-11-30T09:00", "2026-11-30T12:00")],
    busy: [],
  });
  assert.deepEqual(show(r), ["1@Mon 10:10-10:40"]);
});

test("a missed task is placed again tonight if hours remain, else tomorrow", () => {
  const windows = [
    win("2026-11-30T09:00", "2026-11-30T12:00"),
    win("2026-11-30T19:00", "2026-11-30T21:00"),
    win("2026-12-01T09:00", "2026-12-01T12:00"),
  ];
  const tasks = [task(1, { remainingMin: 60 })];
  // Missed the morning: replanning in the afternoon lands it in the evening.
  assert.deepEqual(show(schedule({ now: at("2026-11-30T14:00"), tasks, windows, busy: [] })), [
    "1@Mon 19:00-20:00",
  ]);
  // Only 15 minutes of the evening left, under the 30-minute chunk: tomorrow.
  assert.deepEqual(show(schedule({ now: at("2026-11-30T20:45"), tasks, windows, busy: [] })), [
    "1@Tue 09:00-10:00",
  ]);
});

test("reports what did not fit inside the horizon", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { remainingMin: 240, minChunkMin: 60 })],
    windows: [win("2026-11-30T09:00", "2026-11-30T11:00")],
    busy: [],
  });
  assert.deepEqual(show(r), ["1@Mon 09:00-11:00"]);
  assert.deepEqual(r.unscheduled, [{ taskId: 1, minutes: 120 }]);
});

test("buffer leaves a gap between blocks", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { remainingMin: 30 }), task(2, { remainingMin: 30 })],
    windows: [win("2026-11-30T09:00", "2026-11-30T12:00")],
    busy: [],
    bufferMin: 10,
  });
  assert.deepEqual(show(r), ["1@Mon 09:00-09:30", "2@Mon 09:40-10:10"]);
});

test("blocks never overlap each other or busy time", () => {
  const busy = [
    { start: at("2026-11-30T09:20"), end: at("2026-11-30T10:05") },
    { start: at("2026-11-30T13:00"), end: at("2026-11-30T13:50") },
  ];
  const tasks = Array.from({ length: 12 }, (_, i) =>
    task(i + 1, { priority: (i % 4) + 1, remainingMin: 25 + i * 10, minChunkMin: 15 + (i % 3) * 15 }),
  );
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks,
    windows: [win("2026-11-30T09:00", "2026-11-30T17:00"), win("2026-12-01T09:00", "2026-12-01T17:00")],
    busy,
  });
  const all = [...r.blocks].sort((a, b) => a.start - b.start);
  for (let i = 1; i < all.length; i++) assert.ok(all[i].start >= all[i - 1].end, "blocks overlap");
  for (const b of all) for (const z of busy) assert.ok(b.end <= z.start || b.start >= z.end, "overlaps busy");
  // Every task's minutes are either placed or reported, rounded to 5.
  for (const t of tasks) {
    const placed = all.filter((b) => b.taskId === t.id).reduce((s, b) => s + (b.end - b.start) / 60000, 0);
    const left = r.unscheduled.find((u) => u.taskId === t.id)?.minutes ?? 0;
    assert.equal(placed + left, Math.ceil(t.remainingMin / 5) * 5);
  }
});

test("a skipped task waits until its not-before time and others use the gap", () => {
  const r = schedule({
    now: at("2026-11-30T09:10"),
    tasks: [
      task(1, { priority: 1, remainingMin: 60, notBefore: at("2026-11-30T10:00") }),
      task(2, { priority: 3, remainingMin: 30 }),
    ],
    windows: [win("2026-11-30T09:00", "2026-11-30T12:00")],
    busy: [],
  });
  assert.deepEqual(show(r), ["2@Mon 09:10-09:40", "1@Mon 10:00-11:00"]);
});

test("a deadline keeps blocks inside the period and reports what did not fit", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { remainingMin: 120, minChunkMin: 60, notAfter: at("2026-12-01T00:00") })],
    windows: [win("2026-11-30T09:00", "2026-11-30T10:00"), win("2026-12-01T09:00", "2026-12-01T12:00")],
    busy: [],
  });
  assert.deepEqual(show(r), ["1@Mon 09:00-10:00"]);
  assert.deepEqual(r.unscheduled, [{ taskId: 1, minutes: 60 }]);
});

test("within a priority, work with a deadline goes first", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { createdAt: 1 }), task(2, { createdAt: 2, remainingMin: 30, notAfter: at("2026-12-01T00:00") })],
    windows: [win("2026-11-30T09:00", "2026-11-30T12:00")],
    busy: [],
  });
  assert.deepEqual(show(r), ["2@Mon 09:00-09:30", "1@Mon 09:30-10:30"]);
});

test("fixed sessions land once a day on separate days", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { remainingMin: 180, minChunkMin: 60, maxChunkMin: 60, maxPerDayMin: 60 })],
    windows: [
      win("2026-11-30T09:00", "2026-11-30T17:00"),
      win("2026-12-01T09:00", "2026-12-01T17:00"),
      win("2026-12-02T09:00", "2026-12-02T17:00"),
    ],
    busy: [],
  });
  assert.deepEqual(show(r), ["1@Mon 09:00-10:00", "1@Tue 09:00-10:00", "1@Wed 09:00-10:00"]);
});

test("a daily cap spreads a weekly total and counts what is already done today", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [
      task(1, { remainingMin: 240, minChunkMin: 30, maxPerDayMin: 90, usedByDay: { "2026-11-30": 60 } }),
    ],
    windows: [
      win("2026-11-30T09:00", "2026-11-30T17:00"),
      win("2026-12-01T09:00", "2026-12-01T17:00"),
      win("2026-12-02T09:00", "2026-12-02T17:00"),
      win("2026-12-03T09:00", "2026-12-03T17:00"),
    ],
    busy: [],
  });
  assert.deepEqual(show(r), [
    "1@Mon 09:00-09:30",
    "1@Tue 09:00-10:30",
    "1@Wed 09:00-10:30",
    "1@Thu 09:00-09:30",
  ]);
});

// ---- Deadlines ---------------------------------------------------------------

const week = [
  win("2026-11-30T09:00", "2026-11-30T12:00"),
  win("2026-12-01T09:00", "2026-12-01T12:00"),
  win("2026-12-02T09:00", "2026-12-02T12:00"),
];

test("a deadline with time to spare leaves the priority order alone", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [
      task(1, { priority: 1, remainingMin: 120 }),
      task(2, { priority: 4, remainingMin: 60, dueBy: at("2026-12-03T00:00") }),
    ],
    windows: week,
    busy: [],
  });
  assert.deepEqual(show(r), ["1@Mon 09:00-11:00", "2@Mon 11:00-12:00"]);
  assert.deepEqual([r.urgent, r.late], [[], []]);
});

test("a task that would miss its deadline jumps ahead of higher priorities", () => {
  // Three hours of priority 1 work fill Monday; the low-priority task is due Monday night.
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [
      task(1, { priority: 1, remainingMin: 180 }),
      task(2, { priority: 4, remainingMin: 60, dueBy: at("2026-12-01T00:00") }),
    ],
    windows: week,
    busy: [],
  });
  assert.deepEqual(show(r), ["2@Mon 09:00-10:00", "1@Mon 10:00-12:00", "1@Tue 09:00-10:00"]);
  assert.deepEqual([r.urgent, r.late], [[2], []]);
});

test("tasks running out of time go earliest deadline first, whatever their priority", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [
      task(1, { priority: 1, remainingMin: 360 }),
      task(2, { priority: 2, remainingMin: 120, dueBy: at("2026-12-02T00:00") }),
      task(3, { priority: 4, remainingMin: 120, dueBy: at("2026-12-01T00:00") }),
    ],
    windows: week,
    busy: [],
  });
  assert.deepEqual(show(r).slice(0, 3), ["3@Mon 09:00-11:00", "2@Mon 11:00-12:00", "2@Tue 09:00-10:00"]);
  assert.deepEqual([r.urgent.sort(), r.late], [[2, 3], []]);
});

test("pulling one task forward can catch another, which is then pulled forward too", () => {
  // Task 3 fits before its Monday-night deadline until task 2 is moved ahead of it.
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [
      task(1, { priority: 1, remainingMin: 120 }),
      task(3, { priority: 2, remainingMin: 60, dueBy: at("2026-12-01T00:00") }),
      task(2, { priority: 3, remainingMin: 60, dueBy: at("2026-12-01T00:00"), createdAt: 0 }),
    ],
    windows: week,
    busy: [],
  });
  // Both are due at the same time, so priority decides between the two of them.
  assert.deepEqual(show(r), ["3@Mon 09:00-10:00", "2@Mon 10:00-11:00", "1@Mon 11:00-12:00", "1@Tue 09:00-10:00"]);
  assert.deepEqual([r.urgent.sort(), r.late], [[2, 3], []]);
});

test("a deadline that cannot be met is reported, and the work still gets the first time available", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [
      task(1, { priority: 1, remainingMin: 60 }),
      task(2, { priority: 3, remainingMin: 300, minChunkMin: 60, dueBy: at("2026-12-01T00:00") }),
    ],
    windows: week,
    busy: [],
  });
  assert.deepEqual(show(r), ["2@Mon 09:00-12:00", "2@Tue 09:00-11:00", "1@Tue 11:00-12:00"]);
  assert.deepEqual([r.urgent, r.late], [[2], [2]]);
});

test("an overdue task goes first and is reported late", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { priority: 1 }), task(2, { priority: 4, dueBy: at("2026-11-29T00:00") })],
    windows: week,
    busy: [],
  });
  assert.deepEqual(show(r), ["2@Mon 09:00-10:00", "1@Mon 10:00-11:00"]);
  assert.deepEqual([r.urgent, r.late], [[2], [2]]);
});

test("the cushion pulls work forward a day before it would be late", () => {
  const tasks = [
    task(1, { priority: 1, remainingMin: 180 }),
    task(2, { priority: 4, remainingMin: 60, dueBy: at("2026-12-02T00:00") }), // due Tuesday night
  ];
  // No cushion: finishing Tuesday morning is in time, so priority order stands.
  const plain = schedule({ now: at("2026-11-30T08:00"), tasks, windows: week, busy: [] });
  assert.deepEqual(show(plain), ["1@Mon 09:00-12:00", "2@Tue 09:00-10:00"]);
  assert.deepEqual(plain.urgent, []);
  // A day's cushion: it should be done by Monday night, so it goes first.
  const cushioned = schedule({ now: at("2026-11-30T08:00"), tasks, windows: week, busy: [], cushionMin: 24 * 60 });
  assert.deepEqual(show(cushioned), ["2@Mon 09:00-10:00", "1@Mon 10:00-12:00", "1@Tue 09:00-10:00"]);
  assert.deepEqual([cushioned.urgent, cushioned.late], [[2], []]);
});

test("a deadline past the planned period does not count unplanned work as late", () => {
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [
      task(1, { priority: 1, remainingMin: 540 }), // fills all three days
      task(2, { priority: 3, remainingMin: 60, dueBy: at("2026-12-20T00:00") }),
    ],
    windows: week,
    busy: [],
  });
  assert.deepEqual([r.urgent, r.late], [[], []]);
  assert.deepEqual(r.unscheduled, [{ taskId: 2, minutes: 60 }]);
});

test("a deadline respects where the task has to happen", () => {
  // Only Tuesday has office hours, and that is after the deadline.
  const r = schedule({
    now: at("2026-11-30T08:00"),
    tasks: [task(1, { remainingMin: 60, location: "office", dueBy: at("2026-12-01T00:00") })],
    windows: [win("2026-11-30T09:00", "2026-11-30T12:00", "home"), win("2026-12-01T09:00", "2026-12-01T12:00", "office")],
    busy: [],
  });
  assert.deepEqual(show(r), ["1@Tue 09:00-10:00"]);
  assert.deepEqual(r.late, [1]);
});

test("subtract cuts intervals", () => {
  assert.deepEqual(subtract({ start: 0, end: 100 }, [{ start: 20, end: 30 }, { start: 90, end: 120 }]), [
    { start: 0, end: 20 },
    { start: 30, end: 90 },
  ]);
});

test("hours expand per weekday, with date overrides and DST handled", () => {
  const hours: Hours = parseHours({
    weekly: { "1": [{ start: "09:00", end: "12:00", location: "Home" }], "7": [{ start: "10:00", end: "11:00" }] },
    overrides: { "2026-12-01": [{ start: "18:00", end: "20:00", location: "office" }], "2026-12-07": [] },
  });
  const w = expandWindows(hours, at("2026-11-30T08:00"), ZONE, 8);
  assert.deepEqual(
    w.map((x) => `${hm(x.start)}-${hm(x.end).slice(4)} ${x.location}`),
    ["Mon 09:00-12:00 home", "Tue 18:00-20:00 office", "Sun 10:00-11:00 null"],
  );
  // Spring-forward Sunday 2027-03-14: 10:00 local is still 10:00 local.
  const dst = expandWindows(hours, at("2027-03-14T00:30"), ZONE, 1);
  assert.equal(hm(dst[0].start), "Sun 10:00");
});

test("rejects bad hours", () => {
  assert.throws(() => parseHours({ weekly: { "1": [{ start: "12:00", end: "09:00" }] } }));
  assert.throws(() => parseHours({ weekly: { "1": [{ start: "9am", end: "10:00" }] } }));
});
