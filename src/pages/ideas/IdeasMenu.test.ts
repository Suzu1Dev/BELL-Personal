import test from "node:test";
import assert from "node:assert/strict";
import type { IdeaView } from "../../../shared/ideas";
import { ideaMenuItems } from "./IdeasPage";

const idea = (archived = false): IdeaView => ({
  id: "idea-1",
  text: "一段靈感",
  title: "靈感",
  tags: [],
  pinned: true,
  archived,
  origin: "manual",
  createdAt: "2026-10-12T00:00:00.000Z",
  updatedAt: "2026-10-12T00:00:00.000Z",
  day: "2026-10-12",
  proposals: [],
});

test("the compact menu offers every active action once, with delete last and dangerous", () => {
  const calls: string[] = [];
  const items = ideaMenuItems(idea(), {
    edit: () => calls.push("edit"),
    pin: () => calls.push("pin"),
    archive: () => calls.push("archive"),
    remove: () => calls.push("remove"),
  });
  assert.deepEqual(items.map(item => item.id), ["edit", "pin", "archive", "delete"]);
  assert.deepEqual(items.map(item => item.label), ["編輯", "取消釘選", "封存", "刪除"]);
  assert.equal(items.at(-1)?.danger, true);
  for (const item of items) item.onSelect();
  assert.deepEqual(calls, ["edit", "pin", "archive", "remove"], "one selection invokes exactly one original callback");
});

test("an archived idea does not gain pin or convert-to-todo actions", () => {
  const items = ideaMenuItems(idea(true), { edit: () => {}, pin: () => {}, archive: () => {}, remove: () => {} });
  assert.deepEqual(items.map(item => item.id), ["edit", "archive", "delete"]);
  assert.deepEqual(items.map(item => item.label), ["編輯", "移回靈感", "刪除"]);
  assert.equal(items.at(-1)?.danger, true);
});
