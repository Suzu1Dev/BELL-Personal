import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { FEATURE_IDS, hiddenModules, isSectionVisible, PROFILE_ROLES, visibleFeatures } from "../shared/profile.js";
import type { EventsResponse } from "../shared/events.js";
import type { TodayPayload } from "../shared/today.js";
import { seedDemo } from "../scripts/seed-demo.js";
import { openDatabases } from "./db/database.js";
import { calendarModule } from "./features/calendar/index.js";
import { captureModule } from "./features/capture/index.js";
import { calendarService } from "./features/calendar/store.js";
import { briefData } from "./features/brief/generate.js";
import { eventsModule } from "./features/events/index.js";
import { projectsModule } from "./features/projects/index.js";
import { migrateLegacyOnboarding } from "./onboarding.js";
import { VAULT_FILE } from "./secrets/vault.js";
import { createServices, type CoreServices } from "./services.js";
import { startTestServer, tempDir, testConfig, testServices } from "./test-helpers.js";

/**
 * 初次設定 L1 (design/v3/onboarding/04-IMPLEMENTATION.md): the one-time
 * legacy migration and the acceptance checks that need a whole database.
 */

const NOW = new Date("2026-10-12T00:42:00.000Z"); // 08:42 in Asia/Taipei
const SIDEBAR = ["today", "inbox", "calendar", "tasks", "work", "events", "ideas", "habits", "settings"];
const stamp = NOW.toISOString();
/** Every feature on by hand: an old install whose inferred roles own none of them still shows them all. */
const ALL_ON = Object.fromEntries(FEATURE_IDS.map((feature) => [feature, true]));
const SHOWN_BEFORE = visibleFeatures(null);

/** Services on an empty database: what a new install, or a build from before 初次設定, starts with. */
function blank(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  return testServices(t, { fresh: true, env, seams: { now: () => NOW } });
}

const insert = (services: CoreServices, sql: string, ...params: (string | number)[]) => services.db.personal.db.prepare(sql).run(...params);
const appSettings = (services: CoreServices) => {
  const all = services.settings.get();
  return { roles: all["profile.roles"], overrides: all["features.overrides"], completedAt: all["onboarding.completedAt"] };
};

test("a new install: roles [], overrides {} and completedAt null over GET /api/settings/app, and the marker makes it run once", async (t) => {
  const services = blank(t);
  // Rows a server writes on its own just by running (a weather sync, a rule brief) are not user data.
  services.syncState.save("weather", { state: "ok", lastSyncedAt: stamp });
  insert(services, "INSERT INTO daily_briefs (id, json, updated_at, source) VALUES ('2026-10-12', '{}', ?, 'rule')", stamp);
  assert.deepEqual(await migrateLegacyOnboarding(services), { outcome: "fresh" });
  const server = await startTestServer(t, services);
  const settings = (await server.call("GET", "/api/settings/app")).json;
  assert.deepEqual([settings["profile.roles"], settings["features.overrides"], settings["onboarding.completedAt"]], [[], {}, null]);
  assert.equal(services.db.settings.db.prepare("SELECT json FROM app_settings WHERE key = 'onboarding.completedAt'").get()?.json, "null", "the marker row is written");

  // Data the user adds after this, even an LMS connection, never re-runs it: 初次設定 answers instead.
  await services.vault.set("moodle.token", { token: "t", baseUrl: "https://e3p.nycu.edu.tw" });
  insert(services, "INSERT INTO todos (id, json, updated_at, status, created_at) VALUES ('todo-1', '{}', ?, 'open', ?)", stamp, stamp);
  assert.deepEqual(await migrateLegacyOnboarding(services), { outcome: "already" });
  assert.deepEqual(appSettings(services), { roles: [], overrides: {}, completedAt: null });
});

