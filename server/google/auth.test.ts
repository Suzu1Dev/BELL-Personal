import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GOOGLE_SCOPES } from "../../shared/connect.js";
import { googleModule } from "../features/google/index.js";
import { ReconnectRequiredError, type FetchLike } from "../sync.js";
import { calendarModule } from "../features/calendar/index.js";
import { gmailModule } from "../features/gmail/index.js";
import { appContext } from "../app.js";
import { createServices } from "../services.js";
import { fakeCommand, startTestServer, tempDir, testConfig, testServices } from "../test-helpers.js";
import { BUILTIN_GOOGLE_CLIENT, GOOGLE_VAULT_CLIENT, GOOGLE_VAULT_OAUTH, googleClient, normalizeScopes, type StoredGoogleOAuth } from "./auth.js";

const CLIENT = { clientId: "123456789012-abcdef.apps.googleusercontent.com", clientSecret: "GOCSPX-test-secret-value-1234" };
const ALL_SCOPES = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events";
const idToken = (email: string) => `x.${Buffer.from(JSON.stringify({ email, sub: "1" })).toString("base64url")}.sig`;

interface Recorded { url: string; body: string }

/** A fake of Google's token and revoke endpoints; `answer` decides each token response. */
function fakeGoogle(answer: (body: URLSearchParams) => { status?: number; json: unknown } = () => ({ json: { access_token: "ya29.access", expires_in: 3600, refresh_token: "1//refresh-token", scope: ALL_SCOPES, id_token: idToken("suzu1dev@gmail.com") } })) {
  const calls: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = String(input);
    const body = init?.body instanceof URLSearchParams ? init.body.toString() : String(init?.body ?? "");
    calls.push({ url, body });
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      const result = answer(new URLSearchParams(body));
      return new Response(JSON.stringify(result.json), { status: result.status ?? 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  };
  return { fetch, calls };
}

async function setup(t: test.TestContext, options: { env?: NodeJS.ProcessEnv; fake?: ReturnType<typeof fakeGoogle> } = {}) {
  const fake = options.fake ?? fakeGoogle();
  const services = testServices(t, { env: options.env, seams: { fetch: fake.fetch } });
  const server = await startTestServer(t, services, { modules: [googleModule] });
  return { services, server, fake };
}

/** Starts the flow and returns the consent URL's parameters. */
async function start(server: Awaited<ReturnType<typeof setup>>["server"], query = "", headers: Record<string, string> = {}) {
  const response = await server.call("GET", `/oauth/google/start${query}`, { headers });
  assert.equal(response.status, 302, response.text);
  const location = new URL(String(response.headers.location));
  return { location, params: location.searchParams };
}

test("status, client setup and the consent URL (PKCE S256, offline, consent, granular scopes)", async (t) => {
  const { server } = await setup(t, { env: { BELLPERSONAL_GOOGLE_BUILTIN: "off" } });
  const initial = await server.call("GET", "/api/google");
  assert.equal(initial.status, 200);
  assert.deepEqual(
    { ...initial.json, capabilities: undefined },
    { vaultEnabled: true, clientConfigured: false, clientSource: null, clientKind: null, connected: false, grantedScopes: [], missingScopes: [], capabilities: undefined,
      redirectUri: "http://127.0.0.1:4331/oauth/google/callback", loopbackRedirectUri: "http://127.0.0.1:4331/oauth/google/callback" },
  );
  const noClient = await server.call("GET", "/oauth/google/start");
  assert.equal(noClient.status, 302);
  assert.equal(noClient.headers.location, "/#/settings/sources?google=error&reason=client");

  assert.equal((await server.call("PUT", "/api/google/client", { body: { clientId: "nope", clientSecret: CLIENT.clientSecret } })).status, 400);
  assert.equal((await server.call("PUT", "/api/google/client", { body: { ...CLIENT, extra: 1 } })).status, 400);
  const saved = await server.call("PUT", "/api/google/client", { body: CLIENT });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.clientConfigured, true);
  assert.equal(saved.json.clientSource, "settings");
  assert.equal(saved.json.clientKind, "web");
  assert.equal(saved.json.clientIdHint, "123456….apps.googleusercontent.com");
  assert.doesNotMatch(saved.text, /GOCSPX/);

  const { location, params } = await start(server);
  assert.equal(location.origin + location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(params.get("client_id"), CLIENT.clientId);
  assert.equal(params.get("redirect_uri"), "http://127.0.0.1:4331/oauth/google/callback");
  assert.equal(params.get("response_type"), "code");
  assert.equal(params.get("access_type"), "offline");
  assert.equal(params.get("prompt"), "consent");
  assert.equal(params.get("include_granted_scopes"), "true");
  assert.equal(params.get("code_challenge_method"), "S256");
  assert.deepEqual(params.get("scope")!.split(" "), [...GOOGLE_SCOPES]);
  assert.match(params.get("state")!, /^[\w-]{43}$/);
  assert.match(params.get("code_challenge")!, /^[\w-]{43}$/);
});

test("the callback exchanges the code with the PKCE verifier, stores the token and redirects to settings", async (t) => {
  const { server, services, fake } = await setup(t);
  await server.call("PUT", "/api/google/client", { body: CLIENT });
  const { params } = await start(server);
  const state = params.get("state")!;
  services.syncState.save("gmail", { state: "needs_reconnect", lastError: "Gmail 需要重新連線" });
  // Google's redirect back is a cross-site top-level navigation: allowed on this path only.
  const callback = await server.call("GET", `/oauth/google/callback?state=${state}&code=4%2Fcode&scope=x`, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, "/#/settings/sources?google=connected");
  const exchange = new URLSearchParams(fake.calls.find((call) => call.url.startsWith("https://oauth2.googleapis.com/token"))!.body);
  assert.equal(exchange.get("grant_type"), "authorization_code");
  assert.equal(exchange.get("code"), "4/code");
  assert.equal(exchange.get("redirect_uri"), "http://127.0.0.1:4331/oauth/google/callback");
  assert.equal(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url"), params.get("code_challenge"));
  const stored = await services.vault.get<StoredGoogleOAuth>(GOOGLE_VAULT_OAUTH);
  assert.equal(stored?.refreshToken, "1//refresh-token");
  assert.equal(stored?.email, "suzu1dev@gmail.com");
  assert.deepEqual(stored?.scopes, normalizeScopes(ALL_SCOPES));
  assert.equal(services.syncState.get("gmail")?.state, "idle", "a reconnect clears 需要重新連線");
  const status = await server.call("GET", "/api/google");
  assert.equal(status.json.connected, true);
  assert.equal(status.json.email, "suzu1dev@gmail.com");
  assert.deepEqual(status.json.missingScopes, []);
  assert.deepEqual(status.json.capabilities, { gmail: true, calendarRead: true, calendarWrite: true });
  assert.doesNotMatch(status.text, /refresh-token|ya29/);
  // Single use: the same state cannot be replayed.
  const replay = await server.call("GET", `/oauth/google/callback?state=${state}&code=again`);
  assert.equal(replay.headers.location, "/#/settings/sources?google=error&reason=state");
  // Only the callback may arrive cross-site.
  assert.equal((await server.call("GET", "/oauth/google/start", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await server.call("PUT", "/api/google/client", { body: CLIENT })).status, 409, "disconnect before changing the client");
});

test("partial consent is reported; no useful scope, denial, a bad exchange and a missing refresh token are errors", async (t) => {
  let scope = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/calendar.readonly";
  let refresh: string | undefined = "1//partial";
  let status = 200;
  const fake = fakeGoogle(() => ({ status, json: status === 200 ? { access_token: "ya29.a", expires_in: 3600, scope, ...(refresh ? { refresh_token: refresh } : {}) } : { error: "invalid_grant" } }));
  const { server, services } = await setup(t, { fake });
  await server.call("PUT", "/api/google/client", { body: CLIENT });
  const callback = async () => {
    const { params } = await start(server);
    return (await server.call("GET", `/oauth/google/callback?state=${params.get("state")}&code=c`)).headers.location;
  };
  assert.equal(await callback(), "/#/settings/sources?google=connected&missing=gmail.modify%2Ccalendar.events");
  assert.deepEqual((await server.call("GET", "/api/google")).json.capabilities, { gmail: false, calendarRead: true, calendarWrite: false });
  await services.vault.delete(GOOGLE_VAULT_OAUTH);
  scope = "openid https://www.googleapis.com/auth/userinfo.email";
  assert.equal(await callback(), "/#/settings/sources?google=error&reason=no-scopes");
  assert.ok(fake.calls.some((call) => call.url.startsWith("https://oauth2.googleapis.com/revoke")), "a useless grant is revoked");
  scope = ALL_SCOPES;
  refresh = undefined;
  assert.equal(await callback(), "/#/settings/sources?google=error&reason=no-refresh-token");
  status = 400;
  assert.equal(await callback(), "/#/settings/sources?google=error&reason=exchange");
  const { params } = await start(server);
  const denied = await server.call("GET", `/oauth/google/callback?state=${params.get("state")}&error=access_denied`);
  assert.equal(denied.headers.location, "/#/settings/sources?google=error&reason=denied");
  assert.equal(await services.vault.has(GOOGLE_VAULT_OAUTH), false);
});

test("the state is bound to the Tailscale login that started the flow", async (t) => {
  const { server } = await setup(t, { env: { BELLPERSONAL_TAILSCALE_USERS: "alice@github,other@github" } });
  const owner = { "tailscale-user-login": "alice@github" };
  await server.call("PUT", "/api/google/client", { body: CLIENT, headers: owner });
  const { params } = await start(server, "", owner);
  const stolen = await server.call("GET", `/oauth/google/callback?state=${params.get("state")}&code=c`, { headers: { "tailscale-user-login": "other@github" } });
  assert.equal(stolen.headers.location, "/#/settings/sources?google=error&reason=state");
  const again = await start(server, "", owner);
  const ok = await server.call("GET", `/oauth/google/callback?state=${again.params.get("state")}&code=c`, { headers: owner });
  assert.equal(ok.headers.location, "/#/settings/sources?google=connected");
});

test("the desktop-client fallback: loopback redirect and a pasted URL", async (t) => {
  const { server, fake } = await setup(t);
  await server.call("PUT", "/api/google/client", { body: { ...CLIENT, kind: "desktop" } });
  const { params } = await start(server, "?mode=paste");
  assert.equal(params.get("redirect_uri"), "http://127.0.0.1:4331/oauth/google/callback");
  assert.equal((await server.call("POST", "/api/google/paste", { body: { url: "not a url at all" } })).status, 400);
  assert.equal((await server.call("POST", "/api/google/paste", { body: { url: `https://evil.example/oauth/google/callback?state=${params.get("state")}&code=c` } })).status, 400);
  const pasted = await server.call("POST", "/api/google/paste", { body: { url: `http://127.0.0.1:4331/oauth/google/callback?state=${params.get("state")}&code=4%2Fpasted&scope=x` } });
  assert.equal(pasted.status, 200, pasted.text);
  assert.deepEqual(pasted.json, { connected: true, email: "suzu1dev@gmail.com", grantedScopes: normalizeScopes(ALL_SCOPES), missingScopes: [] });
  assert.equal(new URLSearchParams(fake.calls.at(-1)!.body).get("code"), "4/pasted");
  const expired = await server.call("POST", "/api/google/paste", { body: { url: `http://127.0.0.1:4331/oauth/google/callback?state=${params.get("state")}&code=c` } });
  assert.equal(expired.status, 400);
  assert.match(expired.json.error, /重新按「連接 Google」/);
});

test("disconnect revokes best-effort, deletes the token and clears Google caches", async (t) => {
  const { server, services, fake } = await setup(t);
  await server.call("PUT", "/api/google/client", { body: CLIENT });
  const { params } = await start(server);
  await server.call("GET", `/oauth/google/callback?state=${params.get("state")}&code=c`);
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: "m1", value: { id: "m1" } }]);
  services.sourceItems.upsert("google-calendar", [{ kind: "calendar-event", externalId: "e1", value: { id: "e1" } }]);
  services.syncState.save("gmail", { state: "ok" });
  const response = await server.call("DELETE", "/api/google", { body: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(response.json, { disconnected: true, revoked: true, removedItems: 2 });
  assert.equal(new URLSearchParams(fake.calls.at(-1)!.body).get("token"), "1//refresh-token");
  assert.equal(await services.vault.has(GOOGLE_VAULT_OAUTH), false);
  assert.equal(await services.vault.has(GOOGLE_VAULT_CLIENT), true, "the client stays for the next connect");
  assert.equal(services.syncState.get("gmail"), undefined);
  assert.equal((await server.call("GET", "/api/status")).json.google.connected, false);
});

test("googleClient refreshes through ctx.fetch, persists new tokens, and maps invalid_grant to reconnect", async (t) => {
  let grant: "ok" | "dead" = "ok";
  const fake = fakeGoogle((body) => (body.get("grant_type") === "refresh_token"
    ? grant === "ok" ? { json: { access_token: "ya29.refreshed", expires_in: 3600, scope: ALL_SCOPES } } : { status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }
    : { json: {} }));
  const { services } = await setup(t, { fake, env: { BELLPERSONAL_GOOGLE_CLIENT_ID: CLIENT.clientId, BELLPERSONAL_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret } });
  await assert.rejects(googleClient(services), ReconnectRequiredError);
  await services.vault.set(GOOGLE_VAULT_OAUTH, { refreshToken: "1//stored", scopes: normalizeScopes(ALL_SCOPES), clientId: CLIENT.clientId, connectedAt: "2026-10-12T00:00:00.000Z" } satisfies StoredGoogleOAuth);
  // The refreshed token is saved in the background (on the client's "tokens"
  // event), so wait for that vault write to finish instead of a fixed delay.
  const vaultUpdate = services.vault.update.bind(services.vault);
  let tokenSaved!: () => void;
  const saved = new Promise<void>((resolve) => { tokenSaved = resolve; });
  t.mock.method(services.vault, "update", async (name: string, change: (current: unknown) => unknown) => {
    const wrote = await vaultUpdate(name, change);
    if (name === GOOGLE_VAULT_OAUTH) tokenSaved();
    return wrote;
  });
  const client = await googleClient(services);
  const { token } = await client.getAccessToken();
  assert.equal(token, "ya29.refreshed");
  const refresh = new URLSearchParams(fake.calls.at(-1)!.body);
  assert.equal(refresh.get("refresh_token"), "1//stored");
  assert.equal(refresh.get("client_id"), CLIENT.clientId);
  await saved;
  const stored = await services.vault.get<StoredGoogleOAuth>(GOOGLE_VAULT_OAUTH);
  assert.equal(stored?.accessToken, "ya29.refreshed");
  assert.equal(stored?.refreshToken, "1//stored");

  grant = "dead";
  await services.vault.set(GOOGLE_VAULT_OAUTH, { ...stored!, accessToken: undefined, expiryDate: undefined });
  const dead = await googleClient(services);
  await assert.rejects(dead.getAccessToken(), (error: unknown) => error instanceof ReconnectRequiredError && /重新連線 Google/.test((error as Error).message));
  await services.vault.set(GOOGLE_VAULT_OAUTH, { ...stored!, clientId: "other.apps.googleusercontent.com" });
  await assert.rejects(googleClient(services), /用戶端已更換/);
});

test("a disconnect that lands while a refreshed token is being saved is not undone", async (t) => {
  const fake = fakeGoogle((body) => ({ json: body.get("grant_type") === "refresh_token" ? { access_token: "ya29.late", expires_in: 3600, scope: ALL_SCOPES } : {} }));
  const { services } = await setup(t, { fake, env: { BELLPERSONAL_GOOGLE_CLIENT_ID: CLIENT.clientId, BELLPERSONAL_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret } });
  await services.vault.set(GOOGLE_VAULT_OAUTH, { refreshToken: "1//stored", scopes: normalizeScopes(ALL_SCOPES), clientId: CLIENT.clientId, connectedAt: "2026-10-12T00:00:00.000Z" } satisfies StoredGoogleOAuth);
  const client = await googleClient(services);
  // Start the disconnect's delete right after the token save reads the vault
  // file, before it writes. `load` is the vault's private file read, which every
  // read and every write goes through, so this does not depend on how the save
  // reads the record.
  const vault = services.vault as unknown as { load(): Promise<unknown> };
  const load = vault.load.bind(vault);
  let deleting: Promise<boolean> | undefined;
  let saveRead!: () => void;
  const read = new Promise<void>((resolve) => { saveRead = resolve; });
  t.mock.method(vault, "load", async () => {
    const file = await load();
    if (!deleting) { deleting = services.vault.delete(GOOGLE_VAULT_OAUTH); saveRead(); }
    return file;
  });
  assert.equal((await client.getAccessToken()).token, "ya29.late");
  await read;
  assert.equal(await deleting, true);
  // rotate() runs under the vault's write lock, so once it resolves every write
  // queued before it (including the token save) has finished.
  await services.vault.rotate();
  assert.equal(await services.vault.has(GOOGLE_VAULT_OAUTH), false, "the deleted token record was written back");
});

test("a token sealed with another master key turns Gmail and Calendar into 需要重新連線 instead of failing Today", async (t) => {
  const dir = tempDir(t);
  const env = { BELLPERSONAL_GOOGLE_CLIENT_ID: CLIENT.clientId, BELLPERSONAL_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret };
  const before = createServices(testConfig(dir, env), { command: fakeCommand(() => undefined).runner });
  await before.vault.set(GOOGLE_VAULT_OAUTH, { refreshToken: "1//stored", scopes: normalizeScopes(ALL_SCOPES), clientId: CLIENT.clientId, connectedAt: "2026-10-12T00:00:00.000Z" } satisfies StoredGoogleOAuth);
  before.close();
  const services = createServices(testConfig(dir, { ...env, BELLPERSONAL_MASTER_KEY: Buffer.alloc(32, 9).toString("base64") }), { command: fakeCommand(() => undefined).runner, fetch: fakeGoogle().fetch });
  t.after(() => services.close());
  const server = await startTestServer(t, services, { modules: [googleModule, gmailModule, calendarModule] });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => { process.off("unhandledRejection", onUnhandled); });
  appContext(server.app).modules.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unhandled, [], "the boot kick of every source settles");
  const today = await server.call("GET", "/api/today");
  assert.equal(today.status, 200, today.text);
  const states = Object.fromEntries((today.json.sources as Array<{ id: string; state: string }>).map((source) => [source.id, source.state]));
  assert.equal(states.gmail, "reconnect");
  assert.equal(states["google-calendar"], "reconnect");
  assert.equal((await server.call("GET", "/api/status")).status, 200);
  assert.equal((await server.call("POST", "/api/sync", { body: { force: true } })).status, 202);
  const statuses = await Promise.all(appContext(server.app).modules.sources.map((source) => source.sync()));
  assert.deepEqual(statuses.filter((status) => status.configured).map((status) => [status.id, status.state]), [["gmail", "needs_reconnect"], ["google-calendar", "needs_reconnect"]]);
});

