import { z } from "zod";
import { BRIEF_LIMITS, BRIEF_REF_KINDS, type BriefRefKind } from "../../../shared/brief.js";
import type { AgentProvider } from "../../../shared/models.js";
import { localTime } from "../../../shared/time.js";
import type { BriefFallbackReason, QueueKind, TodayPayload } from "../../../shared/today.js";
import { monthDayWeek } from "../../../shared/today-format.js";
import { AppError, SchemaValidationError, TransientAgentError } from "../../errors.js";
import { secretInPatch } from "../../secrets/redact.js";

/**
 * The AI daily brief (SPEC §4.2): what the model sees (the in-process Today
 * payload, compacted), what it must answer, and the checks its answer must
 * pass before it replaces the rule brief. Pure; the service does the I/O.
 */

export const BRIEF_ROLE = "每日摘要";

export const BRIEF_PROMPT = `為使用者寫今天的每日摘要，它顯示在 Today 頁的大標題下方，標題已經說了還有幾件事要處理。
規則：
- 最多 ${BRIEF_LIMITS.sentences} 句、最多 ${BRIEF_LIMITS.text} 個字（含標點）。全形標點；中文與英文、數字之間加半形空格，例如「OS HW3」「23:59 截止」。
- 第一句先點出最重要的一件事（queue 中 group 為「最重要」的第一項；沒有就用「今天內」的第一項），再接下一個有時間的事（agenda 的下一個行程或今天的截止），時間用 HH:MM。
- 第二句可以提最大的空檔（gap）適合做什麼，或之後的行程。
- 不要問候、不要條列、不要表情符號，不要提資料裡沒有的事，不要評論或催促。
- 不要寫「N 件」「N 封」「N 項」這類數量，除非數字和 counts 或資料完全一致。
- 沒有待處理也沒有行程時，用一句話說今天沒有排定的事，並提 later 裡最近的一個行程。
- refs 列出你在文字裡提到的項目：id 只能用資料裡出現的 id，kind 用該項目的 ref，最多 ${BRIEF_LIMITS.refs} 個；沒有就給空陣列。`;

/** What the model must return (strict; also the --json-schema). */
export const briefAnswerSchema = z.object({
  text: z.string().min(1).max(BRIEF_LIMITS.text),
  refs: z.array(z.object({ kind: z.enum(BRIEF_REF_KINDS), id: z.string().max(600) }).strict()).max(BRIEF_LIMITS.refs),
}).strict();
export type BriefAnswer = z.infer<typeof briefAnswerSchema>;

const GROUP_LABELS = { now: "最重要", today: "今天內", later: "可以等" } as const;

export function refKind(kind: QueueKind): BriefRefKind {
  if (kind.startsWith("mail.")) return "mail";
  if (kind === "assignment") return "assignment";
  if (kind === "review" || kind === "pr.changes") return "github";
  if (kind === "todo" || kind === "suggestion.todo") return "todo";
  return "event";
}

const safe = (...texts: Array<string | undefined>) => !texts.some((text) => text !== undefined && secretInPatch(text));

/**
 * The model's input: today's queue (at most 15 rows, in display order), the
 * rest of today's agenda, the free slot, what comes later and the counts. No
 * message bodies; rows whose text looks like a secret are left out.
 */
export function briefData(payload: TodayPayload, timeZone: string) {
  const queue = payload.queue
    .flatMap((group) => group.items.map((item) => ({ item, group: GROUP_LABELS[group.group] })))
    .filter(({ item }) => safe(item.title, item.summary, ...item.meta))
    .slice(0, 15)
    .map(({ item, group }) => ({
      id: item.id,
      ref: refKind(item.kind),
      group,
      kind: item.kind,
      title: item.title,
      meta: item.meta.join(" · "),
      ...(item.when ? { when: item.when.label } : {}),
      ...(item.summary ? { summary: item.summary } : {}),
    }));
  const agenda = payload.agenda.items
    .filter((item) => !item.past && safe(item.title, item.meta))
    .map((item) => ({
      ...(item.itemId ? { id: item.itemId } : {}),
      kind: item.kind === "due" ? "截止" : "行程",
      ...(item.allDay ? { allDay: true } : { start: localTime(timeZone, item.start) }),
      ...(item.end && !item.allDay ? { end: localTime(timeZone, item.end) } : {}),
      title: item.title,
      ...(item.meta ? { meta: item.meta } : {}),
    }));
  const gap = payload.agenda.gap;
  return {
    date: monthDayWeek(timeZone, payload.now),
    now: localTime(timeZone, payload.now),
    counts: {
      open: payload.counts.open,
      handled: payload.counts.handled,
      inboxUnread: payload.counts.inboxUnread,
      habitsLeft: payload.counts.habitsLeft,
    },
    queue,
    agenda,
    ...(gap ? { gap: { start: localTime(timeZone, gap.start), hours: gap.hours, label: gap.label, forItemId: gap.forItemId } } : {}),
    later: payload.later.events.filter((event) => safe(event.title, event.meta)).map((event) => ({ date: `${event.date} ${event.label}`, title: event.title, meta: event.meta })),
    habitsLeft: payload.habits.filter((habit) => habit.due !== false && !habit.doneToday).map((habit) => habit.name),
  };
}

