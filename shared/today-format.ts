import strings from "../src/copy/habits-events-strings.json";
import type { ActionId, QueueAction, QueueItem } from "./today.js";
import { addDays, dayKey, daysBetween, localTime, weekdayOf, zonedParts, type DayKey } from "./time.js";

export type EventLocale = Exclude<keyof typeof strings, "$meta">;

const eventFormat = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => String(values[key] ?? match));

/**
 * Formatting helpers for Today rows, so every module phrases times exactly as
 * SPEC §10 says ("剩 15 小時", "週三 23:59 截止", "10/25（六）"). Pure; every
 * helper takes the IANA zone explicitly because the host clock is UTC.
 */

/** Default label, touch label and key per action (SPEC §4.3 and §10). Override per kind with queueAction(). */
export const QUEUE_ACTION_PRESETS: Record<ActionId, Omit<QueueAction, "id">> = {
  reply: { label: "回覆", touchLabel: "回覆", key: "Enter" },
  open: { label: "開啟", touchLabel: "開啟", key: "Enter" },
  archive: { label: "封存", touchLabel: "封存", key: "E" },
  read: { label: "標為已讀", touchLabel: "已讀", key: "E" },
  todo: { label: "轉待辦", touchLabel: "轉待辦", key: "T" },
  snooze: { label: "延後", touchLabel: "延後", key: "S" },
  done: { label: "完成", touchLabel: "完成", key: "E" },
  submitted: { label: "標為已交", touchLabel: "已交", key: "E" },
  reviewed: { label: "標為已審查", touchLabel: "已審查", key: "E" },
  calendar: { label: "加入行事曆", touchLabel: "加入行事曆", key: "C" },
  going: { label: "要參加", touchLabel: "要參加", key: "C" },
  dismiss: { label: "略過", touchLabel: "略過", key: "E" },
  schedule: { label: "排進", touchLabel: "排進" },
  // SPEC-mail-assignments §1.3. 加入作業 on suggestion rows overrides the label.
  trash: { label: "刪除", touchLabel: "刪除", key: "#" },
  unarchive: { label: "移回收件匣", touchLabel: "移回", key: "E" },
  assignment: { label: "轉成作業", touchLabel: "轉作業", key: "A" },
};

