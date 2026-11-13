import type { ModelExecution } from "./models.js";
import type { SourceRef } from "./sources.js";
import type { DayKey } from "./time.js";

/** Product rule: AI proposes, the user decides. Every model output lands here first. */
export const SUGGESTION_KINDS = ["todo", "event", "mail-triage", "idea-tags", "quick-capture", "assignment"] as const;
export type SuggestionKind = (typeof SUGGESTION_KINDS)[number];

export const SUGGESTION_STATUSES = ["pending", "accepted", "dismissed"] as const;

/** The origin of quick capture's own event records (the Enter already confirmed them): never shown as a pending suggestion. */
export const CAPTURE_ORIGIN = "快速記下";
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export interface AiSuggestion<P = unknown> {
  id: string;
  kind: SuggestionKind;
  status: SuggestionStatus;
  /** Short zh-TW line shown on the card, e.g. 「加入待辦：繳電費」. */
  title: string;
  payload: P;
  sourceRef?: SourceRef;
  createdAt: string;
  decidedAt?: string;
  /** Which local record accepting it created (todo id, manual event id…). */
  resultId?: string;
  /** Where it was found, for the meta line 「來自 KKTIX 報名成功信」 (without 來自). */
  origin?: string;
  modelExecution?: ModelExecution;
}

export interface TodoSuggestion {
  title: string;
  dueDay?: DayKey;
  dueTime?: string;
  notes?: string;
}

export interface EventSuggestion {
  title: string;
  start: string;
  end?: string;
  allDay: boolean;
  location?: string;
}

/**
 * An assignment announced in a mail (SPEC-mail-assignments §5): proposed by the
 * mail triage model or, with AI off, by the rules in shared/assignment-detect.ts.
 * 加入作業 turns it into a native assignment (lms module). The runtime shape is
 * `assignmentSuggestionSchema` in server/today/suggestion-payloads.ts.
 */
export interface AssignmentSuggestion {
  /** The assignment's name, not the mail subject: 「HW5：系統呼叫實作」. */
  title: string;
  /** 「作業系統」 */
  courseName?: string;
  /** ISO instant, or null when the mail gives no deadline. A date without a time is 23:59 local (see dueDay). */
  dueAt: string | null;
  /** Set when the mail gave only a date: the local day dueAt ends. */
  dueDay?: DayKey;
  /** How to hand it in: 「上傳到 E3」「紙本交到系辦」. */
  submitHint?: string;
  /** An https submission or instructions link written in the mail. */
  url?: string;
  notes?: string;
  /** Who proposed it (the row adds 「規則判斷」 for rules); absent = the model. */
  detectedBy?: "ai" | "rule";
}

export interface IdeaTagsSuggestion {
  ideaId: string;
  tags: string[];
}

/** Natural-language capture (「明天下午三點 跟教授 meeting」) parsed into one of these. */
export type QuickCaptureSuggestion =
  | { target: "todo"; todo: TodoSuggestion }
  | { target: "event"; event: EventSuggestion }
  | { target: "idea"; text: string };
