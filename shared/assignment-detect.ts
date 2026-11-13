import { UNSORTED_COURSE } from "./assignments.js";
import { parseCapture, parseNumber } from "./capture-parse.js";
import type { MailAddress } from "./mail.js";
import type { AssignmentSuggestion } from "./suggestions.js";
import { dayKey, zonedTimeToUtc } from "./time.js";

/**
 * Rule-based reading of assignment announcements in mail
 * (SPEC-mail-assignments §5.4). ASSIGNMENTS team owns this file and its
 * golden tests. Pure and linear-time (text cut to 4,000 characters first), so
 * it runs in the sync, in 轉成作業 and in the browser alike.
 *
 *   detectAssignment(): a proposal, only when the mail clearly announces an
 *     assignment (assignment words AND a deadline phrase or a teaching
 *     sender), never for automated mail. Used by the rule fallback (AI off or
 *     failed) and the Today row hint.
 *   extractAssignment(): always a draft (the owner pressed 轉成作業): the
 *     best title, course, deadline, submission hint and link it can find.
 *
 * Signals (§5.4): S1 assignment words in the subject or the first 300
 * characters (作業, HW / Homework / Lab + number, Assignment, 實驗報告,
 * 期末報告…; 繳交 / 上傳 alone are weak and need S2 and S3), S2 a deadline
 * phrase next to a date (「10/16 23:59 前上傳」「截止日期 10/20」「due Oct 20」),
 * S3 a school or teaching sender (mail.schoolDomains, .edu.tw, 教授 / 老師 /
 * 助教 / TA in the name).
 */

export interface AssignmentMailInput {
  subject: string;
  from: MailAddress;
  /** Plain text: the excerpt, else the snippet. */
  text: string;
  receivedAt: string;
  /** List-Unsubscribe or a noreply-style sender (server/features/gmail/rules.ts isAutomated). */
  automated?: boolean;
  /** Gmail labels (CATEGORY_PROMOTIONS is never an assignment). */
  labels?: string[];
  /** The triage's course or organisation (「作業系統」), when there is one. */
  context?: string;
  /** The triage's category: bills and promotions are never assignments. */
  category?: string;
}

export interface AssignmentDetectContext {
  /** mail.schoolDomains (and .edu.tw) count as teaching senders. */
  schoolDomains: string[];
  /** BELLPERSONAL_TZ: dates in the mail are wall-clock time there. */
  timeZone: string;
  /** Course names the owner already has (from Moodle / Canvas and earlier assignments): a mail naming one belongs to it. */
  courses?: string[];
}

/** What the rules found; `detectedBy` is always "rule". */
export type AssignmentDraft = AssignmentSuggestion & { detectedBy: "rule" };

/** Untrusted text is cut to this many characters before any pattern runs. */
export const DETECT_TEXT_MAX = 4000;
/** S1 words count in the subject and this many characters of the text. */
const HEAD_CHARS = 300;
const TITLE_MAX = 120;
const HINT_MAX = 60;

const NOTICE_TAG = /^(?:公告|通知|重要|提醒|轉知|轉寄|announcement|notice|reminder|urgent|important|fwd?)$/i;
const CN_NUMBER = "[一二三四五六七八九十]{1,3}";
/** HW5, Homework 2, Lab 3, Assignment #1, 作業三, 實驗 2. */
const CODE_SOURCE = String.raw`(?<![A-Za-z])(HW|Homework|Assignment|Lab|Project|作業|實驗)\s*#?\s*(\d{1,2}|${CN_NUMBER})(?![\d])`;
const CODE = new RegExp(CODE_SOURCE, "i");
/** 「HW5：系統呼叫實作」 / 「Lab 3 - Socket Programming」: a code and its name. */
const NAMED_CODE = new RegExp(`${CODE_SOURCE}(\\s*[：:]\\s*|\\s+[-–—]\\s+)([^\\n，,。；;！!？?（(「」]{1,60})`, "i");
const REPORT = /(?:期末|期中|書面|實驗|專題|讀書|心得|課堂)報告/;
/**
 * Strong S1 words. 作業 alone also means an office procedure (選課作業, 停修申請作業,
 * 憑證更新作業, 申報作業, 盤點作業, 考核作業) or a course (作業系統, 作業研究), so those
 * are left out; a bare 作業 also needs a course word next to it (BARE_CONTEXT).
 */
