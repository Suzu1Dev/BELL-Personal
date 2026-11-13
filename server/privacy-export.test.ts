import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDatabases } from "./db/database.js";
import { PERSONAL_MIGRATIONS, SETTINGS_MIGRATIONS } from "./db/schema.js";
import { migrate } from "./db/migrate.js";
import { AppSettingsStore } from "./stores/app-settings.js";
import { startTestServer, tempDir, testServices } from "./test-helpers.js";

const OWNER = { "tailscale-user-login": "alice@github" };

test("/privacy is a static zh-TW policy with an English summary, public like health", async (t) => {
  const services = testServices(t, { env: { BELLPERSONAL_TAILSCALE_USERS: "alice@github" } });
  const server = await startTestServer(t, services);
  const page = await server.call("GET", "/privacy");
  assert.equal(page.status, 200, "no Tailscale login needed");
  assert.match(String(page.headers["content-type"]), /^text\/html/);
  assert.match(page.headers["content-security-policy"] as string, /script-src 'self'/);
  assert.match(page.text, /<html lang="zh-Hant">/);
  assert.match(page.text, /<link rel="stylesheet" href="\/privacy.css">/);
  assert.doesNotMatch(page.text, /<script|style=/, "no scripts, no inline styles");
  for (const required of [
    "隱私權政策", "gmail.modify", "calendar.readonly", "calendar.events", "openid", "有限使用", "Limited Use",
    "Google API Services User Data Policy", "https://developers.google.com/terms/api-services-user-data-policy",
    "30 天", "AES-256-GCM", "Claude Code", "Codex", "不會使用 Google 使用者資料來開發、改進或訓練", "不出售",
    "中斷連線", "https://myaccount.google.com/connections", "suzu1dev@gmail.com", "English summary", "2026 年 10 月 15 日",
    "自動備份最多保留約 5 週", "更新前的備份保留 30 天", "從信件產生、還沒確認的 AI 建議",
    // SPEC-mail-assignments §8: trash, archived mail and search.
    "移到垃圾桶", "也不會永久刪除信件", "暫存在伺服器記憶體中最多 5 分鐘", "搜尋文字也不會被記錄", "kept only in server memory for up to five minutes",
    // SPEC-mail-html §7: the original layout and remote images.
    "原始版面", "不保存 HTML", "不能執行程式的隔離框架", "外部圖片預設不載入", "由這台伺服器代為下載", "一次下載整封信的圖片",
    "寄件者看不到擁有者的裝置、瀏覽器或 Cookie", "會看到這台伺服器所在網路的 IP 位址", "也會知道信在何時被打開",
    "已知的追蹤像素不會載入", "它的請求已經送到寄件者", "圖片網址也不會被記錄", "信任的寄件者", "HTML is never stored",
    "fetched by the owner's server, never by the browser", "the sender sees the server's network address", "known tracking pixels are not loaded",
    // The reader's 用 AI 處理: what it sends, and that the result is a suggestion.
    "按下「用 AI 處理」", "看起來含有密碼或驗證碼的信不會送出", "when the owner taps “用 AI 處理”",
  ]) assert.ok(page.text.includes(required), required);
  assert.doesNotMatch(page.text, /也不載入信件中的遠端圖片/, "the old promise is gone");
  // A self-hosted server's requests come from the owner's own connection: no promise that hides the IP address.
  assert.doesNotMatch(page.text, /看不到擁有者的 IP 位址|追蹤像素一律不載入|tracking pixels are never loaded/);
  const css = await server.call("GET", "/privacy.css");
  assert.equal(css.status, 200);
  assert.match(String(css.headers["content-type"]), /^text\/css/);
  assert.match(css.text, /--canvas:/, "styled from the app tokens");
  assert.match(css.text, /prefers-color-scheme:dark/);
  // Everything else still needs the owner's login.
  assert.equal((await server.call("GET", "/api/status")).status, 403);
  assert.equal((await server.call("GET", "/api/export")).status, 403);
  assert.equal((await server.call("POST", "/privacy", { body: {} })).status, 403);
});

