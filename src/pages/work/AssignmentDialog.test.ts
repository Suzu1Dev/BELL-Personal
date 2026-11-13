import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssignmentView } from "../../../shared/assignments";
import { ToastProvider } from "../../components/toast/ToastProvider";
import { AppSettingsProvider } from "../../lib/app-settings";
import { AssignmentDialog } from "./AssignmentDialog";

const noop = () => {};

test("?lang=en renders the assignment dialog and mail provenance without CJK form copy", (t) => {
  const previous = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { location: { search: "?lang=en" } };
  t.after(() => { (globalThis as { window?: unknown }).window = previous; });

  const row = {
    origin: "mail",
    externalId: "a1",
    title: "HW5",
    courseName: "Operating Systems",
    mailSender: "Ada",
    mailRef: { threadId: "mail-1" },
  } as AssignmentView;
  const html = renderToStaticMarkup(createElement(ToastProvider, null,
    createElement(AppSettingsProvider, null,
      createElement(AssignmentDialog, { open: true, row, timeZone: "Asia/Taipei", onClose: noop, onSaved: noop, onDelete: noop }))));

  for (const text of [
    "Edit assignment", "Assignment title", "e.g., HW5: System calls", "Course", "e.g., Operating Systems",
    "Due date", "Due time", "Defaults to 23:59 that day", "How to submit", "e.g., Upload to E3 or drop off at office",
    "Link", "Submission page or handout, optional", "Notes", "Save", "Cancel", "Delete assignment", "Email from Ada", "Open email",
  ]) assert.ok(html.includes(text), `missing English copy: ${text}`);
  const dialog = html.match(/<dialog[\s\S]*<\/dialog>/)?.[0] ?? "";
  assert.ok(dialog, "the assignment dialog rendered");
  assert.match(dialog, /class="dialog-head"[\s\S]*aria-label="Close dialog"/);
  assert.doesNotMatch(dialog, /[㐀-鿿豈-﫿]/);
});
