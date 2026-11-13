/**
 * Keyboard guards shared by every key handler (SPEC-ux §6.2). Pure and
 * DOM-light so they run under node:test with plain objects.
 *
 * Every keydown handler in src/ must call `isComposing(e)` first: Bopomofo and
 * other IMEs send keydown events while composing, and acting on them would
 * archive mail while the user is typing 注音.
 */

/** The fields of a KeyboardEvent the guards read. */
export interface KeyEventLike {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  target?: unknown;
}

/** True while an IME is composing: `isComposing`, or keyCode 229 (Safari and older Chrome). */
export function isComposing(event: Pick<KeyEventLike, "isComposing" | "keyCode">): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

interface ElementLike {
  tagName?: unknown;
  isContentEditable?: unknown;
}

/** Inputs, textareas, selects and contentEditable elements receive keys as text, never as shortcuts. */
export function isTypingTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as ElementLike;
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return element.isContentEditable === true;
}

/**
 * An empty text input or textarea: nothing for the browser's own text undo
 * to act on, so ⌘Z there may undo the last action (after ↵ in the capture
 * field focus stays in the now empty field).
 */
export function isEmptyTextField(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as ElementLike & { value?: unknown; type?: unknown };
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag !== "INPUT" && tag !== "TEXTAREA") return false;
  if (tag === "INPUT" && typeof element.type === "string" && !TEXT_INPUT_TYPES.has(element.type.toLowerCase())) return false;
  return element.value === "";
}

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "email", "tel"]);

interface DocumentLike {
  querySelectorAll(selector: string): ArrayLike<{ classList: { contains(name: string): boolean } }>;
}

/** An open `<dialog>` other than the command palette suspends global shortcuts. */
export function blockingDialogOpen(root: DocumentLike | undefined = typeof document === "undefined" ? undefined : document): boolean {
  if (!root) return false;
  return Array.from(root.querySelectorAll("dialog[open]")).some((dialog) => !dialog.classList.contains("palette"));
}

/** ⌘ on Apple platforms, Ctrl elsewhere (brief B4: /Mac|iPhone|iPad|iPod/). */
export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** The platform modifier: metaKey on Apple, ctrlKey elsewhere (and not both). */
export function hasModKey(event: Pick<KeyEventLike, "metaKey" | "ctrlKey">, apple: boolean): boolean {
  return apple ? event.metaKey === true && event.ctrlKey !== true : event.ctrlKey === true && event.metaKey !== true;
}

/** Display label of the modifier for kbd hints: 「⌘」 or 「Ctrl」. */
export function modKeyLabel(apple: boolean = isApplePlatform()): string {
  return apple ? "⌘" : "Ctrl";
}

/**
 * The key as the shortcut table spells it: letters lower-case, " " → "space",
 * "Esc" → "escape", "ArrowDown" → "arrowdown". Digits and "?" stay as they are.
 */
export function normalizeKey(key: string): string {
  if (key === " " || key === "Spacebar") return "space";
  if (key === "Esc") return "escape";
  return key.toLowerCase();
}
