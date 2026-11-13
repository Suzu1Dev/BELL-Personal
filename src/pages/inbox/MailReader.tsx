/**
 * The reading pane (`.mail-reader`, SPEC-ux §3.3, SPEC-mail-html §5): sender
 * and subject, the AI summary (`.q-sum`), the action row (`.q-actions`, the
 * same buttons and keys as the Today row, plus 在 Gmail 開啟), the
 * 原始版面 / 純文字 switch, the conversation (each message in its original
 * layout inside a sandboxed frame, or as plain text) and the suggestions
 * found in it as `.q-row.is-ai` rows.
 */
import { useCallback, useState, type RefObject } from "react";
import type { InboxMessage, InboxSuggestion, InboxThread, InboxThreadResponse, MailAddress, MailBodyResponse, MailBodyView } from "../../../shared/mail";
import type { QueueAction } from "../../../shared/today";
import { Button } from "../../components/Button";
import { Icon, Sparkles } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { Skeleton, SkeletonStatus } from "../../components/Skeleton";
import { Tile } from "../../components/Tile";
import { ERRORS } from "../../copy/common";
import { SegmentedControl } from "../../components/SegmentedControl";
import { GMAIL_OFFLINE, INBOX, INBOX_NOTICES, MAIL_BODY, MAIL_PROCESS } from "../../copy/inbox";
import { routeHref } from "../../lib/router";
import { ExplainThis } from "../../suite/ExplainThis";
import { clockTime } from "../../lib/today-model";
import { cx } from "../../lib/cx";
import { stateText } from "./InboxList";
import { GMAIL_WRITES, mailExplainText, offlineMessage } from "./inbox-model";
import { ACTION_ICONS, ActionButton, keyLabel, ThreadMark, When } from "./parts";
import { SnoozePopover } from "../today/SnoozePopover";
import { MailBody } from "./MailBody";

export interface MailReaderProps {
  thread: InboxThread | undefined;
  detail: InboxThreadResponse | undefined;
  state: "loading" | "ready" | "stale" | "error";
  error?: string;
  missing?: boolean;
  onRetry: () => void;
  onRun: (thread: InboxThread, action: QueueAction) => void;
  /** Gmail is not connected: 封存 · 標為已讀 · 刪除 · 移回收件匣 are dimmed and a line under them says why, with 前往設定. */
  offline?: boolean;
  onSuggestion: (suggestion: InboxSuggestion, action: QueueAction) => void;
  /** Suggestion rows already acted on (hidden until the server agrees). */
  hiddenSuggestions: ReadonlySet<string>;
  /** The shared `.snooze-pop` (Today's): `sheet` makes it the phone bottom sheet. */
  snooze: { open: boolean; now: Date; limit?: string; sheet: boolean; onPick: (until: string, label: string) => void; onClose: () => void };
  snoozeButtonRef: RefObject<HTMLButtonElement | null>;
  touch: boolean;
  timeZone: string;
  /** 原始版面 / 純文字 (remembered: AppSettings `mail.bodyView`). */
  bodyView: MailBodyView;
  onBodyView: (view: MailBodyView) => void;
  /** How many times the owner asked to see each message's remote images (this session). */
  imagesAsked: ReadonlyMap<string, number>;
  onShowImages: (messageId: string) => void;
  onTrust: (sender: MailAddress, messageId: string) => void;
  /**
   * 用 AI 處理 on this conversation: the model proposes what to add to the
   * calendar, the todos or the assignments (listed under 從這封信找到).
   * Undefined where it cannot run (AI off, live or trashed mail).
   */
  processMail?: { running: boolean; progress: string; onStart: () => void };
}

interface BodyOptions {
  view: MailBodyView;
  imagesAsked: ReadonlyMap<string, number>;
  onShowImages: (messageId: string) => void;
  onTrust: (sender: MailAddress, messageId: string) => void;
  onKind: (messageId: string, kind: MailBodyResponse["kind"]) => void;
  touch: boolean;
}

/**
 * Whether 原始版面 shows (or may still show) a frame: some message answered
 * with its layout, or the newest one has not answered yet. A conversation
 * whose answers are all plain text keeps the plain-text note.
 */
export function framed(messages: InboxMessage[], kinds: ReadonlyMap<string, MailBodyResponse["kind"]>): boolean {
  if (messages.some((message) => kinds.get(message.id) === "html")) return true;
  const latest = messages.at(-1);
  return !latest || kinds.get(latest.id) === undefined;
}

function dateLabel(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("zh-TW", { timeZone, month: "numeric", day: "numeric", weekday: "short" }).format(new Date(iso));
  return `${parts} ${clockTime(iso, timeZone)}`;
}

