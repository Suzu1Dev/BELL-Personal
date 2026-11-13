import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CalendarItem } from "../../../shared/calendar";
import type { CaptureTidyResult, CaptureTidyStart } from "../../../shared/connect";
import { TIDY } from "../../copy/capture";
import { AgendaTimeline } from "../../pages/calendar/AgendaTimeline";
import { timelineRows } from "../../pages/calendar/calendar-model";
import { clearTidying, followTidy, isTidying, markTidying, subscribeTidying, tidyNotice } from "./tidy";

const applied: CaptureTidyResult = {
  kind: "todo", id: "t1", applied: true, title: "Deep Hacking 簡報",
  message: "已整理成「Deep Hacking 簡報」 · 週日 10/18", undoToken: "0b5f6a8e-3a51-4f11-9a3c-5d0f4a0d1e2b",
};

test("tidyNotice: a rewrite shows the server's line with 復原; an automatic no-op or failure stays quiet", () => {
  assert.deepEqual(tidyNotice(applied, false), { kind: "undo", message: applied.message, token: applied.undoToken });
  assert.equal(tidyNotice({ kind: "todo", id: "t1", applied: false, reason: "same" }, false), undefined);
  assert.equal(tidyNotice({ kind: "todo", id: "t1", applied: false, reason: "rejected" }, false), undefined);
  assert.equal(tidyNotice({ error: "Claude 尚未登入。" }, false), undefined, "AI off or signed out: the rule result stays, silently");
});

test("tidyNotice: the manual 整理 says why nothing changed, or what failed", () => {
  assert.deepEqual(tidyNotice({ kind: "todo", id: "t1", applied: false, reason: "same" }, true), { kind: "info", message: TIDY.reasons.same });
  assert.deepEqual(tidyNotice({ kind: "event", id: "e1", applied: false, reason: "google" }, true), { kind: "info", message: TIDY.reasons.google });
  assert.deepEqual(tidyNotice({ error: "整理逾時" }, true), { kind: "error", message: "沒有整理：整理逾時。" });
});

test("followTidy marks the record 整理中… until its job ends, and reads the done result", async (t) => {
  const start: CaptureTidyStart = { jobId: "job-1", kind: "todo", id: "t1" };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    assert.match(String(input), /^\/api\/jobs\/job-1\/events\?from=0$/);
    await gate;
    const body = [{ type: "job", id: "job-1" }, { type: "stage", stage: "tidy", message: "正在整理快速記下…" }, { type: "done", result: applied }].map((line) => JSON.stringify(line)).join("\n") + "\n";
    return new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } });
  }) as typeof fetch;

  let notified = 0;
  const unsubscribe = subscribeTidying(() => { notified++; });
  t.after(unsubscribe);
  const pending = followTidy(start);
  assert.equal(isTidying("todo", "t1"), true);
  release();
  assert.deepEqual(await pending, applied);
  assert.equal(isTidying("todo", "t1"), false);
  assert.equal(notified, 2, "listeners hear the start and the end");
});

test("an older follow never clears a newer tidy of the same record", () => {
  markTidying({ jobId: "new", kind: "event", id: "e1" });
  clearTidying({ jobId: "old", kind: "event", id: "e1" });
  assert.equal(isTidying("event", "e1"), true);
  clearTidying({ jobId: "new", kind: "event", id: "e1" });
  assert.equal(isTidying("event", "e1"), false);
});

const TZ = "Asia/Taipei";
const at = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const local: CalendarItem = {
  id: "manual:e1", kind: "event", origin: "manual", title: "跟林教授 meeting 討論期末專題提案，記得帶筆電", start: at("2026-10-16T15:00"), end: at("2026-10-16T16:00"),
  allDay: false, meta: "工程三館", sourceLabel: "本機行事曆", manualId: "e1", inGoogle: false, typed: true,
};
const renderDay = (item: CalendarItem, tidying: boolean) => renderToStaticMarkup(createElement(AgendaTimeline, {
  rows: timelineRows({ day: "2026-10-16", today: "2026-10-15", items: [item], free: [], now: Date.parse(at("2026-10-15T10:00")), timeZone: TZ, showPast: true }),
  timeZone: TZ, onRemove: () => {}, onTidy: () => {}, tidying: () => tidying, onRevert: () => {},
}));

test("#/calendar: 整理 on a local event; 整理中… while it runs; nothing for an event already in Google", () => {
  const idle = renderDay(local, false);
  assert.match(idle, /aria-label="用 AI 整理「跟林教授 meeting 討論期末專題提案，記得帶筆電」"/);
  assert.match(idle, /class="tl-acts"/);
  const busy = renderDay(local, true);
  assert.match(busy, /整理中…/);
  assert.doesNotMatch(busy, /tl-tidy/, "no second 整理 while one runs");
  // In the actions slot, not as another line under the title: the rows below do not jump.
  assert.match(busy, /<div class="tl-acts"><span class="ai-tag inline tidy-mark" role="status"[^>]*>.*整理中…<\/span>/);
  assert.doesNotMatch(busy, /<div class="tl-body">(?:(?!<\/div>).)*tidy-mark/);
  const inGoogle = renderDay({ ...local, inGoogle: true }, false);
  assert.doesNotMatch(inGoogle, /tl-tidy|tl-del/);
  // 加入行事曆 from a mail suggestion or 排進: source text, never sent to the model.
  assert.doesNotMatch(renderDay({ ...local, typed: undefined }, false), /tl-tidy/);
});

test("#/calendar: a tidied local event offers 復原整理 in the 整理 slot, until it is in Google", () => {
  const tidied = { ...local, title: "跟林教授討論期末專題提案", tidied: true };
  const html = renderDay(tidied, false);
  assert.match(html, /aria-label="復原「跟林教授討論期末專題提案」的整理"/);
  assert.doesNotMatch(html, /用 AI 整理/, "one button in the slot");
  assert.doesNotMatch(renderDay({ ...tidied, inGoogle: true }, false), /復原「/);
});
