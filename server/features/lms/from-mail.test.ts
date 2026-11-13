import assert from "node:assert/strict";
import test from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { MailMessage } from "../../../shared/mail.js";
import type { ActionRequest } from "../../modules.js";
import { testServices } from "../../test-helpers.js";
import { connectGoogle, FakeGmail } from "../gmail/fake-gmail.js";
import { liveMail } from "../gmail/live.js";
import { convertMailHandler } from "./from-mail.js";
import { MOODLE_NOW as NOW } from "./test-support.js";

/**
 * 轉成作業 on a mail read live (封存, a search): the action plan lives in
 * memory for a day (undo), but the mail's text may stay in server memory for
 * 5 minutes only (/privacy §02, SPEC-mail-assignments D4). The plan keeps
 * the ids, the link and the extracted fields, never the message.
 */

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

test("the 轉成作業 plan does not keep the live mail (its plain-text excerpt) reachable once the 5-minute hold drops it", async (t) => {
  const gmail = new FakeGmail(() => NOW);
  const services = testServices(t, { seams: { fetch: gmail.fetch, now: () => NOW } });
  await connectGoogle(services);
  const live = liveMail(services);
  let message: MailMessage | undefined = {
    id: "live-hw7", threadId: "live-thread", from: { name: "王助教", email: "ta-os@cs.nycu.edu.tw" }, subject: "HW7 公告",
    snippet: "HW7 請於 10/30 前上傳", excerpt: `HW7 請於 10/30 前上傳到 E3。${"秘密內容".repeat(500)}`, receivedAt: "2026-10-05T02:00:00.000Z",
    unread: false, labels: [], webUrl: "https://mail.google.com/mail/u/0/#all/live-thread",
  };
  live.putMessage(message);
  const held = new WeakRef(message);
  message = undefined;

  const request: ActionRequest = { actionId: "a1", itemId: "gmail:live-hw7", source: "gmail", sourceId: "live-hw7", action: "assignment", params: {}, day: "2026-10-12", now: NOW };
  const plan = await convertMailHandler()(request, services);
  assert.equal(plan.target?.title, "HW7");

  live.clear(); // the 5-minute hold ends (or 清除快取的信件)
  await new Promise((resolve) => setImmediate(resolve));
  gc();
  assert.ok(held.deref() === undefined, "nothing in the plan keeps the message");
  const applied = await plan.apply!();
  assert.deepEqual(applied && { title: applied.created?.title, dueAt: applied.created?.dueAt }, { title: "HW7", dueAt: "2026-10-30T15:59:00.000Z" }, "and it still creates the assignment");
});
