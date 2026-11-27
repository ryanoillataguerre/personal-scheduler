// Daily copies of the database, written as plain files outside the live data
// folder so that losing one does not lose the other.
import fs from "node:fs";
import path from "node:path";
import { dataDir, db } from "./db.js";

export const backupDir = path.resolve(process.env.BACKUP_DIR || path.join(dataDir, "backups"));
const KEEP = Math.max(1, Number(process.env.BACKUP_KEEP || 14));
const EVERY_MS = 24 * 60 * 60 * 1000;
const NAME = /^dayloop-(\d{8})-(\d{6})\.db$/;

export interface BackupInfo {
  file: string;
  at: number;
  bytes: number;
}

/** Existing backups, newest first. */
export function listBackups(): BackupInfo[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((f) => NAME.test(f))
    .map((file) => {
      const st = fs.statSync(path.join(backupDir, file));
      return { file, at: st.mtimeMs, bytes: st.size };
    })
    .sort((a, b) => b.at - a.at);
}

const stamp = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Write a complete, consistent copy of the database and drop the oldest
 * copies beyond the number to keep. Safe to run while the app is in use.
 */
export function backupNow(now = Date.now()): BackupInfo {
  fs.mkdirSync(backupDir, { recursive: true });
  const file = `dayloop-${stamp(new Date(now))}.db`;
  const target = path.join(backupDir, file);
  const partial = `${target}.partial`;
  fs.rmSync(partial, { force: true });
  // VACUUM INTO takes a snapshot that includes anything still in the write-ahead log.
  db.exec(`VACUUM INTO '${partial.replace(/'/g, "''")}'`);
  fs.renameSync(partial, target);
  fs.utimesSync(target, new Date(now), new Date(now));
  for (const old of listBackups().slice(KEEP)) fs.rmSync(path.join(backupDir, old.file), { force: true });
  return { file, at: now, bytes: fs.statSync(target).size };
}

/** Back up if the newest copy is a day old or there is none. */
export function backupIfDue(now = Date.now()): BackupInfo | null {
  const latest = listBackups()[0];
  if (latest && now - latest.at < EVERY_MS) return null;
  return backupNow(now);
}

export const backupStatus = () => ({ last: listBackups()[0] ?? null, keep: KEEP, dir: backupDir });
