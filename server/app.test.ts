import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Router } from "express";
import { z } from "zod";
import { createApp } from "./app.js";
import { AppError } from "./errors.js";
import type { FeatureModule } from "./modules.js";
import { SourceSync, type SyncContext, type SyncOutcome } from "./sync.js";
import { fakeCommand, startTestServer, tempDir, testServices } from "./test-helpers.js";
import { streamJob } from "./jobs-router.js";

class StubSource extends SourceSync {
  runs = 0;
  configured() { return true; }
  protected async run(_context: SyncContext): Promise<SyncOutcome> { this.runs++; return { items: 2 }; }
}

const noteSchema = z.object({ id: z.string(), text: z.string(), createdAt: z.string(), updatedAt: z.string() });

/** Exercises the module contract: a router, a source, a status entry, a suggestion acceptor and a trash-backed table. */
function demoModule(source: StubSource): FeatureModule {
  return {
    name: "demo",
    setup(ctx) {
      const ideas = ctx.db.personal.docs({
        table: "ideas",
        label: "靈感",
        schema: noteSchema,
        columns: (doc) => ({ archived: 0, pinned: 0, created_at: doc.createdAt }),
      }, ctx.trash);
      const router = Router();
      router.post("/ideas", (req, res) => {
        const { text } = z.object({ text: z.string().min(1).max(100) }).strict().parse(req.body);
        const now = ctx.now().toISOString();
        res.status(201).json(ideas.put({ id: `idea-${ideas.count() + 1}`, text, createdAt: now, updatedAt: now }));
      });
      router.delete("/ideas/:id", (req, res) => {
        const result = ideas.delete(req.params.id);
        if (!result.deleted) throw new AppError(404, "找不到這則靈感。");
        res.json({ undoToken: result.undoToken });
      });
      router.get("/ideas", (_req, res) => { res.json(ideas.list()); });
      router.get("/boom", () => { throw new Error("database password=hunter2hunter2 exploded"); });
      router.get("/unavailable", () => { throw new AppError(503, "來源暫時無法使用 token=ghp_" + "c".repeat(30)); });
      router.post("/job", (_req, res) => {
        const job = ctx.jobs.start({ kind: "daily-brief", title: "今日摘要" }, async (emit) => {
          emit({ type: "stage", stage: "brief", message: "正在整理今日摘要…" });
          return { day: ctx.today() };
        }, { maxRunning: 1 });
        streamJob(res, ctx.jobs, job.id);
      });
      return {
        router,
        sources: [source],
        status: () => ({ ideas: ideas.count() }),
        acceptSuggestion: {
          todo: (suggestion, context) => {
            const now = context.now().toISOString();
            const payload = z.object({ title: z.string() }).parse(suggestion.payload);
            const idea = ideas.put({ id: `from-${suggestion.id}`, text: payload.title, createdAt: now, updatedAt: now });
            return { resultId: idea.id, result: idea };
          },
        },
      };
    },
  };
}

async function setup(t: test.TestContext, options: { fresh?: boolean } = {}) {
  const probes = fakeCommand((call) => {
    const line = [call.executable, ...call.args].join(" ");
    if (line === "claude --version") return "2.1.292 (Claude Code)\n";
    if (line === "claude auth status") return "{}";
    if (line === "gh api user --jq .login") return "Suzu1Dev\n";
    return undefined; // codex missing
  });
  const services = testServices(t, {
    fresh: options.fresh,
    env: { BELLPERSONAL_GOOGLE_CLIENT_ID: "x.apps.googleusercontent.com", BELLPERSONAL_GOOGLE_CLIENT_SECRET: "s" },
    seams: { command: probes.runner, loadCodexCatalog: async () => { throw new AppError(503, "尚未登入 Codex。請在伺服器終端機執行 codex login，完成後重新整理。"); } },
  });
  const source = new StubSource({ id: "github", state: services.syncState });
  const server = await startTestServer(t, services, { modules: [demoModule(source)] });
  return { services, server, source, probes };
}

