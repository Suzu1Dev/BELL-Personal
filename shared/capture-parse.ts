import type { EventRepeatInput } from "./calendar.js";
import type { CaptureType } from "./connect.js";
import { addDays, dayKey, localTime, weekdayOf, zonedParts, zonedTimeToUtc, type DayKey } from "./time.js";

/**
 * The quick-capture rule parser (SPEC-ux §6.6): 「明天 9:00 交報告」 → a todo
 * due tomorrow 09:00. Pure and synchronous, so it runs on every keystroke in
 * the palette, the Today capture field, the 待辦 add row and the 靈感
 * Composer, and again on the server for POST /api/capture. Every day is
 * computed in the given IANA zone (Asia/Taipei), never the host's.
 *
 * Recognised:
 *  - dates: 今天 · 明天 · 後天 · 大後天 · 今晚/明早… · (這|本|下|下下)?(週|周|星期|禮拜)X ·
 *    下週 (vague) · M/D · M月D日 · YYYY-MM-DD · 月底 · 週末 · today/tomorrow/tonight ·
 *    (next|this)? Friday (an abbreviation alone only as Fri/Sat, never SAT or sat, nor before another
 *    capitalised word as in Sun Moon Lake; a weekday nobody leads into never overrides an earlier date)
 *  - repeats: 每週X · 每個禮拜X · 每星期X (X = 一…日) → the same event every week, starting at the next such
 *    weekday (today when the time has not passed yet). Only a weekday makes a repeat: 「每週報告」, 「每次開會」,
 *    「每週一次」 and 「每天」 do not. A repeat with a time reads as an event; only an event keeps it.
 *  - times: H:MM · H點(半|N分)? · 上午/早上/中午/下午/傍晚/晚上 + time (下午 = +12 for 1–11) ·
 *    HHMM right after a date · 3pm · ranges 14:00-15:30 / 下午2點到4點
 *  - durations: N 小時 · N 分(鐘)? · 半小時
 *  - deadline scaffolding, removed with its date or time: 要在/得在/必須在/在/於 … ·
 *    最晚/最遲 … · … 前/之前/以前/為止 (+ 要) · 到 … 為止 · before/by/until/due … · on/at …
 *    · 週五的作業 (the 的 goes with the date). Not inside a word: 只要, 記得, 現在, 還在, 總會, 免得 keep
 *    their characters; after 關於/對於/由於/至於… the date is what the text is about, so it stays in the
 *    title (it still gives the day, at low confidence)
 *  - signals: event (跟…meeting, 開會, @地點, a time range), todo (a leading verb, 前, 截止),
 *    idea (想到/靈感/點子/idea: first, #靈感, or more than 40 characters without a date)
 *  - tags: #tag (not #123, which stays in the title)
 *
 * The title is the text as typed (full-width punctuation kept) without those
 * tokens: a token between two Han characters or full-width punctuation leaves
 * no gap (「報告週五前完成」 → 「報告完成」, 「簡報，要在週日前生出來」 →
 * 「簡報，生出來」), otherwise one space; repeated or dangling punctuation,
 * brackets left empty (「報告（週五前）交」 → 「報告交」) and a 的 left at the
 * end go too.
 */

export type CaptureContext = "any" | "todo" | "idea";
export type CaptureSpanKind = "date" | "time" | "duration" | "tag" | "location" | "marker";

export interface CaptureSpan {
  /** UTF-16 offsets into the original text, end exclusive. */
  start: number;
  end: number;
  kind: CaptureSpanKind;
}

export interface CaptureParse {
  type: CaptureType;
  /** The text without the recognised tokens; the record's title (or the idea text). */
  title: string;
  /** Local day named by the date words (or implied by a time alone). */
  day?: DayKey;
  /** Local "HH:MM" start (event) or due time (todo). */
  time?: string;
  /** Local "HH:MM" end of a range. */
  endTime?: string;
  /** event: ISO start; all-day events use the DayKey. */
  start?: string;
  /** event: ISO end (start + duration, default 1 h); all-day: the next DayKey (exclusive). */
  end?: string;
  /** todo: ISO deadline; a date without a time is due at 23:59 that day. */
  due?: string;
  /** A date without a time (all-day event, todo due "that day"). */
  allDay: boolean;
  /** 「40 分鐘」: an event's length or a todo's estimate. */
  durationMinutes?: number;
  location?: string;
  tags: string[];
  /** Highlighted in the input (`mark`). */
  spans: CaptureSpan[];
  /** high: every token was understood and a signal decided the type. low: offer AI. */
  confidence: "high" | "low";
  signals: { event: boolean; todo: boolean; idea: boolean; deadline: boolean };
  /** A vague time word (下週, 找時間, 下午 without an hour, 3點 without 上午/下午). */
  vague: boolean;
  /** 每週X was read: a weekly event on the weekday of `day` (kept on a todo or idea too, so Tab to 行程 still repeats). */
  repeat?: EventRepeatInput;
}

export interface CaptureParseOptions {
  now: Date;
  timeZone: string;
  /** "idea" (靈感 Composer, Today capture card): no date means an idea. "todo": the 待辦 add row. */
  context?: CaptureContext;
}

/** Tab cycles the type in this order (待辦 → 行程 → 靈感). */
export const CAPTURE_TYPE_ORDER: readonly CaptureType[] = ["todo", "event", "idea"];
export const DEFAULT_EVENT_MINUTES = 60;
/** Longer than this without a date reads as an idea (SPEC §6.6). */
export const IDEA_LENGTH = 40;

