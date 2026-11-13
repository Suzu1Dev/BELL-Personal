/** Composer text → idea fields (#tags become tags; a note's first line is its title). Pure. */
import { ideaBody, parseCapture } from "../../../shared/capture-parse";
import { IDEA_LIMITS } from "../../../shared/ideas";

/** 靈感 tab: the text without #tags, and the tags. */
export function ideaFromText(text: string, now: Date, timeZone: string): { text: string; tags: string[] } {
  const parse = parseCapture(text, { now, timeZone, context: "idea" });
  return { text: ideaBody(text).slice(0, IDEA_LIMITS.text), tags: parse.tags.slice(0, IDEA_LIMITS.tags) };
}

/** 筆記 tab: the first line is the title when more lines follow. */
export function noteFromText(text: string, now: Date, timeZone: string): { title?: string; text: string; tags: string[] } {
  const { text: body, tags } = ideaFromText(text, now, timeZone);
  const [first, ...rest] = text.trim().split("\n");
  const remainder = rest.join("\n").trim();
  if (!remainder) return { text: body, tags };
  const title = ideaBody(first).slice(0, IDEA_LIMITS.title);
  return { title, text: ideaBody(remainder).slice(0, IDEA_LIMITS.text) || body, tags };
}

/** The edit field's text: the idea plus its tags as #tags, so tags are edited inline. */
export function editableText(idea: { text: string; tags: string[] }): string {
  return idea.tags.length ? `${idea.text} ${idea.tags.map((tag) => `#${tag}`).join(" ")}` : idea.text;
}
