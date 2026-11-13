/**
 * BELL Suite handoff rules, ported from bell-suite contracts v1
 * rev. d (`reference.mjs`: isHandoffAttempt, cleanHandoff, parseHandoff, handoffUrl; validHref
 * and the §5.1 allowed routes live in shared/suite.ts). No cross-repo import:
 * change both together. Everything here is pure; the browser side (hash capture,
 * replaceState, sessionStorage) is in useTaskHandoff.ts.
 *
 *   #/tasks?draft=<text>&from=explain&back=<hash>   → a to-do draft (target personal)
 *   <explain>/#/explain?text=…&title=…&from=personal&back=<hash>   ← 解釋這個
 */
import {
  allowedSuiteRoute,
  SUITE_APP_IDS,
  SUITE_LIMITS,
  validSuiteHref,
  type SuiteAppId,
  type SuiteLinks,
} from "../../shared/suite";
import { TODO_LIMITS } from "../../shared/todos";

/** C0, DEL, C1 and the bidi controls, minus \t and \n (a draft keeps its tabs and line breaks). */
const UNSAFE_HANDOFF = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
/** The same with \t and \n, for a one-line title. */
const UNSAFE_TEXT_ALL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * The reserved handoff keys (contract rev. d). Any one of them on `#/tasks` —
 * even empty, even under a percent-encoded name — is a new handoff attempt:
 * the address and the older draft are cleared first, then the link is checked.
 * `text` and `title` are Explain's keys, reserved here too.
 */
export const HANDOFF_PARAMS = ["text", "title", "draft", "from", "back"] as const;
/**
 * Keys a handoff may carry once only (contract D9): a parser that keeps the
 * first copy and one that keeps the last would read different drafts, senders
 * or ways back, so a second copy of any of them refuses the handoff.
 */
export const SINGLE_HANDOFF_PARAMS = HANDOFF_PARAMS;
export const TASK_ROUTE = "#/tasks";

const codePoints = (text: string) => [...text];
const clipCodePoints = (text: string, max: number) => codePoints(text).slice(0, max).join("");

/** A relative hash route inside the sibling's own origin (contracts v1 validHref). */
export const validHref = validSuiteHref;

/** A handoff `back` (≤ 512) that is exactly one of `app`'s allowed routes (contract §5.1). */
export function siblingRoute(app: SuiteAppId, value: unknown): value is string {
  return allowedSuiteRoute(app, value, SUITE_LIMITS.back);
}

/**
 * Personal's own page as a `back` Explain may keep. routeHref encodes ids
 * (`#/events/ics%3Afeed%3Ak`); the contract wants the raw id
 * (`#/events/ics:feed:k`). An id that is not a plain object id even raw
 * falls back to its list page (`#/events`), and anything else is dropped.
 */