const TODO_VERBS = [
  "交", "繳", "寫", "做", "準備", "讀", "回", "買", "寄", "改", "整理", "報名",
  "填", "印", "還", "訂", "申請", "提交", "上傳", "複習", "練習", "完成", "處理", "確認", "聯絡", "打電話", "洗", "拿", "領", "付", "預約", "修", "查", "審查",
];
const TODO_PREFIXES = /^(?:要|得|記得|需要|必須|去|先)/;
/** Event words that make an event on their own (with a time). */
const EVENT_WORDS = /(?:meeting|開會|會議|面試|面談|聚餐|聚會|約會|吃飯|午餐|晚餐|上課|講座|研討會|交流會|演講|看診|門診|會面|晨會|週會|組會|例會|班會|社課|workshop)/i;
/** Weaker words that need a companion (跟教授 討論). */
const WITH_PERSON = /(?:跟|和|與|找)[^，,。]{0,12}?(?:meeting|開會|討論|見面|聚|吃飯|約|聊|碰面|面談)/i;
const IDEA_PREFIX = /^\s*(?:想到|靈感|點子|創意|idea)\s*[:：]?\s*/i;
const PERIODS = "凌晨|清晨|早上|上午|中午|下午|午後|傍晚|晚上|夜裡|半夜|早|晚";
const CN_DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const WEEKDAY_CHARS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const EN_WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tues: 2, tue: 2, wednesday: 3, weds: 3, wed: 3,
  thursday: 4, thurs: 4, thur: 4, thu: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const EN_WEEKDAY = /(?<![A-Za-z])(?:(next|this)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|tues|thurs|thur|weds|sun|mon|tue|wed|thu|fri|sat)\.?(?![A-Za-z])/i;

/** 每週一 / 每個禮拜二 / 每星期五: a weekday after 每週; a count (每週一次, 每週三堂) or a list (每週一、三) is not one. */
const WEEKLY = /每(?:個)?(?:週|周|星期|禮拜)([一二三四五六日天])(?![次回堂節個遍趟天、和及與])/;

/** 「三」→3, 「十五」→15, 「二十三」→23, "7"→7. NaN when not a number. */
export function parseNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  if (!/^[零〇一二兩三四五六七八九十]+$/.test(text)) return Number.NaN;
  if (!text.includes("十")) return text.length === 1 ? CN_DIGITS[text] : Number.NaN;
  const [tens, ones] = text.split("十");
  if (text.split("十").length > 2) return Number.NaN;
  const t = tens === "" ? 1 : CN_DIGITS[tens];
  const o = ones === "" ? 0 : CN_DIGITS[ones];
  if (t === undefined || o === undefined || (tens.length > 1) || (ones.length > 1)) return Number.NaN;
  return t * 10 + o;
}

/** Full-width digits and punctuation → ASCII, one UTF-16 unit each, so offsets survive. */
function normalize(text: string): string {
  return text
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/：/g, ":")
    .replace(/／/g, "/")
    .replace(/－/g, "-")
    .replace(/＃/g, "#")
    .replace(/＠/g, "@");
}

interface Moment {
  day?: DayKey;
  hour?: number;
  minute?: number;
}

class Scanner {
  readonly consumed: boolean[];
  spans: CaptureSpan[] = [];

  /**
   * `text` is normalize()d for matching; `original` is what was typed (same
   * offsets), which the title is cut from, so 「簡報：…」 keeps its full-width colon.
   */
  constructor(readonly text: string, readonly original: string = text) {
    this.consumed = new Array(text.length).fill(false);
  }

  free(start: number, end: number): boolean {
    for (let index = start; index < end; index++) if (this.consumed[index]) return false;
    return true;
  }

  take(start: number, end: number, kind: CaptureSpanKind): void {
    for (let index = start; index < end; index++) this.consumed[index] = true;
    this.spans.push({ start, end, kind });
  }

  /** Puts [start, end) back into the title; spans of `kinds` inside it are forgotten (others stay highlighted). */
  release(start: number, end: number, kinds: CaptureSpanKind[]): void {
    for (let index = start; index < end; index++) this.consumed[index] = false;
    this.spans = this.spans.filter((span) => !(span.start >= start && span.end <= end && kinds.includes(span.kind)));
  }

  /** Every free match of `pattern` (global), in order. */
  *matches(pattern: RegExp): Generator<RegExpExecArray> {
    const regex = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(this.text))) {
      if (match[0].length === 0) { regex.lastIndex++; continue; }
      if (this.free(match.index, match.index + match[0].length)) yield match;
      // A match that overlaps a token found earlier: retry one character later (「明早 9點」).
      else regex.lastIndex = match.index + 1;
    }
  }

  /** The index of the previous non-space character before `index`, or -1. */
  previousSolid(index: number): number {
    let cursor = index - 1;
    while (cursor >= 0 && /\s/.test(this.text[cursor])) cursor--;
    return cursor;
  }

  /**
   * The typed text without the consumed tokens. A token between two Han
   * characters or full-width punctuation leaves no gap (「交週五的作業」 →
   * 「交作業」, 「簡報，要在週日前生出來」 → 「簡報，生出來」); anywhere else it
   * leaves one space, which cleanTitle() collapses. A 的 right before a token
   * that ends the text dangles once the token is gone (「報告的週五前」), so it goes too.
   */
  remainder(): string {
    const { text, original, consumed } = this;
    let out = "";
    let index = 0;
    while (index < text.length) {
      if (!consumed[index]) {
        out += original[index++];
        continue;
      }
      let end = index;
      while (end < text.length && consumed[end]) end++;
      const before = index > 0 ? text[index - 1] : "";
      const after = end < text.length ? text[end] : "";
      // `before` is never consumed: a run starts right after free text.
      if (before === "的" && !/[目有別似]的$/.test(out) && !/[^\s,，。、;；:：!！?？]/u.test(text.slice(end))) out = out.slice(0, -1);
      // Punctuation is read as typed: normalize() turned 「：」 into ":".
      const typedBefore = index > 0 ? original[index - 1] : "";
      const typedAfter = end < original.length ? original[end] : "";
      const closeLeft = HAN.test(before) || CJK_LEFT.test(typedBefore) || (ASCII_PUNCT.test(typedBefore) && HAN.test(original[index - 2] ?? ""));
      const closeRight = HAN.test(after) || CJK_RIGHT.test(typedAfter);
      out += closeLeft && closeRight ? "" : " ";
      index = end;
    }
    return out;
  }
}

