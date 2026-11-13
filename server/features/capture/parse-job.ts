import { z } from "zod";
import { parseCapture } from "../../../shared/capture-parse.js";
import { CAPTURE_LIMITS, CAPTURE_TYPES, type CaptureParseOption, type CaptureParseResult } from "../../../shared/connect.js";
import type { JobView } from "../../../shared/jobs.js";
import type { QuickCaptureSuggestion } from "../../../shared/suggestions.js";
import { addDays, dayKey, localTime, zonedTimeToUtc, type DayKey } from "../../../shared/time.js";
import { weekdayChar } from "../../../shared/today-format.js";
import { AppError } from "../../errors.js";
import { withGenerationProgress } from "../../generation-progress.js";
import type { ModuleContext } from "../../modules.js";
import { dueFromInstant } from "../todos/actions.js";

/**
 * How long the model may take once its CLI is running. SPEC-ux §6.6 asked for
 * 8 s, but one Claude Code turn already takes 3.5–7 s on this host (AGENTS.md)
 * and a kill at 8 s threw away answers whose tokens were spent. The palette
 * shows the rule result at once and the AI result as a separate option, so
 * the wait costs nothing; typing on or closing the palette cancels the job.
 * Time queued behind other model work does not count (the parse also goes
 * ahead of background work for the agent slot).
 */
export const CAPTURE_PARSE_TIMEOUT_MS = 45_000;
const STALE_SUGGESTION_MS = 60 * 60_000;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const parseAnswerSchema = z.object({
  type: z.enum(CAPTURE_TYPES),
  title: z.string().min(1).max(CAPTURE_LIMITS.title),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  time: z.string().regex(TIME).nullable(),
  endTime: z.string().regex(TIME).nullable(),
  location: z.string().max(200).nullable(),
  basis: z.string().max(40).nullable(),
}).strict();

export type ParseAnswer = z.infer<typeof parseAnswerSchema>;

const PROMPT = [
  "把使用者快速記下的一句話整理成一筆紀錄，type 只能是：todo（要做的事，可以有截止時間）、event（在某個時間發生、要出席的行程）、idea（想法或點子）。",
  "title：簡潔的標題，去掉日期與時間的字詞，保留人名與事情（例如「跟林教授討論期末專題提案」）。",
  "date：YYYY-MM-DD。依 data.today 與 data.weekday 推算「明天」「週三」「下週」等相對日期（一週從星期一開始）；說不出日期就回傳 null。",
  "time：24 小時制 HH:MM。只說「早上」「下午」時取合理時間（09:00、14:00）；「…前」表示截止時間；沒有時間就回傳 null。",
  "endTime：行程的結束時間，沒有就回傳 null。location：地點，沒有就回傳 null。",
  "basis：原文中推得日期或時間的字詞（最多 12 個字，例如「週三 meeting 前」），沒有就回傳 null。",
  "data.rule 是規則解析的猜測，可能不完整，僅供參考。",
].join("\n");

/** The model's answer as a confirmable option with UTC instants (an event without a day or time becomes a todo). */
export function optionFromAnswer(answer: ParseAnswer, timeZone: string, today: DayKey): CaptureParseOption {
  const basis = answer.basis?.trim() || undefined;
  const location = answer.location?.trim() || undefined;
  const title = answer.title.trim();
  const at = (date: string, time: string) => {
    const [hour, minute] = time.split(":").map(Number);
    return zonedTimeToUtc(timeZone, date, hour, minute).toISOString();
  };
  let type = answer.type;
  let date = answer.date;
  if (type === "event" && !date && answer.time) date = today;
  if (type === "event" && !date) type = "todo";
  if (type === "idea") return { type, title, allDay: false, ...(basis ? { basis } : {}) };
  if (type === "todo") {
    if (!date) return { type, title, allDay: false, ...(basis ? { basis } : {}) };
    return { type, title, due: at(date, answer.time ?? "23:59"), allDay: !answer.time, ...(basis ? { basis } : {}) };
  }
  if (!answer.time) return { type, title, start: date!, end: addDays(date!, 1), allDay: true, ...(location ? { location } : {}), ...(basis ? { basis } : {}) };
  const start = at(date!, answer.time);
  let end = answer.endTime ? at(date!, answer.endTime) : new Date(Date.parse(start) + 3_600_000).toISOString();
  if (Date.parse(end) <= Date.parse(start)) end = at(addDays(date!, 1), answer.endTime!);
  return { type, title, start, end, allDay: false, ...(location ? { location } : {}), ...(basis ? { basis } : {}) };
}

