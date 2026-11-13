import { z } from "zod";
import {
  BOT_OPERATION_KINDS,
  type BotOperationKind,
} from "../../shared/bot.js";
import { addDays, dayKey, isDayKey, isLocalTime, zonedTimeToUtc, type DayKey } from "../../shared/time.js";
import { TODO_PRIORITIES } from "../../shared/todos.js";
import { AppError } from "../errors.js";
import { calendarService, resolveTimes } from "../features/calendar/store.js";
import { habitStore } from "../features/habits/store.js";
import { ideaStore } from "../features/ideas/store.js";
import { todoStore } from "../features/todos/store.js";
import type { ModuleHost } from "../modules.js";
import type { CoreServices } from "../services.js";
import type { SuiteBridge } from "../suite/bridge.js";
import type { TodayService } from "../today/service.js";

/**
 * Strict JSON-schema-compatible output shape for Personal Bot turns:
 * every object is `.strict()` and every optional parameter uses `.nullable()`
 * (never `.optional()`), so both Claude Code `--json-schema` and Codex
 * `strictSchemaFor(jsonSchemaFor(botModelTurnSchema))` enforce it natively.
 */
export const botProposedOpSchema = z.object({
  kind: z.enum(BOT_OPERATION_KINDS),
  title: z.string().max(200).nullable(),
  text: z.string().max(4000).nullable(),
  notes: z.string().max(4000).nullable(),
  targetId: z.string().max(600).nullable(),
  dueDay: z.string().max(20).nullable(),
  dueTime: z.string().max(10).nullable(),
  priority: z.enum(TODO_PRIORITIES).nullable(),
  start: z.string().max(64).nullable(),
  end: z.string().max(64).nullable(),
  allDay: z.boolean().nullable(),
  location: z.string().max(200).nullable(),
  tags: z.array(z.string().max(32)).max(8).nullable(),
  until: z.string().max(64).nullable(),
  depth: z.enum(["beginner", "intermediate", "advanced"]).nullable(),
  learnByHand: z.boolean().nullable(),
}).strict();

export type BotProposedOp = z.infer<typeof botProposedOpSchema>;

export const botModelTurnSchema = z.object({
  reply: z.string().min(1).max(4000),
  operations: z.array(botProposedOpSchema).max(6),
  followUps: z.array(z.string().min(1).max(60)).max(3),
}).strict();

export type BotModelTurn = z.infer<typeof botModelTurnSchema>;

export const botUndoSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("todo.discard"), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("todo.reopen"), id: z.string().min(1).max(100) }).strict(),
  z.object({
    kind: z.literal("todo.patch"),
    id: z.string().min(1).max(100),
    patch: z.object({
      title: z.string().max(500),
      notes: z.string().max(10000).nullable(),
      dueDay: z.string().max(20).nullable(),
      dueTime: z.string().max(10).nullable(),
      priority: z.enum(TODO_PRIORITIES),
    }).strict(),
  }).strict(),
  z.object({ kind: z.literal("trash"), token: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("idea.discard"), id: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("event.discard"), id: z.string().min(1).max(100), google: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("habit.uncheck"), id: z.string().min(1).max(100), day: z.string().min(1).max(20) }).strict(),
  z.object({ kind: z.literal("today.action"), actionId: z.string().min(1).max(100) }).strict(),
]);

export type BotUndoSpec = z.infer<typeof botUndoSpecSchema>;

export interface BotExecutorDeps {
  services: CoreServices;
  host: ModuleHost;
  today: TodayService;
  suiteBridge: SuiteBridge;
}

export interface BotExecutionResult {
  label: string;
  detail?: string;
  resultHref?: string;
  undoSpec?: BotUndoSpec;
}

