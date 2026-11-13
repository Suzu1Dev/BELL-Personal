/**
 * The keyboard shortcut registry and the one global keydown listener
 * (SPEC-ux §6.2). `SHORTCUTS` is the single source for the `?` dialog and
 * palette hints; the dispatcher applies one guard to
 * every handler:
 *
 *   IME composing → ignore everything (even ⌘K).
 *   ⌘K / Ctrl K   → always (also inside inputs).
 *   ⌘Z / Ctrl Z   → undo (only while an undo toast is visible; the handler decides),
 *                   also from an empty text field, where the browser has nothing to undo.
 *   typing target, a non-palette <dialog open>, Alt, other ⌘/Ctrl combos → ignore.
 *   單鍵快捷鍵 off → ignore letters, digits and symbols (Esc, ↵, arrows, Space still work).
 *   G then X within 1 s → the chord "g x".
 *
 * Pages add their own keys with `useShortcuts({ j: …, e: … })`; the most
 * recently mounted handler wins, and returning `false` passes the key on.
 */
import { useEffect, useRef } from "react";
import { ACTION_LABELS } from "../copy/common";
import { guideCopy, SHORTCUT_LABELS } from "../copy/guide";
import { onboardingLocale } from "../copy/onboarding";
import { blockingDialogOpen, hasModKey, isApplePlatform, isComposing, isEmptyTextField, isTypingTarget, modKeyLabel, normalizeKey, type KeyEventLike } from "./keys";
import { singleKeyStore } from "./preferences";

export type ShortcutScope = "everywhere" | "list" | "inbox" | "habits" | "toast";

export interface ShortcutDef {
  id: keyof typeof SHORTCUT_LABELS;
  /** Dispatcher combos: "n", "g t", "mod+k", "arrowdown", "space", "escape", "1"… */
  combos: string[];
  /** Display alternatives; each inner array is one sequence of <kbd>. "Mod" renders ⌘ or Ctrl. */
  keys: string[][];
  scope: ShortcutScope;
}

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "palette", combos: ["mod+k"], keys: [["Mod", "K"]], scope: "everywhere" },
  { id: "capture", combos: ["n"], keys: [["N"]], scope: "everywhere" },
  { id: "help", combos: ["?"], keys: [["?"]], scope: "everywhere" },
  { id: "goToday", combos: ["g t"], keys: [["G", "T"]], scope: "everywhere" },
  { id: "goBot", combos: ["g b"], keys: [["G", "B"]], scope: "everywhere" },
  { id: "goInbox", combos: ["g i"], keys: [["G", "I"]], scope: "everywhere" },
  { id: "goCalendar", combos: ["g c"], keys: [["G", "C"]], scope: "everywhere" },
  { id: "goTasks", combos: ["g d"], keys: [["G", "D"]], scope: "everywhere" },
  { id: "goWork", combos: ["g w"], keys: [["G", "W"]], scope: "everywhere" },
  { id: "goEvents", combos: ["g e"], keys: [["G", "E"]], scope: "everywhere" },
  { id: "goIdeas", combos: ["g l"], keys: [["G", "L"]], scope: "everywhere" },
  { id: "goHabits", combos: ["g h"], keys: [["G", "H"]], scope: "everywhere" },
  { id: "next", combos: ["j", "arrowdown"], keys: [["J"], ["↓"]], scope: "list" },
  { id: "prev", combos: ["k", "arrowup"], keys: [["K"], ["↑"]], scope: "list" },
  { id: "primary", combos: ["enter"], keys: [["↵"]], scope: "list" },
  { id: "close", combos: ["e"], keys: [["E"]], scope: "list" },
  { id: "snooze", combos: ["s"], keys: [["S"]], scope: "list" },
  { id: "todo", combos: ["t"], keys: [["T"]], scope: "list" },
  { id: "calendar", combos: ["c"], keys: [["C"]], scope: "list" },
  { id: "expand", combos: ["space"], keys: [["Space"]], scope: "list" },
  // SPEC-mail-assignments §6: 刪除 and 轉成作業 on mail rows, / for the mail search.
  { id: "trash", combos: ["#", "delete"], keys: [["#"], ["Delete"]], scope: "list" },
  { id: "assignment", combos: ["a"], keys: [["A"]], scope: "list" },
  { id: "search", combos: ["/"], keys: [["/"]], scope: "inbox" },
  // SPEC-mail-html §5: 顯示圖片 on the open message (the reader, 原始版面).
  { id: "images", combos: ["i"], keys: [["I"]], scope: "inbox" },
  { id: "escape", combos: ["escape"], keys: [["Esc"]], scope: "everywhere" },
  { id: "undo", combos: ["z", "mod+z"], keys: [["Z"], ["Mod", "Z"]], scope: "toast" },
  { id: "habits", combos: DIGITS, keys: [["1–9"]], scope: "habits" },
];

