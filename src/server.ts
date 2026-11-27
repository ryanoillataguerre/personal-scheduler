import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DateTime, IANAZone } from "luxon";
import { db, getHours, getSettings, saveHours, saveSettings, type BlockRow, type Settings, type TaskRow } from "./db.js";
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
import { normLoc } from "./scheduler.js";

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
  const location = normLoc((body.location === undefined ? existing?.location : body.location) as string | null);
  const notes = String(body.notes ?? existing?.notes ?? "").slice(0, 2000);
  return { title, duration, priority, minChunk: Math.min(minChunk, duration), location, notes };
}

const publicTask = (t: TaskRow) => ({
  id: t.id,
  title: t.title,
  priority: t.priority,
  durationMin: t.duration_min,
  doneMin: t.done_min,
  minChunkMin: t.min_chunk_min,
  location: t.location,
  notes: t.notes,
  status: t.status,
  missedCount: t.missed_count,
  createdAt: t.created_at,
  completedAt: t.completed_at,
});

async function state() {
  const s = getSettings();
  const now = Date.now();
  const dayStart = DateTime.fromMillis(now, { zone: s.zone }).startOf("day").toMillis();
  const tasks = db
    .prepare("SELECT * FROM tasks WHERE status = 'open' OR completed_at >= ? ORDER BY priority, created_at")
    .all(now - 7 * 86_400_000) as TaskRow[];
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
    blocks: blocks.map((b) => ({ id: b.id, taskId: b.task_id, start: b.start, end: b.end, status: b.status })),
    hours: getHours(),
    settings: s,
    plan: getPlanInfo(),
    google: {
      configured: googleConfigured(),
      connected: googleConnected(),
      error: googleError() ?? calendarError,
      calendars,
      redirectUri: redirectUri(),
    },
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
      "INSERT INTO tasks (title, priority, duration_min, min_chunk_min, location, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(t.title, t.priority, t.duration, t.minChunk, t.location, t.notes, Date.now());
  }),
);

app.patch(
  "/api/tasks/:id",
  change((req) => {
    const existing = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id(req)) as TaskRow | undefined;
    if (!existing) return bad("Task not found.");
    const t = parseTask(req.body ?? {}, existing);
    db.prepare(
      "UPDATE tasks SET title = ?, priority = ?, duration_min = ?, min_chunk_min = ?, location = ?, notes = ? WHERE id = ?",
    ).run(t.title, t.priority, t.duration, t.minChunk, t.location, t.notes, existing.id);
    touchTask(existing.id);
    if (existing.status === "open" && existing.done_min >= t.duration) finishTask(existing.id);
  }),
);

app.delete("/api/tasks/:id", change((req) => deleteTask(id(req))));
app.post("/api/tasks/:id/done", change((req) => finishTask(id(req))));
app.post("/api/tasks/:id/reopen", change((req) => reopenTask(id(req))));
app.post("/api/blocks/:id/done", change((req) => completeBlock(id(req))));
app.post("/api/blocks/:id/skip", change((req) => skipBlock(id(req))));

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
    };
    if (next.reminderMin !== cur.reminderMin) db.prepare("UPDATE blocks SET synced = 0 WHERE status = 'planned'").run();
    saveSettings(next);
  }),
);

app.post(
  "/api/google/disconnect",
  change(() => disconnect()),
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

// The heartbeat: pick up new calendar events and sweep missed blocks.
setInterval(() => replan().catch((e) => console.error("Replan failed:", e)), TICK_MIN * 60_000);
