import test from "node:test";
import assert from "node:assert/strict";
import { matchItems, splitCapturePrefix } from "./match";

const items = [
  { label: "今天", keywords: ["today"] },
  { label: "收件匣", keywords: ["inbox", "mail", "信"] },
  { label: "待辦", keywords: ["tasks", "todo"] },
  { label: "作業與專案", keywords: ["work", "github"] },
];

test("labels match strongly and rank above keyword matches", () => {
  assert.deepEqual(matchItems(items, "").items.map((item) => item.label), ["今天", "收件匣", "待辦", "作業與專案"]);
  assert.deepEqual(matchItems(items, "待辦"), { items: [items[2]], strong: true });
  assert.deepEqual(matchItems(items, "專案"), { items: [items[3]], strong: true });
  assert.deepEqual(matchItems(items, "Mail"), { items: [items[1]], strong: false }, "keywords are case-insensitive but weak");
  assert.deepEqual(matchItems(items, "明天 9:00 交報告"), { items: [], strong: false });
});

test("a leading + switches to capture mode and is stripped", () => {
  assert.deepEqual(splitCapturePrefix("+ 明天 9:00 交報告", "go"), { mode: "capture", text: "明天 9:00 交報告" });
  assert.deepEqual(splitCapturePrefix("＋讀書", "go"), { mode: "capture", text: "讀書" });
  assert.deepEqual(splitCapturePrefix("收件匣", "go"), { mode: "go", text: "收件匣" });
  assert.deepEqual(splitCapturePrefix("交報告", "capture"), { mode: "capture", text: "交報告" });
});
