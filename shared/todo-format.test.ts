import assert from "node:assert/strict";
import test from "node:test";
import { todoDeadline, todoDueAt, todoWhen } from "./todo-format.js";

const TZ = "Asia/Taipei";
const NOW = new Date("2026-10-12T08:42:00+08:00");
const TODAY = "2026-10-12";

test("todoDueAt: the due time, else 23:59 that day", () => {
  assert.equal(todoDueAt({ dueDay: "2026-10-12", dueTime: "14:00" }, TZ), "2026-10-12T06:00:00.000Z");
  assert.equal(todoDueAt({ dueDay: "2026-10-12" }, TZ), "2026-10-12T15:59:00.000Z");
  assert.equal(todoDueAt({}, TZ), undefined);
});

test("todoWhen follows the SPEC time phrasing", () => {
  assert.deepEqual(todoWhen({ dueDay: "2026-10-12", dueTime: "14:00" }, TODAY, NOW, TZ), { label: "14:00", tone: "warm", mono: true });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-12", dueTime: "20:00" }, TODAY, NOW, TZ), { label: "20:00", mono: true });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-12", dueTime: "08:00" }, TODAY, NOW, TZ), { label: "逾期 1 小時", tone: "hot", mono: false });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-12" }, TODAY, NOW, TZ), { label: "今天到期", mono: false });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-13" }, TODAY, NOW, TZ), { label: "明天到期", mono: false });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-13", dueTime: "09:00" }, TODAY, NOW, TZ), { label: "明天 09:00", mono: false });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-16" }, TODAY, NOW, TZ), { label: "還有 4 天", tone: "muted", mono: false });
  assert.deepEqual(todoWhen({ dueDay: "2026-10-09" }, TODAY, NOW, TZ), { label: "逾期 2 天", tone: "hot", mono: false });
  assert.equal(todoWhen({}, TODAY, NOW, TZ), undefined);
});

test("todoDeadline phrases the due for meta lines", () => {
  assert.equal(todoDeadline({ dueDay: "2026-10-12", dueTime: "23:59" }, TODAY, NOW, TZ), "今晚 23:59 截止");
  assert.equal(todoDeadline({ dueDay: "2026-10-12" }, TODAY, NOW, TZ), "今天截止");
  assert.equal(todoDeadline({ dueDay: "2026-10-13" }, TODAY, NOW, TZ), "明天截止");
  assert.equal(todoDeadline({ dueDay: "2026-10-16" }, TODAY, NOW, TZ), "週五截止");
  assert.equal(todoDeadline({ dueDay: "2026-10-20" }, TODAY, NOW, TZ), "10/20 截止");
  assert.equal(todoDeadline({ dueDay: "2026-10-14", dueTime: "10:00" }, TODAY, NOW, TZ), "週三 10:00 截止");
  assert.equal(todoDeadline({}, TODAY, NOW, TZ), undefined);
});
