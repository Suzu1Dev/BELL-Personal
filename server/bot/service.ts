import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import {
  BOT_SESSION_FOLDERS,
  botNeedsApproval,
  botOperationApp,
  botOperationTier,
  type BotContextStatus,
  type BotOperationResponse,
  type BotSendResponse,
  type BotSessionResponse,
} from "../../shared/bot.js";
import { localTime } from "../../shared/time.js";
import { weekdayChar } from "../../shared/today-format.js";
import { AppError, publicError } from "../errors.js";
import { calendarService } from "../features/calendar/store.js";
import { ideaStore } from "../features/ideas/store.js";
import { todoStore } from "../features/todos/store.js";
import { withGenerationProgress } from "../generation-progress.js";
import type { ModuleHost } from "../modules.js";
import { redact } from "../secrets/redact.js";
import type { CoreServices } from "../services.js";
import type { SuiteBridge } from "../suite/bridge.js";
import type { TodayService } from "../today/service.js";
import {
  botModelTurnSchema,
  describeProposedOp,
  executeBotOp,
  undoBotOp,
  type BotExecutorDeps,
  type BotProposedOp,
} from "./executor.js";
import {
  BotSessionStore,
  toPublicOperation,
  toSessionView,
  type StoredBotMessage,
  type StoredBotOperation,
} from "./store.js";

export const BOT_TURN_TIMEOUT_MS = 60_000;

const sendMessageSchema = z.object({
  text: z.string().trim().min(1, { message: "請先輸入要告訴 Personal Bot 的內容。" }).max(4000),
}).strict();

const patchSessionSchema = z.object({
  title: z.string().max(120).optional(),
  folder: z.enum(BOT_SESSION_FOLDERS).optional(),
  pinned: z.boolean().optional(),
}).strict();

const BOT_PROMPT = [
  "你是 BELL Personal 的智慧代理助理「Personal Bot」，同時整合 BELL Suite（BELL Personal、BELL Explain、BELL PR）的跨產品資訊與操作。",
  "請根據 data 提供的真實狀態回答與行動：包含今日專注佇列（queue）、今日行程與空檔（agenda）、待辦（openTodos）、習慣（habits）、作業（assignments）、靈感（ideas）、BELL Explain 學習講義（suite.explain）以及 BELL PR 儲存庫與程式碼任務（suite.pr）。絕對不要捏造不存在的信件、作業、講義或 PR 任務。",
  "語言與風格：預設使用臺灣繁體中文（全形標點、語氣自然精煉、重點清楚）；若使用者全程用英文提問，改用英文回覆。",
  "動作規劃（operations，最多 6 筆；若只是問答或整理現況請回傳 []）：",
  "- todo.create：新增待辦（必填 title；可選 notes、dueDay YYYY-MM-DD、dueTime HH:MM、priority）。",
  "- todo.complete：完成待辦（targetId 填待辦 id，或 title 填明確標題）。",
  "- todo.update：修改待辦（targetId 填待辦 id；填入要改的 title、notes、dueDay、dueTime、priority）。",
  "- todo.delete：刪除待辦（targetId 填待辦 id）。",
  "- idea.create：記下靈感或筆記想法（text 填內容；可選 title、tags）。",
  "- event.create_local：新增 BELL 本機行程（title 填名稱；start/end 填 ISO 時間或 YYYY-MM-DD；allDay 填布林值；可選 location、notes）。",
  "- event.create_google：新增並同步至 Google 行事曆（僅在 data.googleCalendarWritable 為 true 且使用者明確要求同步 Google 行事曆時使用；否則用 event.create_local）。",
  "- habit.check：今日習慣打卡（targetId 填習慣 id 或 title 填習慣名稱；可選 dueDay）。",
  "- queue.snooze：延後專注佇列項目（targetId 填 queue item id，例如 gmail:... 或 native:...；until 填 ISO 時間，未指定可填 null 預設延到明早 08:00）。",
  "- sources.sync：立即同步所有外部來源。",
  "- mail.archive / mail.mark_read：封存或標為已讀 Gmail 信件（targetId 填 gmail:... 佇列項目 id）。",
  "- explain.create_note：在 BELL Explain 建立互動式學習講義（title 填主題或問題、text 填教材內容／概念說明／網址、depth 填 beginner | intermediate | advanced）。",
  "- pr.create_run：在 BELL PR 啟動程式碼任務（targetId 填儲存庫 id 或名稱、title 填任務標題、text 填完整任務需求描述、learnByHand 填布林值或 null）。",
  "- pr.approve_plan：核准等待審核計畫的 BELL PR 任務（targetId 填 run id）。",
  "注意：operations 內每個物件的所有欄位都必須出現，用不到的欄位請一律填 null。",
  "權限感知（data.autonomy）：auto 會直接執行所有動作；balanced 會直接執行本機安全動作，但將刪除、Gmail/Google 行事曆寫入與 Explain/PR 跨產品動作列為待核准卡片；cautious 會將所有動作列為待核准卡片。若動作需要核准，請在 reply 中說明已準備好動作請使用者確認，不要宣稱外部動作已經送出。",
  "followUps：回傳 1 至 3 個簡短、可直接點擊發送的下一步指令建議（每則不超過 24 字）。",
].join("\n");