test("an old database with LMS and CTFtime data: roles [student, ctf], completedAt set, no 初次設定 and the same sidebar; it runs once", async (t) => {
  // The demo database as a build from before 初次設定 wrote it: no roles, overrides or completedAt, no GitHub.
  const dir = tempDir(t);
  const config = testConfig(dir);
  const db = openDatabases(config.dataDir);
  seedDemo(db, { now: NOW, timeZone: "Asia/Taipei" });
  db.settings.db.prepare("DELETE FROM app_settings WHERE key IN ('profile.roles', 'features.overrides', 'onboarding.completedAt')").run();
  db.sources.db.prepare("DELETE FROM source_items WHERE source = 'github'").run();
  db.sources.db.prepare("DELETE FROM sync_state WHERE source = 'github'").run();
  db.close();
  let clock = NOW;
  const services = createServices(config, { now: () => clock, fetch: async () => { throw new Error("no network in tests"); } });
  t.after(() => services.close());
  const before = SIDEBAR.filter((section) => isSectionVisible(section, null));

  const migrated = await migrateLegacyOnboarding(services);
  assert.deepEqual(migrated, { outcome: "migrated", roles: ["student", "ctf"], overrides: { github: true }, completedAt: stamp });
  assert.deepEqual(appSettings(services), { roles: ["student", "ctf"], overrides: { github: true }, completedAt: stamp });
  const after = appSettings(services);
  assert.deepEqual(SIDEBAR.filter((section) => isSectionVisible(section, after.roles, after.overrides)), before, "the sidebar shows what it showed before the upgrade");
  assert.deepEqual(visibleFeatures(after.roles, after.overrides), SHOWN_BEFORE, "and so does every feature, GitHub included");

  // Later starts leave it alone, even once the user has changed it.
  clock = new Date("2026-10-13T00:00:00.000Z");
  services.settings.update({ "profile.roles": ["ctf"] });
  assert.deepEqual(await migrateLegacyOnboarding(services), { outcome: "already" });
  assert.deepEqual(appSettings(services), { roles: ["ctf"], overrides: { github: true }, completedAt: stamp });
});

test("each connection implies its role: an LMS token in the vault, a GitHub login, CTFtime switched on", async (t) => {
  const lms = blank(t);
  await lms.vault.set("canvas.token", { token: "t", baseUrl: "https://canvas.example.edu" });
  assert.deepEqual(await migrateLegacyOnboarding(lms), { outcome: "migrated", roles: ["student"], overrides: { github: true, events: true }, completedAt: stamp });

  const github = blank(t);
  github.syncState.save("github", { state: "ok", cursor: JSON.stringify({ login: "octocat" }), lastSyncedAt: stamp });
  assert.deepEqual(await migrateLegacyOnboarding(github), { outcome: "migrated", roles: ["developer"], overrides: { assignments: true, timetable: true, events: true }, completedAt: stamp });

  // A GitHub cursor without a login (gh never answered) is not a connection; CTFtime switched off is not one either.
  const neither = blank(t);
  neither.syncState.save("github", { state: "error", cursor: JSON.stringify({}), lastError: "gh: not logged in" });
  neither.settings.update({ "ctftime.enabled": false });
  assert.deepEqual(await migrateLegacyOnboarding(neither), { outcome: "migrated", roles: [], overrides: ALL_ON, completedAt: stamp }, "a setting saved is an existing install");

  const ctf = blank(t);
  ctf.settings.update({ "ctftime.enabled": true });
  assert.deepEqual(await migrateLegacyOnboarding(ctf), { outcome: "migrated", roles: ["ctf"], overrides: { assignments: true, timetable: true, projects: true, github: true }, completedAt: stamp });

  // CTFtime was on by default before 初次設定 (no row): a 要參加 the user gave a CTF counts, an untouched default does not.
  const decided = blank(t);
  insert(decided, "INSERT INTO action_log (id, day, item_id, kind, action, at, updated_at) VALUES ('act-1', '2026-10-11', 'ctftime:2846', 'event.decide', 'attend', ?, ?)", stamp, stamp);
  assert.deepEqual(await migrateLegacyOnboarding(decided), { outcome: "migrated", roles: ["ctf"], overrides: { assignments: true, timetable: true, projects: true, github: true }, completedAt: stamp });
  const undone = blank(t);
  insert(undone, "INSERT INTO action_log (id, day, item_id, kind, action, at, undone, updated_at) VALUES ('act-1', '2026-10-11', 'ctftime:2846', 'event.decide', 'attend', ?, 1, ?)", stamp, stamp);
  assert.deepEqual(await migrateLegacyOnboarding(undone), { outcome: "migrated", roles: [], overrides: ALL_ON, completedAt: stamp }, "an undone action is not a choice");

  const assignments = blank(t);
  insert(assignments, "INSERT INTO local_assignments (id, json, updated_at, origin, created_at) VALUES ('a1', '{}', ?, 'manual', ?)", stamp, stamp);
  assert.equal(((await migrateLegacyOnboarding(assignments)) as { roles: string[] }).roles.join(), "student", "assignments the user typed in");
});