const shortText = (value: string | null | undefined, max = 48): string => {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

const KIND_NOUN: Record<BotOperationKind, string> = {
  "todo.create": "新增待辦",
  "todo.complete": "完成待辦",
  "todo.update": "更新待辦",
  "todo.delete": "刪除待辦",
  "idea.create": "記下靈感",
  "event.create_local": "新增本機行程",
  "event.create_google": "新增 Google 行事曆行程",
  "habit.check": "習慣打卡",
  "queue.snooze": "延後佇列項目",
  "sources.sync": "立即同步所有來源",
  "mail.archive": "封存 Gmail 信件",
  "mail.mark_read": "將 Gmail 信件標為已讀",
  "explain.create_note": "在 BELL Explain 建立學習筆記",
  "pr.create_run": "在 BELL PR 啟動程式碼任務",
  "pr.approve_plan": "核准 BELL PR 執行計畫",
};

/** Human-readable preview before (or while) an operation runs, used on Permission Broker cards. */
export function describeProposedOp(op: BotProposedOp): { label: string; detail?: string } {
  const prefix = KIND_NOUN[op.kind];
  const subject = shortText(op.title ?? op.text ?? op.targetId, 44);
  const label = op.kind === "sources.sync" || !subject ? prefix : `${prefix}「${subject}」`;
  const parts: string[] = [];
  if (op.dueDay) parts.push(op.dueTime ? `${op.dueDay} ${op.dueTime}` : op.dueDay);
  if (op.start) parts.push(op.end ? `${op.start} → ${op.end}` : op.start);
  if (op.location) parts.push(op.location);
  if (op.until) parts.push(`延後至 ${op.until}`);
  if (op.kind === "explain.create_note" && op.depth) {
    const depthLabel = op.depth === "beginner" ? "入門" : op.depth === "advanced" ? "深入" : "標準";
    parts.push(`深度：${depthLabel}`);
  }
  if ((op.kind === "explain.create_note" || op.kind === "pr.create_run") && op.text && op.title) {
    parts.push(shortText(op.text, 72));
  }
  return { label, ...(parts.length ? { detail: parts.join(" · ") } : {}) };
}

function resolveTodoTargetId(services: CoreServices, targetId: string | null, title: string | null): string {
  const store = todoStore(services);
  const cleaned = targetId?.trim().replace(/^native:/, "") ?? "";
  if (cleaned && store.get(cleaned)) return cleaned;
  const needle = title?.trim().toLowerCase() ?? "";
  if (needle) {
    const open = store.open();
    const exact = open.filter((todo) => todo.title.toLowerCase() === needle);
    if (exact.length === 1) return exact[0].id;
    const partial = open.filter((todo) => todo.title.toLowerCase().includes(needle));
    if (partial.length === 1) return partial[0].id;
  }
  if (cleaned) return cleaned;
  throw new AppError(400, "請指定要操作的待辦項目。");
}

function parseNaiveOrIsoInstant(timeZone: string, raw: string): string {
  const trimmed = raw.trim();
  const localMatch = /^(\d{4}-\d{2}-\d{2})[T ]([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(trimmed);
  if (localMatch && isDayKey(localMatch[1])) {
    return zonedTimeToUtc(timeZone, localMatch[1], Number(localMatch[2]), Number(localMatch[3])).toISOString();
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) throw new AppError(400, "時間格式不正確。");
  return new Date(ms).toISOString();
}

function resolveEventTimes(timeZone: string, today: DayKey, op: BotProposedOp): { start: string; end?: string; allDay: boolean } {
  const rawStart = op.start?.trim() || "";
  if (!rawStart) {
    const day = op.dueDay && isDayKey(op.dueDay) ? op.dueDay : today;
    if (op.dueTime && isLocalTime(op.dueTime)) {
      const [h, m] = op.dueTime.split(":").map(Number);
      const start = zonedTimeToUtc(timeZone, day, h, m).toISOString();
      return { start, end: new Date(Date.parse(start) + 3_600_000).toISOString(), allDay: false };
    }
    if (op.dueDay && isDayKey(op.dueDay)) {
      const resolved = resolveTimes(timeZone, { start: day, allDay: true });
      return { ...resolved, allDay: true };
    }
    throw new AppError(400, "請提供行程開始日期或時間。");
  }
  if (isDayKey(rawStart) || op.allDay === true) {
    const startDay = isDayKey(rawStart) ? rawStart : dayKey(timeZone, parseNaiveOrIsoInstant(timeZone, rawStart));
    const rawEnd = op.end?.trim() || undefined;
    const endDay = rawEnd ? (isDayKey(rawEnd) ? rawEnd : dayKey(timeZone, parseNaiveOrIsoInstant(timeZone, rawEnd))) : undefined;
    const resolved = resolveTimes(timeZone, { start: startDay, ...(endDay ? { end: endDay } : {}), allDay: true });
    return { ...resolved, allDay: true };
  }
  const start = parseNaiveOrIsoInstant(timeZone, rawStart);
  const end = op.end?.trim()
    ? parseNaiveOrIsoInstant(timeZone, op.end)
    : new Date(Date.parse(start) + 3_600_000).toISOString();
  const resolved = resolveTimes(timeZone, { start, end, allDay: false });
  return { ...resolved, allDay: false };
}

export async function executeBotOp(op: BotProposedOp, deps: BotExecutorDeps): Promise<BotExecutionResult> {
  const { services, host, today, suiteBridge } = deps;
  const timeZone = services.config.timeZone;

  switch (op.kind) {
    case "todo.create": {
      const title = (op.title ?? op.text ?? "").trim();
      if (!title) throw new AppError(400, "請提供待辦標題。");
      const dueTime = op.dueTime && isLocalTime(op.dueTime) ? op.dueTime : undefined;
      const dueDay = op.dueDay && isDayKey(op.dueDay)
        ? op.dueDay
        : dueTime ? services.today() : undefined;
      const todo = todoStore(services).create({
        title,
        ...(op.notes?.trim() ? { notes: op.notes.trim() } : {}),
        ...(dueDay ? { dueDay } : {}),
        ...(dueDay && dueTime ? { dueTime } : {}),
        ...(op.priority ? { priority: op.priority } : {}),
        origin: "quick-capture",
      });
      return {
        label: `新增待辦「${todo.title}」`,
        ...(todo.dueDay ? { detail: [todo.dueDay, todo.dueTime].filter(Boolean).join(" ") } : {}),
        resultHref: `#/tasks?focus=${encodeURIComponent(todo.id)}`,
        undoSpec: { kind: "todo.discard", id: todo.id },
      };
    }

    case "todo.complete": {
      const store = todoStore(services);
      const id = resolveTodoTargetId(services, op.targetId, op.title);
      const prev = store.require(id);
      const wasOpen = prev.status === "open";
      const done = store.complete(id);
      return {
        label: `完成待辦「${done.title}」`,
        resultHref: `#/tasks?focus=${encodeURIComponent(done.id)}`,
        ...(wasOpen ? { undoSpec: { kind: "todo.reopen", id: done.id } } : {}),
      };
    }

    case "todo.update": {
      const store = todoStore(services);
      const id = resolveTodoTargetId(services, op.targetId, null);
      const prev = store.require(id);
      const dueTime = op.dueTime && isLocalTime(op.dueTime) ? op.dueTime : undefined;
      const dueDay = op.dueDay && isDayKey(op.dueDay)
        ? op.dueDay
        : dueTime && !prev.dueDay ? services.today() : undefined;
      const next = store.update(id, {
        ...(op.title?.trim() ? { title: op.title.trim() } : {}),
        ...(op.notes !== null ? { notes: op.notes } : {}),
        ...(dueDay ? { dueDay } : {}),
        ...(dueTime ? { dueTime } : {}),
        ...(op.priority ? { priority: op.priority } : {}),
      });
      return {
        label: `更新待辦「${next.title}」`,
        ...(next.dueDay ? { detail: [next.dueDay, next.dueTime].filter(Boolean).join(" ") } : {}),
        resultHref: `#/tasks?focus=${encodeURIComponent(next.id)}`,
        undoSpec: {
          kind: "todo.patch",
          id: next.id,
          patch: {
            title: prev.title,
            notes: prev.notes ?? null,
            dueDay: prev.dueDay ?? null,
            dueTime: prev.dueTime ?? null,
            priority: prev.priority,
          },
        },
      };
    }

    case "todo.delete": {
      const store = todoStore(services);
      const id = resolveTodoTargetId(services, op.targetId, op.title);
      const prev = store.require(id);
      const { undoToken } = store.delete(id);
      return {
        label: `刪除待辦「${prev.title}」`,
        ...(undoToken ? { undoSpec: { kind: "trash", token: undoToken } } : {}),
      };
    }

    case "idea.create": {
      const text = (op.text ?? op.notes ?? op.title ?? "").trim();
      if (!text) throw new AppError(400, "請提供靈感內容。");
      const tags = (op.tags ?? [])
        .map((tag) => tag.replace(/^[#＃]+/, "").trim())
        .filter((tag) => tag.length > 0 && !/[\s#＃,，]/.test(tag));
      const idea = ideaStore(services).create({
        text,
        ...(op.title?.trim() && op.text?.trim() ? { title: op.title.trim() } : {}),
        tags,
        origin: "quick-capture",
      });
      return {
        label: `記下靈感「${shortText(idea.title ?? idea.text, 36)}」`,
        ...(idea.tags.length ? { detail: idea.tags.map((t) => `#${t}`).join(" ") } : {}),
        resultHref: `#/ideas?focus=${encodeURIComponent(idea.id)}`,
        undoSpec: { kind: "idea.discard", id: idea.id },
      };
    }

    case "event.create_local":
    case "event.create_google": {
      const title = (op.title ?? op.text ?? "").trim();
      if (!title) throw new AppError(400, "請提供行程名稱。");
      const calendar = calendarService(services);
      const pushGoogle = op.kind === "event.create_google";
      if (pushGoogle && !(await calendar.canWriteGoogle())) {
        throw new AppError(409, "尚未授權 Google 行事曆新增權限，請先在「連線與設定」連接 Google 行事曆，或改為建立本機行程。");
      }
      const when = resolveEventTimes(timeZone, services.today(), op);
      const event = calendar.create({
        title,
        start: when.start,
        end: when.end,
        allDay: when.allDay,
        ...(op.location?.trim() ? { location: op.location.trim() } : {}),
        ...(op.notes?.trim() ? { notes: op.notes.trim() } : {}),
        origin: "capture",
      });
      if (pushGoogle) {
        try {
          await calendar.pushToGoogle(event.id, AbortSignal.timeout(15_000));
        } catch (error) {
          calendar.discard(event.id);
          throw error;
        }
      }
      const eventDay = dayKey(timeZone, event.start);
      return {
        label: `${pushGoogle ? "新增 Google 行程" : "新增本機行程"}「${event.title}」`,
        detail: [eventDay, event.location].filter(Boolean).join(" · "),
        resultHref: `#/calendar?day=${encodeURIComponent(eventDay)}`,
        undoSpec: { kind: "event.discard", id: event.id, ...(pushGoogle ? { google: true } : {}) },
      };
    }

    case "habit.check": {
      const store = habitStore(services);
      const active = store.all().filter((h) => !h.archived);
      const cleanedId = op.targetId?.trim() ?? "";
      const needle = (op.title ?? "").trim().toLowerCase();
      const habit = (cleanedId ? active.find((h) => h.id === cleanedId) : undefined)
        ?? (needle ? active.find((h) => h.name.toLowerCase() === needle || (h.short ?? "").toLowerCase() === needle) : undefined)
        ?? (cleanedId ? store.get(cleanedId) : undefined);
      if (!habit) throw new AppError(404, "找不到指定的習慣。");
      const day = op.dueDay && isDayKey(op.dueDay) ? op.dueDay : services.today();
      const alreadyDone = (store.logs([habit]).get(habit.id) ?? []).some((entry) => entry.day === day);
      store.check(habit, day, services.now().toISOString());
      return {
        label: `習慣打卡「${habit.name}」`,
        detail: day,
        resultHref: "#/habits",
        ...(!alreadyDone ? { undoSpec: { kind: "habit.uncheck", id: habit.id, day } } : {}),
      };
    }

    case "queue.snooze": {
      const itemId = op.targetId?.trim() ?? "";
      if (!itemId) throw new AppError(400, "請指定要延後的佇列項目。");
      const until = op.until?.trim()
        ? parseNaiveOrIsoInstant(timeZone, op.until)
        : zonedTimeToUtc(timeZone, addDays(services.today(), 1), 8, 0).toISOString();
      const res = await today.actions.perform({ itemId, action: "snooze", params: { until } });
      return {
        label: op.title ? `延後「${shortText(op.title, 36)}」` : `延後佇列項目`,
        resultHref: "#/today",
        undoSpec: { kind: "today.action", actionId: res.actionId },
      };
    }

    case "sources.sync": {
      const started = (await Promise.all(host.sources.map(async (source) => ((await source.request(true)) ? source.id : null)))).filter(Boolean);
      return {
        label: "立即同步所有來源",
        detail: started.length > 0 ? `已啟動 ${started.length} 個來源同步` : "所有來源已是最新狀態",
      };
    }

    case "mail.archive":
    case "mail.mark_read": {
      const raw = op.targetId?.trim() ?? "";
      if (!raw) throw new AppError(400, "請指定要處理的信件代碼。");
      const itemId = raw.includes(":") ? raw : `gmail:${raw}`;
      const action = op.kind === "mail.archive" ? "archive" : "read";
      const res = await today.actions.perform({ itemId, action });
      const verb = op.kind === "mail.archive" ? "封存信件" : "標為已讀";
      return {
        label: op.title ? `${verb}「${shortText(op.title, 36)}」` : verb,
        resultHref: "#/mail",
        undoSpec: { kind: "today.action", actionId: res.actionId },
      };
    }

    case "explain.create_note": {
      const content = (op.text ?? op.notes ?? op.title ?? "").trim();
      if (content.length < 2) throw new AppError(400, "請提供要整理成 BELL Explain 學習筆記的主題或內容。");
      const created = await suiteBridge.createExplainNote({
        content,
        question: op.title?.trim() || undefined,
        depth: op.depth ?? "intermediate",
      });
      return {
        label: `在 BELL Explain 建立筆記「${created.title}」`,
        detail: "已在背景啟動講義產生",
        ...(created.href ? { resultHref: created.href } : {}),
      };
    }

    case "pr.create_run": {
      const prompt = (op.text ?? op.notes ?? op.title ?? "").trim();
      if (!prompt) throw new AppError(400, "請提供要交給 BELL PR 執行的任務描述。");
      const snapshot = await suiteBridge.readPrSnapshot();
      const rawRepo = op.targetId?.trim() ?? "";
      const matchedRepo = rawRepo
        ? snapshot.repos.find((r) => r.id === rawRepo || r.name.toLowerCase() === rawRepo.toLowerCase())
        : snapshot.repos.length === 1 ? snapshot.repos[0] : undefined;
      const repoId = matchedRepo?.id ?? rawRepo;
      if (!repoId) {
        throw new AppError(400, snapshot.repos.length > 1
          ? `請指定目標儲存庫（目前有：${snapshot.repos.map((r) => r.name).join("、")}）。`
          : "找不到可用的 BELL PR 儲存庫，請先在 BELL PR 新增儲存庫。");
      }
      const created = await suiteBridge.createPrRun({
        repoId,
        prompt,
        title: op.title,
        learnByHand: op.learnByHand,
      });
      return {
        label: `在 BELL PR 啟動任務「${created.title}」`,
        detail: `狀態：${created.status}`,
        ...(created.href ? { resultHref: created.href } : {}),
      };
    }

    case "pr.approve_plan": {
      const runId = (op.targetId ?? "").trim();
      if (!runId) throw new AppError(400, "請指定要核准計畫的 BELL PR 任務編號。");
      const approved = await suiteBridge.approvePrPlan({ runId });
      return {
        label: `核准 BELL PR 計畫「${approved.title}」`,
        detail: `狀態：${approved.status}`,
        ...(approved.href ? { resultHref: approved.href } : {}),
      };
    }
  }
}

export async function undoBotOp(spec: BotUndoSpec, deps: BotExecutorDeps): Promise<void> {
  const { services, today } = deps;
  switch (spec.kind) {
    case "todo.discard":
      todoStore(services).discard(spec.id);
      return;
    case "todo.reopen":
      todoStore(services).reopen(spec.id);
      return;
    case "todo.patch":
      todoStore(services).update(spec.id, {
        title: spec.patch.title,
        notes: spec.patch.notes,
        dueDay: spec.patch.dueDay as DayKey | null,
        dueTime: spec.patch.dueTime,
        priority: spec.patch.priority,
      });
      return;
    case "trash":
      services.trash.restore(spec.token);
      return;
    case "idea.discard":
      ideaStore(services).discard(spec.id);
      return;
    case "event.discard": {
      const calendar = calendarService(services);
      if (spec.google) {
        await calendar.removeFromGoogle(spec.id, AbortSignal.timeout(12_000)).catch(() => {});
      }
      calendar.discard(spec.id);
      return;
    }
    case "habit.uncheck": {
      const store = habitStore(services);
      const habit = store.get(spec.id);
      store.uncheck(habit, spec.day as DayKey);
      return;
    }
    case "today.action":
      await today.actions.undo(spec.actionId);
      return;
  }
}