const BARE_HOMEWORK = String.raw`(?<!申請|選課|停修|加選|退選|加退選|註冊|行政|報名|審核|系統|資訊|作業|更新|申報|盤點|考核|維護|處理|審查|填報|變更|結算|升級|轉換|移轉|驗收|招生|請款|核銷)作業(?!系統|研究|時間|流程|程序|辦法|要點|平台|規定|期間|說明會)`;
const BARE_WORD = new RegExp(BARE_HOMEWORK);
/** 「作業三」, 「作業 2」: numbered homework needs no other word. */
const NUMBERED_HOMEWORK = new RegExp(`作業\\s*#?\\s*(?:\\d{1,2}|${CN_NUMBER})(?![\\d])`);
const STRONG_WORDS = new RegExp([
  String.raw`\bassignments?\b`, String.raw`\bhomework\b`, String.raw`\bhw\s*#?\s*\d`, String.raw`\blab\s*#?\s*\d`,
  "實驗報告", "書面報告", "期末報告", "期中報告", "報告繳交", "繳交報告", "專題報告",
].join("|"), "i");
/** A bare 作業 is homework only next to a course word (課, 老師, 助教, E3, 報告, 同學…), not in a bank's or an office's notice. */
const BARE_CONTEXT = /課|老師|教授|助教|講師|同學|報告|E3|e3|NTU COOL|Moodle|Canvas|題目|第\s*[一二三四五六七八九十\d]+\s*[章題週]/;
/** Weak S1: a hand-in verb without an assignment word (needs a deadline and a teaching sender). */
const WEAK_WORDS = /繳交|上傳|提交|\bsubmit|\bupload|hand in/i;
/** Fees and applications use the same verbs (學雜費繳交、獎學金申請): never an assignment on weak words. */
const FEE_WORDS = /學雜費|繳費|費用|帳單|電費|水費|獎學金|申請表|退費|保險/;
const EXAM_WORDS = /期中考|期末考|小考|考試|exam\b|midterm|final exam|quiz/i;
/** Grades and closed deadlines: about an assignment, but nothing left to hand in. */
const CLOSED_WORDS = /成績|分數|已截止|已經截止|grades?\s+(?:are|is|have been)\s+(?:posted|released|out)|graded/i;
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|donotreply|notifications?|mailer-daemon)([-+._].*)?$/i;
const TEACHER_NAME = /教授|老師|助教|講師|\bprof\.?(?=\s|$)|professor|teaching assistant|instructor/i;
/** 「TA Kevin」, 「王 TA」: upper case only, so 「Ta-Wei」 is a name, not a role. */
const TA_NAME = /(?<![A-Za-z])TA(?![A-Za-z])/;
/** Hand-in verbs for the submission hint (§5.4: 上傳 / 繳交 / 寄到 / 紙本); 「繳交期限」「繳交方式」 name the deadline or the heading, not the way. */
const SUBMIT_VERBS = /(?:上傳|繳交|寄到|寄至|寄給|交到|交至|紙本|提交)(?!期限|時間|日期|截止|期間|狀態|方式|說明)|\b(?:submit|upload|hand in)\b/gi;
const SUBMIT_HOSTS = [/(^|\.)e3p?\.nycu\.edu\.tw$/i, /(^|\.)cool\.ntu\.edu\.tw$/i, /^forms\.gle$/i, /^classroom\.github\.com$/i];
const DEADLINE_WORDS = /截止|期限|到期|deadline|\bdue\b|before|\bby\b|no later than|前/i;
/** Deadline words parseCapture does not mark on its own: English ones, 期限, and 前 after a period word (「明天中午前」). */
const EXTRA_DEADLINE = /\b(?:due|deadline|before|by|no later than)\b|期限|截止|到期|(?<![目提眼面])前(?![往面後輩端言])/i;

/** A month as English writes it (Oct, Oct., October, Sept): whole words only, so 「10 marks」 or 「separate」 are not months. */
const MONTH_NAME = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAY_ZH: Record<string, string> = { mon: "一", tue: "二", wed: "三", thu: "四", fri: "五", sat: "六", sun: "日" };

