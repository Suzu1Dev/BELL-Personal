import test from "node:test";
import assert from "node:assert/strict";
import { pageLabel, visibleNavItems, workNavLabel } from "./nav";

const sections = (roles: Parameters<typeof visibleNavItems>[0], overrides?: Parameters<typeof visibleNavItems>[1]) => visibleNavItems(roles, overrides).map((item) => item.section);

test("sidebar visibility and work naming follow roles and overrides", () => {
  assert.deepEqual(sections([]), ["today", "bot", "inbox", "calendar", "tasks", "ideas", "habits"]);
  assert.deepEqual(sections(["developer"]), ["today", "bot", "inbox", "calendar", "tasks", "work", "ideas", "habits"]);
  assert.ok(sections(["ctf"]).includes("events"));
  assert.deepEqual(sections([], { events: true, github: true }), ["today", "bot", "inbox", "calendar", "tasks", "work", "events", "ideas", "habits"]);
  assert.ok(!sections(["student"], { assignments: false, projects: false }).includes("work"));
  assert.equal(workNavLabel(["student", "developer"]), "作業與專案");
  assert.equal(workNavLabel(["developer"]), "專案");
  assert.equal(workNavLabel([], { assignments: true }), "作業與專案");
  assert.equal(workNavLabel(["student"], { assignments: false }), "專案");
  assert.equal(visibleNavItems(["ctf"], { assignments: true }).find((item) => item.section === "work")?.label, "作業與專案");
  assert.equal(pageLabel({ name: "work", tab: "assignments" }, [], { assignments: true }), "作業與專案");
});
