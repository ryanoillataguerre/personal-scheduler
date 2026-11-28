import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backupIfDue, backupNow, backupStatus } from "./backup.js";
import { DateTime, IANAZone } from "luxon";
import { db, getHours, getSettings, saveHours, saveSettings, type BlockRow, type HabitRow, type Settings, type TaskRow } from "./db.js";
import {
  authUrl,
  disconnect,
  finishAuth,
  googleConfigured,
  googleConnected,
  googleError,
  listCalendars,
  redirectUri,
} from "./google.js";
import {
  createHabit,
  deleteHabit,
  getHabit,
  habitProgress,
  habitWeekdays,
  parseHabit,
  setHabitActive,
  updateHabit,
} from "./habits.js";
import { parseHours, pruneOverrides } from "./hours.js";
import {
  completeBlock,
  deleteTask,
  finishTask,
  getPlanInfo,
  reopenTask,
  replan,
  skipBlock,
  touchTask,
  UserError,
} from "./planner.js";
import { normBlocks } from "./scheduler.js";
import { normTags, storeTags } from "./tags.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
const TICK_MIN = Number(process.env.TICK_MIN || 5);
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const app = express();
app.use(express.json({ limit: "200kb" }));

// Changes must come from the app itself: a custom header cannot be sent by
// another website's form or image tag, which rules out cross-site requests.
app.use("/api", (req, res, next) => {
  if (req.method !== "GET" && req.get("X-Dayloop") !== "1") {
    res.status(403).json({ error: "Missing X-Dayloop header." });
    return;
  }
  next();
});

class BadRequest extends UserError {}
const bad = (msg: string): never => {
  throw new BadRequest(msg);
};

function int(v: unknown, name: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`${name} must be a whole number from ${min} to ${max}.`);
  return n;
}

function parseTask(body: Record<string, unknown>, existing?: TaskRow) {
  const title = String(body.title ?? existing?.title ?? "").trim();
  if (!title) bad("Give the task a title.");
  if (title.length > 200) bad("Keep the title under 200 characters.");
  const duration = int(body.durationMin ?? existing?.duration_min, "Length", 5, 6000);
  const priority = int(body.priority ?? existing?.priority ?? 2, "Priority", 1, 4);
  const minChunk = int(
    body.minChunkMin ?? existing?.min_chunk_min ?? Math.min(duration, 30),
    "Minimum chunk",
    5,
    6000,
  );
  const blocks = normBlocks(body.blocks === undefined ? existing?.blocks : body.blocks).join(",") || null;
  const notes = String(body.notes ?? existing?.notes ?? "").slice(0, 2000);
  const rawDue = body.dueDate === undefined ? existing?.due_date : body.dueDate;
  const dueDate = rawDue === null || rawDue === undefined || rawDue === "" ? null : String(rawDue);
  if (dueDate !== null && !(/^\d{4}-\d{2}-\d{2}$/.test(dueDate) && DateTime.fromISO(dueDate).isValid)) {
    bad("The deadline must be a date like 2026-12-04.");
  }
  const tags = storeTags(normTags(body.tags === undefined ? existing?.tags : body.tags));
  return { title, duration, priority, minChunk: Math.min(minChunk, duration), blocks, notes, dueDate, tags };
}

const publicTask = (t: TaskRow) => ({
  id: t.id,
  title: t.title,
  priority: t.priority,
  durationMin: t.duration_min,
  doneMin: t.done_min,
  minChunkMin: t.min_chunk_min,
  blocks: normBlocks(t.blocks),
  tags: normTags(t.tags),
  notes: t.notes,
  status: t.status,
  missedCount: t.missed_count,
  createdAt: t.created_at,
  completedAt: t.completed_at,
  habitId: t.habit_id,
  dueDate: t.due_date,
});

const publicHabit = (h: HabitRow) => ({
  id: h.id,
  title: h.title,
  kind: h.kind,
  priority: h.priority,
  sessionMin: h.session_min,
  daysPerWeek: h.days_per_week,
  weeklyMin: h.weekly_min,
  minChunkMin: h.min_chunk_min,
  maxPerDayMin: h.max_per_day_min,
  blocks: normBlocks(h.blocks),
  tags: normTags(h.tags),
  days: habitWeekdays(h) ?? [],
  timeFrom: h.time_from,
  timeTo: h.time_to,
  active: h.active === 1,
});

