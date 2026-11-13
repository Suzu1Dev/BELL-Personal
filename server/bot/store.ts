import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  BOT_OPERATION_KINDS,
  BOT_SESSION_FOLDERS,
  type BotMessage,
  type BotOperation,
  type BotSessionFolder,
  type BotSessionSummary,
  type BotSessionView,
} from "../../shared/bot.js";
import type { DocTable } from "../db/database.js";
import { AppError } from "../errors.js";
import type { CoreServices } from "../services.js";
import { botProposedOpSchema, botUndoSpecSchema, type BotProposedOp, type BotUndoSpec } from "./executor.js";

export const MAX_SESSION_MESSAGES = 60;
export const MAX_LISTED_SESSIONS = 50;

export interface StoredBotOperation extends BotOperation {
  params: BotProposedOp;
  undoSpec?: BotUndoSpec;
}

export interface StoredBotMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  operations?: StoredBotOperation[];
  followUps?: string[];
}

export interface StoredBotSession {
  id: string;
  archived?: boolean;
  title?: string;
  folder?: BotSessionFolder;
  customFolder?: boolean;
  pinned?: boolean;
  messages: StoredBotMessage[];
  createdAt: string;
  updatedAt: string;
}

const storedOpSchema: z.ZodType<StoredBotOperation> = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(BOT_OPERATION_KINDS),
  tier: z.enum(["safe", "sensitive"]),
  app: z.enum(["personal", "explain", "pr"]),
  status: z.enum(["pending_approval", "executed", "dismissed", "undone", "failed"]),
  label: z.string().min(1).max(300),
  detail: z.string().max(500).optional(),
  resultHref: z.string().max(2000).optional(),
  undoable: z.boolean(),
  error: z.string().max(500).optional(),
  updatedAt: z.string(),
  params: botProposedOpSchema,
  undoSpec: botUndoSpecSchema.optional(),
});

const storedMessageSchema: z.ZodType<StoredBotMessage> = z.object({
  id: z.string().min(1).max(100),
  role: z.enum(["user", "assistant"]),
  text: z.string().max(8000),
  createdAt: z.string(),
  operations: z.array(storedOpSchema).max(12).optional(),
  followUps: z.array(z.string().max(80)).max(5).optional(),
});