test("environment client and a missing master key", async (t) => {
  const env = await setup(t, { env: { BELLPERSONAL_GOOGLE_CLIENT_ID: CLIENT.clientId, BELLPERSONAL_GOOGLE_CLIENT_SECRET: CLIENT.clientSecret, BELLPERSONAL_ALLOWED_ORIGINS: "https://box.tailone.ts.net:20003" } });
  const status = await env.server.call("GET", "/api/google", { headers: { host: "box.tailone.ts.net:20003" } });
  assert.equal(status.json.clientSource, "env");
  assert.equal(status.json.redirectUri, "https://box.tailone.ts.net:20003/oauth/google/callback");
  assert.equal((await env.server.call("PUT", "/api/google/client", { body: CLIENT })).status, 409);
  const { params } = await start(env.server);
  assert.equal(params.get("redirect_uri"), "https://box.tailone.ts.net:20003/oauth/google/callback");

  const locked = await setup(t, { env: { BELLPERSONAL_MASTER_KEY: "" } });
  assert.equal((await locked.server.call("GET", "/oauth/google/start")).headers.location, "/#/settings/sources?google=error&reason=vault");
  assert.equal((await locked.server.call("PUT", "/api/google/client", { body: CLIENT })).status, 503);
  assert.equal((await locked.server.call("GET", "/api/google")).json.vaultEnabled, false);
});

