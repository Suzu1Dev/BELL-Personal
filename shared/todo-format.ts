import strings from "../src/copy/tasks-strings.json";
import { addDays, daysBetween, localTime, zonedTimeToUtc, type DayKey } from "./time.js";
import type { Todo } from "./todos.js";
import type { QueueItem } from "./today.js";
import { deadlineWhen, metaDeadline, weekdayChar } from "./today-format.js";

export type TodoLocale = keyof typeof strings;

const format = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key) => String(values[key] ?? match));

function numericDate(day: DayKey): string {
  const [, month, date] = day.split("-").map(Number);
  return `${month}/${date}`;
}

function englishWeekday(day: DayKey): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${day}T12:00:00.000Z`));
}

export function todoDueAt(todo: Pick<Todo, "dueDay" | "dueTime">, timeZone: string): string | undefined {
  if (!todo.dueDay) return undefined;
  const [hour, minute] = todo.dueTime ? todo.dueTime.split(":").map(Number) : [23, 59];
  return zonedTimeToUtc(timeZone, todo.dueDay, hour, minute).toISOString();
}

export function todoWhen(
  todo: Pick<Todo, "dueDay" | "dueTime">,
  today: DayKey,
  now: Date,
  timeZone: string,
  locale: TodoLocale = "zh-TW",
): QueueItem["when"] | undefined {
  const dueAt = todoDueAt(todo, timeZone);
  if (!dueAt || !todo.dueDay) return undefined;
  const t = strings[locale].tasks;
  if (Date.parse(dueAt) < now.getTime()) {
    if (locale === "zh-TW") return deadlineWhen(dueAt, now, timeZone);
    const lateHours = Math.max(1, Math.floor((now.getTime() - Date.parse(dueAt)) / 3_600_000));
    if (lateHours >= 24) {
      const days = Math.floor(lateHours / 24);
      return { label: format(days === 1 ? t.overdueDaysOne : t.overdueDays, { n: days }), tone: "hot", mono: false };
    }
    return { label: format(lateHours === 1 ? t.overdueHoursOne : t.overdueHours, { n: lateHours }), tone: "hot", mono: false };
  }
  if (todo.dueTime) {
    const time = localTime(timeZone, dueAt);
    const days = daysBetween(today, todo.dueDay);
    if (days === 0) {
      const ahead = Date.parse(dueAt) - now.getTime();
      return { label: time, ...(ahead >= 0 && ahead <= 6 * 3_600_000 ? { tone: "warm" } : {}), mono: true };
    }
    if (days === 1) return { label: `${t.schedule.tomorrow} ${time}`, mono: false };
    return { label: `${numericDate(todo.dueDay)} ${time}`, mono: false };
  }
  if (todo.dueDay === today) return { label: t.dueFormat.dueToday, mono: false };
  if (todo.dueDay === addDays(today, 1)) return { label: locale === "en" ? t.dueFormat.dueTomorrowMeta : "明天到期", mono: false };
  if (locale === "zh-TW") return { label: `還有 ${daysBetween(today, todo.dueDay)} 天`, tone: "muted", mono: false };
  return { label: format(t.dueFormat.dueDateMeta, { date: numericDate(todo.dueDay) }), tone: "muted", mono: false };
}

export function todoDeadline(
  todo: Pick<Todo, "dueDay" | "dueTime">,
  today: DayKey,
  now: Date,
  timeZone: string,
  locale: TodoLocale = "zh-TW",
): string | undefined {
  if (!todo.dueDay) return undefined;
  if (locale === "zh-TW") {
    if (todo.dueTime) return metaDeadline(todoDueAt(todo, timeZone)!, now, timeZone);
    const days = daysBetween(today, todo.dueDay);
    if (days === 0) return "今天截止";
    if (days === 1) return "明天截止";
    if (days > 1 && days <= 6) return `週${weekdayChar(todo.dueDay)}截止`;
    return `${numericDate(todo.dueDay)} 截止`;
  }

  const t = strings.en.tasks.dueFormat;
  const days = daysBetween(today, todo.dueDay);
  const time = todo.dueTime ? ` ${localTime(timeZone, todoDueAt(todo, timeZone)!)}` : "";
  if (days < 0 || days > 6) return format(t.dueDateMeta, { date: numericDate(todo.dueDay) });
  if (days === 0) return `${t.dueTodayMeta}${time}`;
  if (days === 1) return `${t.dueTomorrowMeta}${time}`;
  return `${format(t.dueWeekdayMeta, { weekday: englishWeekday(todo.dueDay) })}${time}`;
}

export function todoDuration(minutes: number, locale: TodoLocale = "zh-TW"): string {
  const t = strings[locale].tasks.dueFormat;
  if (minutes < 60) return format(t.durationMinutes, { m: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return format(rest ? t.durationHoursMinutes : t.durationHours, { h: hours, m: rest });
}
