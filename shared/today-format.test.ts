import test from "node:test";
import assert from "node:assert/strict";
import { deadlineWhen, durationText, metaDeadline, monthDayWeek, queueAction, receivedWhen, relativeStart, timeWhen } from "./today-format.js";

const TZ = "Asia/Taipei";
const NOW = new Date("2026-10-12T00:42:00.000Z"); // Mon 10/12 08:42 Taipei
const taipei = (local: string) => new Date(`${local}:00+08:00`).toISOString();

test("deadline phrases follow SPEC §10", () => {
  assert.deepEqual(deadlineWhen(taipei("2026-10-12T23:59"), NOW, TZ), { label: "剩 15 小時", tone: "hot", mono: false });
  assert.deepEqual(deadlineWhen(taipei("2026-10-12T09:10"), NOW, TZ), { label: "剩 28 分鐘", tone: "hot", mono: false });
  assert.deepEqual(deadlineWhen(taipei("2026-10-13T12:00"), NOW, TZ), { label: "明天到期", mono: false });
  assert.deepEqual(deadlineWhen(taipei("2026-10-14T23:59"), NOW, TZ), { label: "還有 2 天", tone: "muted", mono: false });
  assert.deepEqual(deadlineWhen(taipei("2026-10-20T23:59"), NOW, TZ), { label: "還有 8 天", tone: "muted", mono: false });
  assert.deepEqual(deadlineWhen(taipei("2026-10-12T05:00"), NOW, TZ), { label: "逾期 3 小時", tone: "hot", mono: false });
  assert.deepEqual(deadlineWhen(taipei("2026-10-09T23:59"), NOW, TZ), { label: "逾期 2 天", tone: "hot", mono: false });
});

test("times, received times and meta deadlines", () => {
  assert.deepEqual(timeWhen(taipei("2026-10-12T14:00"), NOW, TZ), { label: "14:00", tone: "warm", mono: true });
  assert.deepEqual(timeWhen(taipei("2026-10-12T19:30"), NOW, TZ), { label: "19:30", mono: true });
  assert.deepEqual(timeWhen(taipei("2026-10-13T09:00"), NOW, TZ), { label: "明天 09:00", mono: false });
  assert.deepEqual(receivedWhen(taipei("2026-10-12T08:05"), NOW, TZ), { label: "08:05", mono: true });
  assert.deepEqual(receivedWhen(taipei("2026-10-11T23:50"), NOW, TZ), { label: "昨天", mono: false });
  assert.deepEqual(receivedWhen(taipei("2026-10-09T10:00"), NOW, TZ), { label: "10/9", mono: false });
  assert.equal(metaDeadline(taipei("2026-10-12T23:59"), NOW, TZ), "今晚 23:59 截止");
  assert.equal(metaDeadline(taipei("2026-10-12T12:00"), NOW, TZ), "今天 12:00 截止");
  assert.equal(metaDeadline(taipei("2026-10-13T09:00"), NOW, TZ), "明天 09:00 截止");
  assert.equal(metaDeadline(taipei("2026-10-14T23:59"), NOW, TZ), "週三 23:59 截止");
  assert.equal(metaDeadline(taipei("2026-10-20T23:59"), NOW, TZ), "10/20 截止");
  assert.equal(metaDeadline(taipei("2026-10-14T23:59"), NOW, TZ, { dateOnly: true }), "10/14 截止");
  assert.equal(monthDayWeek(TZ, taipei("2026-10-25T13:30")), "10/25（日）");
  assert.equal(monthDayWeek(TZ, taipei("2026-10-17T08:00")), "10/17（六）");
});

test("relative start, durations and action presets", () => {
  assert.equal(relativeStart(taipei("2026-10-12T10:10"), NOW, TZ), "1 小時 28 分後");
  assert.equal(relativeStart(taipei("2026-10-12T09:10"), NOW, TZ), "28 分後");
  assert.equal(relativeStart(taipei("2026-10-12T10:42"), NOW, TZ), "2 小時後");
  assert.equal(relativeStart(taipei("2026-10-13T09:00"), NOW, TZ), "明天 09:00");
  assert.equal(durationText(40), "40 分鐘");
  assert.equal(durationText(48 * 60), "48 小時");
  assert.deepEqual(queueAction("submitted"), { id: "submitted", label: "標為已交", touchLabel: "已交", key: "E" });
  assert.deepEqual(queueAction("open", { label: "開啟 E3" }), { id: "open", label: "開啟 E3", touchLabel: "開啟", key: "Enter" });
  assert.deepEqual(queueAction("schedule"), { id: "schedule", label: "排進", touchLabel: "排進" });
});
