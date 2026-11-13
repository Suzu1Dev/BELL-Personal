/**
 * Command palette (SPEC-ux §6.6, §9; states.html 06): a native modal
 * <dialog class="palette"> opened by ⌘K / Ctrl K (go mode), and by N, the
 * sidebar 快速記下, the Today empty state and the quickbar ＋捕捉 (capture
 * mode). Sections: 快速新增 → AI 解析 (./quickAdd.tsx), 前往 (./goSection.tsx),
 * 搜尋 (./searchSection.tsx) and 信件 (./mailSearchSection.tsx); the parser's tokens are marked in the input
 * through a mirror layer. ↑↓ move, ↵ runs, Esc closes; nothing
 * happens while an IME is composing. In capture mode the text is kept as a
 * draft in `bell-personal.composer.draft` until an option runs.
 */
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { PALETTE_CAPTURE } from "../../copy/capture";
import { DIALOG, PALETTE } from "../../copy/common";
import { cx } from "../../lib/cx";
import { isComposing } from "../../lib/keys";
import { STORAGE_KEYS, readStorage, writeStorage } from "../../lib/storage";
import { useNativeDialog } from "../Dialog";
import { Button } from "../Button";
import { Icon, Search, X } from "../Icon";
import { Tile } from "../Tile";
import { useGoSection } from "./goSection";
import { useMailSearchSection } from "./mailSearchSection";
import { splitCapturePrefix } from "./match";
import { useQuickAddSection } from "./quickAdd";
import { useSearchSection } from "./searchSection";
import type { PaletteMark, PaletteOption, PaletteQuery, PaletteSection } from "./types";
import "./CommandPalette.css";

/** The input text with `marks` wrapped in <mark>, for the highlight layer behind the input. */
function markedText(text: string, marks: PaletteMark[]): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  for (const mark of marks) {
    if (mark.start < cursor || mark.end > text.length) continue;
    out.push(text.slice(cursor, mark.start));
    out.push(<mark key={mark.start}>{text.slice(mark.start, mark.end)}</mark>);
    cursor = mark.end;
  }
  out.push(text.slice(cursor));
  return out;
}

export interface CommandPaletteProps {
  open: boolean;
  mode: "go" | "capture";
  /** Prefilled text (e.g. 新增行程 → "明天 "). Without it, capture mode restores the draft. */
  initialText?: string;
  onClose: () => void;
}

