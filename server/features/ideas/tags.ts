import { z } from "zod";
import { IDEA_LIMITS, type Idea, type IdeaTagProposal } from "../../../shared/ideas.js";
import type { IdeaTagsSuggestion } from "../../../shared/suggestions.js";
import { AppError } from "../../errors.js";
import { withGenerationProgress } from "../../generation-progress.js";
import type { JobView } from "../../../shared/jobs.js";
import type { ModuleContext, SuggestionAcceptor } from "../../modules.js";
import { tagSchema, type IdeaStore } from "./store.js";

/** Ideas sent to the model per job, and how much of each. */
const BATCH = 10;
/** Ideas per idea-tags job. */
export const TAG_BATCH = BATCH;
const TEXT_CHARS = 1000;
const TAGS_PER_IDEA = 3;

const answerSchema = z.object({
  ideas: z.array(z.object({
    id: z.string().max(100),
    tags: z.array(z.string().min(1).max(20)).max(TAGS_PER_IDEA),
  }).strict()).max(BATCH),
}).strict();

const PROMPT = [
  "為每則靈感建議最多 3 個簡短的分類標籤，方便日後搜尋。",
  "標籤用繁體中文或常見英文縮寫（例如 OS、CTF、寫作、專題），2–8 個字，不加 # 號，不要空白。",
  "優先沿用 existingTags 裡已經在用的標籤；不要重複這則靈感已經有的標籤；不確定就少給。",
  "依照 data.ideas 的 id 回傳，每則都要出現（沒有建議就回傳空陣列）。",
].join("\n");

/** Whether AI tag proposals may run (使用 AI and 靈感自動標籤 both on). */
export function aiTagsEnabled(ctx: Pick<ModuleContext, "settings">): boolean {
  return ctx.settings.value("ai.enabled") && ctx.settings.value("ai.ideaTags");
}

/** Pending proposals by idea id, minus tags the idea already has. */
export function pendingProposals(ctx: Pick<ModuleContext, "suggestions">, ideas: Map<string, Idea>): Map<string, IdeaTagProposal[]> {
  const map = new Map<string, IdeaTagProposal[]>();
  const pending = ctx.suggestions.list<IdeaTagsSuggestion>({ status: "pending", kind: "idea-tags", limit: 1000 })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.payload?.tags?.[0] ?? "").localeCompare(b.payload?.tags?.[0] ?? ""));
  for (const suggestion of pending) {
    const idea = ideas.get(suggestion.payload?.ideaId);
    if (!idea) continue;
    const have = new Set(idea.tags.map((tag) => tag.toLowerCase()));
    for (const tag of suggestion.payload.tags ?? []) {
      if (have.has(tag.toLowerCase())) continue;
      const list = map.get(idea.id) ?? [];
      if (!list.some((item) => item.tag.toLowerCase() === tag.toLowerCase())) list.push({ suggestionId: suggestion.id, tag });
      map.set(idea.id, list);
    }
  }
  return map;
}

/**
 * Starts the `idea-tags` job: asks the model for tags on `ids` (or the newest
 * ideas with fewer than two tags and no proposal yet) and stores one
 * `idea-tags` suggestion per tag (dedupe key per idea and tag, so a tag the
 * user dismissed is never proposed again). Nothing is tagged until the user
 * taps a proposal.
 */
export function startTagJob(ctx: ModuleContext, store: IdeaStore, ids?: string[]): JobView {
  if (!aiTagsEnabled(ctx)) throw new AppError(503, "AI 標籤建議已關閉，可以在 連線與設定 › 每日摘要 開啟。");
  const proposed = new Set(ctx.suggestions.list<IdeaTagsSuggestion>({ kind: "idea-tags", limit: 1000 }).map((item) => item.payload?.ideaId));
  const ideas = ids?.length
    ? ids.map((id) => store.get(id)).filter((idea): idea is Idea => !!idea && !idea.archived)
    : store.list({ limit: 200 }).filter((idea) => idea.tags.length < 2 && !proposed.has(idea.id));
  const batch = ideas.slice(0, BATCH);
  if (!batch.length) throw new AppError(409, "沒有需要建議標籤的靈感。");
  const existingTags = [...new Set(store.list({ limit: 500 }).flatMap((idea) => idea.tags))].slice(0, 40);

  return ctx.jobs.start({ kind: "idea-tags", title: "整理靈感標籤" }, async (emit, signal) => {
    const { value, execution } = await withGenerationProgress("整理靈感標籤", "idea-tags", emit, signal, (onProgress) => ctx.ai.runStructured({
      role: "靈感標籤",
      schema: answerSchema,
      prompt: PROMPT,
      data: { existingTags, ideas: batch.map((idea) => ({ id: idea.id, text: idea.text.slice(0, TEXT_CHARS), tags: idea.tags })) },
      signal,
      timeoutKind: "quick",
      onProgress,
    }));
    let proposals = 0;
    for (const answer of value.ideas) {
      const idea = batch.find((item) => item.id === answer.id);
      if (!idea) continue;
      const have = new Set(idea.tags.map((tag) => tag.toLowerCase()));
      for (const raw of answer.tags) {
        const parsed = tagSchema.safeParse(raw);
        if (!parsed.success || have.has(parsed.data.toLowerCase())) continue;
        const tag = parsed.data;
        const created = ctx.suggestions.create<IdeaTagsSuggestion>({
          kind: "idea-tags",
          title: `加上標籤 #${tag}`,
          payload: { ideaId: idea.id, tags: [tag] },
          dedupeKey: `idea-tag:${idea.id}:${tag.toLowerCase()}`,
          modelExecution: execution,
        });
        if (created.status === "pending") proposals++;
      }
    }
    return { proposals };
  }, { maxRunning: 1, busyMessage: "靈感標籤正在整理中。" });
}

/** acceptSuggestion["idea-tags"]: adds the proposed tag(s) to the idea. */
export function acceptIdeaTags(store: IdeaStore): SuggestionAcceptor {
  return (suggestion) => {
    const payload = z.object({ ideaId: z.string().min(1).max(100), tags: z.array(tagSchema).min(1).max(IDEA_LIMITS.tags) }).safeParse(suggestion.payload);
    if (!payload.success) throw new AppError(422, "這則標籤建議的內容不完整。");
    const idea = store.addTags(payload.data.ideaId, payload.data.tags);
    return { resultId: idea.id, result: idea };
  };
}