/** 「Re: [公告] 【作業系統】HW5 公告」 → { title: "HW5 公告", course: "作業系統" }. */
export function cleanSubject(subject: string): { title: string; course?: string } {
  let text = subject.slice(0, 300).replace(/\s+/g, " ").trim();
  for (;;) {
    const next = text
      .replace(/^(?:re|fw|fwd|回覆|轉寄)\s*[:：]\s*/i, "")
      .replace(/^[【[]([^】\]]{1,20})[】\]]\s*/u, (tag, name: string) => (NOTICE_TAG.test(name.trim()) ? "" : tag));
    if (next === text) break;
    text = next;
  }
  const tag = /^[【[]([^】\]]{1,40})[】\]]\s*/u.exec(text);
  const course = tag && !CODE.test(tag[1]) ? tag[1].trim() : undefined;
  const title = (tag ? text.slice(tag[0].length) : text).trim();
  return { title: title || text || subject.trim(), ...(course ? { course } : {}) };
}

/** Text the patterns may read: cut, full-width digits and colons folded, spaces squeezed per line. */
function prepare(text: string, max = DETECT_TEXT_MAX): string {
  return text
    .slice(0, max)
    .replace(/[０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30))
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ");
}

const domainOf = (email: string) => email.split("@")[1]?.toLowerCase() ?? "";
const localOf = (email: string) => email.split("@")[0]?.toLowerCase() ?? "";

/** S3 by name: 教授, 老師, 助教, TA… in the sender's name. */
function teacherByName(from: MailAddress): boolean {
  return TEACHER_NAME.test(from.name ?? "") || TA_NAME.test(from.name ?? "");
}

/**
 * S3: a teacher's name, or a school address. Classmates write from school
 * addresses too, so on a reply (「Re: HW5 公告」 from a classmate) only the
 * name counts.
 */
function teachingSender(from: MailAddress, schoolDomains: string[], reply: boolean): boolean {
  if (teacherByName(from)) return true;
  if (reply) return false;
  const domain = domainOf(from.email);
  if (schoolDomains.some((item) => domain === item.toLowerCase() || domain.endsWith(`.${item.toLowerCase()}`))) return true;
  return /\.edu(\.[a-z]{2})?$/i.test(domain);
}

const REPLY_PREFIX = /^\s*(?:re|回覆)\s*[:：]/i;

function automatedMail(input: AssignmentMailInput): boolean {
  if (input.automated) return true;
  if (input.category === "bill" || input.category === "promo") return true;
  if (input.labels?.includes("CATEGORY_PROMOTIONS") || input.labels?.includes("SENT")) return true;
  const domain = domainOf(input.from.email);
  if (/(^|\.)github\.com$/i.test(domain)) return true;
  return AUTOMATED_SENDER.test(localOf(input.from.email));
}

/**
 * English dates and day words → the forms parseCapture reads (Oct 20 → 10/20,
 * next Friday → 下週五, tomorrow → 明天, noon → 中午 12:00, midnight → 23:59).
 */