async function state() {
  const s = getSettings();
  const now = Date.now();
  const dayStart = DateTime.fromMillis(now, { zone: s.zone }).startOf("day").toMillis();
  // One-off tasks that are open or recently finished, plus the habit
  // occurrences that today's blocks and this week's progress refer to.
  const tasks = db
    .prepare(
      `SELECT * FROM tasks
       WHERE (habit_id IS NULL AND (status = 'open' OR completed_at >= ?))
          OR (habit_id IS NOT NULL AND period_end > ?)
       ORDER BY priority, created_at`,
    )
    .all(now - 7 * 86_400_000, dayStart) as TaskRow[];
  const plan = getPlanInfo();
  const unscheduled = new Map(plan.unscheduled.map((u) => [u.taskId, u.minutes]));
  const habits = (db.prepare("SELECT * FROM habits ORDER BY priority, created_at").all() as HabitRow[]).map((h) => ({
    ...publicHabit(h),
    progress: habitProgress(h, now, s.zone, unscheduled),
  }));
  const blocks = db
    .prepare("SELECT * FROM blocks WHERE end >= ? ORDER BY start")
    .all(dayStart) as BlockRow[];
  let calendars: Awaited<ReturnType<typeof listCalendars>> = [];
  let calendarError: string | null = null;
  if (googleConnected()) {
    try {
      calendars = await listCalendars();
    } catch (e) {
      calendarError = (e as Error).message;
    }
  }
  return {
    now,
    tasks: tasks.map(publicTask),
    habits,
    blocks: blocks.map((b) => ({ id: b.id, taskId: b.task_id, start: b.start, end: b.end, status: b.status })),
    hours: getHours(),
    settings: s,
    plan,
    google: {
      configured: googleConfigured(),
      connected: googleConnected(),
      error: googleError() ?? calendarError,
      calendars,
      redirectUri: redirectUri(),
    },
    backup: backupStatus(),
  };
}

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const route = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .catch(next);
};
/** Run a change, replan, and answer with the fresh state. */
const change = (fn: (req: Request) => void) =>
  route(async (req, res) => {
    fn(req);
    await replan();
    res.json(await state());
  });
const id = (req: Request) => int(req.params.id, "id", 1, Number.MAX_SAFE_INTEGER);

app.get("/api/state", route(async (_req, res) => res.json(await state())));
app.post("/api/replan", change(() => {}));

app.post(
  "/api/tasks",
  change((req) => {
    const t = parseTask(req.body ?? {});
    db.prepare(
      "INSERT INTO tasks (title, priority, duration_min, min_chunk_min, blocks, notes, due_date, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(t.title, t.priority, t.duration, t.minChunk, t.blocks, t.notes, t.dueDate, t.tags, Date.now());
  }),
);

app.patch(
  "/api/tasks/:id",
  change((req) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id(req)) as TaskRow | undefined;
    if (!existing) return bad("Task not found.");
    if (existing.habit_id) return bad("This block comes from a habit. Edit the habit instead.");
    const t = parseTask(req.body ?? {}, existing);
    db.prepare(
      "UPDATE tasks SET title = ?, priority = ?, duration_min = ?, min_chunk_min = ?, blocks = ?, notes = ?, due_date = ?, tags = ? WHERE id = ?",
    ).run(t.title, t.priority, t.duration, t.minChunk, t.blocks, t.notes, t.dueDate, t.tags, existing.id);
    touchTask(existing.id);
    if (existing.status === "open" && existing.done_min >= t.duration) finishTask(existing.id);
  }),
);

app.delete("/api/tasks/:id", change((req) => deleteTask(id(req))));
app.post("/api/tasks/:id/done", change((req) => finishTask(id(req))));
app.post("/api/tasks/:id/reopen", change((req) => reopenTask(id(req))));
app.post("/api/blocks/:id/done", change((req) => completeBlock(id(req))));
app.post("/api/blocks/:id/skip", change((req) => skipBlock(id(req))));

