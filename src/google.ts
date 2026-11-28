// Google Calendar: sign-in, reading busy time, and writing blocks as events.
//
// Scopes are deliberately narrow. Dayloop can read when you are busy and can
// manage the one calendar it creates. It cannot read or change your own events.
import { calendar as gcal, type calendar_v3 } from "@googleapis/calendar";
import { OAuth2Client, type Credentials } from "google-auth-library";
import crypto from "node:crypto";
import { db, delKv, getKv, getSettings, setKv, type BlockRow, type TaskRow } from "./db.js";
import type { Interval } from "./scheduler.js";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created", // create and manage Dayloop's own calendar
  "https://www.googleapis.com/auth/calendar.freebusy", // see when you are busy, not what the events are
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly", // list calendars to choose from
];

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const BASE_URL = (process.env.BASE_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, "");
const CALENDAR_NAME = process.env.CALENDAR_NAME || "Dayloop";

export const googleConfigured = () => CLIENT_ID !== "" && CLIENT_SECRET !== "";
export const googleConnected = () => googleConfigured() && getKv<Credentials | null>("google.tokens", null) !== null;
export const redirectUri = () => `${BASE_URL}/oauth/callback`;

let lastError: string | null = null;
export const googleError = () => lastError;

const pendingStates = new Set<string>();

function client(): OAuth2Client {
  const c = new OAuth2Client({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: redirectUri() });
  const tokens = getKv<Credentials | null>("google.tokens", null);
  if (tokens) c.setCredentials(tokens);
  // Google sends the refresh token only once, so merge instead of replacing.
  c.on("tokens", (t) => setKv("google.tokens", { ...getKv<Credentials>("google.tokens", {}), ...t }));
  return c;
}

const api = () => gcal({ version: "v3", auth: client() });

export function authUrl(): string {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.add(state);
  return client().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES, state });
}

export async function finishAuth(code: string, state: string): Promise<void> {
  if (!pendingStates.delete(state)) throw new Error("Sign-in link expired. Start again from Settings.");
  const c = client();
  const { tokens } = await c.getToken(code);
  setKv("google.tokens", { ...getKv<Credentials>("google.tokens", {}), ...tokens });
  lastError = null;
}

export function disconnect(): void {
  delKv("google.tokens");
  delKv("google.calendarId");
  // Events already on the calendar stay there; local blocks forget them.
  db.prepare("UPDATE blocks SET event_id = NULL, synced = 0").run();
  db.prepare("DELETE FROM pending_deletes").run();
  lastError = null;
}

function describe(e: unknown): string {
  const err = e as { message?: string; response?: { data?: { error?: unknown; error_description?: string } } };
  const data = err.response?.data;
  if (data?.error === "invalid_grant") {
    return "Google sign-in expired. Reconnect in Settings. If this happens weekly, the Google Cloud app is still in Testing: publish it.";
  }
  return data?.error_description || err.message || String(e);
}

const statusOf = (e: unknown) => (e as { code?: number; status?: number }).code ?? (e as { status?: number }).status;

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
}

export async function listCalendars(): Promise<CalendarInfo[]> {
  const res = await api().calendarList.list({ minAccessRole: "freeBusyReader", maxResults: 250 });
  const own = getKv<string | null>("google.calendarId", null);
  return (res.data.items ?? [])
    .filter((c) => c.id && c.id !== own)
    .map((c) => ({ id: c.id!, name: c.summaryOverride || c.summary || c.id!, primary: !!c.primary }));
}

async function ensureCalendar(): Promise<string> {
  const existing = getKv<string | null>("google.calendarId", null);
  if (existing) return existing;
  const res = await api().calendars.insert({
    requestBody: { summary: CALENDAR_NAME, timeZone: getSettings().zone },
  });
  const id = res.data.id!;
  setKv("google.calendarId", id);
  return id;
}

let busyCache: Interval[] = [];

/** Busy time from the calendars you chose. Falls back to the last good answer. */
export async function fetchBusy(from: number, to: number): Promise<Interval[]> {
  if (!googleConnected()) return [];
  try {
    const ids = getSettings().busyCalendars;
    if (ids.length === 0) return (busyCache = []);
    const res = await api().freebusy.query({
      requestBody: {
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        items: ids.map((id) => ({ id })),
      },
    });
    const out: Interval[] = [];
    for (const cal of Object.values(res.data.calendars ?? {})) {
      for (const b of cal.busy ?? []) {
        if (b.start && b.end) out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
      }
    }
    lastError = null;
    busyCache = out;
    return out;
  } catch (e) {
    lastError = describe(e);
    return busyCache.filter((b) => b.end > from);
  }
}

function eventBody(block: BlockRow, task: TaskRow): calendar_v3.Schema$Event {
  const s = getSettings();
  const lines = [`Priority ${task.priority}`, `${task.done_min} of ${task.duration_min} min done`];
  if (task.due_date) lines.push(`Due ${task.due_date}`);
  if (task.tags) lines.push(`Tags: ${task.tags.split(",").join(", ")}`);
  if (task.notes) lines.push("", task.notes);
  return {
    summary: (block.status === "done" ? "✓ " : "") + task.title,
    description: lines.join("\n"),
    start: { dateTime: new Date(block.start).toISOString() },
    end: { dateTime: new Date(block.end).toISOString() },
    reminders:
      s.reminderMin === null || block.status === "done"
        ? { useDefault: false, overrides: [] }
        : { useDefault: false, overrides: [{ method: "popup", minutes: s.reminderMin }] },
    extendedProperties: { private: { dayloopBlock: String(block.id), dayloopTask: String(task.id) } },
  };
}

/** Push local changes to Google: delete removed blocks, create or update the rest. */
export async function syncEvents(): Promise<void> {
  if (!googleConnected()) return;
  try {
    const cal = api();
    const calendarId = await ensureCalendar();

    const deletes = db.prepare("SELECT event_id FROM pending_deletes").all() as { event_id: string }[];
    for (const d of deletes) {
      try {
        await cal.events.delete({ calendarId, eventId: d.event_id });
      } catch (e) {
        const code = statusOf(e);
        if (code !== 404 && code !== 410) throw e; // already gone is fine
      }
      db.prepare("DELETE FROM pending_deletes WHERE event_id = ?").run(d.event_id);
    }

    const dirty = db
      .prepare("SELECT * FROM blocks WHERE synced = 0 ORDER BY start")
      .all() as BlockRow[];
    const getTask = db.prepare("SELECT * FROM tasks WHERE id = ?");
    const markSynced = db.prepare("UPDATE blocks SET event_id = ?, synced = 1 WHERE id = ?");
    for (const b of dirty) {
      const task = getTask.get(b.task_id) as TaskRow | undefined;
      if (!task) continue;
      const requestBody = eventBody(b, task);
      let eventId = b.event_id;
      if (eventId) {
        try {
          await cal.events.patch({ calendarId, eventId, requestBody });
        } catch (e) {
          const code = statusOf(e);
          if (code !== 404 && code !== 410) throw e;
          eventId = null; // deleted by hand in the calendar: recreate it
        }
      }
      if (!eventId) {
        const res = await cal.events.insert({ calendarId, requestBody });
        eventId = res.data.id!;
      }
      // The block may have been replanned away while we were talking to Google.
      const still = db.prepare("SELECT id FROM blocks WHERE id = ?").get(b.id);
      if (still) markSynced.run(eventId, b.id);
      else db.prepare("INSERT OR IGNORE INTO pending_deletes (event_id) VALUES (?)").run(eventId);
    }
    lastError = null;
  } catch (e) {
    lastError = describe(e);
  }
}