export interface PersonalBotOptions {
  turnTimeoutMs?: number;
}

export class PersonalBotService {
  readonly store: BotSessionStore;
  private readonly deps: BotExecutorDeps;
  private readonly turnTimeoutMs: number;
  private readonly inFlightOps = new Set<string>();

  constructor(
    private readonly services: CoreServices,
    private readonly host: ModuleHost,
    private readonly today: TodayService,
    private readonly suiteBridge: SuiteBridge,
    options: PersonalBotOptions = {},
  ) {
    this.store = new BotSessionStore(services);
    this.deps = { services, host, today, suiteBridge };
    this.turnTimeoutMs = options.turnTimeoutMs ?? BOT_TURN_TIMEOUT_MS;
  }

  async contextStatus(): Promise<BotContextStatus> {
    const [explain, prStatus] = await Promise.all([
      this.suiteBridge.readExplainSnapshot(),
      this.suiteBridge.prStatus(),
    ]);
    const running = this.services.jobs.running("personal-bot")[0];
    return {
      aiEnabled: this.services.settings.value("ai.enabled"),
      autonomy: this.services.settings.value("bot.autonomy"),
      runningJobId: running?.id ?? null,
      explain: {
        configured: explain.configured,
        ready: explain.status === "ready" || explain.lessons.length > 0,
        ...(explain.link ? { link: explain.link } : {}),
      },
      pr: {
        configured: prStatus.configured,
        connected: prStatus.connected,
        ...(prStatus.link ? { link: prStatus.link } : {}),
      },
    };
  }

  async sessionResponse(): Promise<BotSessionResponse> {
    const session = this.store.active();
    return {
      session: toSessionView(session),
      sessions: this.store.listSummaries(),
      context: await this.contextStatus(),
    };
  }

  async resetSession(): Promise<BotSessionResponse> {
    for (const running of this.services.jobs.running("personal-bot")) {
      this.services.jobs.cancel(running.id, "已開啟新的對話。");
    }
    const fresh = this.store.reset();
    return {
      session: toSessionView(fresh),
      sessions: this.store.listSummaries(),
      context: await this.contextStatus(),
    };
  }

  async selectSession(sessionId: string): Promise<BotSessionResponse> {
    if (this.services.jobs.running("personal-bot").length > 0) {
      throw new AppError(409, "Personal Bot 正在處理訊息，請等完成後再切換對話。");
    }
    const chosen = this.store.select(sessionId);
    return {
      session: toSessionView(chosen),
      sessions: this.store.listSummaries(),
      context: await this.contextStatus(),
    };
  }

  async updateSession(sessionId: string, rawBody: unknown): Promise<BotSessionResponse> {
    const patch = patchSessionSchema.parse(rawBody ?? {});
    this.store.patch(sessionId, patch);
    const active = this.store.active();
    return {
      session: toSessionView(active),
      sessions: this.store.listSummaries(),
      context: await this.contextStatus(),
    };
  }

  async deleteSession(sessionId: string): Promise<BotSessionResponse> {
    for (const running of this.services.jobs.running("personal-bot")) {
      this.services.jobs.cancel(running.id, "對話已刪除。");
    }
    const next = this.store.remove(sessionId);
    return {
      session: toSessionView(next),
      sessions: this.store.listSummaries(),
      context: await this.contextStatus(),
    };
  }

