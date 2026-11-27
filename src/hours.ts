// Turns "which hours I work each day" into concrete time windows.
import { DateTime } from "luxon";
import type { Window } from "./scheduler.js";
import { normLoc } from "./scheduler.js";

/** One stretch of workable time on a day. Times are "HH:MM" in local time. */
export interface HourRange {
  start: string;
  end: string;
  /** Where you are for this stretch (e.g. "home"). Empty means untagged. */
  location?: string | null;
}

export interface Hours {
  /** Default week. Keys are ISO weekdays: "1" Monday through "7" Sunday. */
  weekly: Record<string, HourRange[]>;
  /** Specific dates ("YYYY-MM-DD") that replace the default. [] is a day off. */
  overrides: Record<string, HourRange[]>;
}

export const DEFAULT_HOURS: Hours = {
  weekly: {
    "1": [{ start: "09:00", end: "17:00", location: null }],
    "2": [{ start: "09:00", end: "17:00", location: null }],
    "3": [{ start: "09:00", end: "17:00", location: null }],
    "4": [{ start: "09:00", end: "17:00", location: null }],
    "5": [{ start: "09:00", end: "17:00", location: null }],
    "6": [],
    "7": [],
  },
  overrides: {},
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function parseRange(r: unknown): HourRange {
  const o = (r ?? {}) as Record<string, unknown>;
  const start = String(o.start ?? "");
  let end = String(o.end ?? "");
  if (end === "24:00") end = "23:59";
  if (!HHMM.test(start) || !HHMM.test(end)) throw new Error(`Times must be HH:MM, got "${start}"–"${end}"`);
  if (end <= start) throw new Error(`A time range must end after it starts (${start}–${end})`);
  return { start, end, location: normLoc(o.location as string | null) };
}

/** Validate and normalize hours coming from the client. Throws on bad input. */
export function parseHours(raw: unknown): Hours {
  const o = (raw ?? {}) as Record<string, unknown>;
  const weeklyIn = (o.weekly ?? {}) as Record<string, unknown>;
  const overridesIn = (o.overrides ?? {}) as Record<string, unknown>;
  const weekly: Record<string, HourRange[]> = {};
  for (let d = 1; d <= 7; d++) {
    const list = weeklyIn[String(d)];
    weekly[String(d)] = Array.isArray(list) ? list.map(parseRange) : [];
  }
  const overrides: Record<string, HourRange[]> = {};
  for (const [date, list] of Object.entries(overridesIn)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Dates must be YYYY-MM-DD, got "${date}"`);
    overrides[date] = Array.isArray(list) ? list.map(parseRange) : [];
  }
  return { weekly, overrides };
}

/** Drop overrides for dates that have passed so the list does not grow forever. */
export function pruneOverrides(hours: Hours, now: number, zone: string): Hours {
  const today = DateTime.fromMillis(now, { zone }).toISODate()!;
  const overrides: Record<string, HourRange[]> = {};
  for (const [date, list] of Object.entries(hours.overrides)) if (date >= today) overrides[date] = list;
  return { weekly: hours.weekly, overrides };
}

/** Expand hours into concrete windows for `days` days starting today. */
export function expandWindows(hours: Hours, now: number, zone: string, days: number): Window[] {
  const out: Window[] = [];
  const today = DateTime.fromMillis(now, { zone }).startOf("day");
  for (let i = 0; i < days; i++) {
    const day = today.plus({ days: i });
    const date = day.toISODate()!;
    const ranges = hours.overrides[date] ?? hours.weekly[String(day.weekday)] ?? [];
    for (const r of ranges) {
      const [sh, sm] = r.start.split(":").map(Number);
      const [eh, em] = r.end.split(":").map(Number);
      // Building from the calendar date keeps this correct across DST changes.
      const start = day.set({ hour: sh, minute: sm }).toMillis();
      const end = day.set({ hour: eh, minute: em }).toMillis();
      if (end > start) out.push({ start, end, location: normLoc(r.location), day: date });
    }
  }
  return out;
}
