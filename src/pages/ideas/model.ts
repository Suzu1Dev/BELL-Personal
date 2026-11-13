/**
 * #/ideas list helpers: by-day groups with 今天 / 昨天 headings, pinned on
 * top, and the Composer's text → idea fields. Pure, so they are unit-tested.
 */
import type { IdeaView } from "../../../shared/ideas";
import { addDays, type DayKey } from "../../../shared/time";
import { ideasCopy, type IdeasLocale } from "../../copy/ideas";
import { dateLabel } from "../../components/capture/describe";

export interface IdeaGroup {
  key: string;
  label: string;
  ideas: IdeaView[];
}

/** 「釘選」 first, then one group per local day, newest first. */
export function groupIdeas(ideas: readonly IdeaView[], today: DayKey, timeZone: string, locale: IdeasLocale = "zh-TW"): IdeaGroup[] {
  const { IDEAS } = ideasCopy(locale);
  const groups: IdeaGroup[] = [];
  const pinned = ideas.filter((idea) => idea.pinned && !idea.archived);
  if (pinned.length) groups.push({ key: "pinned", label: IDEAS.pinned, ideas: pinned });
  const byDay = new Map<string, IdeaView[]>();
  for (const idea of ideas) {
    if (idea.pinned && !idea.archived) continue;
    const list = byDay.get(idea.day) ?? [];
    list.push(idea);
    byDay.set(idea.day, list);
  }
  for (const day of [...byDay.keys()].sort().reverse()) {
    const date = locale === "en"
      ? new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${day}T12:00:00.000Z`))
      : dateLabel(day, timeZone);
    const label = day === today ? IDEAS.today : day === addDays(today, -1) ? IDEAS.yesterday : date;
    groups.push({ key: day, label, ideas: byDay.get(day)!.sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
  }
  return groups;
}

export { editableText, ideaFromText, noteFromText } from "../../components/capture/ideaText";