  async sendMessage(rawBody: unknown): Promise<BotSendResponse> {
    const { text } = sendMessageSchema.parse(rawBody ?? {});
    if (this.services.jobs.running("personal-bot").length > 0) {
      throw new AppError(429, "Personal Bot 正在處理上一則訊息，請稍候。");
    }

    const now = this.services.now().toISOString();
    const active = this.store.active();
    const userMsg: StoredBotMessage = {
      id: randomUUID(),
      role: "user",
      text,
      createdAt: now,
    };

    if (!this.services.settings.value("ai.enabled")) {
      const disabledReply: StoredBotMessage = {
        id: randomUUID(),
        role: "assistant",
        text: "目前「使用 AI」已關閉，請先前往「連線與設定 › AI」開啟並完成模型登入後，再讓我替你整理與操作。",
        createdAt: now,
      };
      const saved = this.store.save({
        ...active,
        messages: [...active.messages, userMsg, disabledReply],
      });
      return {
        jobId: null,
        session: toSessionView(saved),
        sessions: this.store.listSummaries(),
        context: await this.contextStatus(),
      };
    }

    const withUser = this.store.save({
      ...active,
      messages: [...active.messages, userMsg],
    });
    const sessionId = withUser.id;

    const job = this.services.jobs.start(
      { kind: "personal-bot", title: "Personal Bot 回應" },
      async (emit, signal) => {
        emit({ type: "stage", stage: "context", message: "正在讀取 Personal 與 BELL Suite 資料…" });
        const data = await this.buildPromptData(sessionId, text);
        const { value } = await withGenerationProgress(
          "思考與規劃動作",
          "bot",
          emit,
          signal,
          (onProgress) => this.services.ai.runStructured({
            role: "Personal Bot",
            schema: botModelTurnSchema,
            prompt: BOT_PROMPT,
            data,
            signal,
            timeoutMs: this.turnTimeoutMs,
            priority: "interactive",
            onProgress,
          }),
        );

        const autonomy = this.services.settings.value("bot.autonomy");
        const operations: StoredBotOperation[] = [];
        for (const proposed of value.operations) {
          operations.push(await this.processProposedOp(proposed, autonomy));
        }

        const assistantMsg: StoredBotMessage = {
          id: randomUUID(),
          role: "assistant",
          text: redact(value.reply.trim()),
          createdAt: this.services.now().toISOString(),
          ...(operations.length ? { operations } : {}),
          ...(value.followUps.length ? { followUps: value.followUps.map((f) => f.trim()).filter(Boolean) } : {}),
        };

        const latest = this.store.table.get(sessionId) ?? withUser;
        this.store.save({
          ...latest,
          messages: [...latest.messages, assistantMsg],
        });

        const executedCount = operations.filter((op) => op.status === "executed").length;
        const pendingCount = operations.filter((op) => op.status === "pending_approval").length;
        return { messageId: assistantMsg.id, executedCount, pendingCount };
      },
      { maxRunning: 1, busyMessage: "Personal Bot 正在處理上一則訊息，請稍候。" },
    );

    return {
      jobId: job.id,
      session: toSessionView(withUser),
      sessions: this.store.listSummaries(),
      context: await this.contextStatus(),
    };
  }

  async approveOperation(opId: string): Promise<BotOperationResponse> {
    if (this.inFlightOps.has(opId)) throw new AppError(409, "這項動作正在執行中，請稍候。");
    const session = this.store.active();
    const found = this.store.findOperation(session, opId);
    if (!found) throw new AppError(404, "找不到這項待核准動作。");
    if (found.operation.status !== "pending_approval") {
      throw new AppError(409, "這項動作已經處理過了。");
    }

    this.inFlightOps.add(opId);
    try {
      const executed = await executeBotOp(found.operation.params, this.deps);
      found.operation.status = "executed";
      found.operation.label = executed.label;
      if (executed.detail) found.operation.detail = executed.detail;
      if (executed.resultHref) found.operation.resultHref = executed.resultHref;
      if (executed.undoSpec) found.operation.undoSpec = executed.undoSpec;
      found.operation.undoable = Boolean(executed.undoSpec);
      delete found.operation.error;
      found.operation.updatedAt = this.services.now().toISOString();

      const saved = this.store.save(session);
      return {
        operation: toPublicOperation(found.operation),
        session: toSessionView(saved),
        sessions: this.store.listSummaries(),
        context: await this.contextStatus(),
      };
    } catch (error) {
      found.operation.status = "failed";
      found.operation.error = publicError(error);
      found.operation.undoable = false;
      found.operation.updatedAt = this.services.now().toISOString();
      this.store.save(session);
      throw error;
    } finally {
      this.inFlightOps.delete(opId);
    }
  }

