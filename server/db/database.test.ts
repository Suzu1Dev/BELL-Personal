import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { tempDir } from "../test-helpers.js";
import { AppDatabase, openDatabases } from "./database.js";
import { PERSONAL_MIGRATIONS, SETTINGS_MIGRATIONS, SOURCES_MIGRATIONS } from "./schema.js";
import { Trash } from "./trash.js";

const todoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  dueDay: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type TodoDoc = z.infer<typeof todoSchema>;
const todo = (id: string, extra: Partial<TodoDoc> = {}): TodoDoc => ({ id, title: `t-${id}`, status: "open", createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z", ...extra });

test("the three databases open with 0700/0600 modes, WAL and secure_delete on sources", (t) => {
  const dir = join(tempDir(t), "data");
  const dbs = openDatabases(dir);
  t.after(() => dbs.close());
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const file of ["personal.sqlite", "sources.sqlite", "settings.sqlite"]) assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600, file);
  assert.equal(dbs.personal.db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
  assert.equal(Number(dbs.sources.db.prepare("PRAGMA secure_delete").get()!.secure_delete), 1);
  assert.equal(dbs.personal.version, PERSONAL_MIGRATIONS.at(-1)!.version);
  assert.equal(dbs.sources.version, SOURCES_MIGRATIONS.at(-1)!.version);
  assert.equal(dbs.settings.version, SETTINGS_MIGRATIONS.at(-1)!.version);
});

test("migration versions are consecutive from 1 in every database", () => {
  for (const steps of [PERSONAL_MIGRATIONS, SOURCES_MIGRATIONS, SETTINGS_MIGRATIONS])
    steps.forEach((step, index) => assert.equal(step.version, index + 1));
});

test("the frozen v1 fixture still opens and reads with the current code", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "personal.sqlite");
  const raw = new DatabaseSync(path);
  raw.exec(readFileSync(new URL("../fixtures/personal.v1.sql", import.meta.url), "utf8"));
  raw.close();
  const db = new AppDatabase({ path, name: "個人資料", migrations: PERSONAL_MIGRATIONS });
  t.after(() => db.close());
  const todos = db.docs({ table: "todos", label: "待辦", schema: todoSchema });
  assert.equal(todos.get("fixture-todo")?.title, "繳電費");
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM habit_logs").get()!.n, 2);
  // Every later step ran on the v1 data, including v4's native assignments table (empty).
  assert.equal(db.version, PERSONAL_MIGRATIONS.at(-1)!.version);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM local_assignments").get()!.n, 0);
});

test("DocTable upserts with derived columns, and reads leniently or strictly", (t) => {
  const db = new AppDatabase({ path: ":memory:", name: "個人資料", migrations: PERSONAL_MIGRATIONS });
  t.after(() => db.close());
  const todos = db.docs({
    table: "todos",
    label: "待辦",
    schema: todoSchema,
    columns: (doc) => ({ status: doc.status, due_day: doc.dueDay ?? null, project_id: null, created_at: doc.createdAt }),
  });
  todos.put(todo("a", { dueDay: "2026-10-13" }));
  todos.put(todo("b"));
  todos.put({ ...todo("a", { dueDay: "2026-10-14" }), title: "renamed" });
  assert.equal(todos.get("a")?.title, "renamed");
  assert.equal(db.db.prepare("SELECT due_day FROM todos WHERE id = 'a'").get()!.due_day, "2026-10-14");
  assert.deepEqual(todos.list({ where: "due_day IS NOT NULL" }).map((item) => item.id), ["a"]);
  assert.equal(todos.count("status = ?", ["open"]), 2);
  assert.throws(() => todos.put({ ...todo("c"), status: "maybe" as "open" }));
  db.db.prepare("INSERT INTO todos (id, json, updated_at, status, created_at) VALUES ('bad', '{not json', 'x', 'open', 'x')").run();
  assert.equal(todos.list().length, 2, "a lenient read skips the unreadable row");
  assert.throws(() => todos.list({ strict: true }), /有一筆待辦資料無法讀取/);
  assert.throws(() => todos.get("bad", { strict: true }), (error: { status?: number }) => error.status === 500);
});