test("中斷連線 also deletes what was derived from the mail: suggestions, queue state and handled-list subjects", async (t) => {
  const { server, services } = await setup(t);
  await server.call("PUT", "/api/google/client", { body: CLIENT });
  const { params } = await start(server);
  await server.call("GET", `/oauth/google/callback?state=${params.get("state")}&code=c`);
  const pending = services.suggestions.create({ kind: "event", title: "SITCON 秋季交流會", payload: { title: "SITCON 秋季交流會", start: "2026-10-25" }, sourceRef: { source: "gmail", externalId: "m1", url: "https://mail.google.com/mail/u/0/#all/m1" }, origin: "KKTIX 報名成功信" });
  const decided = services.suggestions.create({ kind: "todo", title: "繳電話費", payload: { title: "繳電話費" }, sourceRef: { source: "gmail", externalId: "m2" }, origin: "中華電信 信件" });
  services.suggestions.decide(decided.id, "dismissed");
  const unrelated = services.suggestions.create({ kind: "idea-tags", title: "標籤", payload: { ideaId: "i1", tag: "OS" } });
  services.itemState.record({ itemId: "gmail:m3", kind: "mail.reply", action: "archive", title: "Re: 期末專題（教授）", closes: true, state: { state: "handled" } });
  services.itemState.record({ itemId: `ai:${decided.id}`, kind: "suggestion.todo", action: "dismiss", title: "繳電話費", closes: true, state: { state: "dismissed" } });
  services.itemState.record({ itemId: "native:t1", kind: "todo", action: "done", title: "我的待辦", closes: true, state: { state: "handled" } });
  assert.equal((await server.call("DELETE", "/api/google", { body: {} })).status, 200);
  assert.equal(services.suggestions.get(pending.id), undefined, "a pending mail suggestion is deleted");
  const kept = services.suggestions.get(decided.id)!;
  assert.deepEqual([kept.status, kept.title, kept.payload, kept.sourceRef, kept.origin], ["dismissed", "", null, undefined, undefined], "a decided one keeps only its decision");
  assert.ok(services.suggestions.get(unrelated.id), "suggestions not made from mail stay");
  assert.equal(services.itemState.get("gmail:m3"), undefined);
  const titles = services.db.personal.db.prepare("SELECT item_id, title FROM action_log ORDER BY item_id").all().map((row) => [row.item_id, row.title]);
  assert.deepEqual(titles, [[`ai:${decided.id}`, "（已清除的信件）"], ["gmail:m3", "（已清除的信件）"], ["native:t1", "我的待辦"]]);
});

