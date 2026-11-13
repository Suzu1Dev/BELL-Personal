/**
 * localStorage for browser-only conveniences (theme, collapsed sidebar,
 * shortcut preference, drafts). Keys are `bell-personal.*`; every access is
 * wrapped in try/catch because storage can be blocked or full, and the app
 * must work without it.
 */
import { useSyncExternalStore } from "react";

export const STORAGE_KEYS = {
  theme: "bell-personal.theme",
  sidebarCollapsed: "bell-personal.sidebar.collapsed",
  singleKeyShortcuts: "bell-personal.shortcuts.single-key",
  composerDraft: "bell-personal.composer.draft",
  todayCollapsed: "bell-personal.today.collapsed-widgets",
  /** The reader's 原始版面 / 純文字 (AppSettings `mail.bodyView`, cached for the first render). */
  mailView: "bell-personal.mail.view",
} as const;

export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Blocked or full storage: the value lives for this page only.
  }
}

export interface StoredValue<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

/**
 * A typed value persisted under `key`, shared by every component that reads
 * it and kept in sync across tabs through the `storage` event.
 */
export function storedValue<T>(key: string, parse: (raw: string | null) => T, serialize: (value: T) => string | null): StoredValue<T> {
  const listeners = new Set<() => void>();
  let cached: { raw: string | null; value: T } | undefined;
  // When storage is blocked, the last value set lives here for this page.
  let memory: string | null = null;
  let usingMemory = false;

  const read = (): T => {
    const raw = usingMemory || typeof window === "undefined" ? memory : readStorage(key);
    if (!cached || cached.raw !== raw) cached = { raw, value: parse(raw) };
    return cached.value;
  };
  const notify = () => listeners.forEach((listener) => listener());

  return {
    get: read,
    set(value) {
      const raw = serialize(value);
      memory = raw;
      if (typeof window !== "undefined") {
        writeStorage(key, raw);
        usingMemory = readStorage(key) !== raw;
      }
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      const onStorage = (event: StorageEvent) => { if (event.key === key) notify(); };
      if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
      };
    },
  };
}

export function useStoredValue<T>(store: StoredValue<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