test("health is minimal and public; status reports CLIs, sources and modules", async (t) => {
  const { server } = await setup(t);
  const health = await server.call("GET", "/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.json.status, "ok");
  assert.equal(health.json.version, "1.0.0");
  assert.equal(health.headers["cache-control"], "no-store");
  assert.ok(health.headers["x-request-id"]);
  const status = await server.call("GET", "/api/status");
  assert.equal(status.status, 200);
  assert.match(status.json.today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(status.json.timeZone, "Asia/Taipei");
  assert.deepEqual(status.json.ai.clis.claude, { installed: true, authenticated: true, version: "2.1.292 (Claude Code)" });
  assert.deepEqual(status.json.ai.clis.codex, { installed: false, authenticated: false });
  assert.deepEqual(status.json.github, { authenticated: true, login: "Suzu1Dev" });
  assert.deepEqual(status.json.ai.settings, { provider: "claude", model: "sonnet", reasoningEffort: "low" });
  assert.deepEqual(status.json.vault, { enabled: true });
  assert.deepEqual(status.json.google, { clientConfigured: true, connected: false });
  assert.equal(status.json.sources[0].id, "github");
  assert.equal(status.json.sources[0].label, "GitHub");
  assert.deepEqual(status.json.modules, { demo: { ideas: 0 } });
  assert.doesNotMatch(status.text, /googleusercontent|"s"/);
});

test("CLI probes are cached for 10 seconds", async (t) => {
  const { server, probes } = await setup(t);
  await server.call("GET", "/api/status");
  const count = probes.calls.length;
  await server.call("GET", "/api/status");
  assert.equal(probes.calls.length, count);
});

test("provider settings: defaults, partial updates validated against the catalog", async (t) => {
  const { server } = await setup(t);
  const initial = await server.call("GET", "/api/settings/provider");
  assert.deepEqual(initial.json.settings, { provider: "claude", model: "sonnet", reasoningEffort: "low" });
  assert.deepEqual(initial.json.catalogs.map((item: { source: string }) => item.source), ["claude", "codex"]);
  assert.match(initial.json.catalogs[1].error, /codex login/);
  const updated = await server.call("PUT", "/api/settings/provider", { body: { model: "haiku", reasoningEffort: "" } });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.json.settings, { provider: "claude", model: "haiku", reasoningEffort: "" });
  assert.equal((await server.call("PUT", "/api/settings/provider", { body: { model: "haiku", reasoningEffort: "high" } })).status, 400);
  assert.equal((await server.call("PUT", "/api/settings/provider", { body: { model: "nope" } })).status, 400);
  assert.equal((await server.call("PUT", "/api/settings/provider", { body: { surprise: true } })).status, 400);
  assert.equal((await server.call("PUT", "/api/settings/provider", { body: { provider: "codex" } })).status, 503);
  assert.equal((await server.call("GET", "/api/settings/provider")).json.settings.model, "haiku");
});

test("app settings: defaults, validated partial updates, unknown keys refused", async (t) => {
  const { server } = await setup(t);
  const initial = await server.call("GET", "/api/settings/app");
  assert.equal(initial.json["brief.autoTime"], "06:30");
  assert.equal(initial.json.theme, "system");
  assert.equal(initial.json["ai.enabled"], true);
  assert.equal(initial.json["mail.retentionDays"], 30);
  assert.equal(initial.json["weather.location"].name, "台北");
  assert.deepEqual(initial.json["sidebar.projectIds"], []);
  const updated = await server.call("PUT", "/api/settings/app", { body: { "brief.autoTime": "07:15", "ai.ideaTags": true, theme: "dark", "mail.schoolDomains": ["NYCU.edu.tw", "ntu.edu.tw"] } });
  assert.equal(updated.status, 200);
  assert.equal(updated.json["brief.autoTime"], "07:15");
  assert.equal(updated.json["ai.ideaTags"], true);
  assert.equal(updated.json.theme, "dark");
  assert.deepEqual(updated.json["mail.schoolDomains"], ["nycu.edu.tw", "ntu.edu.tw"]);
  for (const body of [{ "brief.autoTime": "25:00" }, { unknown: 1 }, {}, { "mail.retentionDays": 0 }, { theme: "blue" }, { "ctftime.minWeight": 101 },
    { "mail.schoolDomains": ["not a domain"] }, { "sidebar.projectIds": ["a", "b", "c", "d", "e", "f"] }, { "brief.time": "07:00" }]) {
    const response = await server.call("PUT", "/api/settings/app", { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(typeof response.json.error, "string");
  }
  assert.equal((await server.call("GET", "/api/settings/app")).json["brief.autoTime"], "07:15");
});

test("初次設定 settings: a new install has no roles, no overrides and completedAt null; each key is validated", async (t) => {
  const { server } = await setup(t, { fresh: true });
  const fresh = (await server.call("GET", "/api/settings/app")).json;
  assert.deepEqual(fresh["profile.roles"], []);
  assert.deepEqual(fresh["features.overrides"], {});
  assert.equal(fresh["onboarding.completedAt"], null);

  const picked = await server.call("PUT", "/api/settings/app", { body: { "profile.roles": ["ctf", "student", "ctf"] } });
  assert.equal(picked.status, 200);
  assert.deepEqual(picked.json["profile.roles"], ["student", "ctf"], "deduplicated, in PROFILE_ROLES order");
  assert.deepEqual((await server.call("PUT", "/api/settings/app", { body: { "profile.roles": [] } })).json["profile.roles"], [], "[] is an answer: only the shared features");

  const overrides = await server.call("PUT", "/api/settings/app", { body: { "features.overrides": { github: true, events: false } } });
  assert.equal(overrides.status, 200);
  assert.deepEqual(overrides.json["features.overrides"], { github: true, events: false });
  const done = await server.call("PUT", "/api/settings/app", { body: { "onboarding.completedAt": "2026-11-10T09:30:00.000+08:00" } });
  assert.equal(done.json["onboarding.completedAt"], "2026-11-10T09:30:00.000+08:00");
  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "onboarding.completedAt": null } })).json["onboarding.completedAt"], null, "null runs 初次設定 again");

  for (const body of [
    { "profile.roles": ["teacher"] }, { "profile.roles": "student" }, { "profile.roles": [1] }, { "profile.roles": null },
    { "profile.roles": ["student", "developer", "ctf", "student", "developer", "ctf", "student"] },
    { "features.overrides": { calendar: true } }, { "features.overrides": { github: "on" } }, { "features.overrides": null }, { "features.overrides": [] },
    { "onboarding.completedAt": "yesterday" }, { "onboarding.completedAt": "2026-11-10" }, { "onboarding.completedAt": 1 },
  ]) {
    const response = await server.call("PUT", "/api/settings/app", { body });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  const after = (await server.call("GET", "/api/settings/app")).json;
  assert.deepEqual([after["profile.roles"], after["features.overrides"], after["onboarding.completedAt"]], [[], { github: true, events: false }, null]);
});

