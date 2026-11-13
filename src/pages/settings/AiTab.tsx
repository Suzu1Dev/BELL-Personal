import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { AI_KEY_METHOD, type AiActiveStatus, type AiConnection, type AiConnectionMethod, type AiConnectionsResponse, type AiKeyProvider, type AiLoginMethod } from "../../../shared/ai-connections";
import { BOT_AUTONOMY_LEVELS, type BotAutonomy } from "../../../shared/settings";
import { format, onboardingCopy, type OnboardingCopy } from "../../copy/onboarding";
import { AiConnect } from "../../components/ai-connect/AiConnect";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Icon, LockKeyhole } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { Pill } from "../../components/Pill";
import { Skeleton } from "../../components/Skeleton";
import { useToast } from "../../components/toast/ToastProvider";
import { useAppSettings } from "../../lib/app-settings";
import { useStatus } from "../../lib/status";
import { ModelSettings } from "./ModelSettings";
import { connectionAction, connectionMeta, connectionReason, nextRadioIndex } from "./ai-tab-model";
import { settingsApi } from "./settings-api";

type DialogMethod = AiLoginMethod | AiKeyProvider;
const LOGIN_METHODS: readonly AiConnectionMethod[] = ["chatgpt", "claude"];
const KEY_METHODS: readonly AiConnectionMethod[] = ["openai-key", "anthropic-key"];

