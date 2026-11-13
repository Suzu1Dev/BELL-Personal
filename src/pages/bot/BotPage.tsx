import { Pin, Sparkles } from "lucide-react";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  BOT_SESSION_FOLDERS,
  type BotContextStatus,
  type BotOperation,
  type BotSessionFolder,
  type BotSessionSummary,
  type BotSessionView,
} from "../../../shared/bot";
import { useShell } from "../../app/shell-context";
import { Button } from "../../components/Button";
import {
  ArrowUpRight,
  CornerDownLeft,
  Icon,
  PanelLeftOpen,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { BOT, CAPTURE } from "../../copy/today";
import { useBot } from "../../lib/bot-store";
import { cx } from "../../lib/cx";
import type { RouteOf } from "../../lib/router";
import {
  BellBotMascot,
  BotMiniVisor,
  FormattedBotText,
  OperationItem,
  STARTER_META,
} from "../today/PersonalBotCard";
import "../today/PersonalBotCard.css";
import "./BotPage.css";

type FolderFilter = "all" | "pinned" | BotSessionFolder;

function formatSessionTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const diffMin = Math.round((Date.now() - ts) / 60_000);
  if (diffMin < 1) return "剛剛";
  if (diffMin < 60) return `${diffMin} 分前`;
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export interface BotWorkspaceViewProps {
  session: BotSessionView | undefined;
  sessions: BotSessionSummary[];
  context: BotContextStatus | undefined;
  draft: string;
  sending: boolean;
  progressMessage?: string;
  busyOpId?: string | null;
  error?: string | null;
  onDraftChange: (value: string) => void;
  onSubmit: (text?: string) => void;
  onReset: () => void;
  onSelectSession: (id: string) => void;
  onPatchSession: (id: string, patch: { title?: string; folder?: BotSessionFolder; pinned?: boolean }) => void;
  onDeleteSession: (id: string) => void;
  onApproveOp: (op: BotOperation) => void;
  onDismissOp: (op: BotOperation) => void;
  onUndoOp: (op: BotOperation) => void;
  onQuickCapture?: () => void;
}

export function BotWorkspaceView({
  session,
  sessions,
  context,
  draft,
  sending,
  progressMessage,
  busyOpId,
  error,
  onDraftChange,
  onSubmit,
  onReset,
  onSelectSession,
  onPatchSession,
  onDeleteSession,
  onApproveOp,
  onDismissOp,
  onUndoOp,
  onQuickCapture,
}: BotWorkspaceViewProps) {
  const inputId = useId();
  const searchId = useId();
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prevSessionKeyRef = useRef<string>("");

  const [filter, setFilter] = useState<FolderFilter>("all");
  const [query, setQuery] = useState("");
  const [railOpen, setRailOpen] = useState(false);

  const messages = session?.messages ?? [];
  const hasMessages = messages.length > 0;
  const isEmpty = !hasMessages && !sending;
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const autonomy = context?.autonomy ?? "balanced";
  const activeFolder: BotSessionFolder = session?.folder ?? "general";
  const activePinned = Boolean(session?.pinned);
  const mascotMode: "idle" | "typing" | "thinking" = sending
    ? "thinking"
    : draft.trim().length > 0
      ? "typing"
      : "idle";

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((item) => {
      if (filter === "pinned" && !item.pinned) return false;
      if (filter !== "all" && filter !== "pinned" && item.folder !== filter) return false;
      if (q && !item.title.toLowerCase().includes(q) && !item.preview.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [sessions, filter, query]);

  const folderCounts = useMemo(() => {
    const counts: Record<FolderFilter, number> = {
      all: sessions.length,
      pinned: 0,
      daily: 0,
      tasks: 0,
      suite: 0,
      general: 0,
    };
    for (const s of sessions) {
      if (s.pinned) counts.pinned += 1;
      counts[s.folder] += 1;
    }
    return counts;
  }, [sessions]);

  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const key = `${session?.id ?? ""}:${messages.length}:${sending ? "1" : "0"}`;
    if (prevSessionKeyRef.current !== key) {
      el.scrollTop = el.scrollHeight;
      prevSessionKeyRef.current = key;
    }
  }, [session?.id, messages.length, sending]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(160, Math.max(26, ta.scrollHeight))}px`;
  }, [draft]);

  const handleFormSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (sending || !draft.trim()) return;
    onSubmit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!sending && draft.trim()) onSubmit();
    }
  };

  const handlePickSession = (id: string) => {
    onSelectSession(id);
    setRailOpen(false);
  };

  const handleStartNew = () => {
    onReset();
    setRailOpen(false);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  return (
    <div className={cx("bot-studio", railOpen && "is-rail-open")}>
      <h1 className="sr-only">{BOT.title}</h1>

      {railOpen ? (
        <div className="bot-rail-scrim" aria-hidden="true" onClick={() => setRailOpen(false)} />
      ) : null}

      <aside className="bot-rail" aria-label={BOT.historyTitle}>
        <div className="bot-rail-head">
          <div className="bot-rail-heading">
            <Icon icon={Sparkles} size="sm" />
            <strong>{BOT.historyTitle}</strong>
            {sessions.length > 0 ? <span className="bot-rail-count mono">{sessions.length}</span> : null}
          </div>
          <Button
            size="sm"
            variant="primary"
            icon={Plus}
            disabled={sending}
            onClick={handleStartNew}
          >
            {BOT.newChat}
          </Button>
        </div>

        <label className="bot-rail-search" htmlFor={searchId}>
          <Icon icon={Search} size="xs" />
          <input
            id={searchId}
            type="search"
            value={query}
            placeholder={BOT.searchPlaceholder}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query ? (
            <button
              type="button"
              className="bot-rail-clear"
              aria-label="清除搜尋"
              onClick={() => setQuery("")}
            >
              <Icon icon={X} size="xs" />
            </button>
          ) : null}
        </label>

        <div className="bot-folders" role="tablist" aria-label="依分類篩選對話">
          <button
            type="button"
            role="tab"
            aria-selected={filter === "all"}
            className={cx("bot-folder-pill", filter === "all" && "is-active")}
            onClick={() => setFilter("all")}
          >
            <span>{BOT.filters.all}</span>
            {folderCounts.all > 0 ? <small className="mono">{folderCounts.all}</small> : null}
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={filter === "pinned"}
            className={cx("bot-folder-pill", filter === "pinned" && "is-active")}
            onClick={() => setFilter("pinned")}
          >
            <Icon icon={Pin} size="xs" />
            <span>{BOT.filters.pinned}</span>
            {folderCounts.pinned > 0 ? <small className="mono">{folderCounts.pinned}</small> : null}
          </button>

          {BOT_SESSION_FOLDERS.map((folderKey) => (
            <button
              key={folderKey}
              type="button"
              role="tab"
              aria-selected={filter === folderKey}
              className={cx("bot-folder-pill", `is-f-${folderKey}`, filter === folderKey && "is-active")}
              onClick={() => setFilter(folderKey)}
            >
              <i className="bot-folder-dot" aria-hidden="true" />
              <span>{BOT.folders[folderKey]}</span>
              {folderCounts[folderKey] > 0 ? <small className="mono">{folderCounts[folderKey]}</small> : null}
            </button>
          ))}
        </div>

        <div className="bot-session-list">
          {sessions.length === 0 ? (
            <p className="bot-rail-empty kp">{BOT.emptyHistory}</p>
          ) : filteredSessions.length === 0 ? (
            <p className="bot-rail-empty kp">{BOT.noMatchHistory}</p>
          ) : (
            filteredSessions.map((item) => {
              const active = session?.id === item.id && hasMessages;
              return (
                <div
                  key={item.id}
                  className={cx("bot-session-item", `is-f-${item.folder}`, active && "is-active")}
                >
                  <button
                    type="button"
                    className="bot-session-main"
                    aria-current={active ? "true" : undefined}
                    onClick={() => handlePickSession(item.id)}
                  >
                    <div className="bot-session-meta">
                      <span className={cx("bot-session-tag", `is-f-${item.folder}`)}>
                        <i className="bot-folder-dot" aria-hidden="true" />
                        {BOT.folders[item.folder]}
                      </span>
                      <span className="bot-session-when mono">{formatSessionTime(item.updatedAt)}</span>
                    </div>
                    <strong className="bot-session-title">{item.title}</strong>
                    {item.preview ? <span className="bot-session-preview">{item.preview}</span> : null}
                  </button>

                  <div className="bot-session-acts">
                    <button
                      type="button"
                      className={cx("bot-icon-act", item.pinned && "is-pinned")}
                      title={item.pinned ? BOT.unpin : BOT.pin}
                      aria-label={item.pinned ? BOT.unpin : BOT.pin}
                      onClick={() => onPatchSession(item.id, { pinned: !item.pinned })}
                    >
                      <Icon icon={Pin} size="xs" />
                    </button>
                    <button
                      type="button"
                      className="bot-icon-act is-danger"
                      title={BOT.deleteChat}
                      aria-label={BOT.deleteChat}
                      onClick={() => onDeleteSession(item.id)}
                    >
                      <Icon icon={Trash2} size="xs" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      <section className="bot-stage" aria-label={BOT.title}>
        <header className="bot-stage-head">
          <div className="bot-stage-title-group">
            <button
              type="button"
              className="bot-mobile-rail-btn"
              aria-label={BOT.historyToggle}
              onClick={() => setRailOpen(true)}
            >
              <Icon icon={PanelLeftOpen} size="sm" />
            </button>
            <strong className="bot-stage-title">
              {hasMessages && session?.title ? session.title : BOT.title}
            </strong>

            {hasMessages && session ? (
              <div className="bot-stage-tags" role="group" aria-label={BOT.folderGroupLabel}>
                {BOT_SESSION_FOLDERS.map((folderKey) => (
                  <button
                    key={folderKey}
                    type="button"
                    className={cx("bot-tag-chip", `is-f-${folderKey}`, activeFolder === folderKey && "is-selected")}
                    onClick={() => onPatchSession(session.id, { folder: folderKey })}
                  >
                    <i className="bot-folder-dot" aria-hidden="true" />
                    <span>{BOT.folders[folderKey]}</span>
                  </button>
                ))}
                <button
                  type="button"
                  className={cx("bot-tag-chip is-pin-chip", activePinned && "is-selected")}
                  title={activePinned ? BOT.unpin : BOT.pin}
                  onClick={() => onPatchSession(session.id, { pinned: !activePinned })}
                >
                  <Icon icon={Pin} size="xs" />
                  <span>{activePinned ? BOT.filters.pinned : BOT.pin}</span>
                </button>
              </div>
            ) : null}
          </div>

          <div className="bot-stage-status">
            <div className="bot-suite-pills" aria-label="已連接工作空間">
              <span className="bot-suite-dot is-ok"><i></i>{BOT.suitePersonal}</span>
              {context?.explain.configured ? (
                <span className={`bot-suite-dot${context.explain.ready ? " is-ok" : ""}`}>
                  <i></i>{BOT.suiteExplain}
                </span>
              ) : null}
              {context?.pr.configured ? (
                <span className={`bot-suite-dot${context.pr.connected ? " is-ok" : ""}`}>
                  <i></i>{BOT.suitePr}
                </span>
              ) : null}
            </div>
            <a className="bot-autonomy-link" href="#/settings/ai" title={BOT.autonomyTitle}>
              <Icon icon={Settings} size="xs" />
              <span>{BOT.autonomy[autonomy]}</span>
            </a>
          </div>
        </header>

        {context && !context.aiEnabled && isEmpty ? (
          <div className="bot-stage-banner">
            <div className="bot-ai-off" role="status">
              <span className="kp">{BOT.aiOffHint}</span>
              <Button size="sm" variant="secondary" href="#/settings/ai">{BOT.aiSettings}</Button>
            </div>
          </div>
        ) : null}

        {error ? (
          <div className="bot-stage-banner">
            <Notice tone="error" role="alert" title={BOT.errorTitle}>
              {error}
            </Notice>
          </div>
        ) : null}

        <div ref={threadRef} className="bot-stage-body" role="log" aria-live="polite">
          {isEmpty ? (
            <div className="bot-welcome">
              <BellBotMascot mode={mascotMode} />
              <h2 className="bot-welcome-title kp">{BOT.welcomeTitle}</h2>
              <p className="bot-welcome-sub kp">{BOT.welcomeSub}</p>

              <div className="bot-welcome-starters" role="group" aria-label={BOT.startersLabel}>
                {BOT.starters.map((prompt, index) => {
                  const meta = STARTER_META[index % STARTER_META.length]!;
                  return (
                    <button
                      key={prompt}
                      type="button"
                      className="bot-starter-card"
                      onClick={() => onSubmit(prompt)}
                    >
                      <span className={`bot-starter-ico ${meta.tone}`} aria-hidden="true">
                        <Icon icon={meta.icon} size="xs" />
                      </span>
                      <span className="bot-starter-text kp">{prompt}</span>
                      <Icon icon={ArrowUpRight} size="xs" className="bot-starter-arrow" />
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="bot-stage-stream">
              {messages.map((msg) => (
                <div key={msg.id} className={`bot-msg is-${msg.role}`}>
                  {msg.role === "assistant" ? <BotMiniVisor /> : null}
                  <div className="bot-msg-body">
                    <FormattedBotText text={msg.text} />
                    {msg.operations?.length ? (
                      <div className="bot-ops">
                        {msg.operations.map((op) => (
                          <OperationItem
                            key={op.id}
                            op={op}
                            busy={busyOpId === op.id}
                            onApprove={onApproveOp}
                            onDismiss={onDismissOp}
                            onUndo={onUndoOp}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}

              {sending ? (
                <div className="bot-msg is-assistant is-thinking" role="status">
                  <BotMiniVisor spinning />
                  <span className="bot-thinking-text">{progressMessage || BOT.thinkingDefault}</span>
                </div>
              ) : null}

              {!sending && lastAssistant?.followUps?.length ? (
                <div className="bot-followups" role="group" aria-label={BOT.followUpsLabel}>
                  {lastAssistant.followUps.map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="bot-chip"
                      onClick={() => onSubmit(prompt)}
                    >
                      <span>{prompt}</span>
                      <Icon icon={ArrowUpRight} size="xs" className="bot-chip-arrow" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="bot-stage-dock">
          <form className="bot-stage-form" onSubmit={handleFormSubmit}>
            <label className="bot-field bot-stage-field" htmlFor={inputId}>
              <textarea
                ref={textareaRef}
                id={inputId}
                rows={1}
                value={draft}
                placeholder={BOT.placeholder}
                aria-label={BOT.inputLabel}
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={handleKeyDown}
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                icon={CornerDownLeft}
                disabled={sending || !draft.trim()}
                aria-busy={sending || undefined}
              >
                {sending ? BOT.sending : BOT.send}
              </Button>
            </label>
            <div className="bot-stage-foot">
              <span>{BOT.hint}</span>
              <div className="bot-quick-links">
                {onQuickCapture ? (
                  <>
                    <button type="button" className="bot-util-link" onClick={onQuickCapture}>
                      {BOT.quickCapture}
                    </button>
                    <span className="bot-foot-sep" aria-hidden="true">·</span>
                  </>
                ) : null}
                <TextLink href="#/ideas">{CAPTURE.ideasLink}</TextLink>
              </div>
            </div>
          </form>
        </div>
      </section>
    </div>
  );
}

export default function BotPage(_props: { route: RouteOf<"bot"> }) {
  const bot = useBot();
  const shell = useShell();
  return (
    <BotWorkspaceView
      session={bot.session}
      sessions={bot.sessions}
      context={bot.context}
      draft={bot.draft}
      sending={bot.sending}
      progressMessage={bot.progressMessage}
      busyOpId={bot.busyOpId}
      error={bot.error}
      onDraftChange={bot.setDraft}
      onSubmit={(text) => void bot.submit(text)}
      onReset={() => void bot.reset()}
      onSelectSession={(id) => void bot.selectSession(id)}
      onPatchSession={(id, patch) => void bot.patchSession(id, patch)}
      onDeleteSession={(id) => void bot.deleteSession(id)}
      onApproveOp={(op) => void bot.approveOp(op)}
      onDismissOp={(op) => void bot.dismissOp(op)}
      onUndoOp={(op) => void bot.undoOp(op)}
      onQuickCapture={() => shell.openPalette("capture")}
    />
  );
}