const storedSessionSchema: z.ZodType<StoredBotSession> = z.object({
  id: z.string().min(1).max(100),
  archived: z.boolean().optional(),
  title: z.string().max(120).optional(),
  folder: z.enum(BOT_SESSION_FOLDERS).optional(),
  customFolder: z.boolean().optional(),
  pinned: z.boolean().optional(),
  messages: z.array(storedMessageSchema).max(MAX_SESSION_MESSAGES),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function inferSessionFolder(messages: readonly StoredBotMessage[]): BotSessionFolder {
  for (const msg of messages) {
    for (const op of msg.operations ?? []) {
      if (op.app === "explain" || op.app === "pr") return "suite";
      if (op.kind.startsWith("event.") || op.kind.startsWith("habit.") || op.kind.startsWith("queue.") || op.kind.startsWith("mail.")) {
        return "daily";
      }
      if (op.kind.startsWith("todo.") || op.kind.startsWith("idea.")) return "tasks";
    }
  }
  const combined = messages.map((m) => m.text).join(" ");
  if (/explain|講義|筆記|複習|\bpr\b|pull request|repo|程式碼/i.test(combined)) return "suite";
  if (/行程|空檔|行事曆|日曆|打卡|習慣|信件|信箱|今天重點|今日/i.test(combined)) return "daily";
  if (/待辦|todo|靈感|點子|作業|截止/i.test(combined)) return "tasks";
  return "general";
}

export function deriveSessionTitle(session: StoredBotSession): string {
  const manual = session.title?.trim();
  if (manual) return manual;
  const firstUser = session.messages.find((msg) => msg.role === "user")?.text ?? session.messages[0]?.text ?? "";
  const clean = firstUser.replace(/\s+/g, " ").trim();
  if (!clean) return "新對話";
  return clean.length > 34 ? `${clean.slice(0, 34)}…` : clean;
}

export function deriveSessionPreview(session: StoredBotSession): string {
  const last = session.messages[session.messages.length - 1];
  if (!last) return "";
  const clean = last.text.replace(/[#*`]/g, "").replace(/\s+/g, " ").trim();
  return clean.length > 56 ? `${clean.slice(0, 56)}…` : clean;
}

export function toPublicOperation(op: StoredBotOperation): BotOperation {
  return {
    id: op.id,
    kind: op.kind,
    tier: op.tier,
    app: op.app,
    status: op.status,
    label: op.label,
    ...(op.detail ? { detail: op.detail } : {}),
    ...(op.resultHref ? { resultHref: op.resultHref } : {}),
    undoable: op.status === "executed" && Boolean(op.undoSpec),
    ...(op.error ? { error: op.error } : {}),
    updatedAt: op.updatedAt,
  };
}

export function toSessionSummary(session: StoredBotSession): BotSessionSummary {
  const folder = session.folder ?? inferSessionFolder(session.messages);
  return {
    id: session.id,
    title: deriveSessionTitle(session),
    preview: deriveSessionPreview(session),
    folder,
    pinned: Boolean(session.pinned),
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function toSessionView(session: StoredBotSession): BotSessionView {
  const messages: BotMessage[] = session.messages.map((msg) => ({
    id: msg.id,
    role: msg.role,
    text: msg.text,
    createdAt: msg.createdAt,
    ...(msg.operations?.length ? { operations: msg.operations.map(toPublicOperation) } : {}),
    ...(msg.followUps?.length ? { followUps: msg.followUps } : {}),
  }));
  const folder = session.folder ?? inferSessionFolder(session.messages);
  return {
    id: session.id,
    title: deriveSessionTitle(session),
    folder,
    pinned: Boolean(session.pinned),
    messages,
    updatedAt: session.updatedAt,
  };
}

/**
 * Persists Personal Bot conversations in `personal.sqlite` (`bot_sessions`).
 * Supports switching between past sessions, folder/tag classification, pinning, and reset.
 */
export class BotSessionStore {
  readonly table: DocTable<StoredBotSession>;

  constructor(private readonly ctx: Pick<CoreServices, "db" | "now">) {
    this.table = ctx.db.personal.docs<StoredBotSession>({
      table: "bot_sessions",
      label: "Personal Bot 對話",
      schema: storedSessionSchema,
      columns: (session) => ({ created_at: session.createdAt }),
    });
  }

  active(): StoredBotSession {
    const recent = this.table.list({ orderBy: "updated_at DESC", limit: MAX_LISTED_SESSIONS });
    const live = recent.find((session) => !session.archived);
    if (live) return live;
    return this.createFresh();
  }

  listSummaries(): BotSessionSummary[] {
    const rows = this.table.list({ orderBy: "updated_at DESC", limit: MAX_LISTED_SESSIONS });
    return rows
      .filter((row) => row.messages.length > 0)
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      })
      .map(toSessionSummary);
  }

  save(session: StoredBotSession, options: { touch?: boolean } = {}): StoredBotSession {
    const touch = options.touch !== false;
    const updatedAt = touch ? this.ctx.now().toISOString() : session.updatedAt;
    const messages = session.messages.length > MAX_SESSION_MESSAGES
      ? session.messages.slice(session.messages.length - MAX_SESSION_MESSAGES)
      : session.messages;
    const folder = session.customFolder && session.folder
      ? session.folder
      : messages.length > 0
        ? inferSessionFolder(messages)
        : session.folder;
    return this.table.put({
      ...session,
      ...(folder ? { folder } : {}),
      messages,
      updatedAt,
    });
  }

  reset(): StoredBotSession {
    const current = this.active();
    if (current.messages.length === 0) return current;
    this.save({ ...current, archived: true }, { touch: false });
    return this.createFresh();
  }

  select(id: string): StoredBotSession {
    const target = this.table.get(id);
    if (!target) throw new AppError(404, "找不到這筆對話紀錄。");
    const recent = this.table.list({ orderBy: "updated_at DESC", limit: MAX_LISTED_SESSIONS });
    for (const row of recent) {
      if (!row.archived && row.id !== id) {
        if (row.messages.length === 0) {
          this.table.delete(row.id);
        } else {
          this.save({ ...row, archived: true }, { touch: false });
        }
      }
    }
    if (!target.archived) return target;
    return this.save({ ...target, archived: false }, { touch: false });
  }

  patch(id: string, input: { title?: string; folder?: BotSessionFolder; pinned?: boolean }): StoredBotSession {
    const target = this.table.get(id);
    if (!target) throw new AppError(404, "找不到這筆對話紀錄。");
    const next: StoredBotSession = { ...target };
    if (input.title !== undefined) {
      const clean = input.title.trim();
      if (clean) next.title = clean;
      else delete next.title;
    }
    if (input.folder !== undefined) {
      next.folder = input.folder;
      next.customFolder = true;
    }
    if (input.pinned !== undefined) {
      next.pinned = input.pinned;
    }
    return this.save(next, { touch: false });
  }

  remove(id: string): StoredBotSession {
    const existing = this.table.get(id);
    if (!existing) throw new AppError(404, "找不到這筆對話紀錄。");
    const wasActive = !existing.archived;
    this.table.delete(id);
    if (!wasActive) return this.active();
    const remaining = this.table.list({ orderBy: "updated_at DESC", limit: MAX_LISTED_SESSIONS });
    const candidate = remaining.find((row) => row.messages.length > 0);
    if (candidate) return this.save({ ...candidate, archived: false }, { touch: false });
    return this.createFresh();
  }

  findOperation(session: StoredBotSession, opId: string): { message: StoredBotMessage; operation: StoredBotOperation } | undefined {
    for (const message of session.messages) {
      for (const operation of message.operations ?? []) {
        if (operation.id === opId) return { message, operation };
      }
    }
    return undefined;
  }

  private createFresh(): StoredBotSession {
    const now = this.ctx.now().toISOString();
    return this.table.put({
      id: randomUUID(),
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
  }
}
