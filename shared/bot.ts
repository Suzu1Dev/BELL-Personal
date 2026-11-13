import type { BotAutonomy } from "./settings.js";

export const BOT_SAFE_OPERATION_KINDS = [
  "todo.create",
  "todo.complete",
  "todo.update",
  "idea.create",
  "event.create_local",
  "habit.check",
  "queue.snooze",
  "sources.sync",
] as const;

export const BOT_SENSITIVE_OPERATION_KINDS = [
  "todo.delete",
  "event.create_google",
  "mail.archive",
  "mail.mark_read",
  "explain.create_note",
  "pr.create_run",
  "pr.approve_plan",
] as const;

export const BOT_OPERATION_KINDS = [
  ...BOT_SAFE_OPERATION_KINDS,
  ...BOT_SENSITIVE_OPERATION_KINDS,
] as const;

export const BOT_SESSION_FOLDERS = ["daily", "tasks", "suite", "general"] as const;
export type BotSessionFolder = (typeof BOT_SESSION_FOLDERS)[number];

export type BotOperationKind = (typeof BOT_OPERATION_KINDS)[number];
export type BotOperationTier = "safe" | "sensitive";
export type BotOperationApp = "personal" | "explain" | "pr";
export type BotOperationStatus = "pending_approval" | "executed" | "dismissed" | "undone" | "failed";

export function botOperationTier(kind: BotOperationKind): BotOperationTier {
  return (BOT_SAFE_OPERATION_KINDS as readonly string[]).includes(kind) ? "safe" : "sensitive";
}

export function botOperationApp(kind: BotOperationKind): BotOperationApp {
  if (kind.startsWith("explain.")) return "explain";
  if (kind.startsWith("pr.")) return "pr";
  return "personal";
}

export function botNeedsApproval(tier: BotOperationTier, autonomy: BotAutonomy): boolean {
  if (autonomy === "auto") return false;
  if (autonomy === "cautious") return true;
  return tier === "sensitive";
}

export interface BotOperation {
  id: string;
  kind: BotOperationKind;
  tier: BotOperationTier;
  app: BotOperationApp;
  status: BotOperationStatus;
  label: string;
  detail?: string;
  resultHref?: string;
  undoable: boolean;
  error?: string;
  updatedAt: string;
}

export interface BotMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  operations?: BotOperation[];
  followUps?: string[];
}

export interface BotSessionSummary {
  id: string;
  title: string;
  preview: string;
  folder: BotSessionFolder;
  pinned: boolean;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface BotSessionView {
  id: string;
  title?: string;
  folder?: BotSessionFolder;
  pinned?: boolean;
  messages: BotMessage[];
  updatedAt: string;
}

export interface BotContextStatus {
  aiEnabled: boolean;
  autonomy: BotAutonomy;
  runningJobId: string | null;
  explain: { configured: boolean; ready: boolean; link?: string };
  pr: { configured: boolean; connected: boolean; link?: string };
}

export interface BotSessionResponse {
  session: BotSessionView;
  sessions?: BotSessionSummary[];
  context: BotContextStatus;
}

export interface BotSendResponse {
  jobId: string | null;
  session: BotSessionView;
  sessions?: BotSessionSummary[];
  context: BotContextStatus;
}

export interface BotOperationResponse {
  operation: BotOperation;
  session: BotSessionView;
  sessions?: BotSessionSummary[];
  context: BotContextStatus;
}