app.post("/api/habits", change((req) => void createHabit(parseHabit(req.body ?? {}))));
app.patch(
  "/api/habits/:id",
  change((req) => {
    const existing = getHabit(id(req));
    if (!existing) return bad("Habit not found.");
    updateHabit(existing.id, parseHabit(req.body ?? {}, existing));
  }),
);
app.delete("/api/habits/:id", change((req) => deleteHabit(id(req))));
app.post("/api/habits/:id/pause", change((req) => setHabitActive(id(req), false)));
app.post("/api/habits/:id/resume", change((req) => setHabitActive(id(req), true)));

app.put(
  "/api/hours",
  change((req) => {
    let hours;
    try {
      hours = parseHours(req.body);
    } catch (e) {
      return bad((e as Error).message);
    }
    saveHours(pruneOverrides(hours, Date.now(), getSettings().zone));
  }),
);

app.put(
  "/api/settings",
  change((req) => {
    const b = (req.body ?? {}) as Partial<Settings>;
    const cur = getSettings();
    const zone = String(b.zone ?? cur.zone);
    if (!IANAZone.isValidZone(zone)) bad(`"${zone}" is not a time zone name like America/Los_Angeles.`);
    const next: Settings = {
      zone,
      graceMin: int(b.graceMin ?? cur.graceMin, "Grace period", 0, 720),
      horizonDays: int(b.horizonDays ?? cur.horizonDays, "Days ahead", 1, 60),
      bufferMin: int(b.bufferMin ?? cur.bufferMin, "Gap between blocks", 0, 120),
      reminderMin:
        b.reminderMin === null ? null : int(b.reminderMin ?? cur.reminderMin ?? 0, "Alert", 0, 240),
      busyCalendars: Array.isArray(b.busyCalendars) ? b.busyCalendars.map(String).slice(0, 50) : cur.busyCalendars,
      deadlineCushionHours: int(b.deadlineCushionHours ?? cur.deadlineCushionHours, "Deadline cushion", 0, 336),
    };
    if (next.reminderMin !== cur.reminderMin) db.prepare("UPDATE blocks SET synced = 0 WHERE status = 'planned'").run();
    saveSettings(next);
  }),
);

app.post(
  "/api/google/disconnect",
  change(() => disconnect()),
);

app.post(
  "/api/backup",
  route(async (_req, res) => {
    backupNow();
    res.json(await state());
  }),
);

app.get("/oauth/start", (_req, res) => {
  if (!googleConfigured()) {
    res.status(400).send("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env, then restart.");
    return;
  }
  res.redirect(authUrl());
});

app.get(
  "/oauth/callback",
  route(async (req, res) => {
    if (req.query.error) {
      res.status(400).send(`Google sign-in was cancelled (${String(req.query.error)}). Go back and try again.`);
      return;
    }
    await finishAuth(String(req.query.code ?? ""), String(req.query.state ?? ""));
    await replan();
    res.redirect("/#settings");
  }),
);

app.get("/healthz", (_req, res) => void res.json({ ok: true }));
app.use(express.static(publicDir, { maxAge: 0 }));

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof UserError ? 400 : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message });
});

app.listen(PORT, HOST, () => {
  console.log(`Dayloop is running on http://${HOST}:${PORT}`);
  replan().catch((e) => console.error("Initial plan failed:", e));
});

// Keep a daily copy of the database. Checked on startup and every hour, so a
// machine that was off at the usual time catches up when it comes back.
const backupTick = () => {
  try {
    const made = backupIfDue();
    if (made) console.log(`Backed up to ${made.file}`);
  } catch (e) {
    console.error("Backup failed:", e);
  }
};
backupTick();
setInterval(backupTick, 60 * 60_000);

// The heartbeat: pick up new calendar events and sweep missed blocks.
setInterval(() => replan().catch((e) => console.error("Replan failed:", e)), TICK_MIN * 60_000);