export type BriefData = ReturnType<typeof briefData>;

/** The model's answer did not follow the brief contract (length, sentences, numbers). */
export class BriefRejectedError extends AppError {
  constructor(readonly rule: "length" | "sentences" | "numbers") {
    super(502, "AI 摘要不符合格式，先顯示規則整理的摘要。");
    this.name = "BriefRejectedError";
  }
}

/** Numbers the text may state with 件 / 封 / 項: the counts and every per-group or per-kind tally of the queue. */
function allowedNumbers(payload: TodayPayload): Set<number> {
  const allowed = new Set<number>([
    payload.counts.open, payload.counts.handled, payload.counts.total, payload.counts.inboxUnread, payload.counts.habitsLeft,
    payload.digest?.total ?? 0,
  ]);
  const byKind = new Map<string, number>();
  for (const group of payload.queue) {
    allowed.add(group.items.length);
    for (const item of group.items) {
      byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
      byKind.set(refKind(item.kind), (byKind.get(refKind(item.kind)) ?? 0) + 1);
    }
  }
  for (const value of byKind.values()) allowed.add(value);
  const dueToday = payload.agenda.items.filter((item) => item.kind === "due" && !item.past).length;
  allowed.add(dueToday);
  return allowed;
}

/**
 * Checks the AI text against the SPEC contract: ≤ 80 characters, ≤ 2
 * sentences, and no 「N 件／N 封／N 項」 that contradicts the counts.
 * Returns the trimmed text; throws BriefRejectedError otherwise.
 */
export function checkBriefText(text: string, payload: TodayPayload): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed || Array.from(trimmed).length > BRIEF_LIMITS.text) throw new BriefRejectedError("length");
  const sentences = trimmed.split(/[。！？!?]+/).map((part) => part.trim()).filter(Boolean);
  if (sentences.length > BRIEF_LIMITS.sentences) throw new BriefRejectedError("sentences");
  const allowed = allowedNumbers(payload);
  for (const match of trimmed.matchAll(/(\d+)\s*(件|封|項)/g))
    if (!allowed.has(Number(match[1]))) throw new BriefRejectedError("numbers");
  return trimmed;
}

/** Keeps refs that name an item of the data, with the data's own kind. */
export function knownRefs(refs: BriefAnswer["refs"], data: BriefData): BriefAnswer["refs"] {
  const kinds = new Map<string, BriefRefKind>(data.queue.map((item) => [item.id, item.ref]));
  const seen = new Set<string>();
  return refs
    .filter((ref) => kinds.has(ref.id) && !seen.has(ref.id) && seen.add(ref.id))
    .map((ref) => ({ kind: kinds.get(ref.id)!, id: ref.id }))
    .slice(0, BRIEF_LIMITS.refs);
}

/**
 * The SPEC §4.2 reason shown in the fallback note for a failed generation:
 * a login problem, a timeout, a usage or rate limit, a connection that failed
 * on the way (an upstream error, a lost OAuth refresh race), or an answer
 * that did not pass the schema.
 */
export function fallbackReason(error: unknown, provider: AgentProvider): BriefFallbackReason {
  if (error instanceof AppError && error.status === 503) {
    if (error instanceof TransientAgentError) return "暫時無法連線";
    return provider === "codex" ? "Codex 尚未登入" : "Claude 尚未登入";
  }
  if ((error instanceof AppError && error.status === 504) || (error instanceof Error && error.name === "TimeoutError")) return "產生逾時";
  if (error instanceof AppError && error.status === 429) return "額度已達上限";
  if (error instanceof SchemaValidationError || (error instanceof AppError && (error.status === 422 || error.status === 413))) return "回應格式不正確";
  if (error instanceof BriefRejectedError) return "回應格式不正確";
  if (error instanceof AppError && error.status === 502) return "暫時無法連線";
  return "回應格式不正確";
}

/** Reasons worth one automatic retry later the same day: they say nothing about the setup or the answer. */
export const TRANSIENT_REASONS: ReadonlySet<BriefFallbackReason> = new Set(["額度已達上限", "暫時無法連線", "產生逾時"]);