/** `G` chords → the hash they open. */
export const GO_CHORDS: Readonly<Record<string, string>> = {
  "g t": "#/today",
  "g b": "#/bot",
  "g i": "#/inbox",
  "g c": "#/calendar",
  "g d": "#/tasks",
  "g w": "#/work",
  "g e": "#/events",
  "g l": "#/ideas",
  "g h": "#/habits",
};

export function shortcut(id: ShortcutDef["id"]): ShortcutDef {
  const found = SHORTCUTS.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown shortcut ${id}`);
  return found;
}

/** Replaces "Mod" with ⌘ or Ctrl for display. */
export function displayKeys(keys: string[], apple: boolean = isApplePlatform()): string[] {
  return keys.map((key) => (key === "Mod" ? modKeyLabel(apple) : key));
}

/** The inbox list legend (SPEC-mail-assignments §6): `J K 移動 · E 封存 · # 刪除 · / 搜尋 · Z 復原 · ? 全部`. */
export function inboxLegendItems(): Array<{ keys: string[]; label: string }> {
  return [
    { keys: ["J", "K"], label: SHORTCUT_LABELS.next.short },
    { keys: ["E"], label: onboardingLocale() === "en" ? guideCopy().shortcutLabels.close.short : ACTION_LABELS.archive },
    ...(["trash", "search", "undo", "help"] as const).map((id) => ({ keys: shortcut(id).keys[0], label: SHORTCUT_LABELS[id].short })),
  ];
}

/**
 * The key the toast's 復原 advertises: Z, or ⌘Z / Ctrl Z when a bare Z would
 * not undo (單鍵快捷鍵 off, or focus in a text field where it types a z).
 */
export function undoKeyHint(singleKeys: boolean, typing: boolean, apple: boolean = isApplePlatform()): string {
  return singleKeys && !typing ? "Z" : `${modKeyLabel(apple)}${apple ? "" : " "}Z`;
}

/** Hints for named keys and chords (↵, Esc, ↑↓, ⌘K) work with 單鍵快捷鍵 off; a single letter, digit or symbol does not. */
const NAMED_HINTS = new Set(["↵", "Esc", "esc", "↑", "↓", "←", "→", "Space", "Tab"]);

/**
 * The kbd hint to show for `label`, or undefined when it would advertise a
 * key that does nothing: 單鍵快捷鍵 off silences single letters, digits and
 * symbols (SPEC-ux §6.2: the hints shown match what works).
 */
export function visibleKeyHint(label: string | undefined, singleKeys: boolean): string | undefined {
  if (!label || singleKeys || NAMED_HINTS.has(label)) return label;
  const single = [...label].length === 1 || /^\d[–-]\d$/.test(label);
  return single ? undefined : label;
}

/** Single-key shortcuts are letters, digits and symbols (WCAG 2.1.4); these named keys are not. */
const NAMED_KEYS = new Set(["escape", "enter", "arrowup", "arrowdown", "arrowleft", "arrowright", "space", "tab"]);

export type ShortcutHandler = (combo: string, event: KeyEventLike & { preventDefault(): void }) => boolean | void;

export interface DispatcherOptions {
  singleKeys: () => boolean;
  apple: () => boolean;
  dialogOpen: () => boolean;
  now: () => number;
  chordWindowMs?: number;
}

export interface ShortcutDispatcher {
  /** Returns true when a handler took the key (and preventDefault was called). */
  handle(event: KeyEventLike & { preventDefault(): void }): boolean;
  register(handler: ShortcutHandler): () => void;
}

export function createShortcutDispatcher(options: DispatcherOptions): ShortcutDispatcher {
  const handlers: ShortcutHandler[] = [];
  const chordWindow = options.chordWindowMs ?? 1000;
  let chordStartedAt: number | undefined;

  const dispatch = (combo: string, event: KeyEventLike & { preventDefault(): void }): boolean => {
    for (let index = handlers.length - 1; index >= 0; index--) {
      if (handlers[index](combo, event) === true) {
        event.preventDefault();
        return true;
      }
    }
    return false;
  };

  return {
    handle(event) {
      if (isComposing(event)) return false;
      const key = normalizeKey(event.key);
      const apple = options.apple();
      const mod = hasModKey(event, apple);
      if (mod && !event.altKey && key === "k") return dispatch("mod+k", event);
      const undo = mod && key === "z" && !event.shiftKey && !event.altKey;
      // Text undo wins in a field with text; an empty one (the capture field right after ↵) undoes the action.
      if (undo && isEmptyTextField(event.target) && !options.dialogOpen()) return dispatch("mod+z", event);
      if (isTypingTarget(event.target) || options.dialogOpen() || event.altKey) return false;
      if (undo) return dispatch("mod+z", event);
      if (event.metaKey || event.ctrlKey) return false;
      const named = NAMED_KEYS.has(key);
      if (!named && !options.singleKeys()) return false;

      if (chordStartedAt !== undefined) {
        const fresh = options.now() - chordStartedAt <= chordWindow;
        chordStartedAt = undefined;
        if (fresh && !named) return dispatch(`g ${key}`, event) || (event.preventDefault(), true);
      }
      if (key === "g" && !event.shiftKey) {
        chordStartedAt = options.now();
        event.preventDefault();
        return true;
      }
      return dispatch(key, event);
    },
    register(handler) {
      handlers.push(handler);
      return () => {
        const index = handlers.lastIndexOf(handler);
        if (index >= 0) handlers.splice(index, 1);
      };
    },
  };
}

let globalDispatcher: ShortcutDispatcher | undefined;

/** The app's dispatcher, with its one window listener installed on first use. */
export function shortcutDispatcher(): ShortcutDispatcher {
  if (!globalDispatcher) {
    const apple = isApplePlatform();
    globalDispatcher = createShortcutDispatcher({
      singleKeys: () => singleKeyStore.get(),
      apple: () => apple,
      dialogOpen: () => blockingDialogOpen(),
      now: () => Date.now(),
    });
    const dispatcher = globalDispatcher;
    window.addEventListener("keydown", (event) => { dispatcher.handle(event); });
  }
  return globalDispatcher;
}

/**
 * Registers key handlers while the component is mounted:
 * `useShortcuts({ j: () => move(1), e: () => close() })`. A handler that
 * returns `false` lets older handlers see the key; anything else consumes it.
 */
export function useShortcuts(map: Record<string, (event: KeyEventLike) => boolean | void>, enabled = true): void {
  const mapRef = useRef(map);
  mapRef.current = map;
  useEffect(() => {
    if (!enabled) return;
    return shortcutDispatcher().register((combo, event) => {
      const handler = mapRef.current[combo];
      if (!handler) return false;
      return handler(event) !== false;
    });
  }, [enabled]);
}