test("reconnecting as another Google account drops the old mailbox's cache and cursor", async (t) => {
  let account = "suzu1dev@gmail.com";
  const fake = fakeGoogle(() => ({ json: { access_token: "ya29.access", expires_in: 3600, refresh_token: "1//refresh-token", scope: ALL_SCOPES, id_token: idToken(account) } }));
  const { server, services } = await setup(t, { fake });
  await server.call("PUT", "/api/google/client", { body: CLIENT });
  const connect = async () => {
    const { params } = await start(server);
    await server.call("GET", `/oauth/google/callback?state=${params.get("state")}&code=c`);
  };
  await connect();
  services.sourceItems.upsert("gmail", [{ kind: "mail", externalId: "m1", value: { id: "m1" } }]);
  services.syncState.save("gmail", { state: "needs_reconnect", cursor: "12345" });
  await connect();
  assert.equal(services.sourceItems.count("gmail"), 1, "the same account keeps its cache");
  assert.equal(services.syncState.get("gmail")?.cursor, "12345");
  assert.equal(services.syncState.get("gmail")?.state, "idle");
  account = "student@nycu.edu.tw";
  await connect();
  assert.equal(services.sourceItems.count("gmail"), 0, "another account: the old mailbox is gone");
  assert.equal(services.syncState.get("gmail")?.cursor ?? null, null);
});

