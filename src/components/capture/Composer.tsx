/**
 * Composer (brief §B6, SPEC-ux §3.3 「靈感」): tabs 靈感 · 待辦 · 筆記, an
 * autosizing textarea, and a footer with 「已自動儲存」 and the primary
 * button. Each tab keeps its own draft in localStorage
 * (`bell-personal.composer.<tab>`). 靈感 and 筆記 create ideas (#tags become
 * tags; a note's first line is its title); 待辦 runs the capture pipeline
 * with the live parse row. ⌘↵ / Ctrl↵ saves; Tab cycles the 待辦 type.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { IDEA_LIMITS, type Idea } from "../../../shared/ideas";
import { ApiError, api, send } from "../../api";
import { CAPTURE } from "../../copy/capture";
import { ERRORS } from "../../copy/common";
import { COMPOSER, IDEAS, type ComposerTab } from "../../copy/ideas";
import { cx } from "../../lib/cx";
import { hasModKey, isApplePlatform, isComposing, modKeyLabel } from "../../lib/keys";
import { readStorage, writeStorage } from "../../lib/storage";
import { Button } from "../Button";
import { NotebookPen } from "lucide-react";
import { CalendarPlus, Check, Icon, Lightbulb, ListPlus } from "../Icon";
import { Tabs, type TabInteraction } from "../Tabs";
import { useToast } from "../toast/ToastProvider";
import { captureApi, notifyCaptured } from "./client";
import { ideaFromText, noteFromText } from "./ideaText";
import { whenLabel } from "./describe";
import { ParseRow } from "./ParseRow";
import { useCaptureCommit, useCaptureEnv, useCaptureState } from "./useCapture";
import "./Composer.css";

export const COMPOSER_TABS: readonly ComposerTab[] = ["idea", "todo", "note"];
export const composerDraftKey = (tab: ComposerTab) => `bell-personal.composer.${tab}`;
const TAB_KEY = "bell-personal.composer.tab";
const MAX_HEIGHT = 320;

export function changeComposerTab(
  tab: ComposerTab,
  interaction: TabInteraction,
  setTab: (tab: ComposerTab) => void,
  focusInput: () => void,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
) {
  setTab(tab);
  if (interaction === "pointer") schedule(focusInput);
}

function readDrafts(): Record<ComposerTab, string> {
  return { idea: readStorage(composerDraftKey("idea")) ?? "", todo: readStorage(composerDraftKey("todo")) ?? "", note: readStorage(composerDraftKey("note")) ?? "" };
}

export function Composer({ onSaved }: { onSaved?: (idea?: Idea) => void }) {
  const env = useCaptureEnv();
  const toast = useToast();
  const panelId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<ComposerTab>(() => {
    const saved = readStorage(TAB_KEY);
    return saved === "todo" || saved === "note" ? saved : "idea";
  });
  const [drafts, setDrafts] = useState(readDrafts);
  const [saving, setSaving] = useState(false);
  const text = drafts[tab];
  const capture = useCaptureState(tab === "todo" ? text : "", "todo", env.timeZone);
  const commit = useCaptureCommit(env.timeZone);

  // Drafts are saved as they are typed; 「已自動儲存」 says so.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const key of COMPOSER_TABS) writeStorage(composerDraftKey(key), drafts[key] || null);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [drafts]);
  useEffect(() => { writeStorage(TAB_KEY, tab === "idea" ? null : tab); }, [tab]);

  useLayoutEffect(() => {
    const area = textareaRef.current;
    if (!area) return;
    area.style.height = "auto";
    area.style.height = `${Math.min(MAX_HEIGHT, area.scrollHeight)}px`;
  }, [text, tab]);

  const setText = (value: string) => setDrafts((current) => ({ ...current, [tab]: value }));
  const clear = (which: ComposerTab) => {
    setDrafts((current) => ({ ...current, [which]: "" }));
    writeStorage(composerDraftKey(which), null);
  };

  const saveIdea = async (which: ComposerTab, value: string) => {
    const now = new Date();
    const body = which === "note" ? noteFromText(value, now, env.timeZone) : ideaFromText(value, now, env.timeZone);
    setSaving(true);
    try {
      const idea = await api<Idea>("/ideas", send("POST", body));
      clear(which);
      onSaved?.(idea);
      notifyCaptured();
      toast.undo(which === "note" ? IDEAS.toasts.noteSaved : IDEAS.toasts.saved, () => {
        captureApi.undo(`/api/ideas/${idea.id}`).then(() => { onSaved?.(); notifyCaptured(); })
          .catch((cause: unknown) => toast.error(ERRORS.undoFailed(cause instanceof Error ? cause.message : "")));
      }, { icon: which === "note" ? NotebookPen : Lightbulb });
    } catch (cause) {
      const reason = cause instanceof ApiError ? cause.message : ERRORS.offline;
      toast.error(ERRORS.actionFailed(IDEAS.toasts.saveFailed, reason), () => { void saveIdea(which, value); });
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    const value = text.trim();
    if (!value || saving) return;
    if (tab === "todo") {
      const parse = capture.parse;
      clear("todo");
      void commit(value, parse, { onFailed: () => setDrafts((current) => ({ ...current, todo: current.todo || value })) }).catch(() => {});
      return;
    }
    void saveIdea(tab, value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Enter" && hasModKey(event, isApplePlatform())) {
      event.preventDefault();
      submit();
      return;
    }
    if (tab === "todo" && event.key === "Enter" && !event.shiftKey) {
      // A todo is one line: Enter saves it, like the other capture fields.
      event.preventDefault();
      submit();
      return;
    }
    if (tab === "todo" && event.key === "Tab" && !event.shiftKey && text.trim()) {
      event.preventDefault();
      capture.cycleType();
    }
  };

  const typed = text.trim().length > 0;
  // In 待辦 the parse may read an event or an idea (Tab or the type control): the button says what ↵ creates.
  const todoType = typed ? capture.parse.type : "todo";
  const submitLabel = tab === "todo" && todoType !== "todo" ? COMPOSER.enterType[todoType] : COMPOSER.submit[tab];
  const submitIcon = tab === "note" ? NotebookPen : tab === "idea" || todoType === "idea" ? Lightbulb : todoType === "event" ? CalendarPlus : ListPlus;
  const limit = tab === "todo" ? 500 : IDEA_LIMITS.text;
  return (
    <section className="card composer" aria-label={COMPOSER.label}>
      <Tabs
        label={COMPOSER.tabsLabel}
        items={COMPOSER_TABS.map((value) => ({ value, label: COMPOSER.tabs[value], controls: panelId }))}
        value={tab}
        onChange={(value, interaction) => changeComposerTab(value, interaction, setTab, () => textareaRef.current?.focus())}
        className="composer-tabs"
      />
      <div id={panelId} role="tabpanel" className="composer-body">
        <textarea
          ref={textareaRef}
          className="composer-input"
          aria-label={COMPOSER.tabs[tab]}
          placeholder={COMPOSER.placeholders[tab]}
          rows={tab === "todo" ? 1 : 3}
          maxLength={limit}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          enterKeyHint={tab === "todo" ? "done" : "enter"}
        />
        {tab === "todo" && typed ? (
          <div className="composer-parse">
            <span className="composer-preview">{CAPTURE.preview(capture.parse.type, whenLabel(capture.parse, env.timeZone, new Date()))}</span>
            <ParseRow parse={capture.parse} timeZone={env.timeZone} onType={capture.setType} onMoment={capture.setMoment} hideHint />
          </div>
        ) : null}
      </div>
      <div className="composer-foot">
        <span className={cx("composer-saved", !typed && "is-idle")} aria-live="polite">
          {typed ? <><Icon icon={Check} size="xs" />{COMPOSER.saved}</> : null}
        </span>
        <span className="composer-keys d-only" aria-hidden="true"><kbd>{modKeyLabel()}↵</kbd>{COMPOSER.submitHint}</span>
        <Button variant="primary" size="sm" icon={submitIcon} disabled={!typed || saving} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </section>
  );
}
