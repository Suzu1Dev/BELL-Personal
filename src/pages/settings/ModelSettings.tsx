import { useEffect, useState } from "react";
import type { ModelOption, ProviderSettings, ProviderSnapshot } from "../../../shared/models";
import { commonCopy } from "../../copy/common";
import { format, onboardingCopy } from "../../copy/onboarding";
import { Button } from "../../components/Button";
import { Field, Select } from "../../components/Field";
import { Notice } from "../../components/Notice";
import { useToast } from "../../components/toast/ToastProvider";
import { useStatus } from "../../lib/status";
import { effortDefaultLabel, modelSelectionDisabled } from "./ai-tab-model";
import { settingsApi } from "./settings-api";

export function modelDescription(copy: ReturnType<typeof onboardingCopy>, model: ModelOption): string {
  return copy.settings.model.descriptions[model.id as keyof typeof copy.settings.model.descriptions] ?? model.description;
}

export function ModelSettings() {
  const copy = onboardingCopy();
  const { ERRORS } = commonCopy();
  const toast = useToast();
  const status = useStatus();
  const [snapshot, setSnapshot] = useState<ProviderSnapshot>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    settingsApi.provider(controller.signal)
      .then((value) => { setSnapshot(value); setError(undefined); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : ERRORS.offline); });
    return () => controller.abort();
  }, [attempt]);

  const save = (patch: Partial<ProviderSettings>) => {
    const before = snapshot;
    if (snapshot) setSnapshot({ ...snapshot, settings: { ...snapshot.settings, ...patch } });
    void settingsApi.saveProvider(patch).then((next) => {
      setSnapshot(next);
      const previousModel = before?.settings.model;
      if (previousModel && next.settings.model !== previousModel) {
        const provider = next.connection === "chatgpt" || next.connection === "openai-key" ? "OpenAI" : "Anthropic";
        toast.success(format(copy.settings.toasts.modelReset, { provider }));
      }
    }).catch(() => {
      setSnapshot(before);
      toast.error(copy.settings.toasts.saveFailed);
    });
  };

  const provider = snapshot?.settings.provider ?? "claude";
  const catalog = snapshot?.catalogs.find((entry) => entry.source === provider);
  const models = catalog?.models ?? [];
  const defaultModel = models.find((model) => model.isDefault) ?? models[0];
  const model = models.find((entry) => entry.id === (snapshot?.settings.model || defaultModel?.id));
  const efforts = model?.reasoningEfforts ?? [];
  const listError = error ?? catalog?.error;
  const unavailable = modelSelectionDisabled(status.data?.ai.connection);
  return (
    <section className="settings-section">
      <div className="sec-head"><h2>{copy.settings.model.title}</h2><p className="hint">{copy.settings.model.hint}</p></div>
      {listError ? <Notice tone="error" title={copy.settings.model.catalogError} actions={<Button variant="secondary" size="sm" onClick={() => setAttempt((value) => value + 1)}>{copy.ai.errors.retry}</Button>}>{listError}</Notice> : null}
        <div className="group model-settings">
          <div className="opt model-row"><span><span className="opt-title">{copy.settings.model.model}</span><span className="opt-meta">{model ? modelDescription(copy, model) : (provider === "codex" ? "Codex" : "Claude")}</span></span><Field label={<span className="sr-only">{copy.settings.model.model}</span>}><Select value={snapshot?.settings.model ?? ""} disabled={!snapshot || !defaultModel || unavailable} onChange={(event) => save({ model: event.target.value })}><option value="">{defaultModel ? `${copy.settings.model.modelValue} · ${defaultModel.name}` : copy.settings.model.modelValue}</option>{models.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</Select></Field></div>
          <div className="opt model-row"><span><span className="opt-title">{copy.settings.model.effort}</span><span className="opt-meta">{copy.settings.model.effortHint}</span></span><Field label={<span className="sr-only">{copy.settings.model.effort}</span>}><Select value={snapshot?.settings.reasoningEffort ?? ""} disabled={!snapshot || !efforts.length || unavailable} onChange={(event) => save({ reasoningEffort: event.target.value as ProviderSettings["reasoningEffort"] })}><option value="">{effortDefaultLabel(copy, model?.defaultReasoningEffort)}</option>{efforts.map((effort) => <option key={effort} value={effort}>{copy.settings.model.effortLevels[effort]}</option>)}</Select></Field></div>
        </div>
    </section>
  );
}
