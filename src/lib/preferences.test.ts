import test from "node:test";
import assert from "node:assert/strict";
import { effectiveTheme, nextThemeMode, type ThemeMode } from "./preferences";

test("the topbar theme toggle flips light and dark, so every click changes the screen", () => {
  for (const prefersDark of [false, true]) {
    for (const mode of ["system", "light", "dark"] as ThemeMode[]) {
      const next = nextThemeMode(mode, prefersDark);
      assert.notEqual(effectiveTheme(next, prefersDark), effectiveTheme(mode, prefersDark), `${mode} on a ${prefersDark ? "dark" : "light"} OS`);
      assert.notEqual(next, "system", "跟隨系統 is chosen in 外觀, not by the toggle");
    }
  }
  // A light OS: four clicks alternate dark, light, dark, light.
  let mode: ThemeMode = "system";
  const seen: string[] = [];
  for (let click = 0; click < 4; click++) { mode = nextThemeMode(mode, false); seen.push(effectiveTheme(mode, false)); }
  assert.deepEqual(seen, ["dark", "light", "dark", "light"]);
});