/** One row action from the presets, e.g. queueAction("open", { label: "開啟 E3" }). */
export function queueAction(id: ActionId, override: Partial<Omit<QueueAction, "id">> = {}): QueueAction {
  const preset = QUEUE_ACTION_PRESETS[id];
  const action: QueueAction = { id, ...preset, ...override };
  if (action.key === undefined) delete action.key;
  return action;
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"] as const;

/** 「一」…「日」 for a local day. */
export function weekdayChar(day: DayKey): string {
  return WEEKDAYS[weekdayOf(day)];
}

/** "10/25" */
export function monthDay(timeZone: string, instant: Date | string): string {
  const parts = zonedParts(timeZone, instant);
  return `${parts.month}/${parts.day}`;
}

const EVENT_WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** "10/25（六）": the date style for meta lines. */
export function monthDayWeek(timeZone: string, instant: Date | string, locale: EventLocale = "zh-TW"): string {
  const day = dayKey(timeZone, instant);
  if (locale === "zh-TW") return `${monthDay(timeZone, instant)}（${weekdayChar(day)}）`;
  const t = strings[locale].eventModel;
  return eventFormat(t.monthDayWeek, { date: monthDay(timeZone, instant), weekday: t.weekdaysShort[EVENT_WEEKDAYS[weekdayOf(day)]] });
}

/** 「明天」 for tomorrow, else 「週六」. */
export function dayLabel(timeZone: string, instant: Date | string, now: Date, locale: EventLocale = "zh-TW"): string {
  const today = dayKey(timeZone, now);
  const day = dayKey(timeZone, instant);
  if (locale === "zh-TW") {
    if (day === today) return "今天";
    if (day === addDays(today, 1)) return "明天";
    return `週${weekdayChar(day)}`;
  }
  const labels = strings[locale].eventModel.dayBlockLabels;
  if (day === today) return labels.today;
  if (day === addDays(today, 1)) return labels.tomorrow;
  return labels[EVENT_WEEKDAYS[weekdayOf(day)]];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * The `.when` phrase for a deadline (SPEC §10): 逾期 N 天/小時 and 剩 N 分鐘/小時
 * are hot, 明天到期 is plain, 還有 N 天 is muted.
 */
export function deadlineWhen(dueAt: string, now: Date, timeZone: string): NonNullable<QueueItem["when"]> {
  const left = Date.parse(dueAt) - now.getTime();
  if (left < 0) {
    const late = -left;
    return late >= 24 * HOUR
      ? { label: `逾期 ${Math.floor(late / (24 * HOUR))} 天`, tone: "hot", mono: false }
      : { label: `逾期 ${Math.max(1, Math.floor(late / HOUR))} 小時`, tone: "hot", mono: false };
  }
  if (left < HOUR) return { label: `剩 ${Math.max(1, Math.floor(left / MINUTE))} 分鐘`, tone: "hot", mono: false };
  if (left < 24 * HOUR) return { label: `剩 ${Math.floor(left / HOUR)} 小時`, tone: "hot", mono: false };
  const days = daysBetween(dayKey(timeZone, now), dayKey(timeZone, dueAt));
  if (days <= 1) return { label: "明天到期", mono: false };
  return { label: `還有 ${days} 天`, tone: "muted", mono: false };
}

/** An event or todo time: today "14:00" (warm within 6 h), tomorrow 「明天 09:00」, later "10/25 13:30". */
export function timeWhen(start: string, now: Date, timeZone: string): NonNullable<QueueItem["when"]> {
  const time = localTime(timeZone, start);
  const days = daysBetween(dayKey(timeZone, now), dayKey(timeZone, start));
  if (days === 0) {
    const ahead = Date.parse(start) - now.getTime();
    return ahead >= 0 && ahead <= 6 * HOUR ? { label: time, tone: "warm", mono: true } : { label: time, mono: true };
  }
  if (days === 1) return { label: `明天 ${time}`, mono: false };
  return { label: `${monthDay(timeZone, start)} ${time}`, mono: false };
}

/** When a mail or request arrived: today "08:05", 「昨天」, else "10/9". */
export function receivedWhen(at: string, now: Date, timeZone: string): NonNullable<QueueItem["when"]> {
  const days = daysBetween(dayKey(timeZone, at), dayKey(timeZone, now));
  if (days <= 0) return { label: localTime(timeZone, at), mono: true };
  if (days === 1) return { label: "昨天", mono: false };
  return { label: monthDay(timeZone, at), mono: false };
}

/**
 * The deadline phrase for meta lines: 「今晚 23:59 截止」 (today from 17:00),
 * 「今天 12:00 截止」, 「明天 09:00 截止」, 「週三 23:59 截止」 within six days,
 * else 「10/20 截止」. `dateOnly` drops the time (bills).
 */
export function metaDeadline(dueAt: string, now: Date, timeZone: string, options: { dateOnly?: boolean } = {}): string {
  const days = daysBetween(dayKey(timeZone, now), dayKey(timeZone, dueAt));
  const time = localTime(timeZone, dueAt);
  if (options.dateOnly || days < 0 || days > 6) return `${monthDay(timeZone, dueAt)} 截止`;
  if (days === 0) return `${zonedParts(timeZone, dueAt).hour >= 17 ? "今晚" : "今天"} ${time} 截止`;
  if (days === 1) return `明天 ${time} 截止`;
  return `週${weekdayChar(dayKey(timeZone, dueAt))} ${time} 截止`;
}

/** The next-up relative phrase: 「28 分後」, 「1 小時 28 分後」, 「明天 09:00」. */
export function relativeStart(start: string, now: Date, timeZone: string): string {
  const days = daysBetween(dayKey(timeZone, now), dayKey(timeZone, start));
  if (days >= 1) return `${days === 1 ? "明天" : monthDay(timeZone, start)} ${localTime(timeZone, start)}`;
  const minutes = Math.max(0, Math.round((Date.parse(start) - now.getTime()) / MINUTE));
  if (minutes < 60) return `${minutes} 分後`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小時 ${rest} 分後` : `${hours} 小時後`;
}

/** 「1 小時 30 分鐘」 style durations for meta (48 小時, 40 分鐘). */
export function durationText(minutes: number, locale: EventLocale = "zh-TW"): string {
  if (locale === "zh-TW") {
    if (minutes < 60) return `${minutes} 分鐘`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} 小時 ${rest} 分鐘` : `${hours} 小時`;
  }
  const t = strings[locale].eventModel.duration;
  if (minutes < 60) return eventFormat(minutes === 1 ? t.minutesOne : t.minutes, { m: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest) return eventFormat(t.hoursMinutes, { h: hours, m: rest });
  return eventFormat(hours === 1 ? t.hoursOne : t.hours, { h: hours });
}
