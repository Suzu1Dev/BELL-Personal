/**
 * The one-line capture field (SPEC-ux §4.6): `label.cap-field` (Lightbulb,
 * input, kbd N) + `p.cap-hint` with the live parse preview
 * 「→ 待辦 · 明天 10/13（二）09:00 · Tab 換類型」. Used by Today's capture
 * card (which wraps it in `.card.capture` and adds `.recent`) and anywhere a
 * single-line capture fits. Same pipeline as the palette (useCaptureState):
 * ↵ commits optimistically with an undo toast, Tab cycles the type,
 * ⌘↵ / Ctrl↵ hands the text to the palette where AI 解析 lives (as the
 * palette's draft, so closing the palette keeps it; with AI off ⌘↵ is ↵).
 * A failed save puts the text back (it is also kept in localStorage).
 *
 *   <CaptureField hintAside={<TextLink href="#/ideas">靈感</TextLink>} onCommit={(parse) => …} />
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { CaptureContext, CaptureParse } from "../../../shared/capture-parse";
import type { CaptureResponse } from "../../../shared/connect";
import { useShell } from "../../app/shell-context";
import { CAPTURE } from "../../copy/capture";
import { cx } from "../../lib/cx";
import { hasModKey, isApplePlatform, isComposing } from "../../lib/keys";
import { useSingleKeyShortcuts } from "../../lib/preferences";
import { visibleKeyHint } from "../../lib/shortcuts";
import { STORAGE_KEYS, readStorage, writeStorage } from "../../lib/storage";
import { Icon, Lightbulb, Sparkles } from "../Icon";
import { whenLabel } from "./describe";
import { useCaptureCommit, useCaptureEnv, useCaptureState } from "./useCapture";
import "./CaptureField.css";

/** The field's unsent text (kept across reloads and after a failed save). */
export const CAPTURE_FIELD_DRAFT_KEY = "bell-personal.capture.field";

/** What ⌘↵ / Ctrl↵ does in the field: open the palette for AI 解析, or, with AI off (nothing more to offer there), save like ↵. */
export function modEnterIntent(aiParse: boolean): "palette" | "submit" {
  return aiParse ? "palette" : "submit";
}

/**
 * Hands the field's text to the palette. It goes in as the palette's draft
 * too: the palette only saves a draft when the user types, and Esc there
 * would otherwise lose text that was already cleared from the field.
 */
export function handToPalette(text: string, openPalette: (mode: "capture", text: string) => void): void {
  const draft = text.trim();
  if (draft) writeStorage(STORAGE_KEYS.composerDraft, draft);
  openPalette("capture", text);
}

export interface CaptureFieldProps {
  /** "idea" (default): text without a date becomes an idea. "todo": it becomes a todo. */
  context?: CaptureContext;
  placeholder?: string;
  /** Right end of the hint line, e.g. the 「靈感 →」 link. */
  hintAside?: ReactNode;
  /** Right after ↵, before the server answers (e.g. prepend an idea to `.recent`). */
  onCommit?: (parse: CaptureParse) => void;
  onCreated?: (response: CaptureResponse, parse: CaptureParse) => void;
  /** The kbd hint at the right of the field; null hides it. */
  kbd?: string | null;
  /** localStorage key for the draft; null keeps no draft. */
  draftKey?: string | null;
  autoFocus?: boolean;
  className?: string;
}

export function CaptureField({
  context = "idea", placeholder = CAPTURE.placeholder, hintAside, onCommit, onCreated, kbd = "N",
  draftKey = CAPTURE_FIELD_DRAFT_KEY, autoFocus, className,
}: CaptureFieldProps) {
  const env = useCaptureEnv();
  const shell = useShell();
  const hintId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => (draftKey ? readStorage(draftKey) ?? "" : ""));
  const state = useCaptureState(text, context, env.timeZone);
  const commit = useCaptureCommit(env.timeZone);
  const keyHint = visibleKeyHint(kbd ?? undefined, useSingleKeyShortcuts());

  useEffect(() => {
    if (draftKey) writeStorage(draftKey, text || null);
  }, [draftKey, text]);

  const submit = () => {
    const value = text.trim();
    if (!value) return;
    const parse = state.parse;
    setText("");
    onCommit?.(parse);
    void commit(value, parse, {
      onCreated: (response) => onCreated?.(response, parse),
      // Put the text back unless the user already typed something new.
      onFailed: () => setText((current) => current || value),
    }).catch(() => {});
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Enter" && hasModKey(event, isApplePlatform())) {
      event.preventDefault();
      if (modEnterIntent(env.aiParse) === "submit") {
        submit();
        return;
      }
      // AI 解析 lives in the palette: hand the text over.
      const value = text;
      setText("");
      handToPalette(value, shell.openPalette);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === "Tab" && !event.shiftKey && text.trim()) {
      event.preventDefault();
      state.cycleType();
      return;
    }
    if (event.key === "Escape") inputRef.current?.blur();
  };

  const typing = text.trim().length > 0;
  const preview = typing ? CAPTURE.preview(state.parse.type, whenLabel(state.parse, env.timeZone, new Date())) : CAPTURE.hintIdle;

  return (
    <div className={cx("capture-field", className)}>
      <label className="cap-field">
        <Icon icon={Lightbulb} />
        <span className="sr-only">{CAPTURE.label}</span>
        <input
          ref={inputRef}
          type="text"
          placeholder={placeholder}
          autoComplete="off"
          enterKeyHint="done"
          aria-describedby={hintId}
          autoFocus={autoFocus}
          maxLength={500}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {keyHint ? <kbd>{keyHint}</kbd> : null}
      </label>
      <p className="cap-hint">
        <Icon icon={Sparkles} size="xs" />
        <span id={hintId} className="cap-hint-text" aria-live="polite">{preview}</span>
        {hintAside}
      </p>
    </div>
  );
}