test("delete goes to the trash and the undo token restores it once", (t) => {
  const dir = tempDir(t);
  const trash = new Trash(join(dir, "trash"));
  const db = new AppDatabase({ path: join(dir, "personal.sqlite"), name: "個人資料", migrations: PERSONAL_MIGRATIONS });
  t.after(() => db.close());
  const todos = db.docs({
    table: "todos",
    label: "待辦",
    schema: todoSchema,
    columns: (doc) => ({ status: doc.status, due_day: doc.dueDay ?? null, project_id: null, created_at: doc.createdAt }),
  }, trash);
  todos.put(todo("x/1"));
  const removed = todos.delete("x/1");
  assert.equal(removed.deleted, true);
  assert.ok(removed.undoToken);
  assert.equal(todos.get("x/1"), undefined);
  const files = readdirSync(join(dir, "trash"));
  assert.equal(files.length, 1);
  assert.equal(statSync(join(dir, "trash", files[0])).mode & 0o777, 0o600);
  assert.doesNotMatch(files[0], /\//);
  const restored = trash.restore(removed.undoToken!);
  assert.equal(restored.table, "todos");
  assert.equal(todos.get("x/1")?.title, "t-x/1");
  assert.throws(() => trash.restore(removed.undoToken!), /找不到可復原的資料/);
  assert.throws(() => trash.restore("../../etc/passwd"), /格式不正確/);
  assert.deepEqual(todos.delete("missing"), { deleted: false });
});

test("a restore refuses to overwrite a record that exists again", (t) => {
  const trash = new Trash(null);
  const db = new AppDatabase({ path: ":memory:", name: "個人資料", migrations: PERSONAL_MIGRATIONS });
  t.after(() => db.close());
  const todos = db.docs({ table: "todos", label: "待辦", schema: todoSchema, columns: (doc) => ({ status: doc.status, created_at: doc.createdAt }) }, trash);
  todos.put(todo("a"));
  const { undoToken } = todos.delete("a");
  todos.put(todo("a", { title: "new" }));
  assert.throws(() => trash.restore(undoToken!), (error: { status?: number }) => error.status === 409);
  assert.equal(todos.get("a")?.title, "new");
});

test("transactions roll back on error and nest", (t) => {
  const db = new AppDatabase({ path: ":memory:", name: "設定", migrations: SETTINGS_MIGRATIONS });
  t.after(() => db.close());
  assert.throws(() => db.transaction(() => {
    db.db.prepare("INSERT INTO app_settings (key, json, updated_at) VALUES ('a', '1', 'x')").run();
    db.transaction(() => db.db.prepare("INSERT INTO app_settings (key, json, updated_at) VALUES ('b', '1', 'x')").run());
    throw new Error("stop");
  }), /stop/);
  assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM app_settings").get()!.n, 0);
});

test("CTFtime became opt-in: a settings database that tuned it keeps it on, a fresh one starts off", (t) => {
  const dir = tempDir(t);
  const open = (name: string, steps: typeof SETTINGS_MIGRATIONS) => new AppDatabase({ path: join(dir, name), name: "設定", migrations: steps });
  const enabled = (db: AppDatabase) => db.db.prepare("SELECT json FROM app_settings WHERE key = 'ctftime.enabled'").get()?.json;

  const tuned = open("tuned.sqlite", SETTINGS_MIGRATIONS.slice(0, 2));
  tuned.db.prepare("INSERT INTO app_settings (key, json, updated_at) VALUES ('ctftime.minWeight', '0', 'x')").run();
  tuned.close();
  const upgraded = open("tuned.sqlite", SETTINGS_MIGRATIONS);
  t.after(() => upgraded.close());
  assert.equal(enabled(upgraded), "true");

  const explicit = open("off.sqlite", SETTINGS_MIGRATIONS.slice(0, 2));
  explicit.db.prepare("INSERT INTO app_settings (key, json, updated_at) VALUES ('ctftime.enabled', 'false', 'x')").run();
  explicit.close();
  const kept = open("off.sqlite", SETTINGS_MIGRATIONS);
  t.after(() => kept.close());
  assert.equal(enabled(kept), "false", "an explicit choice is never overwritten");

  const fresh = open("fresh.sqlite", SETTINGS_MIGRATIONS);
  t.after(() => fresh.close());
  assert.equal(enabled(fresh), undefined);
});

test("a long-lived process prunes expired trash copies when it writes new ones, not only at boot", (t) => {
  const dir = tempDir(t);
  let now = new Date();
  const trash = new Trash(join(dir, "trash"), () => now);
  const old = trash.put("todos", "a", "{}");
  now = new Date(now.getTime() + 31 * 86_400_000);
  trash.put("todos", "b", "{}");
  const files = readdirSync(join(dir, "trash"));
  assert.equal(files.length, 1, "the 31-day-old copy is gone without a restart");
  assert.ok(!files.includes(`${old}.json`));
});