function englishDates(text: string): string {
  return text
    // 「Friday, October 23」: the date says it; the weekday before it would be read as another day.
    .replace(new RegExp(String.raw`\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b\.?,?\s+(?=${MONTH_NAME}\b\.?\s+\d)`, "gi"), "")
    .replace(new RegExp(String.raw`\b${MONTH_NAME}\b\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?:,?\s*\d{4})?`, "gi"),
      (_match, month: string, date: string) => ` ${MONTHS[month.slice(0, 3).toLowerCase()]}/${date} `)
    .replace(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?\s+${MONTH_NAME}\b\.?(?:,?\s*\d{4})?\b`, "gi"),
      (_match, date: string, month: string) => ` ${MONTHS[month.slice(0, 3).toLowerCase()]}/${date} `)
    .replace(/\b(next\s+)?(mon|tue|wed|thu|fri|sat|sun)(?:day|sday|nesday|rsday|urday)?\b\.?/gi,
      (_match, next: string | undefined, day: string) => ` ${next ? "下" : ""}週${WEEKDAY_ZH[day.toLowerCase()]} `)
    .replace(/\btomorrow\b/gi, " 明天 ")
    .replace(/\btonight\b/gi, " 今晚 ")
    .replace(/\btoday\b/gi, " 今天 ")
    .replace(/\bnoon\b/gi, " 中午 12:00 ")
    .replace(/\bmidnight\b/gi, " 23:59 ");
}

const URL_PATTERN = /https?:\/\/[^\s<>"'，。、）)」]+/gi;
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** What one comma clause says about a deadline: its date and time words (as written) and whether it names a deadline. */
interface ClauseRead {
  date?: string;
  time?: string;
  deadline: boolean;
}

const DATE_OR_TIME_HINT = /\d|[今明後]天|今晚|明早|明晚|[週周]|星期|禮拜|月底|中午|午夜|晚上|早上|上午|下午/;

/** One clause of a sentence already through englishDates (links and addresses removed). */
function readClause(text: string, receivedAt: string, timeZone: string): ClauseRead {
  const deadline = EXTRA_DEADLINE.test(text);
  if (!DATE_OR_TIME_HINT.test(text)) return { deadline };
  const parse = parseCapture(text, { now: new Date(receivedAt), timeZone, context: "todo" });
  const words = (kind: "date" | "time") => parse.spans.filter((span) => span.kind === kind).map((span) => text.slice(span.start, span.end)).join(" ") || undefined;
  const date = words("date");
  const time = words("time");
  return { ...(date ? { date } : {}), ...(time ? { time } : {}), deadline: deadline || parse.signals.deadline };
}

/** A date and a time (either may be missing) read relative to the received day; never before it. */
function deadlineAt(date: string | undefined, time: string | undefined, receivedAt: string, timeZone: string): { dueAt: string; dueDay?: string } | undefined {
  const parse = parseCapture(`${date ?? ""} ${time ?? ""} 截止`, { now: new Date(receivedAt), timeZone, context: "todo" });
  if (!parse.day || parse.day < dayKey(timeZone, receivedAt)) return undefined;
  if (parse.time) {
    const [hour, minute] = parse.time.split(":").map(Number);
    return { dueAt: zonedTimeToUtc(timeZone, parse.day, hour, minute).toISOString() };
  }
  return { dueAt: zonedTimeToUtc(timeZone, parse.day, 23, 59).toISOString(), dueDay: parse.day };
}

/**
 * The first deadline next to a deadline word, sentence by sentence (subject
 * first). A comma never separates a date from its time: one date and one
 * time in a sentence belong together (「due Oct 20, 9:00 AM」, 「10/16（五），
 * 上午 9:00 前上傳」, 「23:59, Friday」). With several dates or times, the
 * clause holding the deadline word decides, completed by a neighbouring
 * clause's date or (date-less) time; a time alone counts only when the
 * sentence names no date at all.
 */
function findDeadline(sentences: string[], receivedAt: string, timeZone: string): { dueAt: string; dueDay?: string } | undefined {
  for (const sentence of sentences) {
    if (!DEADLINE_WORDS.test(sentence)) continue;
    // English dates first, on the whole sentence: 「Friday, October 23」 is one date across its comma.
    const prepared = englishDates(sentence.replace(URL_PATTERN, " ").replace(EMAIL_PATTERN, " "));
    const clauses = prepared.split(/[，,]/).map((clause) => readClause(clause, receivedAt, timeZone));
    if (!clauses.some((clause) => clause.deadline)) continue;
    const dated = clauses.filter((clause) => clause.date);
    const timed = clauses.filter((clause) => clause.time);
    if (!dated.length && !timed.length) continue;
    if (dated.length <= 1 && timed.length <= 1) {
      const found = deadlineAt(dated[0]?.date, timed[0]?.time, receivedAt, timeZone);
      if (found) return found;
      continue;
    }
    for (const [index, clause] of clauses.entries()) {
      if (!clause.deadline || (!clause.date && !clause.time)) continue;
      const neighbours = [clauses[index - 1], clauses[index + 1]];
      const date = clause.date ?? neighbours.find((other) => other?.date)?.date;
      if (!date && dated.length) continue;
      const time = clause.time ?? neighbours.find((other) => other?.time && !other.date)?.time;
      const found = deadlineAt(date, time, receivedAt, timeZone);
      if (found) return found;
    }
  }
  return undefined;
}

/** Sentences: Chinese and English terminators, line breaks (not the dot inside 10.5 or a URL). */
const SENTENCE_END = /[。！？!?；;\n]+|\.\s+/;
const sentencesOf = (text: string) => text.split(SENTENCE_END).map((part) => part.trim()).filter(Boolean);
const trimEnds = (text: string) => text.replace(/^[\s,，、:：;；\-–—]+|[\s,，、:：;；\-–—。.!！]+$/g, "").trim();
/** Where an assignment's name ends: 「HW5：系統呼叫實作 請於…」, "Homework 2: DP is now available." */
const NAME_END = /\s{2,}|\.(?:\s|$)|\s(?=(?:is|are|was|will|has|have|due|please)\b)|\s?(?=請|截止|deadline)|\s(?=於|在|繳交|上傳)/i;

/** 「HW5：系統呼叫實作」, else 「Lab 3」, else 「期末報告」, else the cleaned subject. */
function titleOf(subjectTitle: string, text: string): string {
  for (const source of [text, subjectTitle]) {
    const named = NAMED_CODE.exec(source);
    if (!named) continue;
    const name = trimEnds(named[4].split(NAME_END)[0]);
    const code = CODE.exec(named[0])?.[0].trim();
    if (!name || !code) continue;
    const separator = /[-–—]/.test(named[3]) ? " - " : /\p{Script=Han}/u.test(name) ? "：" : ": ";
    return `${code}${separator}${name}`;
  }
  for (const source of [subjectTitle, text]) {
    const code = CODE.exec(source);
    if (code) return code[0].trim();
  }
  for (const source of [subjectTitle, text]) {
    const report = REPORT.exec(source);
    if (report) return report[0];
  }
  return subjectTitle.replace(/\s*(?:公告|通知|announcement|notice)$/i, "").trim() || subjectTitle;
}

/**
 * The longest known course named in the subject, else in the opening of the
 * text. A name with Chinese characters is found anywhere (spaces ignored); a
 * Latin-only name needs three letters or more and whole words, so 「AI」 or
 * 「OS」 never match inside 「details」 or 「those」.
 */
function knownCourse(courses: string[] | undefined, subject: string, head: string): string | undefined {
  if (!courses?.length) return undefined;
  const fold = (text: string) => text.normalize("NFKC").toLowerCase();
  const names = [...new Set(courses.map((name) => name.trim()).filter((name) => [...name].length >= 2 && name !== UNSORTED))]
    .filter((name) => /\p{Script=Han}/u.test(name) || fold(name).replace(/[^a-z0-9]/g, "").length >= 3);
  const named = (source: string, name: string) => {
    if (/\p{Script=Han}/u.test(name)) return source.replace(/\s+/g, "").includes(fold(name).replace(/\s+/g, ""));
    const words = fold(name).split(/[^a-z0-9]+/).filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`(?<![a-z0-9])${words.join("[^a-z0-9]+")}(?![a-z0-9])`).test(source);
  };
  for (const source of [fold(subject), fold(head)]) {
    const found = names.filter((name) => named(source, name)).sort((a, b) => b.length - a.length)[0];
    if (found) return found;
  }
  return undefined;
}

const UNSORTED = UNSORTED_COURSE;

/**
 * How to hand it in: the clause holding 上傳 / 繳交 / 寄到 / 紙本, from just
 * after its deadline marker (「…前上傳至 E3」 → 「上傳至 E3」) or from the verb.
 * 「題目已上傳到 E3」 describes the handout, not the submission.
 */
function submitHintOf(text: string): string | undefined {
  for (const raw of text.split(/[。！？!?；;\n，,]+|\.\s+/)) {
    // The link is kept apart (submitUrlOf); the hint says how, in words.
    const clause = raw.replace(URL_PATTERN, " ").replace(/\s+/g, " ");
    const verb = [...clause.matchAll(SUBMIT_VERBS)].find((match) => !/已\s*$/.test(clause.slice(0, match.index)));
    if (!verb) continue;
    let start = verb.index;
    for (const marker of clause.matchAll(/(?:之前|以前|(?<![目提眼面])前)\s*/g)) {
      if (marker.index + marker[0].length <= verb.index) start = marker.index + marker[0].length;
    }
    let hint = trimEnds(clause.slice(start));
    // 「Submit via <link>」: name the site the link went to.
    const host = /(?:\bvia|\bto|\bat|\bon|\bthrough|到|至|在)$/i.test(hint) ? hostOf(raw) : undefined;
    if (host) hint = `${hint} ${host}`;
    // 「請準時繳交」 says nothing about how: a hint needs more than the verb.
    if (hint.replace(verb[0], "").replace(/[\s請準時務必記得]/g, "").length < 2) continue;
    return hint.length > HINT_MAX ? `${hint.slice(0, HINT_MAX - 1)}…` : hint;
  }
  return undefined;
}

/** The host of the first link in a clause (「forms.gle」). */
function hostOf(text: string): string | undefined {
  const match = /https?:\/\/[^\s<>"'，。、）)」]+/i.exec(text);
  try { return match ? new URL(match[0]).hostname : undefined; } catch { return undefined; }
}

/** The first https link on a known submission host (E3, NTU COOL, Google Forms, GitHub Classroom); never any other link. */
function submitUrlOf(text: string): string | undefined {
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(/[.,;:!?]+$/, "");
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== "https:" || url.username || url.password) continue;
    const host = url.hostname.toLowerCase();
    if (SUBMIT_HOSTS.some((pattern) => pattern.test(host)) || (host === "docs.google.com" && url.pathname.startsWith("/forms"))) return url.toString();
  }
  return undefined;
}

/** A proposal when the mail announces an assignment; undefined otherwise (§5.4 signals). */
export function detectAssignment(input: AssignmentMailInput, context: AssignmentDetectContext): AssignmentDraft | undefined {
  if (automatedMail(input)) return undefined;
  const subject = prepare(input.subject, 300);
  const text = prepare(input.text);
  const head = `${subject}\n${text.slice(0, HEAD_CHARS)}`;
  const strong = STRONG_WORDS.test(head) || NUMBERED_HOMEWORK.test(head) || (BARE_WORD.test(head) && BARE_CONTEXT.test(head));
  const weak = !strong && WEAK_WORDS.test(head) && !FEE_WORDS.test(head);
  if (!strong && !weak) return undefined;
  // Exam notices are not assignments unless they also name one (「期中考與 HW3 繳交」).
  if (EXAM_WORDS.test(subject) && !CODE.test(subject) && !REPORT.test(subject)) return undefined;
  const draft = extractAssignment(input, context);
  const deadline = draft.dueAt !== null;
  if (!deadline && CLOSED_WORDS.test(head)) return undefined;
  const reply = REPLY_PREFIX.test(input.subject);
  // A hand-in verb alone (繳交, 上傳) is also how offices write (宿舍申請資料繳交): it needs a teacher by name.
  const teacher = strong ? teachingSender(input.from, context.schoolDomains, reply) : teacherByName(input.from);
  if (strong ? !(deadline || teacher) : !(deadline && teacher)) return undefined;
  return draft;
}

/** Always a draft for 轉成作業 (§5.4 extraction: title phrase, course, due, submit hint, link). */
export function extractAssignment(input: AssignmentMailInput, context: AssignmentDetectContext): AssignmentDraft {
  const subject = cleanSubject(prepare(input.subject, 300));
  const text = prepare(input.text);
  const title = titleOf(subject.title, text).slice(0, TITLE_MAX);
  // The subject's tag first; the triage's course beats a known course the text only seems to name.
  const known = knownCourse(context.courses, subject.title, text.slice(0, HEAD_CHARS));
  const triaged = input.context?.trim() || undefined;
  const courseName = (subject.course ?? (known && (!triaged || sameCourse(known, triaged)) ? known : triaged ?? known))?.slice(0, 80);
  const due = findDeadline([...sentencesOf(subject.title), ...sentencesOf(text)], input.receivedAt, context.timeZone);
  const submitHint = submitHintOf(text);
  const url = submitUrlOf(text);
  return {
    title: title || subject.title.slice(0, TITLE_MAX),
    ...(courseName ? { courseName } : {}),
    dueAt: due?.dueAt ?? null,
    ...(due?.dueDay ? { dueDay: due.dueDay } : {}),
    ...(submitHint ? { submitHint } : {}),
    ...(url ? { url } : {}),
    detectedBy: "rule",
  };
}

/* ------------------------------------------------------------------ matching */

/** A course name folded for comparison: 「【113上】作業系統 (OS)」 → 「作業系統os」 (a leading term tag dropped). */
export function courseKey(name: string | undefined): string {
  return courseWords(name).join("");
}

/** A course name's words: runs of Chinese characters and Latin words (「作業系統 Operating Systems」 → 作業系統 · operating · systems). */
function courseWords(name: string | undefined): string[] {
  const text = (name ?? "").normalize("NFKC").toLowerCase().replace(/^\s*(?:【[^】]{0,20}】|\[[^\]]{0,20}\])\s*/u, "").trim();
  if (!text || text === UNSORTED) return [];
  return text.match(/\p{Script=Han}+|[a-z0-9]+/gu) ?? [];
}

const isHan = (word: string) => /\p{Script=Han}/u.test(word);

/**
 * Whether two course names name the same course: equal once folded; or every
 * word of the shorter is a whole word of the longer (「作業系統」 and 「作業系統
 * Operating Systems」, 「ML」 and 「機器學習 (ML)」); or they share a run of
 * three or more Chinese characters; or a Chinese name of four or more
 * characters starts the other's (「作業系統」, 「作業系統概論」). Never a bare
 * substring: 「DS」 is not in 「Numerical Methods」.
 */
export function sameCourse(a: string | undefined, b: string | undefined): boolean {
  const x = courseWords(a);
  const y = courseWords(b);
  if (!x.length || !y.length) return false;
  if (x.join("") === y.join("")) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.every((word) => long.includes(word))) return true;
  return x.some((word) => isHan(word) && (([...word].length >= 3 && y.includes(word))
    || y.some((other) => isHan(other) && ([...word].length >= 4 && other.startsWith(word) || [...other].length >= 4 && word.startsWith(other)))));
}

/** 「HW5：系統呼叫實作」 → "hw5"; 「Homework 5」 → "hw5"; 「Lab 3」 → "lab3"; else the folded title. */
export function assignmentKey(title: string): string {
  const code = CODE.exec(title.normalize("NFKC"));
  if (code) {
    const kind = /lab|實驗/i.test(code[1]) ? "lab" : /project/i.test(code[1]) ? "project" : "hw";
    const number = /^\d+$/.test(code[2]) ? Number(code[2]) : parseNumber(code[2]);
    if (!Number.isNaN(number)) return `${kind}${number}`;
  }
  return title.normalize("NFKC").toLowerCase().replace(/[\s()（）[\]【】「」'"`·・,，.。:：\-–—_/]+/g, "");
}

