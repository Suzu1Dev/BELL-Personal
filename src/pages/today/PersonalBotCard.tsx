import {
  Component,
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  BotContextStatus,
  BotOperation,
  BotOperationResponse,
  BotSendResponse,
  BotSessionResponse,
  BotSessionView,
} from "../../../shared/bot";
import { api, followJob, send } from "../../api";
import { Button } from "../../components/Button";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  Icon,
  Layers,
  LoaderCircle,
  RotateCcw,
  Settings,
  Sparkles,
  Undo2,
  X,
} from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { Pill } from "../../components/Pill";
import { useToast } from "../../components/toast/ToastProvider";
import { ERRORS } from "../../copy/common";
import { BOT, CAPTURE } from "../../copy/today";
import { notifySuiteRefresh } from "../../suite/useSuite";
import "./PersonalBotCard.css";

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

export type BotTextBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; lines: string[] }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] };

/** Parse plain/markdown-lite bot text into clean semantic blocks so lists & paragraphs scan effortlessly. */
export function parseBotBlocks(raw: string): BotTextBlock[] {
  const blocks: BotTextBlock[] = [];
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let listKind: "ul" | "ol" | null = null;
  let listItems: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", lines: paragraph });
      paragraph = [];
    }
  };

  const flushList = () => {
    if (listKind && listItems.length > 0) {
      blocks.push({ kind: listKind, items: listItems });
    }
    listKind = null;
    listItems = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const headingMatch = /^#{1,4}\s+(.+)$/.exec(line);
    if (headingMatch) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", text: headingMatch[1].trim() });
      continue;
    }

    const olMatch = /^\d+[.)、]\s*(.+)$/.exec(line);
    if (olMatch) {
      flushParagraph();
      if (listKind !== "ol") {
        flushList();
        listKind = "ol";
      }
      listItems.push(olMatch[1].trim());
      continue;
    }

    const ulMatch = /^[-*•·]\s+(.+)$/.exec(line);
    if (ulMatch) {
      flushParagraph();
      if (listKind !== "ul") {
        flushList();
        listKind = "ul";
      }
      listItems.push(ulMatch[1].trim());
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.filter(Boolean).map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={idx}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return <code key={idx} className="bot-code">{part.slice(1, -1)}</code>;
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

export function FormattedBotText({ text }: { text: string }) {
  const blocks = parseBotBlocks(text);
  return (
    <div className="bot-msg-text">
      {blocks.map((block, idx) => {
        if (block.kind === "heading") {
          return <h4 key={idx} className="bot-h kp">{renderInline(block.text)}</h4>;
        }
        if (block.kind === "ol") {
          return (
            <ol key={idx} className="bot-list is-ordered">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ol>
          );
        }
        if (block.kind === "ul") {
          return (
            <ul key={idx} className="bot-list">
              {block.items.map((item, i) => (
                <li key={i}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={idx} className="bot-p">
            {block.lines.map((line, i) => (
              <Fragment key={i}>
                {i > 0 ? <br /> : null}
                {renderInline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

export const STARTER_META = [
  { icon: Sparkles, tone: "is-personal" },
  { icon: CalendarClock, tone: "is-schedule" },
  { icon: Layers, tone: "is-suite" },
] as const;

/** Bespoke tactile companion mascot (Bellbot): ceramic shell, terracotta ear-pods, bell chime antenna, and reactive visor eyes. */
export function BellBotMascot({ mode }: { mode: "idle" | "typing" | "thinking" }) {
  return (
    <div className={`bot-mascot-stage is-${mode}`} aria-hidden="true">
      <svg className="bot-mascot-svg" viewBox="0 0 80 80" fill="none">
        {/* Ground contact shadow */}
        <ellipse className="bot-mascot-shadow" cx="40" cy="70.5" rx="16.5" ry="2.6" />

        <g className="bot-mascot-float">
          {/* Chime signal waves (pulse on thinking or hover) */}
          <g className="bot-mascot-waves" strokeLinecap="round" strokeWidth="1.5">
            <path d="M29.5 10.8C27.4 12.4 27.4 15.6 29.5 17.2" />
            <path d="M50.5 10.8C52.6 12.4 52.6 15.6 50.5 17.2" />
          </g>

          {/* Bell chime antenna */}
          <rect x="38.8" y="14.5" width="2.4" height="5.5" rx="1.2" className="bot-mascot-stroke-fill" />
          <path
            d="M35.2 14.2C35.2 10.5 44.8 10.5 44.8 14.2L46.3 16.1H33.7L35.2 14.2Z"
            className="bot-mascot-accent"
          />
          <circle cx="40" cy="16.8" r="1.25" className="bot-mascot-stroke-fill" />

          {/* Cozy torso / collar peek */}
          <rect x="26.5" y="55" width="27" height="11" rx="5.5" className="bot-mascot-accent" />
          <rect x="36.2" y="59.2" width="7.6" height="2.4" rx="1.2" className="bot-mascot-badge" />

          {/* Tactile side ear-pods */}
          <rect x="12" y="32.5" width="6.5" height="13" rx="3.25" className="bot-mascot-accent" />
          <rect x="61.5" y="32.5" width="6.5" height="13" rx="3.25" className="bot-mascot-accent" />

          {/* Sculpted ceramic head */}
          <rect x="17" y="18.5" width="46" height="39" rx="14" className="bot-mascot-shell" />
          <path d="M23 53.2Q40 55.6 57 53.2" className="bot-mascot-chin" strokeLinecap="round" strokeWidth="1.6" />
          <circle cx="40" cy="22.1" r="1" className="bot-mascot-sensor" />

          {/* Deep espresso visor */}
          <rect x="22.5" y="25" width="35" height="23.5" rx="8.5" className="bot-mascot-visor" />
          <rect x="25.8" y="27.6" width="6.8" height="1.8" rx="0.9" fill="#FFFFFF" fillOpacity="0.16" />

          {/* Warm cheek glow */}
          <ellipse cx="28.2" cy="42.6" rx="2.7" ry="1.3" fill="#E58550" fillOpacity="0.35" />
          <ellipse cx="51.8" cy="42.6" rx="2.7" ry="1.3" fill="#E58550" fillOpacity="0.35" />

          {/* Reactive visor expression */}
          {mode === "thinking" ? (
            <g className="bot-mascot-dots">
              <circle cx="33" cy="36.8" r="2.2" />
              <circle cx="40" cy="36.8" r="2.2" />
              <circle cx="47" cy="36.8" r="2.2" />
            </g>
          ) : (
            <g className="bot-mascot-gaze">
              <g className="bot-mascot-blink">
                <rect x="30" y="32" width="4.8" height="7.6" rx="2.4" fill="#FBF3EA" />
                <circle cx="33.1" cy="34" r="1.05" fill="#FFFFFF" />
                <rect x="45.2" y="32" width="4.8" height="7.6" rx="2.4" fill="#FBF3EA" />
                <circle cx="48.3" cy="34" r="1.05" fill="#FFFFFF" />
              </g>
              <path
                d="M37.6 42.1Q40 44.1 42.4 42.1"
                stroke="#EC9B6C"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </g>
          )}
        </g>
      </svg>
    </div>
  );
}

export function BotMiniVisor({ spinning = false }: { spinning?: boolean }) {
  if (spinning) {
    return (
      <span className="bot-msg-avatar" aria-hidden="true">
        <Icon icon={LoaderCircle} size="xs" className="spin" />
      </span>
    );
  }
  return (
    <span className="bot-msg-avatar is-mascot" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
        <rect x="2.5" y="4.5" width="19" height="15" rx="5.5" fill="#171615" stroke="rgba(255,255,255,0.14)" />
        <rect x="7" y="8.8" width="2.6" height="4.4" rx="1.3" fill="#FBF3EA" />
        <rect x="14.4" y="8.8" width="2.6" height="4.4" rx="1.3" fill="#FBF3EA" />
        <path d="M10.5 15Q12 16.2 13.5 15" stroke="#EC9B6C" strokeWidth="1.2" strokeLinecap="round" />
      </svg>
    </span>
  );
}

export interface PersonalBotViewProps {
  session: BotSessionView | undefined;
  context: BotContextStatus | undefined;
  expanded: boolean;
  draft: string;
  sending: boolean;
  progressMessage?: string;
  busyOpId?: string | null;
  error?: string | null;
  onDraftChange: (value: string) => void;
  onSubmit: (text?: string) => void;
  onToggleExpanded: () => void;
  onReset: () => void;
  onApproveOp: (op: BotOperation) => void;
  onDismissOp: (op: BotOperation) => void;
  onUndoOp: (op: BotOperation) => void;
  onQuickCapture?: () => void;
}

export function OperationItem({
  op,
  busy,
  onApprove,
  onDismiss,
  onUndo,
}: {
  op: BotOperation;
  busy: boolean;
  onApprove: (op: BotOperation) => void;
  onDismiss: (op: BotOperation) => void;
  onUndo: (op: BotOperation) => void;
}) {
  const external = op.resultHref ? /^https?:\/\//.test(op.resultHref) : false;

  if (op.status === "pending_approval") {
    return (
      <div className="bot-op-card is-pending" role="group" aria-label={op.label}>
        <div className="bot-op-card-head">
          <Pill tone="warn" dot>{BOT.approvalBadge}</Pill>
          {op.app !== "personal" ? <Pill tone="accent">{BOT.appBadge[op.app]}</Pill> : null}
          <strong className="bot-op-title">{op.label}</strong>
        </div>
        {op.detail ? <p className="bot-op-detail">{op.detail}</p> : null}
        <div className="bot-op-actions">
          <Button
            size="sm"
            variant="primary"
            icon={Check}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => onApprove(op)}
          >
            {busy ? BOT.approving : BOT.approve}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={X}
            disabled={busy}
            onClick={() => onDismiss(op)}
          >
            {BOT.dismiss}
          </Button>
        </div>
      </div>
    );
  }

  const tone = op.status === "executed"
    ? "ok"
    : op.status === "failed"
      ? "danger"
      : "neutral";

  return (
    <div className={`bot-op-row is-${op.status}`}>
      <div className="bot-op-row-main">
        <Pill tone={tone}>{BOT.status[op.status]}</Pill>
        {op.app !== "personal" ? <Pill>{BOT.appBadge[op.app]}</Pill> : null}
        <span className="bot-op-label">{op.label}</span>
        {op.error ? (
          <span className="bot-op-row-sub">{op.error}</span>
        ) : op.detail ? (
          <span className="bot-op-row-sub">{op.detail}</span>
        ) : null}
      </div>
      <div className="bot-op-row-links">
        {op.resultHref && op.status === "executed" ? (
          external ? (
            <a className="link ext" href={op.resultHref} target="_blank" rel="noopener noreferrer">
              {BOT.openResult}
              <Icon icon={ArrowUpRight} size="xs" />
            </a>
          ) : (
            <TextLink href={op.resultHref}>{BOT.openResult}</TextLink>
          )
        ) : null}
        {op.undoable && op.status === "executed" ? (
          <Button
            size="sm"
            variant="ghost"
            icon={Undo2}
            disabled={busy}
            onClick={() => onUndo(op)}
          >
            {busy ? BOT.undoing : BOT.undo}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function PersonalBotView({
  session,
  context,
  expanded,
  draft,
  sending,
  progressMessage,
  busyOpId,
  error,
  onDraftChange,
  onSubmit,
  onToggleExpanded,
  onReset,
  onApproveOp,
  onDismissOp,
  onUndoOp,
  onQuickCapture,
}: PersonalBotViewProps) {
  const titleId = useId();
  const inputId = useId();
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prevMsgCountRef = useRef<number | null>(null);
  const messages = session?.messages ?? [];
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const autonomy = context?.autonomy ?? "balanced";
  const isEmpty = messages.length === 0 && !sending;
  const hasOpenThread = expanded && (messages.length > 0 || sending);
  const mascotMode: "idle" | "typing" | "thinking" = sending
    ? "thinking"
    : draft.trim().length > 0
      ? "typing"
      : "idle";

  // Scroll thoughtfully: keep both the user prompt and assistant reply framed when they fit,
  // or align to the top of the latest assistant reply on long threads so line 1 is never sliced.
  useEffect(() => {
    const el = threadRef.current;
    if (!expanded || !el) return;
    if (sending) {
      if (el.scrollHeight > el.clientHeight + 4) {
        el.scrollTop = el.scrollHeight;
      }
      prevMsgCountRef.current = messages.length;
      return;
    }
    if (prevMsgCountRef.current !== messages.length) {
      if (el.scrollHeight <= el.clientHeight + 4) {
        el.scrollTop = 0;
      } else {
        const msgEls = el.querySelectorAll<HTMLElement>(".bot-msg");
        const lastEl = msgEls[msgEls.length - 1];
        const prevEl = msgEls.length >= 2 ? msgEls[msgEls.length - 2] : undefined;
        if (lastEl) {
          const toRelTop = (node: HTMLElement) =>
            node.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
          const prevTop = prevEl ? Math.max(0, toRelTop(prevEl) - 10) : undefined;
          const lastTop = Math.max(0, toRelTop(lastEl) - 10);
          el.scrollTop =
            prevTop !== undefined && el.scrollHeight - prevTop <= el.clientHeight + 8
              ? prevTop
              : lastTop;
        }
      }
      prevMsgCountRef.current = messages.length;
    }
  }, [expanded, messages.length, sending]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(132, Math.max(24, ta.scrollHeight))}px`;
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

  return (
    <section
      className={`card personal-bot${hasOpenThread ? " has-thread" : " is-compact"}`}
      aria-labelledby={titleId}
    >
      <BellBotMascot mode={mascotMode} />

      <div className="bot-main">
        <div className="bot-head">
          <div className="bot-title-line">
            <h2 id={titleId} className="bot-title">{BOT.title}</h2>
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
          </div>

          <div className="bot-head-actions">
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
            <a className="bot-autonomy-link" href="#/settings/ai" title={BOT.autonomyTitle}>
              <Icon icon={Settings} size="xs" />
              <span>{BOT.autonomy[autonomy]}</span>
            </a>
            {messages.length > 0 ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={expanded ? ChevronDown : ChevronRight}
                  onClick={onToggleExpanded}
                >
                  {expanded ? BOT.collapse : BOT.expand(messages.length)}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={RotateCcw}
                  disabled={sending}
                  onClick={onReset}
                >
                  {BOT.newChat}
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {context && !context.aiEnabled && messages.length === 0 ? (
          <div className="bot-ai-off" role="status">
            <span className="kp">{BOT.aiOffHint}</span>
            <Button size="sm" variant="secondary" href="#/settings/ai">{BOT.aiSettings}</Button>
          </div>
        ) : null}

        {error ? (
          <Notice tone="error" role="alert" title={BOT.errorTitle}>
            {error}
          </Notice>
        ) : null}

        {hasOpenThread ? (
          <div ref={threadRef} className="bot-thread" role="log" aria-live="polite">
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
        ) : null}

        <form className="bot-composer" onSubmit={handleFormSubmit}>
          <label className="bot-field" htmlFor={inputId}>
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
        </form>

        {isEmpty ? (
          <div className="bot-starters" role="group" aria-label={BOT.startersLabel}>
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
        ) : null}
      </div>
    </section>
  );
}

class PersonalBotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    if (!this.state.failed) return this.props.children;
    return null;
  }
}

export interface PersonalBotCardProps {
  onMutated?: () => void;
  onQuickCapture?: () => void;
}

export function PersonalBotCard(props: PersonalBotCardProps) {
  return (
    <PersonalBotBoundary>
      <LivePersonalBotCard {...props} />
    </PersonalBotBoundary>
  );
}

function LivePersonalBotCard({ onMutated, onQuickCapture }: PersonalBotCardProps) {
  const toast = useToast();
  const [session, setSession] = useState<BotSessionView | undefined>(undefined);
  const [context, setContext] = useState<BotContextStatus | undefined>(undefined);
  const [expanded, setExpanded] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [progressMessage, setProgressMessage] = useState<string | undefined>(undefined);
  const [busyOpId, setBusyOpId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobAbortRef = useRef<AbortController | null>(null);

  const syncWorld = useCallback(() => {
    onMutated?.();
    notifySuiteRefresh();
  }, [onMutated]);

  const loadSession = useCallback(async (signal?: AbortSignal) => {
    const res = await api<BotSessionResponse>("/bot/session", signal ? { signal } : undefined);
    setSession(res.session);
    setContext(res.context);
    return res;
  }, []);

  const watchJob = useCallback(async (jobId: string) => {
    jobAbortRef.current?.abort();
    const controller = new AbortController();
    jobAbortRef.current = controller;
    setSending(true);
    setProgressMessage(BOT.thinkingDefault);
    setError(null);
    try {
      const outcome = await followJob(
        jobId,
        (event) => {
          if (event.type === "stage") setProgressMessage(event.message);
        },
        controller.signal,
      );
      const latest = await loadSession(controller.signal);
      if (outcome.type === "error") {
        setError(outcome.message);
      } else {
        const result = outcome.result as { executedCount?: number } | undefined;
        if ((result?.executedCount ?? 0) > 0 || latest.session.messages.some((m) => m.operations?.some((op) => op.status === "executed"))) {
          syncWorld();
        }
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(reasonOf(cause));
    } finally {
      if (jobAbortRef.current === controller) {
        setSending(false);
        setProgressMessage(undefined);
      }
    }
  }, [loadSession, syncWorld]);

  useEffect(() => {
    const controller = new AbortController();
    loadSession(controller.signal)
      .then((res) => {
        if (res.context.runningJobId) {
          void watchJob(res.context.runningJobId);
        }
      })
      .catch(() => { /* Today's own banner handles offline state */ });
    return () => {
      controller.abort();
      jobAbortRef.current?.abort();
    };
  }, [loadSession, watchJob]);

  const handleSubmit = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? draft).trim();
    if (!text || sending) return;
    setError(null);
    setExpanded(true);
    if (!overrideText) setDraft("");
    try {
      const res = await api<BotSendResponse>("/bot/messages", send("POST", { text }));
      setSession(res.session);
      setContext(res.context);
      if (res.jobId) {
        await watchJob(res.jobId);
      }
    } catch (cause) {
      if (!overrideText) setDraft(text);
      setError(reasonOf(cause));
    }
  }, [draft, sending, watchJob]);

  const handleReset = useCallback(async () => {
    jobAbortRef.current?.abort();
    setSending(false);
    setError(null);
    try {
      const res = await api<BotSessionResponse>("/bot/reset", send("POST"));
      setSession(res.session);
      setContext(res.context);
    } catch (cause) {
      toast.error(reasonOf(cause));
    }
  }, [toast]);

  const handleApprove = useCallback(async (op: BotOperation) => {
    if (busyOpId) return;
    setBusyOpId(op.id);
    setError(null);
    try {
      const res = await api<BotOperationResponse>(`/bot/operations/${encodeURIComponent(op.id)}/approve`, send("POST"));
      setSession(res.session);
      setContext(res.context);
      toast.success(BOT.approvedToast(res.operation.label));
      syncWorld();
    } catch (cause) {
      toast.error(reasonOf(cause));
      await loadSession().catch(() => {});
    } finally {
      setBusyOpId(null);
    }
  }, [busyOpId, loadSession, syncWorld, toast]);

  const handleDismiss = useCallback(async (op: BotOperation) => {
    if (busyOpId) return;
    setBusyOpId(op.id);
    try {
      const res = await api<BotOperationResponse>(`/bot/operations/${encodeURIComponent(op.id)}/dismiss`, send("POST"));
      setSession(res.session);
      setContext(res.context);
    } catch (cause) {
      toast.error(reasonOf(cause));
    } finally {
      setBusyOpId(null);
    }
  }, [busyOpId, toast]);

  const handleUndo = useCallback(async (op: BotOperation) => {
    if (busyOpId) return;
    setBusyOpId(op.id);
    try {
      const res = await api<BotOperationResponse>(`/bot/operations/${encodeURIComponent(op.id)}/undo`, send("POST"));
      setSession(res.session);
      setContext(res.context);
      toast.success(BOT.undoneToast(op.label));
      syncWorld();
    } catch (cause) {
      toast.error(ERRORS.undoFailed(reasonOf(cause)));
    } finally {
      setBusyOpId(null);
    }
  }, [busyOpId, syncWorld, toast]);

  return (
    <PersonalBotView
      session={session}
      context={context}
      expanded={expanded}
      draft={draft}
      sending={sending}
      progressMessage={progressMessage}
      busyOpId={busyOpId}
      error={error}
      onDraftChange={setDraft}
      onSubmit={(text) => void handleSubmit(text)}
      onToggleExpanded={() => setExpanded((prev) => !prev)}
      onReset={() => void handleReset()}
      onApproveOp={(op) => void handleApprove(op)}
      onDismissOp={(op) => void handleDismiss(op)}
      onUndoOp={(op) => void handleUndo(op)}
      onQuickCapture={onQuickCapture}
    />
  );
}