  async dismissOperation(opId: string): Promise<BotOperationResponse> {
    const session = this.store.active();
    const found = this.store.findOperation(session, opId);
    if (!found) throw new AppError(404, "找不到這項動作。");
    if (found.operation.status !== "pending_approval") {
      throw new AppError(409, "這項動作已經處理過了。");
    }
    found.operation.status = "dismissed";
    found.operation.undoable = false;
    found.operation.updatedAt = this.services.now().toISOString();
    const saved = this.store.save(session);
    return {
      operation: toPublicOperation(found.operation),
      session: toSessionView(saved),
      sessions: this.store.listSummaries(),
      context: await this.contextStatus(),
    };
  }

  async undoOperation(opId: string): Promise<BotOperationResponse> {
    if (this.inFlightOps.has(opId)) throw new AppError(409, "這項動作正在處理中，請稍候。");
    const session = this.store.active();
    const found = this.store.findOperation(session, opId);
    if (!found) throw new AppError(404, "找不到這項動作。");
    if (found.operation.status !== "executed" || !found.operation.undoSpec) {
      throw new AppError(409, "這項動作無法復原或已經復原。");
    }

    this.inFlightOps.add(opId);
    try {
      await undoBotOp(found.operation.undoSpec, this.deps);
      found.operation.status = "undone";
      found.operation.undoable = false;
      delete found.operation.undoSpec;
      found.operation.updatedAt = this.services.now().toISOString();
      const saved = this.store.save(session);
      return {
        operation: toPublicOperation(found.operation),
        session: toSessionView(saved),
        sessions: this.store.listSummaries(),
        context: await this.contextStatus(),
      };
    } finally {
      this.inFlightOps.delete(opId);
    }
  }

  private async processProposedOp(
    proposed: BotProposedOp,
    autonomy: ReturnType<CoreServices["settings"]["value"]> extends never ? never : "cautious" | "balanced" | "auto",
  ): Promise<StoredBotOperation> {
    const tier = botOperationTier(proposed.kind);
    const app = botOperationApp(proposed.kind);
    const preview = describeProposedOp(proposed);
    const now = this.services.now().toISOString();
    const id = randomUUID();

    if (botNeedsApproval(tier, autonomy)) {
      return {
        id,
        kind: proposed.kind,
        tier,
        app,
        status: "pending_approval",
        label: preview.label,
        ...(preview.detail ? { detail: preview.detail } : {}),
        undoable: false,
        updatedAt: now,
        params: proposed,
      };
    }

    try {
      const executed = await executeBotOp(proposed, this.deps);
      return {
        id,
        kind: proposed.kind,
        tier,
        app,
        status: "executed",
        label: executed.label,
        ...(executed.detail ? { detail: executed.detail } : {}),
        ...(executed.resultHref ? { resultHref: executed.resultHref } : {}),
        undoable: Boolean(executed.undoSpec),
        updatedAt: this.services.now().toISOString(),
        params: proposed,
        ...(executed.undoSpec ? { undoSpec: executed.undoSpec } : {}),
      };
    } catch (error) {
      return {
        id,
        kind: proposed.kind,
        tier,
        app,
        status: "failed",
        label: preview.label,
        ...(preview.detail ? { detail: preview.detail } : {}),
        undoable: false,
        error: publicError(error),
        updatedAt: this.services.now().toISOString(),
        params: proposed,
      };
    }
  }

