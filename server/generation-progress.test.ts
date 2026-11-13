import test from "node:test";
import assert from "node:assert/strict";
import type { JobEvent } from "../shared/jobs.js";
import { taskDeadline, withGenerationProgress } from "./generation-progress.js";

test("progress heartbeats carry metadata only and stop when the task ends", async () => {
  const events: JobEvent[] = [];
  const result = await withGenerationProgress("整理今日摘要", "brief", (event) => events.push(event), new AbortController().signal, async (onProgress) => {
    onProgress({ phase: "thinking" });
    await new Promise((resolve) => setTimeout(resolve, 35));
    onProgress({ phase: "waiting", notice: "Claude 額度接近上限。" });
    return 42;
  }, 10);
  assert.equal(result, 42);
  const messages = events.map((event) => (event as { message: string }).message);
  assert.ok(messages.length >= 3);
  assert.match(messages[0], /^正在整理今日摘要…正在等候模型回應（已進行 0 秒）。$/);
  assert.ok(messages.some((message) => message.includes("正在思考")));
  assert.ok(messages.some((message) => message.includes("Claude 額度接近上限。")));
  const count = events.length;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(events.length, count);
});

test("a task deadline aborts with a 504 carrying its message", async () => {
  const deadline = taskDeadline(new AbortController().signal, 10, "今日摘要超過時間上限。");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(deadline.signal.aborted, true);
  assert.equal((deadline.signal.reason as { status?: number }).status, 504);
  deadline.dispose();
});