function Message({ message, timeZone, latest, body }: { message: InboxMessage; timeZone: string; latest: boolean; body: BodyOptions }) {
  // An older message's layout is read only once it is opened.
  const [open, setOpen] = useState(false);
  const sender = message.mine ? INBOX.mine : message.from.name ?? message.from.email;
  const head = (
    <>
      <b>{sender}</b>
      {message.from.name && !message.mine ? <span className="mr-addr">{message.from.email}</span> : null}
      <span className="mono">{dateLabel(message.receivedAt, timeZone)}</span>
    </>
  );
  const content = (
    <MailBody
      message={message}
      view={body.view}
      imagesAsked={body.imagesAsked.get(message.id) ?? 0}
      onShowImages={body.onShowImages}
      onTrust={body.onTrust}
      keyHint={latest && !body.touch}
      onKind={body.onKind}
    />
  );
  if (!latest) {
    return (
      <details className="mr-msg" onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary><span className="mr-msg-head">{head}</span><span className="mr-snip">{message.snippet}</span></summary>
        {open ? content : null}
      </details>
    );
  }
  return (
    <article className="mr-msg is-latest">
      <p className="mr-msg-head">{head}</p>
      {content}
      {!message.excerpt && body.view === "plain" ? <p className="mr-note">{INBOX.noText}</p> : null}
    </article>
  );
}