test("sync on open starts stale sources and answers 202 with their status", async (t) => {
  const { server, source } = await setup(t);
  const first = await server.call("POST", "/api/sync", { body: {} });
  assert.equal(first.status, 202);
  assert.deepEqual(first.json.started, ["github"]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(source.runs, 1);
  const second = await server.call("POST", "/api/sync", { body: { sources: ["github"] } });
  assert.deepEqual(second.json.started, [], "a fresh source is not refetched");
  assert.equal(second.json.sources[0].state, "ok");
  assert.equal(second.json.sources[0].items, 2);
  assert.deepEqual((await server.call("POST", "/api/sync", { body: { force: true } })).json.started, ["github"]);
  assert.equal((await server.call("POST", "/api/sync", { body: { sources: ["nope"] } })).status, 400);
});

test("errors map to safe zh-TW messages; unknown API paths are JSON 404s", async (t) => {
  const { server } = await setup(t);
  const zod = await server.call("POST", "/api/demo/ideas", { body: { text: "" } });
  assert.equal(zod.status, 400);
  assert.match(zod.json.error, /^text: 數值過小/, "zod messages use the zh-TW locale");
  const boom = await server.call("GET", "/api/demo/boom");
  assert.equal(boom.status, 500);
  assert.equal(boom.json.error, "操作未完成；請檢查本機服務記錄。");
  const unavailable = await server.call("GET", "/api/demo/unavailable");
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.json.error, /\[REDACTED\]/);
  assert.equal((await server.call("POST", "/api/demo/ideas", { body: "{not json" })).status, 400);
  assert.equal((await server.call("POST", "/api/demo/ideas", { body: { text: "x".repeat(200_000) } })).status, 413);
  const missing = await server.call("GET", "/api/nothing-here");
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error, "找不到 API。");
});

test("a reversible delete returns an undo token that the core restore route honours", async (t) => {
  const { server } = await setup(t);
  const created = await server.call("POST", "/api/demo/ideas", { body: { text: "做一個儀表板" } });
  assert.equal(created.status, 201);
  const removed = await server.call("DELETE", `/api/demo/ideas/${created.json.id}`, { body: {} });
  assert.ok(removed.json.undoToken);
  assert.deepEqual((await server.call("GET", "/api/demo/ideas")).json, []);
  const restored = await server.call("POST", "/api/trash/restore", { body: { token: removed.json.undoToken } });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.restored.id, created.json.id);
  assert.equal((await server.call("GET", "/api/demo/ideas")).json[0].text, "做一個儀表板");
  assert.equal((await server.call("POST", "/api/trash/restore", { body: { token: removed.json.undoToken } })).status, 404);
});