test("built-in PKCE Google OAuth works in one click out of the box, supports setup return, and custom client resets back to builtin", async (t) => {
  const { server, services, fake } = await setup(t);
  const initial = await server.call("GET", "/api/google");
  assert.equal(initial.status, 200);
  assert.equal(initial.json.clientConfigured, true);
  assert.equal(initial.json.clientSource, "builtin");
  assert.equal(initial.json.clientKind, "web");
  assert.equal(initial.json.clientIdHint, undefined, "built-in client hides raw clientIdHint");

  // 1-click OAuth from onboarding (#/setup) without configuring any client in GCP Console:
  const { params } = await start(server, "?return=setup");
  assert.equal(params.get("client_id"), BUILTIN_GOOGLE_CLIENT.clientId);
  assert.equal(params.get("code_challenge_method"), "S256");
  const callback = await server.call("GET", `/oauth/google/callback?state=${params.get("state")}&code=oneclick`, { headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, "/#/setup?google=connected");
  assert.equal(new URLSearchParams(fake.calls.at(-1)!.body).get("client_id"), BUILTIN_GOOGLE_CLIENT.clientId);
  assert.equal((await server.call("GET", "/api/google")).json.connected, true);

  // Error from onboarding also returns to #/setup:
  const deniedStart = await start(server, "?return=setup");
  const denied = await server.call("GET", `/oauth/google/callback?state=${deniedStart.params.get("state")}&error=access_denied`);
  assert.equal(denied.headers.location, "/#/setup?google=error&reason=denied");

  // Disconnect and test custom client override + reset back to built-in:
  assert.equal((await server.call("DELETE", "/api/google/client", { body: {} })).status, 409, "cannot clear while connected");
  await server.call("DELETE", "/api/google", { body: {} });
  const custom = await server.call("PUT", "/api/google/client", { body: CLIENT });
  assert.equal(custom.json.clientSource, "settings");
  const reset = await server.call("DELETE", "/api/google/client", { body: {} });
  assert.equal(reset.status, 200);
  assert.equal(reset.json.clientSource, "builtin");
  assert.equal(reset.json.clientConfigured, true);
  assert.equal(await services.vault.has(GOOGLE_VAULT_CLIENT), false);
});
