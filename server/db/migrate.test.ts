import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tempDir } from "../test-helpers.js";
import { migrate, pruneMigrationCopies, type Migration } from "./migrate.js";

const steps: Migration[] = [
  { version: 1, up: (db) => db.exec("CREATE TABLE notes (id TEXT PRIMARY KEY)") },
  { version: 2, up: (db) => db.exec("ALTER TABLE notes ADD COLUMN title TEXT") },
];

test("migrations run once, in order, and record user_version", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(migrate(db, "測試", steps), 2);
  assert.equal(migrate(db, "測試", steps), 2);
  assert.equal(Number(db.prepare("PRAGMA user_version").get()!.user_version), 2);
  db.prepare("INSERT INTO notes (id, title) VALUES ('a', 'b')").run();
});

test("a database newer than this build is refused", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA user_version = 5");
  assert.throws(() => migrate(db, "個人資料", steps), /個人資料 資料庫版本 5 比這個 BELL 版本支援的 2 新/);
});

test("a failing step rolls back and leaves the version unchanged", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, "測試", steps.slice(0, 1));
  assert.throws(() => migrate(db, "測試", [...steps.slice(0, 1), { version: 2, up: (d) => { d.exec("CREATE TABLE half (id TEXT)"); throw new Error("boom"); } }]), /boom/);
  assert.equal(Number(db.prepare("PRAGMA user_version").get()!.user_version), 1);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
});

test("upgrading existing data first writes a .before-v copy", (t) => {
  const path = join(tempDir(t), "x.sqlite");
  const db = new DatabaseSync(path);
  migrate(db, "測試", steps.slice(0, 1), path);
  assert.equal(existsSync(`${path}.before-v1`), false, "a brand-new database needs no copy");
  migrate(db, "測試", steps, path);
  assert.equal(existsSync(`${path}.before-v2`), true);
  db.close();
});

test("pre-migration copies are removed once they are 30 days old (backups copy the data directory)", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "x.sqlite");
  const db = new DatabaseSync(path);
  migrate(db, "測試", steps.slice(0, 1), path);
  migrate(db, "測試", steps, path);
  db.close();
  assert.equal(pruneMigrationCopies(dir, new Date(Date.now() + 29 * 86_400_000)), 0);
  assert.equal(existsSync(`${path}.before-v2`), true);
  assert.equal(pruneMigrationCopies(dir, new Date(Date.now() + 31 * 86_400_000)), 1);
  assert.equal(existsSync(`${path}.before-v2`), false);
  assert.equal(existsSync(path), true, "the database itself stays");
});