const HAN = /\p{Script=Han}/u;
/** Full-width punctuation a removed token may follow (or an opening bracket) without leaving a space. */
const CJK_LEFT = /[，。、；：！？（「『【《〈]/u;
/** …and may precede (or a closing bracket). */
const CJK_RIGHT = /[，。、；：！？）」』】》〉]/u;
/** 「簡報,週五前交」: an ASCII comma or colon right after a Han character reads like the full-width one. */
const ASCII_PUNCT = /[,;:]/;

function hourWithPeriod(hour: number, period: string | undefined): { hour: number; nextDay: boolean; ambiguous: boolean } {
  if (!period) {
    // 「3點開會」 on a personal dashboard almost always means the afternoon; say so (low confidence).
    if (hour >= 1 && hour <= 6) return { hour: hour + 12, nextDay: false, ambiguous: true };
    return { hour, nextDay: false, ambiguous: false };
  }
  switch (period) {
    case "凌晨": case "清晨": case "早上": case "上午": case "早":
      return { hour: hour === 12 ? 0 : hour, nextDay: false, ambiguous: false };
    case "中午":
      return { hour: hour >= 1 && hour <= 5 ? hour + 12 : hour, nextDay: false, ambiguous: false };
    case "半夜": case "夜裡":
      if (hour === 12) return { hour: 0, nextDay: true, ambiguous: false };
      return { hour: hour >= 7 && hour <= 11 ? hour + 12 : hour, nextDay: false, ambiguous: false };
    default: // 下午 午後 傍晚 晚上 晚
      if (hour === 12) return { hour: period === "晚上" || period === "晚" ? 0 : 12, nextDay: period === "晚上" || period === "晚", ambiguous: false };
      return { hour: hour >= 1 && hour <= 11 ? hour + 12 : hour, nextDay: false, ambiguous: false };
  }
}

const DEFAULT_PERIOD_HOURS: Record<string, number> = { 凌晨: 5, 清晨: 6, 早上: 9, 上午: 9, 中午: 12, 下午: 14, 午後: 14, 傍晚: 17, 晚上: 19, 夜裡: 22, 半夜: 23 };