test("/api/export downloads personal tables and settings, never the vault; sources only on request", async (t) => {
  const services = testServices(t, { env: { BELLPERSONAL_TAILSCALE_USERS: "alice@github" } });
  const server = await startTestServer(t, services);
  const now = "2026-10-12T00:00:00.000Z";
  services.db.personal.db.prepare("INSERT INTO todos (id, json, updated_at, status, due_day, project_id, created_at) VALUES (?, ?, ?, 'open', NULL, NULL, ?)")
    .run("t1", JSON.stringify({ id: "t1", title: "繳電費", status: "open" }), now, now);
  services.db.personal.db.prepare("INSERT INTO habit_logs (habit_id, day, count, note, created_at, updated_at) VALUES ('h1', '2026-10-12', 1, NULL, ?, ?)").run(now, now);
  services.itemState.record({ itemId: "gmail:m1", kind: "mail.action", action: "read", title: "通知", closes: true, state: { state: "handled" } });
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: "m1", value: { id: "m1", subject: "secret subject" } }]);
  await services.vault.set("google.oauth", { refreshToken: "1//never-exported" });
  services.settings.update({ theme: "dark" });

  const response = await server.call("GET", "/api/export", { headers: OWNER });
  assert.equal(response.status, 200);
  assert.match(String(response.headers["content-disposition"]), /^attachment; filename="bell-personal-export-\d{4}-\d{2}-\d{2}\.json"$/);
  assert.equal(response.headers["cache-control"], "no-store");
  const body = response.json;
  assert.equal(body.format, "bell-personal-export");
  assert.equal(body.version, 1);
  assert.deepEqual(body.personal.todos, [{ id: "t1", title: "繳電費", status: "open" }]);
  assert.equal(body.personal.habit_logs[0].habit_id, "h1");
  assert.equal(body.personal.action_log[0].item_id, "gmail:m1");
  assert.ok(Array.isArray(body.personal.item_state));
  assert.ok(["projects", "habits", "ideas", "manual_events", "daily_briefs"].every((table) => Array.isArray(body.personal[table])));
  assert.equal(body.settings.app.theme, "dark");
  assert.equal(body.settings.provider.provider, "claude");
  assert.equal(body.schema.personal, PERSONAL_MIGRATIONS.at(-1)!.version);
  assert.equal(body.sources, undefined);
  assert.doesNotMatch(response.text, /never-exported|secret subject/);

  const withSources = await server.call("GET", "/api/export?include=sources", { headers: OWNER });
  assert.equal(withSources.json.sources.source_items[0].value.subject, "secret subject");
  assert.equal(withSources.json.sources.source_items[0].source, "gmail");
  assert.doesNotMatch(withSources.text, /never-exported/);
  assert.equal((await server.call("GET", "/api/export?include=vault", { headers: OWNER })).status, 400);
});

test("settings v2 renames brief.time and events.ctftime and retires the old Today keys", (t) => {
  const dir = tempDir(t);
  const path = join(dir, "settings.sqlite");
  const raw = new DatabaseSync(path);
  migrate(raw, "設定", SETTINGS_MIGRATIONS.slice(0, 1));
  const put = raw.prepare("INSERT INTO app_settings (key, json, updated_at) VALUES (?, ?, 'x')");
  put.run("brief.time", JSON.stringify("07:10"));
  put.run("events.ctftime", "false");
  put.run("brief.enabled", "false");
  put.run("today.widgetOrder", JSON.stringify(["mail"]));
  put.run("mail.retentionDays", "14");
  raw.close();
  const dbs = openDatabases(dir);
  t.after(() => dbs.close());
  assert.equal(dbs.settings.version, SETTINGS_MIGRATIONS.at(-1)!.version);
  assert.ok(existsSync(`${path}.before-v2`), "a copy is kept before changing existing data");
  const settings = new AppSettingsStore(dbs.settings).get();
  assert.equal(settings["brief.autoTime"], "07:10");
  assert.equal(settings["ctftime.enabled"], false);
  assert.equal(settings["mail.retentionDays"], 14);
  const keys = dbs.settings.db.prepare("SELECT key FROM app_settings ORDER BY key").all().map((row) => row.key);
  assert.deepEqual(keys, ["brief.autoTime", "ctftime.enabled", "mail.retentionDays"]);
});

test("personal v2 upgrades the frozen v1 fixture with the Today state tables", (t) => {
  const dir = tempDir(t);
  const raw = new DatabaseSync(join(dir, "personal.sqlite"));
  raw.exec(readFileSync(new URL("./fixtures/personal.v1.sql", import.meta.url), "utf8"));
  raw.close();
  const dbs = openDatabases(dir);
  t.after(() => dbs.close());
  assert.equal(dbs.personal.version, PERSONAL_MIGRATIONS.at(-1)!.version, "every later step runs on the v1 fixture too");
  const tables = dbs.personal.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => row.name);
  assert.ok(tables.includes("item_state") && tables.includes("action_log"));
  assert.ok(tables.includes("event_feeds"), "v3: feed subscriptions");
  assert.ok(tables.includes("local_assignments"), "v4: assignments from mail or added by hand");
  assert.equal(dbs.personal.db.prepare("SELECT COUNT(*) AS n FROM todos").get()!.n, 1, "v1 data survives");
});
