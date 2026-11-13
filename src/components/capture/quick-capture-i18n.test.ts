import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseCapture } from "../../../shared/capture-parse";
import { ApiError, OFFLINE_REASON_EN, isOfflineErrorMessage } from "../../api";
import { CAPTURE, CAPTURE_TOASTS, CAPTURE_TYPE_LABELS, TIDY, quickCaptureCopy } from "../../copy/capture";
import strings from "../../copy/quick-capture-strings.json";
import { refreshBrief } from "../../pages/today/today-api";
import { ParseRow } from "./ParseRow";
import { aiParse } from "./client";

function leaves(value: unknown, path = ""): Array<[string, string]> {
  if (typeof value === "string") return [[path, value]];
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return Object.entries(value).flatMap(([key, entry]) => leaves(entry, path ? `${path}.${key}` : key));
}

const placeholders = (value: string) => value.match(/\{\w+\}/g) ?? [];

test("quick capture has 86/86 locale keys with identical templates and verbatim source copy", () => {
  const zh = leaves(strings["zh-TW"]);
  const en = leaves(strings.en);
  assert.equal(zh.length, 86);
  assert.equal(en.length, 86);
  assert.deepEqual(en.map(([key]) => key), zh.map(([key]) => key));
  en.forEach(([key, value], index) => {
    assert.deepEqual(placeholders(value), placeholders(zh[index][1]), key);
    assert.doesNotMatch(value, /\p{Script=Han}/u, key);
  });
  assert.deepEqual(quickCaptureCopy("zh-TW"), strings["zh-TW"]);
  assert.deepEqual(quickCaptureCopy("en"), strings.en);
});

test("legacy exports resolve the active locale on every read", (t) => {
  const previous = (globalThis as { window?: unknown }).window;
  const window = { location: { search: "?lang=en" } };
  (globalThis as { window?: unknown }).window = window;
  t.after(() => { (globalThis as { window?: unknown }).window = previous; });

  assert.equal(CAPTURE.label, "Quick capture");
  assert.equal(CAPTURE_TYPE_LABELS.idea, "Idea");
  assert.equal(CAPTURE.preview("todo", "Tomorrow 09:00"), "→ Task · Tomorrow 09:00 · Tab to switch type");
  assert.equal(CAPTURE_TOASTS.failed("No response."), "Not saved: No response. Draft kept.");
  assert.equal(TIDY.failed("No response."), "Couldn't tidy: No response.");

  window.location.search = "?lang=zh-TW";
  assert.equal(CAPTURE.label, "快速記下");
  assert.equal(CAPTURE_TYPE_LABELS.idea, "靈感");
  assert.equal(CAPTURE.preview("todo", "明天 09:00"), "→ 待辦 · 明天 09:00 · Tab 換類型");
});

test("parse row renders English labels and accessibility text", (t) => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { location: { search: "?lang=en" } };
  t.after(() => { (globalThis as { window?: unknown }).window = previous; });
  const parse = parseCapture("Submit report tomorrow 9:00", { now: new Date("2026-10-12T08:42:00+08:00"), timeZone: "Asia/Taipei", context: "todo" });
  const html = renderToStaticMarkup(createElement(ParseRow, { parse, timeZone: "Asia/Taipei", onType: () => {}, onMoment: () => {} }));

  assert.match(html, /aria-label="Type"/);
  assert.match(html, />Task<\/button>/);
  assert.match(html, />Event<\/button>/);
  assert.match(html, />Idea<\/button>/);
  assert.match(html, /aria-label="Edit date and time: 10\/13 \(Tue\) 09:00"/);
  assert.doesNotMatch(html, /\p{Script=Han}/u);
});

test("offline capture copy keeps both auto-dismiss markers", () => {
  assert.equal(OFFLINE_REASON_EN, "Can't reach the local service");
  assert.equal(isOfflineErrorMessage(strings["zh-TW"].captureToasts.failedOffline), true);
  assert.equal(isOfflineErrorMessage(strings.en.captureToasts.failedOffline), true);
  assert.equal(isOfflineErrorMessage("Not saved: permission denied. Draft kept."), false);
});

const structuredRefusal = {
  error: "This module is hidden",
  code: "module_hidden",
  module: "lms",
  feature: "assignments",
  roles: ["student"],
};

function mockRefusal(t: test.TestContext, path: string): void {
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    assert.equal(String(input), path);
    return new Response(JSON.stringify(structuredRefusal), { status: 409, headers: { "Content-Type": "application/json" } });
  });
}

function assertStructuredError(cause: unknown): boolean {
  assert.ok(cause instanceof ApiError);
  assert.equal(cause.status, 409);
  assert.equal(cause.code, "module_hidden");
  assert.deepEqual(cause.roles, ["student"]);
  return true;
}

test("aiParse preserves ApiError code and roles from a refused response", async (t) => {
  mockRefusal(t, "/api/capture/parse");
  await assert.rejects(aiParse("Submit report tomorrow", new AbortController().signal), assertStructuredError);
});

test("refreshBrief preserves ApiError code and roles from a refused response", async (t) => {
  mockRefusal(t, "/api/brief/refresh");
  await assert.rejects(refreshBrief(), assertStructuredError);
});