test("CTFtime on by the old default stays on after the upgrade, switched off stays off, and a new install starts with it off", async (t) => {
  const ctftimeRow = (services: CoreServices) => services.db.settings.db.prepare("SELECT json FROM app_settings WHERE key = 'ctftime.enabled'").get()?.json;
  /** The demo database as a build from before 初次設定 wrote it, CTFtime contests cached, with `ctftime` as its switch row (undefined: none). */
  const upgraded = async (ctftime: string | undefined) => {
    const config = testConfig(tempDir(t));
    const db = openDatabases(config.dataDir);
    seedDemo(db, { now: NOW, timeZone: "Asia/Taipei" });
    db.settings.db.prepare("DELETE FROM app_settings WHERE key IN ('profile.roles', 'features.overrides', 'onboarding.completedAt', 'ctftime.enabled')").run();
    if (ctftime !== undefined) db.settings.db.prepare("INSERT INTO app_settings (key, json, updated_at) VALUES ('ctftime.enabled', ?, ?)").run(ctftime, stamp);
    db.close();
    const services = createServices(config, { now: () => NOW, fetch: async () => { throw new Error("no network in tests"); } });
    t.after(() => services.close());
    const migration = await migrateLegacyOnboarding(services);
    const server = await startTestServer(t, services, { modules: [calendarModule, eventsModule] });
    t.after(() => calendarService(services).dropPending());
    const today = (await server.call("GET", "/api/today")).json as TodayPayload;
    const events = (await server.call("GET", "/api/events")).json as EventsResponse;
    return {
      migration: migration.outcome,
      enabled: services.settings.value("ctftime.enabled"),
      row: ctftimeRow(services),
      queue: today.queue.flatMap((group) => group.items).map((item) => item.id).filter((id) => id.startsWith("ctftime:")),
      ctf: events.events.filter((event) => event.category === "ctf").length,
    };
  };

  // Never touched the switch: it ran with the old default (on), so the upgrade writes that down.
  const implicit = await upgraded(undefined);
  assert.deepEqual(implicit, { migration: "migrated", enabled: true, row: "true", queue: ["ctftime:2846"], ctf: implicit.ctf });
  assert.ok(implicit.ctf > 0, "活動 still lists the CTF contests");
  // A row the store could not read fell back to that default too.
  assert.deepEqual(await upgraded('"yes"'), implicit);
  // Switched on or off by hand: the user's own value is kept.
  assert.deepEqual(await upgraded("true"), implicit);
  const off = await upgraded("false");
  assert.deepEqual(off, { migration: "migrated", enabled: false, row: "false", queue: [], ctf: 0 });

  // A new install gets the new default: off, with no row written for it.
  const fresh = blank(t);
  assert.deepEqual(await migrateLegacyOnboarding(fresh), { outcome: "fresh" });
  assert.equal(fresh.settings.value("ctftime.enabled"), false);
  assert.equal(ctftimeRow(fresh), undefined);
  // Nor does a later start (the marker is set) put the old default back.
  assert.deepEqual(await migrateLegacyOnboarding(fresh), { outcome: "already" });
  assert.equal(ctftimeRow(fresh), undefined);
});

test("the old CTFtime default is written for an install with only todos, and never twice", async (t) => {
  const todos = blank(t);
  insert(todos, "INSERT INTO todos (id, json, updated_at, status, created_at) VALUES ('todo-1', '{}', ?, 'open', ?)", stamp, stamp);
  assert.deepEqual(await migrateLegacyOnboarding(todos), { outcome: "migrated", roles: [], overrides: ALL_ON, completedAt: stamp }, "the default alone is no CTF role");
  assert.equal(todos.settings.value("ctftime.enabled"), true);

  // Turned off after the upgrade: a re-run (marker lost) keeps the user's answer.
  todos.settings.update({ "ctftime.enabled": false });
  todos.db.settings.db.prepare("DELETE FROM app_settings WHERE key = 'onboarding.completedAt'").run();
  await migrateLegacyOnboarding(todos);
  assert.equal(todos.settings.value("ctftime.enabled"), false);
});

