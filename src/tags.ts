// Tags: free-form labels on tasks and habits. They organize and filter; they
// have no effect on scheduling.

const MAX_TAGS = 12;
const MAX_LENGTH = 30;

/**
 * Normalize a list of tags. Accepts an array or the comma-separated form the
 * database stores. Tags are lower-cased so "Job hunt" and "job hunt" are one
 * tag; returns them sorted and unique.
 */
export function normTags(v: unknown): string[] {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  const clean = list
    .map((x) => String(x).replace(/,/g, " ").replace(/^#+/, "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_LENGTH).trim())
    .filter((x) => x !== "");
  return [...new Set(clean)].sort().slice(0, MAX_TAGS);
}

/** The stored form: comma-separated, or null when there are none. */
export const storeTags = (tags: string[]): string | null => tags.join(",") || null;
