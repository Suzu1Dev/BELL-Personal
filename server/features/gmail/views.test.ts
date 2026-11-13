import test from "node:test";
import assert from "node:assert/strict";
import { cleanSearchText, gmailViewQuery } from "./views.js";

test("each #/inbox view has its own Gmail query, and spam and trash are always left out", () => {
  assert.equal(gmailViewQuery("inbox"), "in:inbox -in:spam -in:trash");
  assert.equal(gmailViewQuery("archive"), "-in:inbox -in:snoozed -in:sent -in:drafts -in:spam -in:trash");
  assert.equal(gmailViewQuery("all"), "-in:drafts -in:spam -in:trash");
});

test("a search keeps the user's operators inside the view", () => {
  assert.equal(gmailViewQuery("archive", "  from:cmlin   HW5 "), "-in:inbox -in:snoozed -in:sent -in:drafts from:cmlin HW5 -in:spam -in:trash");
  assert.equal(gmailViewQuery("all", "from:a OR from:b"), "-in:drafts from:a OR from:b -in:spam -in:trash");
  // in:anywhere would include spam and trash; the suffix still excludes them.
  assert.match(gmailViewQuery("inbox", "in:anywhere 作業"), / -in:spam -in:trash$/);
});

test("search text is cleaned before it reaches Gmail", () => {
  assert.equal(cleanSearchText("作業\n\t報告\u0000"), "作業 報告");
  assert.equal(cleanSearchText("(HW5 OR Lab"), "HW5 OR Lab", "unpaired parentheses are dropped");
  assert.equal(cleanSearchText("(HW5 OR Lab) 作業系統"), "(HW5 OR Lab) 作業系統", "paired parentheses stay");
  assert.equal(cleanSearchText(")("), "");
  assert.equal(Array.from(cleanSearchText("作".repeat(500))).length, 200);
  assert.equal(gmailViewQuery("inbox", "   "), "in:inbox -in:spam -in:trash");
});
