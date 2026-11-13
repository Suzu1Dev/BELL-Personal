import assert from "node:assert/strict";
import test from "node:test";
import type { IdeaView } from "../../../shared/ideas";
import { editableText, groupIdeas, ideaFromText, noteFromText } from "./model";

const TZ = "Asia/Taipei";
const NOW = new Date("2026-10-12T08:42:00+08:00");
const idea = (id: string, day: string, extra: Partial<IdeaView> = {}): IdeaView => ({
  id, text: id, tags: [], pinned: false, archived: false, origin: "manual", day,
  createdAt: `${day}T05:00:00.000Z`, updatedAt: `${day}T05:00:00.000Z`, proposals: [], ...extra,
});

test("groupIdeas: pinned first, then 今天 / 昨天 / dates, newest first", () => {
  const groups = groupIdeas([
    idea("a", "2026-10-09"), idea("b", "2026-10-12"), idea("c", "2026-10-11"), idea("d", "2026-10-06", { pinned: true }), idea("e", "2026-10-12", { createdAt: "2026-10-12T06:00:00.000Z" }),
  ], "2026-10-12", TZ);
  assert.deepEqual(groups.map((group) => group.label), ["釘選", "今天", "昨天", "10/9（五）"]);
  assert.deepEqual(groups[1].ideas.map((item) => item.id), ["e", "b"]);
  assert.deepEqual(groups[0].ideas.map((item) => item.id), ["d"]);
});

test("the Composer splits #tags off ideas and the first line off notes", () => {
  assert.deepEqual(ideaFromText("用 eBPF 量 CFS #OS #專題", NOW, TZ), { text: "用 eBPF 量 CFS", tags: ["OS", "專題"] });
  assert.deepEqual(ideaFromText("審查 #127 的想法", NOW, TZ), { text: "審查 #127 的想法", tags: [] });
  assert.deepEqual(noteFromText("讀書會心得\nCh.5 死結的四個條件 #OS", NOW, TZ), { title: "讀書會心得", text: "Ch.5 死結的四個條件", tags: ["OS"] });
  assert.deepEqual(noteFromText("只有一行", NOW, TZ), { text: "只有一行", tags: [] });
  assert.equal(editableText({ text: "CTF 平台", tags: ["CTF", "寫作"] }), "CTF 平台 #CTF #寫作");
});