export function AiTab() {
  const copy = onboardingCopy();
  const app = useAppSettings();
  const status = useStatus();
  const toast = useToast();
  const [data, setData] = useState<AiConnectionsResponse>();
  const [error, setError] = useState(false);
  const [dialog, setDialog] = useState<DialogMethod>();
  const [remove, setRemove] = useState<AiKeyProvider>();
  const [removing, setRemoving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setData(await settingsApi.aiConnections());
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const activate = async (method: AiConnectionMethod) => {
    if (await app.save({ "ai.enabled": true, "ai.connection": method })) {
      await refresh();
      void status.refresh();
    }
  };

  const removeKey = async () => {
    if (!remove) return;
    setRemoving(true);
    try {
      await settingsApi.deleteAiKey(remove);
      if (data?.active === AI_KEY_METHOD[remove]) await app.save({ "ai.enabled": false, "ai.connection": null });
      setRemove(undefined);
      await refresh();
      void status.refresh();
    } catch (cause) {
      toast.error(format(copy.googleGuide.actionFailed, { label: copy.settings.remove, reason: cause instanceof Error ? cause.message : copy.googleGuide.offline }));
    } finally {
      setRemoving(false);
    }
  };

  const connection = (method: AiConnectionMethod) => data?.connections.find((item) => item.method === method);
  const open = (method: AiConnectionMethod) => setDialog(method === "chatgpt" || method === "claude" ? method : method === "openai-key" ? "openai" : "anthropic");
  const dialogTitle = dialog === "chatgpt" ? copy.ai.login.chatgptTitle : dialog === "claude" ? copy.ai.login.claudeTitle : copy.ai.keyFlow.title;
  return (
    <div className="onboarding-settings settings-stack">
      <section className="settings-section">
        <div className="sec-head"><h2>{copy.settings.aiWays.title}</h2><p className="hint">{copy.settings.aiWays.hint}</p></div>
        {!data && !error ? <Skeleton height={190} /> : null}
        {error ? <Notice tone="error" title={copy.ai.errors.loadFailedTitle} actions={<Button variant="secondary" onClick={() => void refresh()}>{copy.ai.errors.retry}</Button>}>{copy.ai.errors.networkBody}</Notice> : null}
        {data ? (
          <>
            <p className="group-label">{copy.ai.subLabel}</p>
            <MethodGroup label={copy.settings.aiWays.title} methods={LOGIN_METHODS} active={data.active} activeStatus={status.data?.ai.connection} copy={copy} connection={connection} onActivate={(method) => void activate(method)} onOpen={open} />
            <p className="group-label">{copy.ai.keyLabel}</p>
            <MethodGroup label={copy.ai.keyLabel} methods={KEY_METHODS} active={data.active} activeStatus={status.data?.ai.connection} copy={copy} connection={connection} onActivate={(method) => void activate(method)} onOpen={open} onRemove={(method) => setRemove(method === "openai-key" ? "openai" : "anthropic")} />
          </>
        ) : null}
        <p className="fine"><Icon icon={LockKeyhole} />{copy.ai.privacy}</p>
      </section>
      <ModelSettings />
      <BotAutonomySettings copy={copy} current={app.settings?.["bot.autonomy"] ?? "balanced"} onSelect={(level) => void app.save({ "bot.autonomy": level })} />
      <Dialog open={!!dialog} onClose={() => setDialog(undefined)} title={dialogTitle} className="ai-connect-modal">
        {dialog ? <AiConnect key={dialog} variant="dialog" initialMethod={dialog} onClose={() => { setDialog(undefined); void refresh(); }} /> : null}
      </Dialog>
      <Dialog open={!!remove} onClose={() => setRemove(undefined)} title={format(copy.settings.removeKey.title, { provider: remove ? providerName(remove) : "" })} footer={<><Button variant="ghost" onClick={() => setRemove(undefined)}>{copy.settings.removeKey.cancel}</Button><Button variant="danger" disabled={removing} onClick={() => void removeKey()}>{copy.settings.removeKey.confirm}</Button></>}>
        <p>{copy.settings.removeKey.body}</p>
      </Dialog>
    </div>
  );
}

function MethodGroup({ label, methods, active, activeStatus, copy, connection, onActivate, onOpen, onRemove }: {
  label: string;
  methods: readonly AiConnectionMethod[];
  active: AiConnectionMethod | null;
  activeStatus: AiActiveStatus | null | undefined;
  copy: OnboardingCopy;
  connection: (method: AiConnectionMethod) => AiConnection | undefined;
  onActivate: (method: AiConnectionMethod) => void;
  onOpen: (method: AiConnectionMethod) => void;
  onRemove?: (method: AiConnectionMethod) => void;
}) {
  const [focused, setFocused] = useState<AiConnectionMethod>(active && methods.includes(active) ? active : methods[0]);
  useEffect(() => {
    if (active && methods.includes(active)) setFocused(active);
  }, [active, methods]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, method: AiConnectionMethod) => {
    const next = nextRadioIndex(methods.length, methods.indexOf(method), event.key);
    if (next < 0) return;
    event.preventDefault();
    const target = methods[next];
    setFocused(target);
    event.currentTarget.closest("[role=radiogroup]")?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  return <div className="group" role="radiogroup" aria-label={label}>{methods.map((method) => <MethodRow key={method} copy={copy} connection={connection(method)} active={active === method} activeStatus={activeStatus} focused={focused === method} onFocus={() => setFocused(method)} onMove={(event) => move(event, method)} onActivate={() => onActivate(method)} onOpen={() => onOpen(method)} onRemove={onRemove ? () => onRemove(method) : undefined} />)}</div>;
}

function MethodRow({ copy, connection, active, activeStatus, focused, onFocus, onMove, onActivate, onOpen, onRemove }: {
  copy: OnboardingCopy;
  connection: AiConnection | undefined;
  active: boolean;
  activeStatus: AiActiveStatus | null | undefined;
  focused: boolean;
  onFocus: () => void;
  onMove: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onActivate: () => void;
  onOpen: () => void;
  onRemove?: () => void;
}) {
  if (!connection) return null;
  const title = connection.method === "chatgpt" ? copy.ai.chatgpt.name : connection.method === "claude" ? copy.ai.claude.name : connection.method === "openai-key" ? copy.settings.keyOpenai : copy.settings.keyAnthropic;
  const ready = connection.state === "detected";
  const reason = connectionReason(connection, active ? activeStatus : undefined);
  const meta = connectionMeta(copy, connection, reason);
  const action = connectionAction(copy, connection, reason);
  const actionButton = action ? <Button variant="secondary" onClick={action.kind === "remove" ? onRemove : onOpen}>{action.label}</Button> : null;
  return (
    <div className="opt ai-method">
      <button type="button" className="radio" role="radio" aria-checked={active} aria-disabled={!ready} aria-label={title} tabIndex={focused ? 0 : -1} onFocus={onFocus} onKeyDown={onMove} onClick={() => { if (ready) onActivate(); }} />
      <span><span className="opt-title">{title}</span><span className="opt-meta">{meta}</span></span>
      <span className="opt-end">{active ? <><Pill tone="ok">{copy.settings.inUse}</Pill>{!ready ? actionButton : null}</> : actionButton}</span>
    </div>
  );
}

function providerName(provider: AiKeyProvider): string {
  return provider === "openai" ? "OpenAI" : "Anthropic";
}

function BotAutonomySettings({ copy, current, onSelect }: {
  copy: OnboardingCopy;
  current: BotAutonomy;
  onSelect: (level: BotAutonomy) => void;
}) {
  const [focused, setFocused] = useState<BotAutonomy>(current);
  useEffect(() => { setFocused(current); }, [current]);

  const move = (event: KeyboardEvent<HTMLButtonElement>, level: BotAutonomy) => {
    const next = nextRadioIndex(BOT_AUTONOMY_LEVELS.length, BOT_AUTONOMY_LEVELS.indexOf(level), event.key);
    if (next < 0) return;
    event.preventDefault();
    const target = BOT_AUTONOMY_LEVELS[next]!;
    setFocused(target);
    event.currentTarget.closest("[role=radiogroup]")?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
  };

  return (
    <section className="settings-section" id="bot-autonomy">
      <div className="sec-head">
        <h2>{copy.settings.bot.title}</h2>
        <p className="hint">{copy.settings.bot.hint}</p>
      </div>
      <div className="group" role="radiogroup" aria-label={copy.settings.bot.title}>
        {BOT_AUTONOMY_LEVELS.map((level) => {
          const info = copy.settings.bot.levels[level];
          const active = current === level;
          return (
            <div key={level} className="opt ai-method">
              <button
                type="button"
                className="radio"
                role="radio"
                aria-checked={active}
                aria-label={info.name}
                tabIndex={focused === level ? 0 : -1}
                onFocus={() => setFocused(level)}
                onKeyDown={(event) => move(event, level)}
                onClick={() => onSelect(level)}
              />
              <span>
                <span className="opt-title">{info.name}</span>
                <span className="opt-meta">{info.meta}</span>
              </span>
              <span className="opt-end">{active ? <Pill tone="ok">{copy.settings.inUse}</Pill> : null}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
