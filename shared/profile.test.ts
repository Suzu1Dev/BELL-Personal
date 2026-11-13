import test from "node:test";
import assert from "node:assert/strict";
import { FEATURE_IDS, hiddenModules, isModuleVisible, isSectionVisible, normalizeRoles, PROFILE_ROLES, ROLE_MODULES, visibleFeatures } from "./profile.js";

test("null (settings not loaded yet) shows every module and section; [] only the shared ones", () => {
  assert.deepEqual(hiddenModules(null), []);
  for (const section of ["today", "inbox", "calendar", "tasks", "work", "events", "ideas", "habits", "settings"]) assert.equal(isSectionVisible(section, null), true, section);
  assert.deepEqual(hiddenModules([]).sort(), ["events", "github", "lms", "projects"]);
  for (const name of ["brief", "calendar", "capture", "gmail", "google", "habits", "ideas", "todos", "weather"]) assert.equal(isModuleVisible(name, []), true, name);
  for (const section of ["today", "inbox", "calendar", "tasks", "ideas", "habits", "settings", "guide"]) assert.equal(isSectionVisible(section, []), true, section);
  assert.equal(isSectionVisible("work", []), false);
  assert.equal(isSectionVisible("events", []), false);
});

test("each role turns on its own modules; #/work shows for students and developers", () => {
  // Design 01: students get 專案 too (their own projects, no GitHub).
  assert.deepEqual(hiddenModules(["student"]).sort(), ["events", "github"]);
  assert.deepEqual(hiddenModules(["developer"]).sort(), ["events", "lms"]);
  assert.deepEqual(hiddenModules(["ctf"]).sort(), ["github", "lms", "projects"]);
  assert.deepEqual(hiddenModules([...PROFILE_ROLES]), []);
  assert.equal(isSectionVisible("work", ["student"]), true);
  assert.equal(isSectionVisible("work", ["developer"]), true);
  assert.equal(isSectionVisible("work", ["ctf"]), false);
  assert.equal(isSectionVisible("events", ["ctf"]), true);
  for (const role of PROFILE_ROLES) for (const name of ROLE_MODULES[role]) assert.equal(isModuleVisible(name, [role]), true, `${role} → ${name}`);
});

test("normalizeRoles drops duplicates and keeps the PROFILE_ROLES order", () => {
  assert.deepEqual(normalizeRoles(["ctf", "student", "ctf"]), ["student", "ctf"]);
  assert.deepEqual(normalizeRoles([]), []);
});

test("visibleFeatures: none ticked, multi-select, and each role's own features (01-FLOW 身分對應的功能)", () => {
  const off = Object.fromEntries(FEATURE_IDS.map((feature) => [feature, false]));
  assert.deepEqual(visibleFeatures([]), off, "no role: only what everyone gets");
  assert.deepEqual(visibleFeatures(["student"]), { ...off, assignments: true, timetable: true, projects: true });
  assert.deepEqual(visibleFeatures(["developer"]), { ...off, projects: true, github: true });
  assert.deepEqual(visibleFeatures(["ctf"]), { ...off, events: true });
  assert.deepEqual(visibleFeatures(["student", "ctf"]), { ...off, assignments: true, timetable: true, projects: true, events: true }, "multi-select is the union");
  assert.deepEqual(visibleFeatures([...PROFILE_ROLES]), Object.fromEntries(FEATURE_IDS.map((feature) => [feature, true])));
  assert.deepEqual(visibleFeatures(null), Object.fromEntries(FEATURE_IDS.map((feature) => [feature, true])));
});

test("an override wins over the roles both ways and keeps winning after the roles change; removing it follows the roles", () => {
  // On by hand without the role.
  assert.equal(visibleFeatures(["ctf"], { github: true }).github, true);
  assert.equal(isModuleVisible("github", ["ctf"], { github: true }), true);
  assert.equal(isSectionVisible("work", ["ctf"], { github: true }), true, "one feature of #/work is enough for the section");
  // Off by hand with the role.
  assert.equal(visibleFeatures(["student"], { assignments: false }).assignments, false);
  assert.deepEqual(hiddenModules(["student"], { assignments: false }).sort(), ["events", "github", "lms"]);
  assert.equal(isSectionVisible("work", ["student"], { assignments: false }), true, "專案 still keeps #/work");
  assert.equal(isSectionVisible("work", ["student"], { assignments: false, projects: false }), false);
  assert.equal(isSectionVisible("events", [...PROFILE_ROLES], { events: false }), false);
  // The roles change later; the manual answers stay.
  const overrides = { events: false, timetable: true };
  for (const roles of [[], ["student"], ["ctf"], [...PROFILE_ROLES]] as const) {
    const features = visibleFeatures(roles, overrides);
    assert.deepEqual([features.events, features.timetable], [false, true], JSON.stringify(roles));
  }
  assert.equal(visibleFeatures(null, { events: false }).events, false, "an override wins over 'not loaded' too");
  assert.deepEqual(visibleFeatures(["ctf"], {}), visibleFeatures(["ctf"]), "no entry: the roles decide");
  assert.deepEqual(hiddenModules(null, {}), []);
});