function lastDayOfMonth(day: DayKey): DayKey {
  const [year, month] = day.split("-").map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

function makeDay(year: number, month: number, date: number): DayKey | undefined {
  if (month < 1 || month > 12 || date < 1 || date > 31) return undefined;
  const value = new Date(Date.UTC(year, month - 1, date));
  if (value.getUTCMonth() !== month - 1) return undefined;
  return value.toISOString().slice(0, 10);
}

/** M/D without a year: this year, or next year when that day is more than 30 days ago. */
function nearYear(today: DayKey, month: number, date: number): DayKey | undefined {
  const year = Number(today.slice(0, 4));
  const candidate = makeDay(year, month, date);
  if (!candidate) return undefined;
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${candidate}T00:00:00Z`)) / 86_400_000;
  return ageDays > 30 ? makeDay(year + 1, month, date) : candidate;
}

/** Monday of the week `day` is in (weeks start on Monday). */
function mondayOf(day: DayKey): DayKey {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

/** (這|下|下下)?週X → the day. Bare 週X is the next one from today (today included). */
function weekdayDay(today: DayKey, prefix: string | undefined, target: number): DayKey {
  const offsetInWeek = (target + 6) % 7; // Monday 0 … Sunday 6
  if (!prefix) {
    const ahead = (target - weekdayOf(today) + 7) % 7;
    return addDays(today, ahead);
  }
  const weeks = prefix.startsWith("下下") ? 2 : prefix.startsWith("下") ? 1 : 0;
  return addDays(mondayOf(today), weeks * 7 + offsetInWeek);
}

const leadingSpace = (text: string) => text.length - text.trimStart().length;

/**
 * 「週三前」, 「10/20 前」, 「9:00 前」, 「週五之前要」, 「週五為止」: a deadline (at the
 * end of that day when there is no time). A 要 right after 前 only leads into
 * the verb (「週日前要交」 → 「交」), unless it starts a word (要求, 要點).
 * Without a deadline, a 的 joining the date to a noun goes with the date
 * (「交週五的作業」 → 「交作業」).
 */
function takeDeadlineSuffix(scanner: Scanner, end: number, state: ParseState): void {
  const rest = scanner.text.slice(end);
  const after = /^\s*(?:之前|以前|前|為止)(?:\s*(?:就要|需要|必須|要(?![求點是不])))?/.exec(rest);
  if (after && scanner.free(end, end + after[0].length)) {
    scanner.take(end + leadingSpace(after[0]), end + after[0].length, "marker");
    state.deadline = true;
    return;
  }
  if (/^的\p{Script=Han}/u.test(rest) && scanner.free(end, end + 1)) scanner.take(end, end + 1, "marker");
}

/** Words that only lead into a date or time (「要在」週日前, 「最晚」週三, "before" Friday, "at" 9:00). */
const ZH_DEADLINE_LEAD = /(?:最晚|最遲|最慢|不晚於|截至)\s*(?:在|於)?\s*$/;
const ZH_LEAD = /((?:一定)?要|得|需要|必須|須|需|會|將|趕|預計|打算)?\s*(在|於)\s*$/;
const ZH_UNTIL_LEAD = /(?:到|至)\s*$/;
const EN_LEAD = /(?<![A-Za-z])(before|by|until|till|due(?:\s+(?:on|by|at))?|on|at)\s+$/i;
/** A modal that is the end of another word keeps it: 只要, 開會, 記得, 總會, 免得 stay; only the 在 goes. */
const MODAL_IN_WORD: Record<string, RegExp> = { 要: /[只想主重還不也就]$/, 會: /[開機學社大約誤體理總才]$/, 得: /[記覺值懂獲取難使免省]$/ };
/** A bare 在 that ends a word stays: 現在, 正在, 存在, 還在. */
const ZAI_IN_WORD = /[現正存實好自所還都也仍]$/;
/** A 於 that ends a word (關於, 對於, 由於, 至於…) is not a lead-in: the date after it is what the text is about. */
const YU_IN_WORD = /[關對由至等屬位基終善便過免]$/;

type LeadIn = { kind: "lead"; start: number; end: number; deadline: boolean } | { kind: "topic" };

/** The lead-in before a token that starts at `head.length`: where it starts and whether it makes a deadline. */
function leadIn(head: string, rest: string): LeadIn | undefined {
  const at = (match: RegExpExecArray, from: number, deadline: boolean): LeadIn => ({ kind: "lead", start: from, end: match.index + match[0].trimEnd().length, deadline });
  let match = ZH_DEADLINE_LEAD.exec(head);
  if (match) return at(match, match.index + leadingSpace(match[0]), true);
  if ((match = ZH_LEAD.exec(head))) {
    const before = head.slice(0, match.index + leadingSpace(match[0]));
    const zai = match.index + match[0].lastIndexOf(match[2]);
    if (!match[1]) {
      if (match[2] === "於" && YU_IN_WORD.test(before)) return { kind: "topic" };
      return match[2] === "在" && ZAI_IN_WORD.test(before) ? undefined : at(match, zai, false);
    }
    const inWord = MODAL_IN_WORD[match[1]];
    return at(match, inWord?.test(before) ? zai : match.index + leadingSpace(match[0]), false);
  }
  if ((match = EN_LEAD.exec(head))) return at(match, match.index, !/^(?:on|at)$/i.test(match[1]));
  // 「到週五為止」: 到 leads in only when 為止 follows soon after.
  if (/^[^，,。]{0,12}?為止/.test(rest) && (match = ZH_UNTIL_LEAD.exec(head))) return at(match, match.index + leadingSpace(match[0]), true);
  return undefined;
}

/**
 * Consumes the lead-in words before each date and time token, so 「簡報 要在周日前生出來」
 * reads 「簡報 生出來」, not 「簡報 要在 生出來」. A date after 關於/對於/由於… is the
 * topic (「寫關於週五的報告」): it goes back into the title with its 的, and the
 * day comes from another date when there is one (else from it, at low confidence).
 */
function takeLeadIns(scanner: Scanner, state: ParseState): void {
  for (const span of [...scanner.spans]) {
    if (span.kind !== "date" && span.kind !== "time") continue;
    const lead = leadIn(scanner.text.slice(0, span.start), scanner.text.slice(span.end));
    if (lead?.kind === "topic") {
      if (span.kind === "date") keepTopicDate(scanner, span, state);
      continue;
    }
    if (!lead || lead.end <= lead.start || !scanner.free(lead.start, lead.end)) continue;
    scanner.take(lead.start, lead.end, "marker");
    if (lead.deadline) state.deadline = true;
  }
  const hits = state.dateHits;
  if (!hits.some((hit) => hit.topic)) return;
  const chosen = hits.find((hit) => !hit.topic) ?? hits[0];
  state.date.day = chosen.day;
  state.period = chosen.period;
}

/** 「關於週五的報告」: 週五 and its 的 stay in the title; a 週五「前」 is a deadline all the same and goes. */
function keepTopicDate(scanner: Scanner, span: CaptureSpan, state: ParseState): void {
  const hit = state.dateHits.find((entry) => entry.start === span.start && entry.end === span.end);
  if (!hit || /^\s*(?:之前|以前|前|為止)/.test(scanner.text.slice(span.end))) return;
  hit.topic = true;
  state.vague = true;
  // The date stays highlighted (it still gives the day); the 的 after it is plain text again.
  scanner.release(span.start, span.end, []);
  if (scanner.text[span.end] === "的") scanner.release(span.end, span.end + 1, ["marker"]);
}

function scanDates(scanner: Scanner, today: DayKey, state: ParseState): void {
  const found = (start: number, end: number, day: DayKey, extra: { period?: string; vague?: boolean } = {}) => {
    if (!state.date.day) {
      state.date.day = day;
      if (extra.period) state.period = extra.period;
    }
    if (extra.vague) state.vague = true;
    state.dateHits.push({ start, end, day, period: extra.period });
    scanner.take(start, end, "date");
    takeDeadlineSuffix(scanner, end, state);
  };

  for (const match of scanner.matches(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)) {
    const day = makeDay(Number(match[1]), Number(match[2]), Number(match[3]));
    if (day) found(match.index, match.index + match[0].length, day);
  }
  for (const match of scanner.matches(/(\d{1,2}|[一二三四五六七八九十]{1,3})月(\d{1,2}|[一二三四五六七八九十]{1,3})[日號号]?/)) {
    const month = parseNumber(match[1]);
    const date = parseNumber(match[2]);
    const day = Number.isNaN(month) || Number.isNaN(date) ? undefined : nearYear(today, month, date);
    if (day) found(match.index, match.index + match[0].length, day);
  }
  for (const match of scanner.matches(/(?<![\d/.])(\d{1,2})\/(\d{1,2})(?![\d/])/)) {
    const day = nearYear(today, Number(match[1]), Number(match[2]));
    if (day) found(match.index, match.index + match[0].length, day);
  }
  const relative: Array<[RegExp, number, string?]> = [
    [/大後天/, 3], [/後天/, 2], [/明早/, 1, "早上"], [/明晚/, 1, "晚上"], [/明天|明日/, 1],
    [/今早/, 0, "早上"], [/今晚/, 0, "晚上"], [/今天|今日/, 0],
    [/(?<![A-Za-z])tomorrow(?![A-Za-z])/i, 1], [/(?<![A-Za-z])tonight(?![A-Za-z])/i, 0, "晚上"], [/(?<![A-Za-z])today(?![A-Za-z])/i, 0],
  ];
  for (const [pattern, offset, period] of relative)
    for (const match of scanner.matches(pattern)) found(match.index, match.index + match[0].length, addDays(today, offset), { period });

  // 「每週一」「每星期五」「每個禮拜二」: the next such day. 每週一次, 每週三堂, 每週一、三 and a bare 每週 name no
  // weekday, and the 週一 inside them is not a day either (「每週一次 讀書」 stays as typed).
  for (const match of scanner.matches(WEEKLY)) {
    state.repeatWeekday ??= WEEKDAY_CHARS[match[1]];
    found(match.index, match.index + match[0].length, weekdayDay(today, undefined, WEEKDAY_CHARS[match[1]]));
  }
  for (const match of scanner.matches(/(?<!每)(下下個?|下個?|這個?|本)?(?:週|周|星期|禮拜)([一二三四五六日天])/))
    found(match.index, match.index + match[0].length, weekdayDay(today, match[1], WEEKDAY_CHARS[match[2]]));
  // "Friday", "next Wed", "before Fri". Nobody leading into it, an abbreviation is a day only written Fri or
  // Sat: SAT (the test), WED and "sun cream" are words, and so is the Sun of "Sun Moon Lake" or "Sun Yat-sen"
  // (a capitalised word follows). Such a weekday never overrides a date found already (「Sun Yat-sen 面試 明天」).
  for (const match of scanner.matches(EN_WEEKDAY)) {
    const word = match[2].toLowerCase();
    const led = !!match[1] || /(?:before|by|on|until|till|due)\s+$/i.test(scanner.text.slice(0, match.index));
    if (!led) {
      if (state.date.day) continue;
      const abbreviation = word.length < 6;
      if (abbreviation && !/^[A-Z][a-z]+$/.test(match[2])) continue;
      if (abbreviation && /^\s*[A-Z][a-z]/.test(scanner.text.slice(match.index + match[0].length))) continue;
    }
    const prefix = match[1] ? (match[1].toLowerCase() === "next" ? "下" : "這") : undefined;
    found(match.index, match.index + match[0].length, weekdayDay(today, prefix, EN_WEEKDAYS[word]));
  }
  for (const match of scanner.matches(/(這個?|本)?(?:週末|周末)/)) found(match.index, match.index + match[0].length, weekdayDay(today, "這", 6));
  for (const match of scanner.matches(/月底/)) found(match.index, match.index + match[0].length, lastDayOfMonth(today));
  // 「下週」 alone names no day: understood, but vague.
  for (const match of scanner.matches(/(?:下下|下|這|本)個?(?:週|周|星期|禮拜)(?![一二三四五六日天末])/)) {
    scanner.take(match.index, match.index + match[0].length, "date");
    state.vague = true;
  }
}

/**
 * One time token. Groups (in order): ampm hour, ampm minute, am|pm · colon hour, colon minute ·
 * 點 hour, 半 or the minute part, the minute number. am/pm comes first so 「3:30pm」 is one token.
 */
const TIME_CORE = String.raw`(\d{1,2})(?::(\d{2}))?\s*([aApP][mM])(?![a-zA-Z])|(\d{1,2}):(\d{2})|(\d{1,2}|[零一二兩三四五六七八九十]{1,3})\s*[點点時](?:\s*(半|(\d{1,2}|[一二三四五六七八九十]{1,3})\s*分?))?`;

interface TimeMatch {
  hour: number;
  minute: number;
  nextDay: boolean;
  ambiguous: boolean;
  /** Written as 24:00 / 24點: the end of the day before (00:00 of the next one). */
  midnight?: boolean;
}

/** Periods after which a smaller end hour of a range is the early morning (「晚上11點到1點」 ends at 01:00). */
const EVENING_PERIODS = new Set(["下午", "午後", "傍晚", "晚上", "晚", "夜裡", "半夜"]);

function readTime(groups: string[], period: string | undefined): TimeMatch | undefined {
  const [ampmHour, ampmMinute, ampm, colonHour, colonMinute, pointHour, pointPart, pointMinute] = groups;
  let hour: number;
  let minute = 0;
  let explicitPeriod = period;
  let leadingZero = false;
  if (ampmHour !== undefined) {
    hour = Number(ampmHour);
    minute = ampmMinute !== undefined ? Number(ampmMinute) : 0;
    if (hour < 1 || hour > 12) return undefined;
    explicitPeriod = ampm.toLowerCase() === "pm" ? "下午" : "上午";
  } else if (colonHour !== undefined) {
    hour = Number(colonHour);
    minute = Number(colonMinute);
    leadingZero = colonHour.length === 2 && colonHour.startsWith("0");
  } else if (pointHour !== undefined) {
    hour = parseNumber(pointHour);
    if (pointPart === "半") minute = 30;
    else if (pointMinute !== undefined) minute = parseNumber(pointMinute);
  } else return undefined;
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour > 24 || minute > 59) return undefined;
  // 「24:00 前」, a common deadline: midnight at the end of the named day, never its start.
  if (hour === 24) return minute === 0 ? { hour: 0, minute: 0, nextDay: true, ambiguous: false, midnight: true } : undefined;
  if (leadingZero || hour === 0 || hour > 12) return { hour, minute, nextDay: false, ambiguous: false };
  const adjusted = hourWithPeriod(hour, explicitPeriod);
  return { hour: adjusted.hour, minute, nextDay: adjusted.nextDay, ambiguous: adjusted.ambiguous };
}

function scanTimes(scanner: Scanner, state: ParseState): void {
  const periodRe = `(${PERIODS})?\\s*`;
  const timeRe = new RegExp(`${periodRe}(?:${TIME_CORE})`);
  const rangeTail = new RegExp(`^\\s*(?:-|–|—|~|～|到|至)\\s*${periodRe}(?:${TIME_CORE})`);
  for (const match of scanner.matches(timeRe)) {
    if (state.time) break;
    let periodWord: string | undefined = match[1];
    let from = match.index + leadingSpace(match[0]);
    // A bare 早/晚 inside a word (提早, 趁早, 稍晚) is not a period: it must start the text, follow a
    // space or punctuation, or follow a date (「週三晚8點」); then it stays in the title.
    if ((periodWord === "早" || periodWord === "晚") && match.index > 0 && /\p{Script=Han}/u.test(scanner.text[match.index - 1]) && !scanner.consumed[match.index - 1]) {
      periodWord = undefined;
      from = match.index + match[0].length - match[0].slice(match[1].length).trimStart().length;
    }
    const period = periodWord ?? state.period;
    const start = readTime(match.slice(2, 10), period);
    if (!start) continue;
    let end = match.index + match[0].length;
    state.time = start;
    if (start.ambiguous) state.vague = true;
    const tail = rangeTail.exec(scanner.text.slice(end));
    if (tail && scanner.free(end, end + tail[0].length)) {
      // 「下午2點到4點」: the end inherits the start's period.
      const endPeriod = tail[1] ?? period;
      let finish = readTime(tail.slice(2, 10), endPeriod);
      // 「晚上11點到1點」: an end hour below the start's, after an evening, is the early morning (01:00), not 13:00.
      const rawStart = readTime(match.slice(2, 10), "上午");
      const rawFinish = readTime(tail.slice(2, 10), "上午");
      if (finish && !tail[1] && period && EVENING_PERIODS.has(period) && rawStart && rawFinish && !rawFinish.midnight
        && rawFinish.hour >= 1 && rawFinish.hour <= 6 && rawFinish.hour < rawStart.hour) finish = rawFinish;
      if (finish) {
        state.endTime = { ...finish, ambiguous: false };
        if (!tail[1] && !period && finish.hour < start.hour && start.hour >= 12 && finish.hour + 12 > start.hour) state.endTime.hour = finish.hour + 12;
        state.range = true;
        end += tail[0].length;
      }
    }
    scanner.take(from, end, "time");
    takeDeadlineSuffix(scanner, end, state);
  }
  // 「明天 1430」: four digits only right after a date or period word.
  if (!state.time) {
    for (const match of scanner.matches(/(?<!\d)([01]\d|2[0-3])([0-5]\d)(?!\d)/)) {
      const previous = scanner.previousSolid(match.index);
      if (previous < 0 || !scanner.consumed[previous] || !scanner.spans.some((span) => span.kind === "date" && span.end === previous + 1)) continue;
      state.time = { hour: Number(match[1]), minute: Number(match[2]), nextDay: false, ambiguous: false };
      scanner.take(match.index, match.index + match[0].length, "time");
      break;
    }
  }
  // A period word alone (「明天下午 開會」): a default hour, flagged vague.
  if (!state.time) {
    for (const match of scanner.matches(/(凌晨|清晨|早上|上午|中午|下午|午後|傍晚|晚上|夜裡|半夜)(?!茶)/)) {
      state.time = { hour: DEFAULT_PERIOD_HOURS[match[1]], minute: 0, nextDay: false, ambiguous: true };
      state.vague = true;
      scanner.take(match.index, match.index + match[0].length, "time");
      break;
    }
  }
  if (!state.time && state.period) {
    // 今晚 / 明早 without an hour.
    state.time = { hour: DEFAULT_PERIOD_HOURS[state.period] ?? 9, minute: 0, nextDay: false, ambiguous: true };
    state.vague = true;
  }
}

function scanDurations(scanner: Scanner, state: ParseState): void {
  let minutes = 0;
  for (const match of scanner.matches(/(\d+(?:\.\d+)?|[一二兩三四五六七八九十]{1,3}|半)\s*個?\s*(?:半\s*)?(小時|鐘頭|hrs?|hours?|h)(?![a-z])/i)) {
    const raw = match[1];
    const hours = raw === "半" ? 0.5 : /\d/.test(raw) ? Number(raw) : parseNumber(raw);
    if (Number.isNaN(hours) || hours <= 0 || hours > 24) continue;
    minutes += Math.round(hours * 60) + (/半\s*(?:小時|鐘頭)/.test(match[0]) && raw !== "半" ? 30 : 0);
    scanner.take(match.index, match.index + match[0].length, "duration");
  }
  for (const match of scanner.matches(/(\d+|[一二兩三四五六七八九十]{1,3})\s*(?:分鐘|分|mins?|minutes?)(?![a-z])/i)) {
    const value = /\d/.test(match[1]) ? Number(match[1]) : parseNumber(match[1]);
    if (Number.isNaN(value) || value <= 0 || value > 24 * 60) continue;
    minutes += value;
    scanner.take(match.index, match.index + match[0].length, "duration");
  }
  if (minutes > 0) state.durationMinutes = minutes;
}

/** A date token as found, in scan order: its day, and whether it turned out to be the topic (關於週五的…). */
interface DateHit {
  start: number;
  end: number;
  day: DayKey;
  period?: string;
  topic?: boolean;
}

interface ParseState {
  date: Moment;
  dateHits: DateHit[];
  period?: string;
  time?: TimeMatch;
  endTime?: TimeMatch;
  range: boolean;
  deadline: boolean;
  vague: boolean;
  /** The weekday of the first 每週X (0 = Sunday). */
  repeatWeekday?: number;
  durationMinutes?: number;
  location?: string;
  tags: string[];
  ideaMarker: boolean;
}

function cleanTitle(raw: string): string {
  return raw
    // 「報告（週五前）交」 → 「報告交」: brackets that only held the date go with it.
    .replace(/(\S?)(?:（\s*）|「\s*」|『\s*』|【\s*】|\(\s*\)|\[\s*\])(\S?)/g, (_, left: string, right: string) => `${left}${HAN.test(left) && HAN.test(right) ? "" : " "}${right}`)
    .replace(/\s+/g, " ")
    // 「交報告， ，記得帶」 once a date between two commas is gone; no space next to full-width punctuation.
    .replace(/([,，、;；])(?:\s*[,，、;；])+/g, "$1")
    .replace(/\s+([，。、；：！？）」』】])/g, "$1")
    .replace(/([，。、；：！？（「『【])\s+/g, "$1")
    .replace(/^[\s,，、:：;；\-–—~～.。!！的]+/, "")
    .replace(/[\s,，、:：;；\-–—~～。!！]+$/, "")
    .trim();
}

/** A todo verb at the start of the title (「回林教授信」, 「記得繳電費」). */
export function startsWithTodoVerb(title: string): boolean {
  const bare = title.replace(TODO_PREFIXES, "");
  return TODO_VERBS.some((verb) => bare.startsWith(verb));
}

const characterCount = (text: string) => [...text].length;

/**
 * Parses one capture. `now` and `timeZone` decide every relative day; the
 * result's ISO instants are UTC. See the golden table in capture-parse.test.ts.
 */
export function parseCapture(text: string, options: CaptureParseOptions): CaptureParse {
  const { now, timeZone } = options;
  const context = options.context ?? "any";
  const today = dayKey(timeZone, now);
  const scanner = new Scanner(normalize(text), text);
  const state: ParseState = { date: {}, dateHits: [], range: false, deadline: false, vague: false, tags: [], ideaMarker: false };

  const prefixEnd = ideaPrefixEnd(scanner.text);
  if (prefixEnd > 0) {
    scanner.take(0, prefixEnd, "marker");
    state.ideaMarker = true;
  }
  for (const match of scanner.matches(TAG)) {
    if (/^\d+$/.test(match[1])) continue;
    scanner.take(match.index, match.index + match[0].length, "tag");
    if (match[1] === "靈感" || match[1].toLowerCase() === "idea") state.ideaMarker = true;
    else if (!state.tags.includes(match[1])) state.tags.push(match[1]);
  }
  for (const match of scanner.matches(/(?<=^|\s)@([^\s@#，。,]{1,40})/)) {
    if (!state.location) state.location = match[1];
    scanner.take(match.index, match.index + match[0].length, "location");
  }
  scanDates(scanner, today, state);
  scanTimes(scanner, state);
  takeLeadIns(scanner, state);
  scanDurations(scanner, state);
  for (const match of scanner.matches(/找個?時間|有空的時候|有空時|有空|改天/)) {
    scanner.take(match.index, match.index + match[0].length, "marker");
    state.vague = true;
  }
  for (const match of scanner.matches(/截止|到期|deadline|due(?![a-z])/i)) {
    scanner.take(match.index, match.index + match[0].length, "marker");
    state.deadline = true;
  }

  const original = text.trim();
  const tokensTitle = cleanTitle(scanner.remainder());
  const title = tokensTitle || original;
  const hasDate = state.date.day !== undefined;
  const hasTime = state.time !== undefined;
  const todoVerb = startsWithTodoVerb(title);
  const explicitEvent = state.range || state.location !== undefined || WITH_PERSON.test(title);
  const eventSignal = explicitEvent || (EVENT_WORDS.test(title) && !todoVerb) || (state.repeatWeekday !== undefined && !state.deadline && (hasTime || !todoVerb));
  const longText = !hasDate && !hasTime && characterCount(title) > IDEA_LENGTH;
  const ideaContext = context === "idea" && !hasDate && !hasTime;

  let type: CaptureType;
  let decided: boolean;
  if (state.ideaMarker) { type = "idea"; decided = true; }
  else if ((hasDate || hasTime) && !state.deadline && eventSignal) { type = "event"; decided = hasTime; }
  else if (hasDate || hasTime) { type = "todo"; decided = todoVerb || state.deadline; }
  else if (todoVerb || state.deadline) { type = "todo"; decided = true; }
  else if (ideaContext || longText) { type = "idea"; decided = true; }
  else { type = "todo"; decided = context === "todo"; }

  // 「今天24點前繳費」: a todo due at the end of its day keeps that day, like 「今天前」 (23:59).
  if (hasTime && state.time!.midnight && type === "todo") state.time = { hour: 23, minute: 59, nextDay: false, ambiguous: false };
  // A time alone falls today, or tomorrow once that time has passed.
  let day = state.date.day;
  // A weekly event starts on the first such weekday from the stated date (or today): 「10/20 每週一」 → the Monday on or after 10/20.
  if (state.repeatWeekday !== undefined && day) day = addDays(day, (state.repeatWeekday - weekdayOf(day) + 7) % 7);
  if (hasTime && day && state.time!.nextDay) day = addDays(day, 1);
  if (hasTime && !day) {
    day = state.time!.nextDay ? addDays(today, 1) : today;
    const candidate = zonedTimeToUtc(timeZone, day, state.time!.hour, state.time!.minute);
    if (candidate.getTime() < now.getTime() - 60_000) day = addDays(day, 1);
  }
  // A weekly event whose time today has already passed starts next week (the 課表 shows what is still ahead).
  if (state.repeatWeekday !== undefined && hasTime && day === today) {
    const first = zonedTimeToUtc(timeZone, day, state.time!.hour, state.time!.minute);
    if (first.getTime() < now.getTime() - 60_000) day = addDays(day, 7);
  }
  // 「每週五 交週報」 is a todo here, and a todo does not repeat: the rules are not sure of what was meant.
  const lostRepeat = state.repeatWeekday !== undefined && type !== "event";

  const result: CaptureParse = {
    type,
    title: type === "idea" ? ideaBody(text) : title,
    allDay: hasDate && !hasTime,
    tags: state.tags,
    spans: scanner.spans.sort((a, b) => a.start - b.start),
    confidence: decided && !state.vague && !lostRepeat && !!tokensTitle ? "high" : "low",
    signals: { event: eventSignal, todo: todoVerb || state.deadline, idea: state.ideaMarker || longText || ideaContext, deadline: state.deadline },
    vague: state.vague,
    ...(day ? { day } : {}),
    ...(hasTime ? { time: hhmm(state.time!.hour, state.time!.minute) } : {}),
    ...(state.endTime ? { endTime: hhmm(state.endTime.hour, state.endTime.minute) } : {}),
    ...(state.durationMinutes ? { durationMinutes: state.durationMinutes } : {}),
    ...(state.location ? { location: state.location } : {}),
    ...(state.repeatWeekday !== undefined ? { repeat: { freq: "weekly" as const } } : {}),
  };
  return withInstants(result, timeZone);
}

const TAG = /#([^\s#，。、,.!?！？:：;；()（）「」]{1,30})/;

/** Where a leading 「靈感：」/「想到」/「idea:」 ends (0 when there is none). It needs a separator except 想到. */
function ideaPrefixEnd(text: string): number {
  const prefix = IDEA_PREFIX.exec(text);
  if (!prefix || !prefix[0].trim()) return 0;
  const word = prefix[0].trim().replace(/[:：]$/, "").trim();
  return /[:：\s]$/.test(prefix[0]) || word === "想到" ? prefix[0].length : 0;
}

/** An idea keeps its whole sentence (dates are content) without the 靈感： marker and #tags (#123 stays). */
export function ideaBody(text: string): string {
  const normalized = normalize(text);
  // Matched on the normalized text, cut from the typed one (same offsets), so 「：」 and ＃ stay as typed.
  const from = ideaPrefixEnd(normalized);
  let body = "";
  let index = from;
  for (const match of normalized.slice(from).matchAll(new RegExp(TAG.source, "g"))) {
    const start = from + match.index;
    if (/^\d+$/.test(match[1])) continue;
    body += `${text.slice(index, start)} `;
    index = start + match[0].length;
  }
  body += text.slice(index);
  return cleanTitle(body) || text.trim();
}

const hhmm = (hour: number, minute: number) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

/** Fills start/end/due from day + time for the parse's type. */
function withInstants(parse: CaptureParse, timeZone: string): CaptureParse {
  const next: CaptureParse = { ...parse };
  delete next.start;
  delete next.end;
  delete next.due;
  if (!parse.day) return next;
  if (parse.type === "event") {
    if (!parse.time) {
      next.allDay = true;
      next.start = parse.day;
      next.end = addDays(parse.day, 1);
      return next;
    }
    const [hour, minute] = parse.time.split(":").map(Number);
    const start = zonedTimeToUtc(timeZone, parse.day, hour, minute);
    let end: Date;
    if (parse.endTime) {
      const [endHour, endMinute] = parse.endTime.split(":").map(Number);
      end = zonedTimeToUtc(timeZone, parse.day, endHour, endMinute);
      if (end.getTime() <= start.getTime()) end = zonedTimeToUtc(timeZone, addDays(parse.day, 1), endHour, endMinute);
    } else end = new Date(start.getTime() + (parse.durationMinutes ?? DEFAULT_EVENT_MINUTES) * 60_000);
    next.allDay = false;
    next.start = start.toISOString();
    next.end = end.toISOString();
    return next;
  }
  if (parse.type === "todo") {
    const [hour, minute] = parse.time ? parse.time.split(":").map(Number) : [23, 59];
    next.allDay = !parse.time;
    next.due = zonedTimeToUtc(timeZone, parse.day, hour, minute).toISOString();
  }
  return next;
}

/**
 * The same capture as another type (Tab in the palette, the type control):
 * a todo keeps its day and time as the due; an event without a day starts at
 * the next whole hour; an idea keeps the whole sentence.
 */
export function retypeCapture(parse: CaptureParse, type: CaptureType, options: CaptureParseOptions & { text: string }): CaptureParse {
  if (parse.type === type) return parse;
  const { now, timeZone, text } = options;
  if (type === "idea") return withInstants({ ...parse, type: "idea", title: ideaBody(text), allDay: false, confidence: "high" }, timeZone);
  // From an idea, read the text again so its date words become the due or the start.
  const base = parse.type === "idea" ? { ...parseCapture(text, { now, timeZone, context: "todo" }), tags: parse.tags } : parse;
  let { day, time } = base;
  if (type === "event" && !day) {
    const nextHour = new Date(Math.ceil((now.getTime() + 60_000) / 3_600_000) * 3_600_000);
    day = dayKey(timeZone, nextHour);
    time = localTime(timeZone, nextHour);
  }
  return withInstants({
    ...base, type,
    ...(day ? { day } : {}), ...(time ? { time } : {}), allDay: !!day && !time, confidence: "high",
  }, timeZone);
}

/**
 * The same capture on another day or time (a parse-row chip edited by hand):
 * `time` undefined keeps the current time, null makes it a day without a time.
 * An event keeps its length.
 */
export function setCaptureMoment(parse: CaptureParse, day: DayKey, time: string | null | undefined, timeZone: string): CaptureParse {
  const nextTime = time === undefined ? parse.time : time ?? undefined;
  const length = parse.type === "event" && parse.start && parse.end && !parse.allDay ? (Date.parse(parse.end) - Date.parse(parse.start)) / 60_000 : undefined;
  const next: CaptureParse = { ...parse, day, allDay: !nextTime, confidence: "high", vague: false };
  if (nextTime) next.time = nextTime;
  else delete next.time;
  delete next.endTime;
  if (length && nextTime) next.durationMinutes = length;
  // A 「直到」 before the new first day would end the series before it starts.
  if (next.repeat?.until && next.repeat.until < day) next.repeat = { freq: "weekly" };
  return withInstants(next, timeZone);
}

/**
 * The same capture repeating every week on the weekday of its day (optionally until a local day), or
 * not repeating (`undefined`): the 重複 chip. An `until` before the first day is dropped.
 */
export function withRepeat(parse: CaptureParse, repeat: EventRepeatInput | undefined): CaptureParse {
  const { repeat: _previous, ...rest } = parse;
  if (!repeat) return rest;
  const until = repeat.until && (!parse.day || repeat.until >= parse.day) ? repeat.until : undefined;
  return { ...rest, repeat: { freq: "weekly", ...(until ? { until } : {}) } };
}

/** The next type in the Tab cycle. */
export function nextCaptureType(type: CaptureType): CaptureType {
  return CAPTURE_TYPE_ORDER[(CAPTURE_TYPE_ORDER.indexOf(type) + 1) % CAPTURE_TYPE_ORDER.length];
}

/** Local wall-clock parts of a parse's main instant, for chips: { day, time? }. */
export function captureMoment(parse: CaptureParse, timeZone: string): { day: DayKey; time?: string; endTime?: string } | undefined {
  if (!parse.day) return undefined;
  if (parse.type === "event" && parse.start && parse.end && !parse.allDay)
    return { day: dayKey(timeZone, parse.start), time: localTime(timeZone, parse.start), endTime: localTime(timeZone, parse.end) };
  return { day: parse.day, ...(parse.time ? { time: parse.time } : {}) };
}

/** Hour of an ISO instant in the zone (test helper and UI). */
export function localHour(timeZone: string, instant: string): number {
  return zonedParts(timeZone, instant).hour;
}