export function personalBackRoute(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (siblingRoute("personal", value)) return value;
  const match = /^(#\/[a-z]+)\/([^/?#]+)$/.exec(value);
  if (!match) return undefined;
  const [, list, encoded] = match;
  let id = "";
  try {
    id = decodeURIComponent(encoded);
  } catch {
    // A malformed escape is not an id; the list page is still a fine way back.
  }
  const raw = `${list}/${id}`;
  if (id && siblingRoute("personal", raw)) return raw;
  return siblingRoute("personal", list) ? list : undefined;
}

/** CRLF → LF, control and bidi characters out (\t \n kept), trimmed, clipped by code points. */
export function cleanHandoffText(value: string, max: number = SUITE_LIMITS.handoffText): { text: string; truncated: boolean } {
  const text = value.replace(/\r\n?/g, "\n").replace(UNSAFE_HANDOFF, "").trim();
  const chars = codePoints(text);
  return { text: chars.slice(0, max).join(""), truncated: chars.length > max };
}

/** One line of plain text for a title: every control and bidi character out, trimmed. */
export function cleanLine(value: string): string {
  return value.replace(UNSAFE_TEXT_ALL, "").trim();
}

export interface TaskHandoffDraft {
  from: SuiteAppId;
  text: string;
  truncated: boolean;
  backUrl?: string;
}

/** Why an attempt was refused: a repeated key, no `draft` key, an unlinked sender, nothing left after cleaning. */
export type TaskHandoffRejection = "duplicate" | "missing" | "from" | "empty";
export type TaskHandoffParse = undefined | { rejected: TaskHandoffRejection } | TaskHandoffDraft;

/** Splits a hash the contract's way: `#/tasks?a=b` → ["/tasks", "a=b"] (`split("?", 2)`). */
function splitHash(hash: string): [string, string] {
  const [path = "", query = ""] = String(hash).replace(/^#/, "").split("?", 2);
  return [path, query];
}

/** True when `hash` is `#/tasks?…` with any reserved handoff key, valid or not: a handoff attempt. */
export function hasTaskHandoffParams(hash: string): boolean {
  const [path, query] = splitHash(hash);
  if (path !== "/tasks" || !query) return false;
  const params = new URLSearchParams(query);
  return HANDOFF_PARAMS.some((key) => params.has(key));
}

/**
 * contracts v1 parseHandoff for target personal: undefined exactly when
 * hasTaskHandoffParams is false (an ordinary visit, the stored draft stays);
 * otherwise an attempt, either { rejected } (a repeated key, no `draft`, an
 * unlinked sender, nothing left after cleaning) or the draft.
 * `back` is dropped (draft kept) unless it is one of the sender's allowed routes.
 * `title` is not part of a to-do handoff and is ignored.
 */
export function parseTaskHandoff(hash: string, links: SuiteLinks): TaskHandoffParse {
  if (!hasTaskHandoffParams(hash)) return undefined;
  const params = new URLSearchParams(splitHash(hash)[1]);
  if (SINGLE_HANDOFF_PARAMS.some((key) => params.getAll(key).length > 1)) return { rejected: "duplicate" };
  if (!params.has("draft")) return { rejected: "missing" };
  const from = params.get("from");
  if (!from || !(SUITE_APP_IDS as readonly string[]).includes(from) || from === "personal") return { rejected: "from" };
  const origin = links[from as SuiteAppId];
  if (!origin) return { rejected: "from" };
  const body = cleanHandoffText(params.get("draft") ?? "", SUITE_LIMITS.handoffText);
  if (!body.text) return { rejected: "empty" };
  const draft: TaskHandoffDraft = { from: from as SuiteAppId, text: body.text, truncated: body.truncated };
  const back = params.get("back");
  if (back && siblingRoute(from as SuiteAppId, back)) draft.backUrl = `${origin}/${back}`;
  return draft;
}

/**
 * 解釋這個: contracts v1 handoffUrl for target explain, from personal. Text
 * ≤ 2000 and title ≤ 120 code points; `back` only as one of Personal's
 * allowed routes (personalBackRoute), otherwise left out.
 */
export function explainThisUrl({ origin, text, title, back }: { origin: string; text: string; title?: string; back?: string }): string {
  const params = new URLSearchParams();
  params.set("text", clipCodePoints(text, SUITE_LIMITS.handoffText));
  if (title) params.set("title", clipCodePoints(title, SUITE_LIMITS.handoffTitle));
  params.set("from", "personal");
  const route = personalBackRoute(back);
  if (route) params.set("back", route);
  return `${origin}/#/explain?${params.toString()}`;
}

export function prDraftUrl({ origin, draft, title, back }: { origin: string; draft: string; title?: string; back?: string }): string {
  const params = new URLSearchParams();
  params.set("draft", clipCodePoints(draft, SUITE_LIMITS.handoffText));
  if (title) params.set("title", clipCodePoints(title, SUITE_LIMITS.handoffTitle));
  params.set("from", "personal");
  const route = personalBackRoute(back);
  if (route) params.set("back", route);
  return `${origin}/#/discover?${params.toString()}`;
}

// ── sessionStorage ────────────────────────────────────────────────────────

/** One key, written whole: a new handoff replaces the old one, never merges with it. */
export const TASK_HANDOFF_KEY = "bell.suite.handoff.tasks";

export interface StoredTaskHandoff {
  v: 1;
  text: string;
  from: SuiteAppId;
  backUrl?: string;
  receivedAt: string;
  /** Present (true) only when the text was clipped to 2000, so 「已截斷」 survives a reload. */
  truncated?: true;
}

export function handoffKindFromBack(backUrl?: string): "待辦" | "靈感" | "郵件" | "行程" | "筆記" | "網頁" | "時程" | undefined {
  if (!backUrl) return;
  const route = backUrl.includes("/#/") ? backUrl.slice(backUrl.indexOf("/#/") + 1) : backUrl;
  if (route.startsWith("#/tasks")) return "待辦";
  if (route.startsWith("#/ideas")) return "靈感";
  if (route.startsWith("#/inbox")) return "郵件";
  if (route.startsWith("#/events")) return "行程";
  if (route.startsWith("#/note/")) return "筆記";
  if (route.startsWith("#/page/")) return "網頁";
  if (route.startsWith("#/schedule")) return "時程";
}

export function handoffSourceLine(sourceName: string, backUrl?: string): string {
  const kind = handoffKindFromBack(backUrl);
  return `來自 ${sourceName}${kind ? ` · ${kind}` : ""}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `${origin}/#/…` where the hash is an allowed route of `from` (the shape parseTaskHandoff writes). */
function validBackUrl(from: SuiteAppId, value: unknown): value is string {
  if (typeof value !== "string") return false;
  const cut = value.indexOf("/#/");
  if (cut < 0) return false;
  const origin = value.slice(0, cut);
  try {
    const url = new URL(origin);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) return false;
  } catch {
    return false;
  }
  return siblingRoute(from, value.slice(cut + 1));
}

export function toStoredHandoff(draft: TaskHandoffDraft, receivedAt: Date): StoredTaskHandoff {
  return {
    v: 1,
    text: draft.text,
    from: draft.from,
    ...(draft.backUrl ? { backUrl: draft.backUrl } : {}),
    receivedAt: receivedAt.toISOString(),
    ...(draft.truncated ? { truncated: true as const } : {}),
  };
}

/** The stored draft, or undefined when there is none or it is not one we wrote (corrupted, edited, old shape). */
export function readTaskHandoff(storage: StorageLike | undefined): StoredTaskHandoff | undefined {
  let raw: string | null;
  try {
    raw = storage?.getItem(TASK_HANDOFF_KEY) ?? null;
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.v !== 1 || typeof entry.text !== "string" || typeof entry.from !== "string" || typeof entry.receivedAt !== "string") return undefined;
  const from = entry.from as SuiteAppId;
  if (!(SUITE_APP_IDS as readonly string[]).includes(from) || from === "personal") return undefined;
  const cleaned = cleanHandoffText(entry.text, SUITE_LIMITS.handoffText);
  if (!cleaned.text || Number.isNaN(Date.parse(entry.receivedAt))) return undefined;
  return {
    v: 1,
    text: cleaned.text,
    from,
    ...(validBackUrl(from, entry.backUrl) ? { backUrl: entry.backUrl } : {}),
    receivedAt: entry.receivedAt,
    ...(entry.truncated === true || cleaned.truncated ? { truncated: true as const } : {}),
  };
}

/** Writes the whole draft under the one key; false when storage refused (private mode, quota). */
export function writeTaskHandoff(storage: StorageLike | undefined, draft: StoredTaskHandoff): boolean {
  try {
    storage?.setItem(TASK_HANDOFF_KEY, JSON.stringify(draft));
    return !!storage;
  } catch {
    return false;
  }
}

export function clearTaskHandoff(storage: StorageLike | undefined): void {
  try {
    storage?.removeItem(TASK_HANDOFF_KEY);
  } catch {
    // Storage that cannot be written cannot hold an old draft either.
  }
}

// ── The to-do form ────────────────────────────────────────────────────────

/** Clips to `max` UTF-16 units (what the server's limits count) without splitting a surrogate pair. */
export function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return text.slice(0, cut);
}

/**
 * The form's starting values: the first line is the title (≤ 200), the rest
 * the notes (≤ 4000). When the first line itself is too long, the notes keep
 * the whole text so nothing is lost.
 */
export function draftFields(text: string): { title: string; notes: string } {
  const newline = text.indexOf("\n");
  const first = (newline < 0 ? text : text.slice(0, newline)).trim();
  const rest = newline < 0 ? "" : text.slice(newline + 1).trim();
  const title = clipUnits(first, TODO_LIMITS.title);
  const notes = title.length < first.length ? text : rest;
  return { title, notes: clipUnits(notes, TODO_LIMITS.notes) };
}

/** The back link may only go to the origin the manifest links for `from` right now. */
export function backUrlFor(draft: Pick<StoredTaskHandoff, "from" | "backUrl">, links: SuiteLinks): string | undefined {
  const origin = links[draft.from];
  if (!draft.backUrl || !origin) return undefined;
  return draft.backUrl.startsWith(`${origin}/#/`) ? draft.backUrl : undefined;
}
