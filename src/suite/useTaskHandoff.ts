/**
 * The to-do draft that arrives from a sibling (bell-suite SPEC §4.3, §5.5):
 * `#/tasks?draft=<text>&from=explain&back=<hash>`.
 *
 *   1. captureTaskHandoff() runs on mount and on every hashchange (AppShell,
 *      before the router reads the hash). When the hash is `#/tasks` with any
 *      reserved handoff key (text, title, draft, from, back) it keeps the raw
 *      hash in memory and, in the same synchronous step, replaceState()s the
 *      address to plain `#/tasks`; it also deletes any older draft (a new
 *      handoff attempt, valid or not, always replaces the old one). Without a
 *      reserved key nothing changes: the stored draft stays.
 *   2. Once the manifest has loaded, the captured hash is validated
 *      (parseTaskHandoff: no reserved key twice, a `draft` key, `from` must
 *      be a linked sibling, the text is cleaned and clipped, a bad `back`
 *      drops only the back link; any refusal shows a notice with 關閉) and
 *      the draft is written whole to sessionStorage, so a reload in the same
 *      tab restores it.
 *   3. Only 建立待辦 writes (TaskDraftPanel); 捨棄草稿 and a successful
 *      creation delete the key.
 *
 * Nothing here calls the server except the manifest read, and nothing calls an AI.
 */
import { useSyncExternalStore } from "react";
import {
  clearTaskHandoff,
  hasTaskHandoffParams,
  parseTaskHandoff,
  readTaskHandoff,
  TASK_ROUTE,
  toStoredHandoff,
  writeTaskHandoff,
  type StoredTaskHandoff,
  type TaskHandoffRejection,
} from "./handoff";
import { getManifest, loadManifest, subscribeManifest } from "./useSuite";

export type TaskHandoffState =
  | { kind: "none" }
  /** Captured; waiting for the manifest to say which siblings are linked. */
  | { kind: "checking" }
  /** The manifest could not be read: the draft is held in memory until 重試. */
  | { kind: "unverified" }
  /** Refused (contract rev. d): a key came twice (D9), no draft, an unlinked sender, or nothing left after cleaning. */
  | { kind: "rejected"; reason: TaskHandoffRejection }
  | { kind: "draft"; draft: StoredTaskHandoff }
  | { kind: "created"; id: string; title: string; from: StoredTaskHandoff["from"]; backUrl?: string };

const NONE: TaskHandoffState = { kind: "none" };

let state: TaskHandoffState | undefined;
/** Stays set for this #/tasks visit after discard or creation, until explicit navigation away. */
let handoffVisit = false;
/** The raw hash captured from the address bar, until it has been validated. */
let pendingHash: string | undefined;
let pendingAt: Date | undefined;
let unsubscribeManifest: (() => void) | undefined;
const listeners = new Set<() => void>();

const session = (): Storage | undefined => {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : undefined;
  } catch {
    return undefined;
  }
};

function current(): TaskHandoffState {
  if (state === undefined) {
    const stored = readTaskHandoff(session());
    if (stored) handoffVisit = true;
    state = stored ? { kind: "draft", draft: stored } : NONE;
  }
  return state;
}

function set(next: TaskHandoffState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Validates the captured hash once the manifest is known; waits for it otherwise. */
function resolvePending() {
  if (pendingHash === undefined) return;
  const manifest = getManifest();
  if (manifest.status === "loading") {
    unsubscribeManifest ??= subscribeManifest(() => resolvePending());
    if (current().kind !== "checking") set({ kind: "checking" });
    return;
  }
  unsubscribeManifest?.();
  unsubscribeManifest = undefined;
  if (manifest.status === "error") {
    set({ kind: "unverified" });
    return;
  }
  const hash = pendingHash;
  const receivedAt = pendingAt ?? new Date();
  pendingHash = undefined;
  pendingAt = undefined;
  const parsed = parseTaskHandoff(hash, manifest.links);
  if (!parsed) {
    set(NONE);
  } else if ("rejected" in parsed) {
    // Every refusal is reported, with 關閉: the page under it works as usual.
    set({ kind: "rejected", reason: parsed.rejected });
  } else {
    const draft = toStoredHandoff(parsed, receivedAt);
    writeTaskHandoff(session(), draft);
    set({ kind: "draft", draft });
  }
}

/**
 * Reads a handoff out of the address bar, if there is one. Synchronous up to
 * and including replaceState: nothing awaits before the parameters are gone.
 */
export function captureTaskHandoff(): void {
  if (typeof window === "undefined") return;
  const hash = window.location.hash;
  if (!hasTaskHandoffParams(hash)) return;
  handoffVisit = true;
  pendingHash = hash;
  pendingAt = new Date();
  window.history.replaceState(window.history.state, "", TASK_ROUTE);
  clearTaskHandoff(session());
  current();
  set({ kind: "checking" });
  resolvePending();
}

/** 重試 after the manifest could not be read. */
export function retryTaskHandoff(): void {
  if (pendingHash === undefined) return;
  set({ kind: "checking" });
  void loadManifest().then(() => resolvePending());
}

/** 捨棄草稿, or closing a notice. */
export function discardTaskHandoff(): void {
  pendingHash = undefined;
  pendingAt = undefined;
  clearTaskHandoff(session());
  set(NONE);
}

/**
 * Takes the stored draft out before the create request goes out, so a reload
 * while it is in flight cannot offer the same draft for a second write.
 * Returns a function that puts it back (the request failed).
 */
export function holdTaskHandoff(draft: StoredTaskHandoff): () => void {
  clearTaskHandoff(session());
  return () => {
    if (current().kind === "draft") writeTaskHandoff(session(), draft);
  };
}

export function taskHandoffCreated(todo: { id: string; title: string }, draft: StoredTaskHandoff, backUrl: string | undefined): void {
  clearTaskHandoff(session());
  set({ kind: "created", id: todo.id, title: todo.title, from: draft.from, ...(backUrl ? { backUrl } : {}) });
}

/** Leaving #/tasks: the 已建立 / 已忽略 notices have been seen; a draft stays until it is created or discarded. */
export function leaveTaskRoute(): void {
  handoffVisit = false;
  const now = current();
  if (now.kind === "created" || now.kind === "rejected") set(NONE);
}

/** Checked immediately before every automatic source sync; raw arrivals cannot race the first effect. */
export function taskHandoffSyncBlocked(): boolean {
  if (typeof window === "undefined" || !window.location.hash.startsWith(TASK_ROUTE)) return false;
  if (current().kind !== "none") handoffVisit = true;
  return handoffVisit || pendingHash !== undefined || hasTaskHandoffParams(window.location.hash);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The current state, outside React (tests, and code that only reads it once). */
export function getTaskHandoff(): TaskHandoffState {
  return current();
}

export function useTaskHandoff(): TaskHandoffState {
  return useSyncExternalStore(subscribe, current, () => NONE);
}
