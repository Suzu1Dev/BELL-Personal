import { Maximize2 } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Button } from "../components/Button";
import {
  ArrowUpRight,
  CornerDownLeft,
  Icon,
  Plus,
  X,
} from "../components/Icon";
import { Notice } from "../components/Notice";
import { BOT } from "../copy/today";
import { useBot } from "../lib/bot-store";
import { cx } from "../lib/cx";
import { navigate } from "../lib/router";
import { useShortcuts } from "../lib/shortcuts";
import {
  BotMiniVisor,
  FormattedBotText,
  OperationItem,
  STARTER_META,
} from "../pages/today/PersonalBotCard";
import "../pages/today/PersonalBotCard.css";
import "./BotFloatingDock.css";

function OrbBellbotIcon({ thinking }: { thinking: boolean }) {
  return (
    <span className={cx("bot-orb-face", thinking && "is-thinking")} aria-hidden="true">
      <svg viewBox="0 0 36 36" width="28" height="28" fill="none">
        <path d="M15.2 5.4C15.2 3.3 20.8 3.3 20.8 5.4L21.7 6.6H14.3L15.2 5.4Z" className="bot-orb-accent" />
        <rect x="4" y="14.5" width="3.4" height="7" rx="1.7" className="bot-orb-accent" />
        <rect x="28.6" y="14.5" width="3.4" height="7" rx="1.7" className="bot-orb-accent" />
        <rect x="6.5" y="7.5" width="23" height="20.5" rx="7.5" className="bot-orb-shell" />
        <rect x="9.5" y="11" width="17" height="12" rx="4.5" fill="#171615" />
        {thinking ? (
          <g fill="#EC9B6C">
            <circle cx="14" cy="17" r="1.35" />
            <circle cx="18" cy="17" r="1.35" />
            <circle cx="22" cy="17" r="1.35" />
          </g>
        ) : (
          <>
            <rect x="13" y="14.4" width="2.5" height="4.1" rx="1.25" fill="#FBF3EA" />
            <rect x="20.5" y="14.4" width="2.5" height="4.1" rx="1.25" fill="#FBF3EA" />
            <path d="M16.4 20.1Q18 21.3 19.6 20.1" stroke="#EC9B6C" strokeWidth="1.2" strokeLinecap="round" />
          </>
        )}
      </svg>
    </span>
  );
}

export function BotFloatingDock({ inert = false }: { inert?: boolean }) {
  const bot = useBot();
  const inputId = useId();
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const open = bot.dockOpen;
  const messages = bot.session?.messages ?? [];
  const hasMessages = messages.length > 0;
  const pendingApproval = messages.some((m) => m.operations?.some((op) => op.status === "pending_approval"));

  useShortcuts(
    {
      escape: () => {
        bot.setDockOpen(false);
        return true;
      },
    },
    open && !inert,
  );

  useEffect(() => {
    if (!open) return;
    const id = window.setTimeout(() => textareaRef.current?.focus(), 40);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    const el = threadRef.current;
    if (open && el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [open, messages.length, bot.sending]);

  const handleOpenFull = () => {
    bot.setDockOpen(false);
    navigate("#/bot");
  };

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (bot.sending || !bot.draft.trim()) return;
    void bot.submit();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!bot.sending && bot.draft.trim()) void bot.submit();
    }
  };

  return (
    <div className={cx("bot-dock-root", open && "is-open")} inert={inert || undefined}>
      {open ? (
        <section className="bot-dock-panel" role="dialog" aria-label={BOT.title}>
          <header className="bot-dock-head">
            <div className="bot-dock-brand">
              <BotMiniVisor spinning={bot.sending} />
              <strong>{BOT.title}</strong>
            </div>

            <div className="bot-dock-head-acts">
              {hasMessages ? (
                <button
                  type="button"
                  className="bot-dock-icon-btn"
                  title={BOT.newChat}
                  aria-label={BOT.newChat}
                  disabled={bot.sending}
                  onClick={() => void bot.reset()}
                >
                  <Icon icon={Plus} size="sm" />
                </button>
              ) : null}
              <button
                type="button"
                className="bot-dock-expand-btn"
                onClick={handleOpenFull}
              >
                <Icon icon={Maximize2} size="xs" />
                <span>{BOT.openFullWorkspace}</span>
              </button>
              <button
                type="button"
                className="bot-dock-icon-btn"
                title={BOT.floatingClose}
                aria-label={BOT.floatingClose}
                onClick={() => bot.setDockOpen(false)}
              >
                <Icon icon={X} size="sm" />
              </button>
            </div>
          </header>

          {bot.error ? (
            <div className="bot-dock-alert">
              <Notice tone="error" role="alert" title={BOT.errorTitle}>
                {bot.error}
              </Notice>
            </div>
          ) : null}

          <div ref={threadRef} className="bot-dock-body">
            {!hasMessages && !bot.sending ? (
              <div className="bot-dock-empty">
                <p className="bot-dock-lead kp">{BOT.subtitle}</p>
                <div className="bot-dock-starters">
                  {BOT.starters.map((prompt, index) => {
                    const meta = STARTER_META[index % STARTER_META.length]!;
                    return (
                      <button
                        key={prompt}
                        type="button"
                        className="bot-starter-card"
                        onClick={() => void bot.submit(prompt)}
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
              <div className="bot-dock-stream">
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
                              busy={bot.busyOpId === op.id}
                              onApprove={(target) => void bot.approveOp(target)}
                              onDismiss={(target) => void bot.dismissOp(target)}
                              onUndo={(target) => void bot.undoOp(target)}
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}

                {bot.sending ? (
                  <div className="bot-msg is-assistant is-thinking" role="status">
                    <BotMiniVisor spinning />
                    <span className="bot-thinking-text">{bot.progressMessage || BOT.thinkingDefault}</span>
                  </div>
                ) : null}
              </div>
            )}
          </div>

          <form className="bot-dock-form" onSubmit={handleSubmit}>
            <label className="bot-field bot-dock-field" htmlFor={inputId}>
              <textarea
                ref={textareaRef}
                id={inputId}
                rows={1}
                value={bot.draft}
                placeholder="直接交辦任務，或展開完整對話…"
                aria-label={BOT.inputLabel}
                onChange={(event) => bot.setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
              />
              <Button
                type="submit"
                size="sm"
                variant="primary"
                icon={CornerDownLeft}
                disabled={bot.sending || !bot.draft.trim()}
                aria-busy={bot.sending || undefined}
              >
                {BOT.send}
              </Button>
            </label>
          </form>
        </section>
      ) : null}

      <button
        type="button"
        className={cx("bot-orb-btn", open && "is-active", (bot.sending || pendingApproval) && "has-badge")}
        aria-label={open ? BOT.floatingClose : BOT.floatingAria}
        aria-expanded={open}
        onClick={() => bot.setDockOpen((prev) => !prev)}
      >
        <OrbBellbotIcon thinking={bot.sending} />
        <span className="bot-orb-label">{BOT.floatingLabel}</span>
        {bot.sending || pendingApproval ? <i className="bot-orb-dot" aria-hidden="true" /> : null}
      </button>
    </div>
  );
}