test("suggestions are accepted through the owning module once, or dismissed", async (t) => {
  const { server, services } = await setup(t);
  const todo = services.suggestions.create({ kind: "todo", title: "加入待辦：繳電費", payload: { title: "繳電費" }, dedupeKey: "mail-todo:m1" });
  assert.equal(services.suggestions.create({ kind: "todo", title: "dup", payload: { title: "x" }, dedupeKey: "mail-todo:m1" }).id, todo.id);
  const listed = await server.call("GET", "/api/suggestions?status=pending");
  assert.deepEqual(listed.json.map((item: { id: string }) => item.id), [todo.id]);
  const accepted = await server.call("POST", `/api/suggestions/${todo.id}/accept`, { body: {} });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.suggestion.status, "accepted");
  assert.equal(accepted.json.suggestion.resultId, `from-${todo.id}`);
  assert.equal((await server.call("POST", `/api/suggestions/${todo.id}/accept`, { body: {} })).status, 409);
  const event = services.suggestions.create({ kind: "event", title: "加入行事曆", payload: {} });
  assert.equal((await server.call("POST", `/api/suggestions/${event.id}/accept`, { body: {} })).status, 501);
  assert.equal((await server.call("POST", `/api/suggestions/${event.id}/dismiss`, { body: {} })).json.suggestion.status, "dismissed");
  assert.equal((await server.call("POST", "/api/suggestions/missing/dismiss", { body: {} })).status, 404);
});

test("jobs stream NDJSON, list, replay their outcome and refuse unknown ids", async (t) => {
  const { server } = await setup(t);
  const streamed = await server.call("POST", "/api/demo/job", { body: {} });
  assert.equal(streamed.status, 200);
  assert.match(String(streamed.headers["content-type"]), /application\/x-ndjson/);
  assert.equal(streamed.headers["content-encoding"], undefined, "progress streams are never compressed");
  const lines = streamed.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "job");
  assert.equal(lines[1].type, "stage");
  assert.equal(lines.at(-1).type, "done");
  assert.match(lines.at(-1).result.day, /^\d{4}-\d{2}-\d{2}$/);
  const id = lines[0].id;
  assert.equal((await server.call("GET", "/api/jobs")).json[0].id, id);
  assert.equal((await server.call("GET", `/api/jobs/${id}`)).json.status, "done");
  const replay = await server.call("GET", `/api/jobs/${id}/events?from=1`);
  assert.deepEqual(replay.text.trim().split("\n").map((line) => JSON.parse(line).type), ["job", "done"]);
  assert.equal((await server.call("GET", "/api/jobs/unknown")).status, 404);
  assert.equal((await server.call("DELETE", "/api/jobs/unknown", { body: {} })).status, 404);
});

test("the module registry rejects bad names, duplicates, reserved and colliding mounts", (t) => {
  const services = testServices(t);
  const router = Router();
  const cases: Array<[FeatureModule[], RegExp]> = [
    [[{ name: "Bad Name", setup: () => ({}) }], /Invalid module name/],
    [[{ name: "todos", setup: () => ({}) }, { name: "todos", setup: () => ({}) }], /Duplicate module name/],
    [[{ name: "sneaky", setup: () => ({ router, mountPath: "/api/settings/extra" }) }], /reserved/],
    [[{ name: "outside", setup: () => ({ router, mountPath: "/admin" }) }], /invalid mount path/],
    [[{ name: "one", setup: () => ({ router, mountPath: "/api/x" }) }, { name: "two", setup: () => ({ router, mountPath: "/api/x" }) }], /already mounted/],
    [[{ name: "acc-a", setup: () => ({ acceptSuggestion: { todo: () => ({}) } }) }, { name: "acc-b", setup: () => ({ acceptSuggestion: { todo: () => ({}) } }) }], /already has an acceptor/],
  ];
  for (const [modules, pattern] of cases) assert.throws(() => createApp(services, { modules }), pattern);
});

test("the built frontend is served with immutable assets and an SPA fallback after the API 404", async (t) => {
  const dist = join(tempDir(t), "dist");
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>BELL Personal</title>");
  writeFileSync(join(dist, "assets", "index-abc.js"), "console.log(1)");
  const services = testServices(t);
  const server = await startTestServer(t, services, { staticDirectory: dist });
  const asset = await server.call("GET", "/assets/index-abc.js");
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  const page = await server.call("GET", "/today");
  assert.equal(page.status, 200);
  assert.match(page.text, /BELL Personal/);
  assert.equal(page.headers["cache-control"], "no-cache");
  assert.equal((await server.call("GET", "/api/missing")).status, 404);
  // A lazy route chunk from an older build is a plain 404, not the SPA page with a 200.
  const stale = await server.call("GET", "/assets/TasksPage-old.js");
  assert.equal(stale.status, 404);
  assert.doesNotMatch(stale.text, /BELL Personal/);
  assert.equal(stale.headers["cache-control"], "no-store");
});
