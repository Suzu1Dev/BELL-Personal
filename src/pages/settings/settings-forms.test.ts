import test from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SourceStatus } from "../../../shared/sources";
import { ToastProvider } from "../../components/toast/ToastProvider";
import { StatusProvider } from "../../lib/status";
import { LmsConnectForm } from "./LmsConnectForm";
import { SourceCard } from "./SourceCard";
import {
  DEFAULT_MOODLE_URL, checkCanvas, checkFeed, checkGoogleClient, checkMoodle, checkPasteUrl, checkRetention, checkTime, checkWeight, missingScopeNames,
} from "./settings-forms";
import { cardState, googleReturn, syncPhrase } from "./settings-view";
import { Mail } from "../../components/Icon";

test("Moodle: an https site, 學號 and 密碼 are required; the site is normalised", () => {
  assert.deepEqual(checkMoodle({ baseUrl: "https://e3p.nycu.edu.tw/", username: " 311551000 ", password: "pw" }), {
    ok: true, value: { baseUrl: "https://e3p.nycu.edu.tw", username: "311551000", password: "pw" },
  });
  const empty = checkMoodle({ baseUrl: "", username: "", password: "" });
  assert.deepEqual(empty, { ok: false, errors: { baseUrl: "請填寫 E3 網址。", username: "請填寫學號。", password: "請填寫密碼。" } });
  const http = checkMoodle({ baseUrl: "http://e3p.nycu.edu.tw", username: "a", password: "b" });
  assert.equal(http.ok ? undefined : http.errors.baseUrl, "請輸入以 https:// 開頭的完整網址。");
  const withPassword = checkMoodle({ baseUrl: "https://user:pass@e3p.nycu.edu.tw", username: "a", password: "b" });
  assert.equal(withPassword.ok, false, "credentials never ride in the URL");
  assert.equal(DEFAULT_MOODLE_URL, "https://e3p.nycu.edu.tw");
});

test("Canvas needs an https site and a token", () => {
  assert.deepEqual(checkCanvas({ baseUrl: "https://canvas.example.edu", token: " 7~abc " }), { ok: true, value: { baseUrl: "https://canvas.example.edu", token: "7~abc" } });
  const missing = checkCanvas({ baseUrl: "canvas", token: "" });
  assert.deepEqual(missing.ok ? {} : Object.keys(missing.errors).sort(), ["baseUrl", "token"]);
});

test("feeds: http(s) and webcal URLs with a name; webcal becomes https", () => {
  assert.deepEqual(checkFeed({ url: "webcal://calendar.g0v.tw/ics", label: "g0v 行事曆" }), { ok: true, value: { url: "https://calendar.g0v.tw/ics", label: "g0v 行事曆" } });
  assert.equal(checkFeed({ url: "https://kktix.com/events.atom", label: "KKTIX" }).ok, true);
  const bad = checkFeed({ url: "ftp://example.com/feed", label: "" });
  assert.deepEqual(bad.ok ? {} : bad.errors, { url: "請輸入完整網址，例如 https://example.com/feed.xml。", label: "請填寫名稱。" });
  // The server fetches HTTPS only: say so next to the field instead of failing later in a toast.
  const http = checkFeed({ url: "http://example.com/feed.xml", label: "測試" });
  assert.equal(http.ok ? undefined : http.errors.url, "請輸入以 https:// 開頭的完整網址。");
  const long = checkFeed({ url: "https://example.com/feed", label: "名".repeat(61) });
  assert.equal(long.ok ? undefined : long.errors.label, "名稱最多 60 個字。");
});

