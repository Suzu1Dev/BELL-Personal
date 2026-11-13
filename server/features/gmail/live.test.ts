import test from "node:test";
import assert from "node:assert/strict";
import type { MailMessage } from "../../../shared/mail.js";
import { LIVE_MAX_BODY_BYTES, LIVE_MAX_IMAGE_BYTES, LIVE_MAX_MESSAGES, LIVE_TTL_MS, LiveMail } from "./live.js";

const message = (id: string, threadId = id): MailMessage => ({
  id, threadId, from: { email: "a@example.com" }, subject: id, snippet: "", receivedAt: "2026-10-01T00:00:00.000Z",
  unread: false, labels: [], webUrl: `https://mail.google.com/mail/u/0/#all/${threadId}`,
});

test("live reads expire after five minutes, the least recently used go first, and an action forgets its conversation", (t) => {
  let now = 1_000_000;
  const live = new LiveMail(() => now);
  t.after(() => live.close());
  live.putMessage(message("a", "thread-1"));
  live.putMessage(message("b", "thread-1"));
  live.putThread("thread-1", [message("a", "thread-1"), message("b", "thread-1")]);
  live.putMessage(message("c", "thread-2"));
  assert.equal(live.size, 4);

  live.forgetThread("thread-1");
  assert.deepEqual([live.message("a"), live.message("b"), live.thread("thread-1")], [undefined, undefined, undefined]);
  assert.equal(live.message("c")?.id, "c");

  now += LIVE_TTL_MS - 1;
  assert.equal(live.message("c")?.id, "c", "still fresh just before five minutes");
  now += 1;
  assert.equal(live.message("c"), undefined, "gone at five minutes");

  live.putMessage(message("first"));
  for (let index = 0; index < LIVE_MAX_MESSAGES; index++) live.putMessage(message(`m${index}`));
  assert.equal(live.message("first"), undefined, "the oldest entry made room");
  assert.equal(live.size, LIVE_MAX_MESSAGES);

  now += LIVE_TTL_MS;
  live.sweep();
  assert.equal(live.size, 0, "the sweep empties expired entries without anyone reading them");
});

test("bodies and images are bounded by bytes, forgotten with their conversation, and gone after five minutes", (t) => {
  let now = 1_000_000;
  const live = new LiveMail(() => now);
  t.after(() => live.close());
  const body = (id: string, threadId: string) => ({ messageId: id, threadId, from: { email: "a@b.com" }, html: "<p>x</p>", images: [] });
  live.putBody(body("m1", "t1"), 1000);
  live.putImage("part:m1:1", { bytes: Buffer.alloc(2000) }, "t1");
  live.putImage("remote:https://a.com/x.png", { bytes: Buffer.alloc(3000) });
  assert.equal(live.heldBytes, 6000);
  live.forgetThread("t1");
  assert.deepEqual([live.body("m1"), live.image("part:m1:1")], [undefined, undefined]);
  assert.ok(live.image("remote:https://a.com/x.png"), "a remote image belongs to no conversation");
  assert.equal(live.heldBytes, 3000);

  // The byte budget drops the least recently used first; one entry bigger than the budget is not held at all.
  const chunk = Math.floor(LIVE_MAX_IMAGE_BYTES / 4);
  for (let index = 0; index < 5; index++) live.putImage(`remote:${index}`, { bytes: Buffer.alloc(chunk) });
  assert.equal(live.image("remote:https://a.com/x.png"), undefined);
  assert.equal(live.image("remote:0"), undefined);
  assert.ok(live.image("remote:4"));
  live.putBody(body("huge", "t9"), LIVE_MAX_BODY_BYTES + 1);
  assert.equal(live.body("huge"), undefined);

  now += LIVE_TTL_MS;
  live.sweep();
  assert.deepEqual([live.size, live.heldBytes], [0, 0]);
});
