import { randomUUID } from "node:crypto";
import { z } from "zod";
import { SUGGESTION_KINDS, SUGGESTION_STATUSES, type AiSuggestion, type SuggestionKind, type SuggestionStatus } from "../../shared/suggestions.js";
import { SOURCE_IDS, type SourceId } from "../../shared/sources.js";
import { agentProviders, reasoningEfforts } from "../../shared/models.js";
import { AppError } from "../errors.js";
import type { AppDatabase, DocTable } from "../db/database.js";

const suggestionSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.enum(SUGGESTION_KINDS),
  status: z.enum(SUGGESTION_STATUSES),
  title: z.string().max(300),
  payload: z.unknown(),
  sourceRef: z.object({ source: z.enum(SOURCE_IDS), externalId: z.string().max(500), url: z.string().max(2000).optional() }).optional(),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
  resultId: z.string().max(100).optional(),
  origin: z.string().max(200).optional(),
  modelExecution: z.object({
    provider: z.enum(agentProviders),
    model: z.string().max(200).optional(),
    reasoningEffort: z.enum(reasoningEfforts).optional(),
    source: z.enum(["selected", "catalog-default", "cli-default"]),
    reported: z.object({ model: z.string().max(200), modelsUsed: z.array(z.string().max(200)).max(20).optional(), cliVersion: z.string().max(100).optional() }).optional(),
  }).optional(),
}) as z.ZodType<AiSuggestion>;

export interface NewSuggestion<P> {
  kind: SuggestionKind;
  title: string;
  payload: P;
  sourceRef?: AiSuggestion["sourceRef"];
  /** Same key twice → the existing suggestion is returned (e.g. "mail-todo:<message id>"). */
  dedupeKey?: string;
  /** 「KKTIX 報名成功信」: shown as 「來自 …」 on the Today row. */
  origin?: string;
  modelExecution?: AiSuggestion["modelExecution"];
}

/**
 * Model output waiting for the user's one-tap decision (sources.sqlite
 * ai_suggestions). Accepting is the feature's job (create the todo, then call
 * decide(id, "accepted", todoId)); this store only records the outcome.
 */
export class SuggestionStore {
  readonly table: DocTable<AiSuggestion>;

  constructor(private readonly database: AppDatabase, private readonly now: () => Date = () => new Date()) {
    this.table = database.docs<AiSuggestion>({
      table: "ai_suggestions",
      label: "建議",
      schema: suggestionSchema,
      columns: (doc) => ({ kind: doc.kind, status: doc.status, created_at: doc.createdAt }),
    });
  }

  create<P>(input: NewSuggestion<P>): AiSuggestion<P> {
    return this.database.transaction(() => {
      if (input.dedupeKey) {
        const existing = this.database.db.prepare("SELECT id FROM ai_suggestions WHERE dedupe_key = ?").get(input.dedupeKey);
        if (existing) return this.table.get(String(existing.id)) as AiSuggestion<P>;
      }
      const createdAt = this.now().toISOString();
      const suggestion = this.table.put({
        id: randomUUID(), kind: input.kind, status: "pending", title: input.title, payload: input.payload,
        ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
        ...(input.modelExecution ? { modelExecution: input.modelExecution } : {}),
        createdAt,
      }) as AiSuggestion<P>;
      if (input.dedupeKey) this.database.db.prepare("UPDATE ai_suggestions SET dedupe_key = ? WHERE id = ?").run(input.dedupeKey, suggestion.id);
      return suggestion;
    });
  }

  get<P = unknown>(id: string): AiSuggestion<P> | undefined {
    return this.table.get(id) as AiSuggestion<P> | undefined;
  }

  list<P = unknown>(filter: { status?: SuggestionStatus; kind?: SuggestionKind; limit?: number } = {}): AiSuggestion<P>[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) { where.push("status = ?"); params.push(filter.status); }
    if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
    return this.table.list({ where: where.join(" AND ") || undefined, params, orderBy: "created_at DESC", limit: filter.limit ?? 200 }) as AiSuggestion<P>[];
  }

  /** Records the user's decision once; deciding twice is a 409. */
  decide(id: string, status: Exclude<SuggestionStatus, "pending">, resultId?: string): AiSuggestion {
    return this.database.transaction(() => {
      const current = this.table.get(id, { strict: true });
      if (!current) throw new AppError(404, "找不到這則建議。");
      if (current.status !== "pending") throw new AppError(409, "這則建議已經處理過了。");
      return this.table.put({ ...current, status, decidedAt: this.now().toISOString(), ...(resultId ? { resultId } : {}) });
    });
  }

  /**
   * The source's data is gone (中斷連線, 清除快取的信件, the retention window):
   * suggestions made from it (all of the source's, or those of `externalIds`)
   * go too. Pending ones are deleted; decided ones keep only the decision
   * (status, time, resultId), with their title, payload, origin and source
   * reference emptied. Returns the ids it touched.
   */
  forgetSource(source: SourceId, externalIds?: readonly string[]): string[] {
    const wanted = externalIds ? new Set(externalIds) : undefined;
    return this.database.transaction(() => {
      const touched: string[] = [];
      const rows = this.database.db.prepare("SELECT id FROM ai_suggestions WHERE json_extract(json, '$.sourceRef.source') = ?").all(source);
      for (const row of rows) {
        const current = this.table.get(String(row.id));
        if (!current?.sourceRef || (wanted && !wanted.has(current.sourceRef.externalId))) continue;
        touched.push(current.id);
        if (current.status === "pending") {
          this.database.db.prepare("DELETE FROM ai_suggestions WHERE id = ?").run(current.id);
          continue;
        }
        const { sourceRef: _ref, origin: _origin, ...rest } = current;
        this.table.put({ ...rest, title: "", payload: null });
      }
      return touched;
    });
  }

  /** Undo of a decision made from the Today queue (DELETE /api/actions/:id): back to pending. */
  reopen(id: string): AiSuggestion {
    return this.database.transaction(() => {
      const current = this.table.get(id, { strict: true });
      if (!current) throw new AppError(404, "找不到這則建議。");
      if (current.status === "pending") return current;
      const { decidedAt: _decidedAt, resultId: _resultId, ...rest } = current;
      return this.table.put({ ...rest, status: "pending" });
    });
  }
}