test("an old install with only todos keeps 作業與專案, 活動 and every other feature it showed, by hand", async (t) => {
  const todos = blank(t);
  insert(todos, "INSERT INTO todos (id, json, updated_at, status, created_at) VALUES ('todo-1', '{}', ?, 'open', ?)", stamp, stamp);
  assert.deepEqual(await migrateLegacyOnboarding(todos), { outcome: "migrated", roles: [], overrides: ALL_ON, completedAt: stamp });
  const after = appSettings(todos);
  assert.deepEqual(after, { roles: [], overrides: ALL_ON, completedAt: stamp }, "no role guessed, nothing hidden");
  assert.deepEqual(visibleFeatures(after.roles, after.overrides), SHOWN_BEFORE);
  assert.deepEqual(hiddenModules(after.roles, after.overrides), [], "lms, projects, github and events stay on");
  assert.deepEqual(SIDEBAR.filter((section) => isSectionVisible(section, after.roles, after.overrides)), SIDEBAR);

  // Projects and 活動 feeds the user made are covered by the same rule, whatever the roles.
  const made = blank(t);
  insert(made, "INSERT INTO projects (id, json, updated_at, status, created_at) VALUES ('os-final', '{}', ?, 'active', ?)", stamp, stamp);
  insert(made, "INSERT INTO event_feeds (id, json, updated_at, enabled, target, created_at) VALUES ('g0v', '{}', ?, 1, 'events', ?)", stamp, stamp);
  await made.vault.set("moodle.token", { token: "t", baseUrl: "https://e3p.nycu.edu.tw" });
  assert.deepEqual(await migrateLegacyOnboarding(made), { outcome: "migrated", roles: ["student"], overrides: { github: true, events: true }, completedAt: stamp }, "a role that already shows a feature needs no override");
});

test("a fully configured old install: every role inferred, so nothing needs an override; a second run changes nothing", async (t) => {
  const full = blank(t);
  await full.vault.set("moodle.token", { token: "t", baseUrl: "https://e3p.nycu.edu.tw" });
  full.syncState.save("github", { state: "ok", cursor: JSON.stringify({ login: "octocat" }), lastSyncedAt: stamp });
  full.settings.update({ "ctftime.enabled": true });
  insert(full, "INSERT INTO projects (id, json, updated_at, status, created_at) VALUES ('os-final', '{}', ?, 'active', ?)", stamp, stamp);
  insert(full, "INSERT INTO event_feeds (id, json, updated_at, enabled, target, created_at) VALUES ('g0v', '{}', ?, 1, 'events', ?)", stamp, stamp);
  assert.deepEqual(await migrateLegacyOnboarding(full), { outcome: "migrated", roles: ["student", "developer", "ctf"], overrides: {}, completedAt: stamp });
  const after = appSettings(full);
  assert.deepEqual(visibleFeatures(after.roles, after.overrides), SHOWN_BEFORE);

  assert.deepEqual(await migrateLegacyOnboarding(full), { outcome: "already" });
  assert.deepEqual(appSettings(full), after);

  // Even without its marker, a re-run over what the first one saved adds nothing.
  const partial = blank(t);
  insert(partial, "INSERT INTO todos (id, json, updated_at, status, created_at) VALUES ('todo-1', '{}', ?, 'open', ?)", stamp, stamp);
  await migrateLegacyOnboarding(partial);
  const first = appSettings(partial);
  partial.db.settings.db.prepare("DELETE FROM app_settings WHERE key = 'onboarding.completedAt'").run();
  assert.deepEqual(await migrateLegacyOnboarding(partial), { outcome: "migrated", roles: first.roles, overrides: first.overrides, completedAt: stamp });
  assert.deepEqual(appSettings(partial), first);
});

test("roles and overrides an older build already saved are kept; a null roles row (not answered) is inferred", async (t) => {
  const saved = blank(t);
  saved.settings.update({ "profile.roles": ["developer"], "features.overrides": { events: false }, "ctftime.enabled": true });
  insert(saved, "INSERT INTO event_feeds (id, json, updated_at, enabled, target, created_at) VALUES ('g0v', '{}', ?, 1, 'events', ?)", stamp, stamp);
  assert.deepEqual(await migrateLegacyOnboarding(saved), { outcome: "migrated", roles: ["developer"], overrides: { events: false }, completedAt: stamp }, "the user's own answers win over the guess");

  const unanswered = blank(t);
  unanswered.db.settings.db.prepare("INSERT INTO app_settings (key, json, updated_at) VALUES ('profile.roles', 'null', ?)").run(stamp);
  unanswered.settings.update({ "ctftime.enabled": true });
  assert.deepEqual(await migrateLegacyOnboarding(unanswered), { outcome: "migrated", roles: ["ctf"], overrides: { assignments: true, timetable: true, projects: true, github: true }, completedAt: stamp }, "unanswered showed everything");
  assert.deepEqual(appSettings(unanswered).roles, ["ctf"]);

  // Overrides saved without roles: the user's "off" stays off, the rest is kept on by hand.
  const overridesOnly = blank(t);
  overridesOnly.settings.update({ "features.overrides": { events: false } });
  assert.deepEqual(await migrateLegacyOnboarding(overridesOnly), { outcome: "migrated", roles: [], overrides: { ...ALL_ON, events: false }, completedAt: stamp });
});