test("Google client: the ID ends with .apps.googleusercontent.com and the secret has no spaces", () => {
  assert.deepEqual(checkGoogleClient({ clientId: " 123-abc.apps.googleusercontent.com ", clientSecret: "GOCSPX-secret1" }), {
    ok: true, value: { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret1", kind: "web" },
  });
  assert.equal(checkGoogleClient({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret1" }, "desktop").ok ? "desktop" : "", "desktop");
  const bad = checkGoogleClient({ clientId: "my-client", clientSecret: "has space" });
  assert.deepEqual(bad.ok ? {} : bad.errors, { clientId: "用戶端 ID 應以 .apps.googleusercontent.com 結尾。", clientSecret: "用戶端密碼至少 8 個字，不可包含空白。" });
});

test("the paste fallback needs the whole redirect URL with its code", () => {
  assert.equal(checkPasteUrl("http://127.0.0.1:4331/oauth/google/callback?state=s&code=4/0Ab").ok, true);
  assert.equal(checkPasteUrl("http://127.0.0.1:4331/oauth/google/callback?error=access_denied&state=s").ok, true, "a refusal is still worth reporting");
  assert.equal(checkPasteUrl("4/0Ab-just-the-code").ok, false);
  assert.equal(checkPasteUrl("http://127.0.0.1:4331/oauth/google/callback").ok, false);
});

test("numbers and times: retention 1–365, CTFtime weight 0–100, HH:MM", () => {
  assert.deepEqual(checkRetention("30"), { ok: true, value: 30 });
  assert.equal(checkRetention("0").ok, false);
  assert.equal(checkRetention("366").ok, false);
  assert.equal(checkRetention("3.5").ok, false);
  assert.deepEqual(checkWeight("0"), { ok: true, value: 0 });
  assert.equal(checkWeight("101").ok, false);
  assert.deepEqual(checkTime("6:30"), { ok: true, value: "06:30" });
  assert.deepEqual(checkTime("23:59"), { ok: true, value: "23:59" });
  assert.equal(checkTime("24:00").ok, false);
  assert.equal(checkTime("noon").ok, false);
  assert.equal(missingScopeNames("gmail.modify,calendar.events", { "gmail.modify": "Gmail", "calendar.events": "新增行程" }), "Gmail、新增行程");
  assert.equal(missingScopeNames(null, {}), undefined);
});

const status = (id: SourceStatus["id"], state: SourceStatus["state"], extra: Partial<SourceStatus> = {}): SourceStatus => ({
  id, label: id, configured: state !== "not_configured", state, lastSyncedAt: null, lastAttemptAt: null, lastError: null, items: null, stale: false, ...extra,
});

test("a card shows the state that needs the user most, with that source's error", () => {
  const sources = [
    status("gmail", "ok", { lastSyncedAt: "2026-10-12T00:40:00.000Z" }),
    status("google-calendar", "needs_reconnect", { lastSyncedAt: "2026-10-11T14:10:00.000Z", lastError: "Google 行事曆需要重新連線。" }),
  ];
  assert.deepEqual(cardState(sources, ["gmail", "google-calendar"]), {
    state: "needs_reconnect", configured: true, error: "Google 行事曆需要重新連線。", lastSyncedAt: "2026-10-12T00:40:00.000Z",
  });
  assert.deepEqual(cardState(sources, ["moodle"]), { state: "not_configured", configured: false });
  assert.deepEqual(cardState([status("ctftime", "disabled")], ["ctftime"]), { state: "disabled", configured: false });
  assert.equal(syncPhrase("2026-10-11T14:10:00.000Z", new Date("2026-10-12T00:42:00.000Z")), "昨天 22:10");
});

test("the OAuth return: connected (with missing scopes) or an error reason", () => {
  assert.deepEqual(googleReturn("#/settings/sources?google=connected"), { kind: "connected" });
  assert.deepEqual(googleReturn("#/settings/sources?google=connected&missing=gmail.modify"), { kind: "connected", missing: "gmail.modify" });
  assert.deepEqual(googleReturn("#/settings/sources?google=error&reason=denied"), { kind: "error", reason: "denied" });
  assert.deepEqual(googleReturn("#/settings/sources?google=error&reason=made-up"), { kind: "error" });
  assert.equal(googleReturn("#/settings/sources"), undefined);
  assert.equal(googleReturn("#/settings/sources?tab=x"), undefined);
});

const withProviders = (child: ReactNode) => renderToStaticMarkup(createElement(ToastProvider, null, createElement(StatusProvider, null, child)));

test("the E3 form starts at the NYCU site and says the password is never stored", () => {
  const html = withProviders(createElement(LmsConnectForm, { kind: "moodle", onDone: () => {} }));
  assert.match(html, /value="https:\/\/e3p.nycu.edu.tw"/);
  assert.match(html, /autocomplete="username"/i, "HTML attributes are case-insensitive");
  assert.match(html, /type="password" autocomplete="current-password"/i);
  assert.match(html, /密碼只用一次換取權杖，不會儲存。/);
  assert.match(html, /<form class="sc-form" novalidate="">/i);
  const canvas = withProviders(createElement(LmsConnectForm, { kind: "canvas", onDone: () => {}, onCancel: () => {}, cancelLabel: "稍後再說" }));
  assert.match(canvas, /存取權杖/);
  assert.match(canvas, /稍後再說/);
  assert.doesNotMatch(canvas + html, /BELLPERSONAL_|process\.env/, "no environment variable names in the UI");
});

test("a source card shows the pill, the error and 上次同步 in one row grammar", () => {
  const html = renderToStaticMarkup(createElement(SourceCard, {
    id: "google", icon: Mail, tone: "mail", name: "Google 帳號", purpose: "Gmail 摘要與 Google 行事曆。",
    pill: { state: "needs_reconnect" }, error: "授權已過期。", meta: "suzu1dev@gmail.com · 上次同步 昨天 22:10",
  }));
  assert.match(html, /<section class="card source-card" aria-labelledby="source-google">/);
  assert.match(html, /<span class="pill dot p-warn">需要重新連線<\/span>/);
  assert.match(html, /<p class="sc-error kp">授權已過期。<\/p>/);
  assert.match(html, /<p class="meta">suzu1dev@gmail.com · 上次同步 昨天 22:10<\/p>/);
});

test("信任的寄件者: an address or a domain, lower-cased, no repeats, at most 200", async () => {
  const { checkTrustedSender } = await import("./settings-forms");
  assert.deepEqual(checkTrustedSender("  News@ITHome.com.tw ", []), { ok: true, value: "news@ithome.com.tw" });
  assert.deepEqual(checkTrustedSender("@medium.com", []), { ok: true, value: "medium.com" });
  assert.deepEqual(checkTrustedSender("*.medium.com", []), { ok: true, value: "medium.com" });
  for (const bad of ["javascript:alert(1)", "localhost", "a@b", "<x@y.com>", "news @example.com", "http://example.com"]) {
    assert.equal(checkTrustedSender(bad, []).ok, false, bad);
  }
  assert.deepEqual(checkTrustedSender("", []), { ok: false, errors: { entry: "請填寫寄件者。" } });
  assert.deepEqual(checkTrustedSender("medium.com", ["medium.com"]), { ok: false, errors: { entry: "這個寄件者已經在清單裡了。" } });
  assert.deepEqual(checkTrustedSender("x.com", Array.from({ length: 200 }, (_, index) => `s${index}.com`)), { ok: false, errors: { entry: "最多 200 個信任的寄件者，請先移除一些。" } });
});
