/**
 * BacklogNote (payload.backlog): one quiet line with a link to #/tasks on the
 * undated group; nothing while loading, after a failed first load, or at 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TodayPayload } from "../../../shared/today";
import { BacklogNote } from "./BacklogNote";
import { FocusQueue } from "./FocusQueue";

const fixture = (name: string): TodayPayload =>
  JSON.parse(readFileSync(new URL(`../../../server/fixtures/today-${name}.json`, import.meta.url), "utf8")) as TodayPayload;
const note = (payload: TodayPayload | undefined) => renderToStaticMarkup(createElement(BacklogNote, { payload }));
const noop = () => {};

test("a backlog shows one calm line and a link to the undated group", () => {
  const html = note({ ...fixture("2026-10-12"), backlog: { undatedTodos: 3 } });
  assert.match(html, /^<p class="backlog"><span>還有 3 件待辦沒排日期<\/span><a class="link" href="#\/tasks\?group=someday">去排一下/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.equal(/btn|notice|pill|role="alert"/.test(html), false, "no alert, pill or button chrome");
});

test("no payload (loading, or the first load failed), no backlog and a backlog of 0 render nothing", () => {
  assert.equal(note(undefined), "");
  assert.equal(note(fixture("2026-10-12")), "");
  assert.equal(note({ ...fixture("2026-10-12"), backlog: { undatedTodos: 0 } }), "");
});

test("the queue ignores the backlog: same rows, same count", () => {
  const payload = fixture("2026-10-12");
  const props = (data: TodayPayload) => ({ payload: data, pollState: "ready" as const, onAct: noop, onRetry: noop, onSyncSources: noop, onCapture: noop, onUndoHandled: noop, onToggleHabit: noop });
  assert.equal(
    renderToStaticMarkup(createElement(FocusQueue, props({ ...payload, backlog: { undatedTodos: 5 } }))),
    renderToStaticMarkup(createElement(FocusQueue, props(payload))),
  );
});