  private readLocalAssignments(): Array<{ id: string; title: string; course: string | null; dueAt: string | null; status: string }> {
    try {
      const rows = this.services.db.personal.db
        .prepare("SELECT json FROM local_assignments ORDER BY due_at IS NULL, due_at ASC LIMIT 8")
        .all() as Array<{ json: string }>;
      const out: Array<{ id: string; title: string; course: string | null; dueAt: string | null; status: string }> = [];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.json) as Record<string, unknown>;
          if (typeof parsed.id === "string" && typeof parsed.title === "string") {
            out.push({
              id: parsed.id,
              title: parsed.title.slice(0, 120),
              course: typeof parsed.course === "string" ? parsed.course.slice(0, 60) : null,
              dueAt: typeof parsed.dueAt === "string" ? parsed.dueAt : null,
              status: typeof parsed.status === "string" ? parsed.status : "open",
            });
          }
        } catch { /* skip malformed row */ }
      }
      return out;
    } catch {
      return [];
    }
  }

  private async buildPromptData(sessionId: string, latestUserText: string): Promise<Record<string, unknown>> {
    const now = this.services.now();
    const today = this.services.today();
    const timeZone = this.services.config.timeZone;
    const autonomy = this.services.settings.value("bot.autonomy");

    const [todayPayload, explain, pr, googleCalendarWritable] = await Promise.all([
      this.today.build(),
      this.suiteBridge.readExplainSnapshot(),
      this.suiteBridge.readPrSnapshot(),
      calendarService(this.services).canWriteGoogle().catch(() => false),
    ]);

    const openTodos = todoStore(this.services).open().slice(0, 24).map((todo) => ({
      id: todo.id,
      title: todo.title,
      priority: todo.priority,
      dueDay: todo.dueDay ?? null,
      dueTime: todo.dueTime ?? null,
      notes: todo.notes ? todo.notes.slice(0, 180) : null,
    }));

    const ideas = ideaStore(this.services).latest(8).map((idea) => ({
      id: idea.id,
      title: idea.title ?? null,
      text: idea.text.slice(0, 200),
      tags: idea.tags,
    }));

    const queue = todayPayload.queue.flatMap((group) =>
      group.items.slice(0, 8).map((item) => ({
        id: item.id,
        group: group.group,
        kind: item.kind,
        title: item.title,
        meta: item.meta,
        when: item.when?.label ?? null,
        summary: item.summary ?? null,
        actions: item.actions.map((action) => action.id),
      })),
    );

    const session = this.store.table.get(sessionId);
    const history = (session?.messages ?? [])
      .slice(-12)
      .map((msg) => ({
        role: msg.role,
        text: msg.text.slice(0, 1200),
        ...(msg.operations?.length
          ? {
              operations: msg.operations.map((op) => ({
                kind: op.kind,
                status: op.status,
                label: op.label,
              })),
            }
          : {}),
      }));

    return {
      today,
      weekday: `週${weekdayChar(today)}`,
      localTime: localTime(timeZone, now),
      timeZone,
      autonomy,
      googleCalendarWritable,
      userMessage: latestUserText,
      conversationHistory: history,
      personal: {
        counts: todayPayload.counts,
        brief: todayPayload.brief.text,
        queue,
        agenda: {
          items: todayPayload.agenda.items.slice(0, 14).map((item) => ({
            title: item.title,
            start: item.start,
            end: item.end ?? null,
            kind: item.kind,
            meta: item.meta,
            past: item.past,
          })),
          freeGap: todayPayload.agenda.gap ?? null,
        },
        habits: todayPayload.habits.map((habit) => ({
          id: habit.id,
          name: habit.name,
          cadence: habit.cadence,
          doneToday: habit.doneToday,
          streak: habit.streak,
        })),
        openTodos,
        assignments: this.readLocalAssignments(),
        ideas,
      },
      suite: {
        explain,
        pr,
      },
    };
  }
}

export function createBotRouter(bot: PersonalBotService): Router {
  const router = Router();

  router.get("/session", async (_req, res) => {
    res.json(await bot.sessionResponse());
  });

  router.post("/messages", async (req, res) => {
    const response = await bot.sendMessage(req.body);
    res.status(response.jobId ? 202 : 200).json(response);
  });

  router.post("/operations/:opId/approve", async (req, res) => {
    res.json(await bot.approveOperation(req.params.opId));
  });

  router.post("/operations/:opId/dismiss", async (req, res) => {
    res.json(await bot.dismissOperation(req.params.opId));
  });

  router.post("/operations/:opId/undo", async (req, res) => {
    res.json(await bot.undoOperation(req.params.opId));
  });

  router.post("/reset", async (_req, res) => {
    res.json(await bot.resetSession());
  });

  router.post("/sessions/:sessionId/select", async (req, res) => {
    res.json(await bot.selectSession(req.params.sessionId));
  });

  router.patch("/sessions/:sessionId", async (req, res) => {
    res.json(await bot.updateSession(req.params.sessionId, req.body));
  });

  router.delete("/sessions/:sessionId", async (req, res) => {
    res.json(await bot.deleteSession(req.params.sessionId));
  });

  return router;
}
