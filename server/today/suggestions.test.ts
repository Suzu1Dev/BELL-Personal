import test from "node:test";
import assert from "node:assert/strict";
import { testServices } from "../test-helpers.js";
import { SUGGESTION_ROWS_MAX, suggestionContribution } from "./suggestions.js";

const NOW = new Date("2026-10-24T02:00:00.000Z"); // Saturday 10:00 in Taipei
const TZ = "Asia/Taipei";
const days = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

function setup(t: test.TestContext) {
  const services = testServices(t, { seams: { now: () => NOW } });
  const event = (title: string, start: string, extra: Record<string, unknown> = {}) =>
    services.suggestions.create({ kind: "event", title, payload: { title, start, allDay: false, ...extra } });
  const todo = (title: string, dueDay?: string) => services.suggestions.create({ kind: "todo", title, payload: { title, ...(dueDay ? { dueDay } : {}) } });
  const shown = () => suggestionContribution(services.suggestions, { now: NOW, timeZone: TZ }).queue!.map((row) => row.meta[0]);
  return { services, event, todo, shown };
}

test("a proposal that is already over is not a decision for today", (t) => {
  const { event, todo, shown } = setup(t);
  event("started yesterday", days(-1));
  event("running now, ends later", days(-0.01), { end: days(0.1) });
  todo("due yesterday", "2026-10-23");
  todo("due today", "2026-10-24");
  assert.deepEqual(shown().sort(), ["due today", "running now, ends later"]);
});

test("an event more than two weeks away waits on #/events, a todo does not wait", (t) => {
  const { event, todo, shown } = setup(t);
  event("lecture next month", days(20));
  event("lecture in 13 days", days(13));
  todo("someday", undefined);
  assert.deepEqual(shown().sort(), ["lecture in 13 days", "someday"]);
});

test("at most three proposals at once, the most urgent first, the next one when one is decided", (t) => {
  const { services, event, todo, shown } = setup(t);
  assert.equal(SUGGESTION_ROWS_MAX, 3);
  event("in 9 days", days(9));
  todo("undated old");
  event("tomorrow", days(1));
  todo("due in 3 days", "2026-10-27");
  event("in 5 days", days(5));
  assert.deepEqual(shown(), ["tomorrow", "due in 3 days", "in 5 days"]);
  const first = services.suggestions.list({ status: "pending" }).find((suggestion) => suggestion.title === "tomorrow")!;
  services.suggestions.decide(first.id, "dismissed");
  assert.deepEqual(shown(), ["due in 3 days", "in 5 days", "in 9 days"]);
  assert.equal(services.suggestions.list({ status: "pending" }).length, 4, "the held-back ones stay pending");
});

test("assignment proposals are never held back by the cap, only dropped when their deadline passed", (t) => {
  const { services, event, shown } = setup(t);
  for (let i = 1; i <= 4; i++) event(`event ${i}`, days(i));
  const assignment = (title: string, dueAt: string | null) => services.suggestions.create({ kind: "assignment", title, payload: { title, dueAt } });
  assignment("HW open", days(3));
  assignment("HW undated", null);
  assignment("HW closed", days(-1));
  const rows = shown();
  assert.deepEqual(rows.slice(0, 2).sort(), ["HW open", "HW undated"]);
  assert.equal(rows.length, 2 + SUGGESTION_ROWS_MAX);
  assert.ok(!rows.includes("HW closed"));
});