const DUE_WINDOW_MS = 36 * 3_600_000;
const deadlinesClose = (a: string | null, b: string | null) => (a && b ? Math.abs(Date.parse(a) - Date.parse(b)) <= DUE_WINDOW_MS : undefined);

/**
 * Whether a native assignment (from a teacher's mail) is the same one an LMS
 * already lists: the same assignment code or title, the same course
 * (sameCourse, on both sides: HW5 and Lab 3 repeat in every course, so a
 * mail without a course is never taken for an LMS row) and deadlines within
 * 36 hours when both are known.
 */
export function sameAssignment(
  native: { title: string; courseName?: string; dueAt: string | null },
  lms: { title: string; courseName: string; dueAt: string | null },
): boolean {
  if (assignmentKey(native.title) !== assignmentKey(lms.title)) return false;
  if (!sameCourse(native.courseName, lms.courseName)) return false;
  return deadlinesClose(native.dueAt, lms.dueAt) !== false;
}

/**
 * Whether two assignments from the owner's mail are one (an announcement and
 * its reminder, the TA's follow-up): the same code or title, and the same
 * course with deadlines that do not disagree, or, when a course is missing,
 * the same known deadline (within 36 hours).
 */
export function sameNativeAssignment(
  a: { title: string; courseName?: string; dueAt: string | null },
  b: { title: string; courseName?: string; dueAt: string | null },
): boolean {
  if (assignmentKey(a.title) !== assignmentKey(b.title)) return false;
  const close = deadlinesClose(a.dueAt, b.dueAt);
  if (courseWords(a.courseName).length && courseWords(b.courseName).length) return sameCourse(a.courseName, b.courseName) && close !== false;
  return close === true;
}
