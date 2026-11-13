import { z } from "zod";
import {
  agentProviders,
  reasoningEfforts,
  type ModelCatalog,
  type ModelExecution,
  type ProviderSettings,
  type ReasoningEffort,
} from "../../shared/models.js";
import { AppError } from "../errors.js";

/** Keeps model ids argv-safe: no leading dash, no spaces, no shell characters. */
export const modelId = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);
const effort = z.enum(reasoningEfforts);
const provider = z.enum(agentProviders);

export const providerSettingsSchema = z.object({
  provider,
  model: modelId.or(z.literal("")),
  reasoningEffort: effort.or(z.literal("")),
}).strict();

export const modelExecutionSchema = z.object({
  provider,
  model: modelId.optional(),
  reasoningEffort: effort.optional(),
  source: z.enum(["selected", "catalog-default", "cli-default"]),
  // Persisted records are parsed with this schema; unknown keys are stripped.
  reported: z
    .object({
      model: modelId,
      modelsUsed: z.array(modelId).max(20).optional(),
      cliVersion: z.string().min(1).max(100).optional(),
    })
    .optional(),
});

const claudeEfforts: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
/**
 * Claude Code has no model-list command, so BELL offers its documented aliases
 * (bell-pr). Each alias follows the latest model of that family; availability
 * depends on the plan. Sonnet at low effort is the default for daily work.
 */
export const claudeModelCatalog: ModelCatalog = {
  source: "claude",
  models: [
    {
      id: "sonnet",
      name: "Claude Sonnet",
      description: "速度與能力平衡，適合每日摘要與信件整理。",
      isDefault: true,
      reasoningEfforts: claudeEfforts,
      defaultReasoningEffort: "low",
    },
    {
      id: "haiku",
      name: "Claude Haiku",
      description: "最快、用量最低；不支援思考強度設定。",
      isDefault: false,
      reasoningEfforts: [],
    },
    {
      id: "opus",
      name: "Claude Opus",
      description: "較深入的推理，回覆較慢、用量較多。",
      isDefault: false,
      reasoningEfforts: claudeEfforts,
    },
    {
      id: "fable",
      name: "Claude Fable",
      description: "能力最強，單次工作可能較久；需方案支援。",
      isDefault: false,
      reasoningEfforts: claudeEfforts,
    },
  ],
};

/**
 * Turns saved settings into what is actually sent to the CLI, checked against
 * the provider's catalog (bell-pr). An empty catalog falls back to the CLI's
 * own default model, recorded as "cli-default".
 */
export function resolveModelExecution(settings: ProviderSettings, catalog: ModelCatalog): ModelExecution {
  const parsed = providerSettingsSchema.safeParse(settings);
  if (!parsed.success) throw new AppError(400, "模型設定格式不正確，請重新選擇。");
  const selected = parsed.data;
  if (selected.provider !== catalog.source) throw new AppError(400, "模型目錄與所選服務不一致，請重新載入後再選擇。");
  const model = selected.model
    ? catalog.models.find((item) => item.id === selected.model)
    : catalog.models.find((item) => item.isDefault);
  if (!model) {
    if (selected.model || selected.reasoningEffort)
      throw new AppError(400, "無法確認這組模型設定，請重新載入模型清單並選擇。");
    return { provider: selected.provider, source: "cli-default" };
  }
  const reasoningEffort = selected.reasoningEffort || model.defaultReasoningEffort;
  if (reasoningEffort && !model.reasoningEfforts.includes(reasoningEffort))
    throw new AppError(400, "所選模型不支援這個思考強度，請重新選擇。");
  return {
    provider: selected.provider,
    model: model.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    source: selected.model || selected.reasoningEffort ? "selected" : "catalog-default",
  };
}
