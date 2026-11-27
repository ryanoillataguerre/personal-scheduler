import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

let dbm: typeof import("../src/db.js");
let backup: typeof import("../src/backup.js");
const HOUR = 3_600_000;
const T0 = Date.parse("2026-12-01T10:00:00Z");

before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dayloop-backup-"));
  process.env.DATA_DIR = path.join(root, "data");
  process.env.BACKUP_DIR = path.join(root, "backups");
  process.env.BACKUP_KEEP = "3";
  dbm = await import("../src/db.js");
  backup = await import("../src/backup.js");
});

test("a backup is a complete, readable copy of the database", () => {
  dbm.db
    .prepare("INSERT INTO tasks (title, priority, duration_min, min_chunk_min, created_at) VALUES ('Taxes', 1, 60, 30, 1)")
    .run();
  dbm.setKv("google.tokens", { refresh_token: "r" });
  const made = backup.backupNow(T0);
  assert.match(made.file, /^dayloop-\d{8}-\d{6}\.db$/);

  const copy = new DatabaseSync(path.join(backup.backupDir, made.file), { readOnly: true });
  const tasks = copy.prepare("SELECT title FROM tasks").all() as { title: string }[];
  const kv = copy.prepare("SELECT key FROM kv").all() as { key: string }[];
  copy.close();
  assert.deepEqual(tasks.map((t) => t.title), ["Taxes"]);
  assert.deepEqual(kv.map((k) => k.key), ["google.tokens"]);
  assert.deepEqual(fs.readdirSync(backup.backupDir), [made.file]); // no partial file left behind
});

test("backs up once a day, not more", () => {
  assert.equal(backup.backupIfDue(T0 + 23 * HOUR), null);
  const next = backup.backupIfDue(T0 + 24 * HOUR);
  assert.ok(next);
  assert.equal(backup.listBackups().length, 2);
  assert.equal(backup.backupStatus().last?.file, next.file);
});

test("keeps only the newest copies", () => {
  for (let day = 2; day <= 5; day++) backup.backupNow(T0 + day * 24 * HOUR);
  const kept = backup.listBackups();
  assert.equal(kept.length, 3);
  assert.equal(kept[0].at, T0 + 5 * 24 * HOUR);
  assert.equal(kept[2].at, T0 + 3 * 24 * HOUR);
});