test("a vault it cannot read never stops the server from starting", async (t) => {
  const off = blank(t, { BELLPERSONAL_MASTER_KEY: "" });
  assert.equal(off.vault.enabled, false);
  assert.deepEqual(await migrateLegacyOnboarding(off), { outcome: "fresh" });

  const corrupt = blank(t);
  mkdirSync(corrupt.config.secretsDir, { recursive: true });
  writeFileSync(join(corrupt.config.secretsDir, VAULT_FILE), "not a vault");
  insert(corrupt, "INSERT INTO todos (id, json, updated_at, status, created_at) VALUES ('todo-1', '{}', ?, 'open', ?)", stamp, stamp);
  assert.deepEqual(await migrateLegacyOnboarding(corrupt), { outcome: "migrated", roles: [], overrides: ALL_ON, completedAt: stamp });
});

test("events switched off: Today's queue, the brief and search have no CTF competition; switched on, they are back at once without a sync", async (t) => {
  const dir = tempDir(t);
  const config = testConfig(dir);
  const db = openDatabases(config.dataDir);
  seedDemo(db, { now: NOW, timeZone: "Asia/Taipei" });
  db.close();
  const services = createServices(config, { now: () => NOW, fetch: async () => { throw new Error("no network in tests"); } });
  t.after(() => services.close());
  assert.deepEqual(await migrateLegacyOnboarding(services), { outcome: "already" }, "the demo seed answers 初次設定 itself");
  assert.deepEqual(appSettings(services).roles, [...PROFILE_ROLES]);
  const server = await startTestServer(t, services, { modules: [calendarModule, eventsModule, projectsModule, captureModule] });
  t.after(() => calendarService(services).dropPending());

  const synced = () => services.db.sources.db.prepare("SELECT source, last_synced_at, last_attempt_at FROM sync_state WHERE source IN ('ctftime', 'feeds') ORDER BY source").all();
  const before = synced();
  const competitions = /Balsn CTF|TSG CTF|HITCON CTF|g0v 零時政府/;
  const look = async () => {
    const today = (await server.call("GET", "/api/today")).json as TodayPayload;
    const queue = today.queue.flatMap((group) => group.items);
    const search = (await server.call("GET", `/api/capture/search?q=${encodeURIComponent("CTF")}`)).json;
    return {
      eventRows: queue.filter((item) => /^(ctftime|feed|feeds):/.test(item.id)).map((item) => item.id),
      later: today.later.events.map((event) => event.title).filter((title) => competitions.test(title)),
      chips: today.sources.map((source) => source.id).filter((id) => ["ctftime", "feeds"].includes(id)),
      brief: competitions.test(JSON.stringify(briefData(today, "Asia/Taipei"))) || competitions.test(today.brief.text),
      search: competitions.test(JSON.stringify(search)) || (search.results as { kind: string }[]).some((result) => !["todo", "idea", "project"].includes(result.kind)),
    };
  };

  const on = await look();
  assert.deepEqual(on.eventRows, ["ctftime:2846"], "Balsn CTF asks 要參加嗎？");
  assert.deepEqual(on.later, ["g0v 零時政府第柒拾次大松"]);
  assert.deepEqual(on.chips.sort(), ["ctftime", "feeds"]);
  assert.equal(on.brief, true, "the brief is built from those rows");

  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "features.overrides": { events: false } } })).status, 200);
  assert.deepEqual(await look(), { eventRows: [], later: [], chips: [], brief: false, search: false });

  assert.equal((await server.call("PUT", "/api/settings/app", { body: { "features.overrides": {} } })).status, 200);
  assert.deepEqual(await look(), on, "back at once");
  assert.deepEqual(synced(), before, "no sync ran: the rows were kept while hidden");
});