function suggestionPayload(option: CaptureParseOption, text: string, timeZone: string): QuickCaptureSuggestion & { input: string; basis?: string } {
  const extra = { input: text, ...(option.basis ? { basis: option.basis } : {}) };
  if (option.type === "idea") return { target: "idea", text: option.title, ...extra };
  if (option.type === "event") {
    return { target: "event", event: { title: option.title, start: option.start!, ...(option.end ? { end: option.end } : {}), allDay: option.allDay, ...(option.location ? { location: option.location } : {}) }, ...extra };
  }
  return { target: "todo", todo: { title: option.title, ...(option.due ? dueFromInstant(option.due, timeZone) : {}) }, ...extra };
}

/**
 * POST /api/capture/parse: the `quick-capture` job (zero tools, strict JSON,
 * CAPTURE_PARSE_TIMEOUT_MS once the CLI runs). A newer parse cancels an older
 * one still running (the palette parses one sentence at a time). Its answer is stored as a pending `quick-capture` suggestion and
 * returned as `done.result` (CaptureParseResult); the palette shows it as the
 * 「AI 建議」 option and creates it only when the user picks it
 * (POST /api/capture { …option, suggestionId }).
 */
export function startParseJob(ctx: ModuleContext, text: string, timeoutMs = CAPTURE_PARSE_TIMEOUT_MS): JobView {
  if (!ctx.settings.value("ai.enabled")) throw new AppError(503, "AI 已關閉，先用規則解析的結果。");
  const now = ctx.now();
  const timeZone = ctx.config.timeZone;
  const today = dayKey(timeZone, now);
  const rule = parseCapture(text, { now, timeZone });
  pruneStale(ctx, now);

  for (const running of ctx.jobs.running("quick-capture")) ctx.jobs.cancel(running.id, "已改為解析新的內容。");
  return ctx.jobs.start({ kind: "quick-capture", title: "解析快速記下" }, async (emit, signal) => {
    try {
      const { value, execution } = await withGenerationProgress("解析快速記下", "parse", emit, signal, (onProgress) => ctx.ai.runStructured({
        role: "快速記下解析",
        schema: parseAnswerSchema,
        prompt: PROMPT,
        data: {
          text,
          today,
          weekday: `週${weekdayChar(today)}`,
          now: localTime(timeZone, now),
          timeZone,
          rule: { type: rule.type, title: rule.title, day: rule.day ?? null, time: rule.time ?? null },
        },
        signal,
        timeoutMs,
        priority: "interactive",
        onProgress,
      }));
      const option = optionFromAnswer(value, timeZone, today);
      const suggestion = ctx.suggestions.create({
        kind: "quick-capture",
        title: `快速記下：${option.title}`,
        payload: suggestionPayload(option, text, timeZone),
        origin: "快速記下",
        modelExecution: execution,
      });
      const result: CaptureParseResult = { suggestionId: suggestion.id, option };
      return result;
    } catch (error) {
      // Our own deadline: report 產生逾時 (the palette's reason) instead of the generic timeout advice.
      if (error instanceof AppError && error.status === 504) throw new AppError(504, "產生逾時");
      throw error;
    }
  }, { maxRunning: 2, busyMessage: "AI 正在解析上一句，請稍候。" });
}

/** AI parses nobody picked within an hour are dismissed, so pending quick-capture suggestions never pile up. */
function pruneStale(ctx: ModuleContext, now: Date): void {
  for (const suggestion of ctx.suggestions.list({ status: "pending", kind: "quick-capture", limit: 200 })) {
    if (now.getTime() - Date.parse(suggestion.createdAt) > STALE_SUGGESTION_MS) ctx.suggestions.decide(suggestion.id, "dismissed");
  }
}