export function MailReader({
  thread, detail, state, error, missing, onRetry, onRun, offline, onSuggestion, hiddenSuggestions, snooze, snoozeButtonRef, touch, timeZone,
  bodyView, onBodyView, imagesAsked, onShowImages, onTrust, processMail,
}: MailReaderProps) {
  // What each message's body answered: the sandbox note only speaks of a frame when one is there.
  const [kinds, setKinds] = useState<ReadonlyMap<string, MailBodyResponse["kind"]>>(new Map());
  const onKind = useCallback((messageId: string, kind: MailBodyResponse["kind"]) => {
    setKinds((current) => (current.get(messageId) === kind ? current : new Map(current).set(messageId, kind)));
  }, []);
  const shown = detail?.thread ?? thread;
  if (!shown) {
    if (state === "error") {
      return (
        <section className="card mail-reader" id="mail-reader" aria-label={INBOX.readerLabel}>
          <Notice tone="error" title={INBOX_NOTICES.readerFailedTitle} actions={<Button size="sm" onClick={onRetry}>{ERRORS.retry}</Button>}>
            {missing ? error ?? INBOX_NOTICES.missing : error}
          </Notice>
        </section>
      );
    }
    return (
      <section className="card mail-reader" id="mail-reader" aria-label={INBOX.readerLabel} aria-busy="true">
        <SkeletonStatus>{INBOX.loading}</SkeletonStatus>
        <Skeleton width="70%" height={22} />
        <Skeleton width="45%" />
        <Skeleton width="96%" />
        <Skeleton width="88%" />
      </section>
    );
  }
  const note = [shown.trashed ? INBOX.trashed : shown.location === "archive" ? INBOX.archived : undefined, stateText(shown)].filter(Boolean).join(" · ");
  const messages = detail?.messages ?? [];
  const suggestions = (detail?.suggestions ?? []).filter((suggestion) => !hiddenSuggestions.has(suggestion.itemId));
  // While the suggestion's 加入作業 A is on screen, A means that one: 轉成作業 would make the same assignment.
  const suggested = suggestions.some((suggestion) => suggestion.kind === "suggestion.assignment");
  const actions = suggested ? shown.actions.filter((action) => action.id !== "assignment") : shown.actions;
  const blocked = offline ? offlineMessage(actions.map((action) => action.id)) : undefined;
  return (
    <section className="card mail-reader" id="mail-reader" aria-labelledby="mail-reader-subject">
      <header className="mr-head">
        <ThreadMark thread={shown} />
        <div className="mr-titles">
          <h2 className="mr-subject kp" id="mail-reader-subject">{shown.subject}</h2>
          <p className="mr-from">
            <b>{shown.from.name ?? shown.from.email}</b>
            {shown.from.name ? <span className="mr-addr">{shown.from.email}</span> : null}
          </p>
        </div>
        <When when={shown.when} />
      </header>
      {shown.summary && shown.summarySource === "ai" ? (
        <p className="q-sum"><Icon icon={Sparkles} size="sm" /><span className="kp">{shown.summary}</span></p>
      ) : null}
      {note ? <p className={cx("mr-state", shown.state?.kind === "replying" && "is-replying")}>{note}</p> : null}
      <div className="q-actions">
        {actions.map((action, index) => (
          <span key={action.id} className={cx("qa-slot", action.id === "snooze" && "has-pop")}>
            <ActionButton
              action={action}
              index={index}
              touch={touch}
              onRun={(chosen) => onRun(shown, chosen)}
              expanded={action.id === "snooze" ? snooze.open : undefined}
              blockedBy={blocked && GMAIL_WRITES.has(action.id) ? "mr-offline" : undefined}
              buttonRef={action.id === "snooze" ? (element) => { snoozeButtonRef.current = element; } : undefined}
            />
            {action.id === "snooze" && snooze.open ? (
              <SnoozePopover
                snoozeLimit={snooze.limit}
                now={snooze.now.toISOString()}
                anchor={snoozeButtonRef.current}
                sheet={snooze.sheet}
                onPick={snooze.onPick}
                onClose={snooze.onClose}
              />
            ) : null}
          </span>
        ))}
        {processMail ? (
          <Button
            variant="secondary"
            size="sm"
            icon={Sparkles}
            title={MAIL_PROCESS.hint}
            aria-disabled={processMail.running || undefined}
            aria-busy={processMail.running || undefined}
            onClick={() => { if (!processMail.running) processMail.onStart(); }}
          >
            {processMail.running ? MAIL_PROCESS.working : MAIL_PROCESS.action}
          </Button>
        ) : null}
        <ExplainThis
          text={mailExplainText(shown.subject, messages, shown.summary)}
          title={shown.subject}
          back={routeHref({ name: "inbox", threadId: shown.threadId })}
        />
        <TextLink external className="ext" href={shown.webUrl}>{INBOX.openInGmail}</TextLink>
      </div>
      {blocked ? (
        <p className="mr-state is-offline" id="mr-offline">
          {blocked}{" "}
          <TextLink href={routeHref({ name: "settings", tab: "sources" })}>{GMAIL_OFFLINE.settings}</TextLink>
        </p>
      ) : null}
      {processMail?.running ? (
        <p className="mr-state is-processing">
          <span className="sr-only" role="status">{MAIL_PROCESS.progress}</span>
          <span aria-hidden="true">{processMail.progress || MAIL_PROCESS.progress}</span>
        </p>
      ) : null}
      {state === "stale" || (state === "error" && detail) ? (
        <Notice tone="warn" title={INBOX_NOTICES.readerFailedTitle} actions={<Button size="sm" onClick={onRetry}>{ERRORS.retry}</Button>}>{error}</Notice>
      ) : null}
      <div className="mr-viewbar">
        <SegmentedControl
          label={MAIL_BODY.viewLabel}
          className="mr-view"
          value={bodyView}
          onChange={onBodyView}
          options={[{ value: "original", label: MAIL_BODY.original }, { value: "plain", label: MAIL_BODY.plain }]}
        />
      </div>
      <div className="mr-body">
        {messages.length
          ? messages.map((message, index) => (
            <Message
              key={message.id}
              message={message}
              timeZone={timeZone}
              latest={index === messages.length - 1}
              body={{ view: bodyView, imagesAsked, onShowImages, onTrust, onKind, touch }}
            />
          ))
          : state === "error" && missing ? <p className="mr-note">{error ?? INBOX_NOTICES.missing}</p>
            : <div className="mr-loading" aria-busy="true"><Skeleton width="96%" /><Skeleton width="90%" /><Skeleton width="64%" /></div>}
      </div>
      {suggestions.length ? (
        <section className="mr-suggestions" aria-labelledby="mr-suggestions-title">
          <h3 id="mr-suggestions-title">{INBOX.suggestionsTitle}</h3>
          <ul className="q-list">
            {suggestions.map((suggestion) => (
              <li key={suggestion.itemId} className="q-row is-ai">
                <Tile icon={Sparkles} tone="accent" />
                <div className="q-main">
                  <p className="q-title">{suggestion.title}</p>
                  <p className="q-meta">{suggestion.meta.join(" · ")}</p>
                </div>
                <div className="q-end">
                  {suggestion.actions.map((action, index) => (
                    <Button
                      key={action.id}
                      variant={index === 0 ? "secondary" : "ghost"}
                      size="sm"
                      icon={index === 0 ? ACTION_ICONS[action.id] : undefined}
                      kbd={index === 0 && !touch ? keyLabel(action.key) : undefined}
                      onClick={() => onSuggestion(suggestion, action)}
                    >
                      {action.label}
                    </Button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {shown.live ? <p className="mr-note">{bodyView === "original" ? MAIL_BODY.liveNote : INBOX.liveNote}</p> : null}
      <p className="mr-note">{bodyView === "original" && framed(messages, kinds) ? MAIL_BODY.sandboxNote : INBOX.textOnly}</p>
    </section>
  );
}