export function CommandPalette({ open, mode: openedMode, initialText, onClose }: CommandPaletteProps) {
  const ref = useNativeDialog(open, onClose);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [mode, setMode] = useState(openedMode);
  const [text, setText] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  // While an IME composes, the input shows its own text (with the preedit underline), not the mirror.
  const [composing, setComposing] = useState(false);

  // Each opening starts fresh: the requested mode, the prefill or the saved draft.
  useEffect(() => {
    if (!open) return;
    setMode(openedMode);
    setText(initialText ?? (openedMode === "capture" ? readStorage(STORAGE_KEYS.composerDraft) ?? "" : ""));
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open, openedMode, initialText]);

  const query: PaletteQuery = useMemo(() => ({ ...splitCapturePrefix(text, mode), open }), [text, mode, open]);
  const quick = useQuickAddSection(query);
  const go = useGoSection(query);
  const search = useSearchSection(query);
  const mailSearch = useMailSearchSection(query);

  const sections = useMemo(() => {
    const quickSections = quick?.sections.filter((section) => section.options.length) ?? [];
    const goSections = go.section ? [go.section] : [];
    // 搜尋 (todos, ideas, projects), then 信件 (搜尋信件「…」) last: they never push 快速新增 or 前往 down.
    const searchSections = [...(search ? [search] : []), ...(mailSearch ? [mailSearch] : [])];
    if (query.mode === "capture" || (query.text.trim() && !go.strong)) return [...quickSections, ...goSections, ...searchSections];
    return [...goSections, ...quickSections, ...searchSections];
  }, [quick, go, search, mailSearch, query]);

  // The highlight layer: the parser's tokens marked behind the (transparent-backed) input.
  const prefixLength = text.length - query.text.length;
  const marks = useMemo(() => (quick?.marks ?? []).map((mark) => ({ start: mark.start + prefixLength, end: mark.end + prefixLength })), [quick, prefixLength]);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const syncMirror = () => {
    if (mirrorRef.current && inputRef.current) mirrorRef.current.scrollLeft = inputRef.current.scrollLeft;
  };
  useLayoutEffect(syncMirror);

  const options = useMemo(() => sections.flatMap((section) => section.options), [sections]);
  const active = options[Math.min(activeIndex, options.length - 1)] as PaletteOption | undefined;

  const changeText = (value: string) => {
    setText(value);
    setActiveIndex(0);
    if (splitCapturePrefix(value, mode).mode === "capture") writeStorage(STORAGE_KEYS.composerDraft, value.replace(/^[+＋]\s*/, "") || null);
  };

  const run = async (option: PaletteOption) => {
    try {
      const result = await option.run();
      if (result === false) return;
      if (query.mode === "capture") writeStorage(STORAGE_KEYS.composerDraft, null);
      onClose();
    } catch {
      // The option reported its own error (toast); keep the text so nothing is lost.
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (quick?.onKeyDown?.(event.nativeEvent, active)) {
      event.preventDefault();
      return;
    }
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (!options.length) return;
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (Math.min(index, options.length - 1) + step + options.length) % options.length);
        return;
      }
      case "Enter":
        event.preventDefault();
        if (active) void run(active);
        return;
      case "Tab":
        // The input is the only stop; Tab belongs to the quick-add type switch.
        event.preventDefault();
        return;
      case "Backspace":
        if (!text && mode === "capture") setMode("go");
        return;
    }
  };

  // Keep the active row in view.
  useEffect(() => {
    if (!open || !active) return;
    document.getElementById(`${listId}-${active.id}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  const capture = query.mode === "capture";
  const enterLabel = active?.enterLabel ?? PALETTE.footGo;

  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label={PALETTE.label}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="pal-q">
        <Icon icon={Search} />
        <div className={cx("pal-field", marks.length > 0 && !composing && "has-marks")}>
          {marks.length && !composing ? <div ref={mirrorRef} className="pal-mirror" aria-hidden="true">{markedText(text, marks)}</div> : null}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={options.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${listId}-${active.id}` : undefined}
            aria-label={PALETTE.label}
            placeholder={capture ? PALETTE.placeholderCapture : PALETTE.placeholderGo}
            enterKeyHint={capture ? "done" : "go"}
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => changeText(event.target.value)}
            onKeyDown={onKeyDown}
            onScroll={syncMirror}
            onSelect={syncMirror}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
          />
        </div>
        <kbd className="d-only">{PALETTE.close}</kbd>
        <Button variant="icon" icon={X} className="m-only pal-close" aria-label={DIALOG.close} onClick={onClose} />
      </div>
      <div className="pal-body" id={listId} role="listbox" aria-label={PALETTE.label}>
        {sections.map((section: PaletteSection) => (
          <div key={section.id} role="group" aria-labelledby={`${listId}-sec-${section.id}`}>
            <p className="pal-sec" id={`${listId}-sec-${section.id}`} role="presentation">{section.title}</p>
            {section.options.map((option) => {
              const isActive = option === active;
              return (
                <Fragment key={option.id}>
                  <div
                    id={`${listId}-${option.id}`}
                    role="option"
                    aria-selected={isActive}
                    className={cx("pal-opt", isActive && "is-active")}
                    onMouseMove={() => { const index = options.indexOf(option); if (index !== activeIndex) setActiveIndex(index); }}
                    onClick={() => void run(option)}
                  >
                    <Tile icon={option.icon} tone={option.tone} />
                    <div>
                      <span className="t">{option.title}</span>
                      {option.meta ? <span className="m">{option.meta}</span> : null}
                    </div>
                    <div className="r">{option.aside}</div>
                  </div>
                  {isActive && option.detail ? <div className="pal-detail" role="presentation">{option.detail}</div> : null}
                </Fragment>
              );
            })}
          </div>
        ))}
        {!options.length ? <p className="pal-empty kp">{capture && !query.text.trim() ? PALETTE_CAPTURE.empty : PALETTE.noMatch}</p> : null}
      </div>
      <div className="pal-foot" aria-hidden="true">
        <span><kbd>↑</kbd><kbd>↓</kbd>{PALETTE.footSelect}</span>
        {active ? <span><kbd>↵</kbd>{enterLabel}</span> : null}
        {quick?.footer}
        <span><kbd>esc</kbd>{PALETTE.footClose}</span>
      </div>
    </dialog>
  );
}
