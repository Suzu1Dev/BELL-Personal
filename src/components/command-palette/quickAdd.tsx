/**
 * The palette's 快速新增 and 「AI 解析 · 規則看不懂時」 sections (SPEC-ux
 * §6.6, states.html 06). Every keystroke runs the rule parser
 * (shared/capture-parse.ts); the first option is the rule result with its
 * parse row (type control + chips), a second one offers the other dated type
 * (建立行程「交報告」). When AI is on and the rules were unsure (or ⌘↵), the
 * AI reading arrives as a separate option tagged 「AI 建議」; it is never
 * selected for the user. ↵ commits the active option once, optimistically.
 */
import { useMemo, useState } from "react";
import { nextCaptureType, retypeCapture, CAPTURE_TYPE_ORDER } from "../../../shared/capture-parse";
import type { CaptureType } from "../../../shared/connect";
import { api, send } from "../../api";
import { CAPTURE, CAPTURE_TYPE_LABELS, PALETTE_CAPTURE } from "../../copy/capture";
import { PALETTE } from "../../copy/common";
import { hasModKey, isApplePlatform, modKeyLabel } from "../../lib/keys";
import { STORAGE_KEYS, writeStorage } from "../../lib/storage";
import { AiTag } from "../AiTag";
import { CircleHelp, Lightbulb, ListTodo, CalendarPlus, Sparkles, type IconType } from "../Icon";
import { Spinner } from "../Skeleton";
import type { TileTone } from "../Tile";
import { ParseRow } from "../capture/ParseRow";
import { chipLabel, inputMarks, optionMeta, shortWhen } from "../capture/describe";
import { useAiParse, useCaptureCommit, useCaptureEnv, useCaptureState } from "../capture/useCapture";
import type { PaletteOption, PaletteSection, PaletteSectionsHook } from "./types";

const TYPE_ICONS: Record<CaptureType, IconType> = { todo: ListTodo, event: CalendarPlus, idea: Lightbulb };
const TYPE_TONES: Record<CaptureType, TileTone> = { todo: "task", event: "cal", idea: "idea" };

function previousType(type: CaptureType): CaptureType {
  return CAPTURE_TYPE_ORDER[(CAPTURE_TYPE_ORDER.indexOf(type) + CAPTURE_TYPE_ORDER.length - 1) % CAPTURE_TYPE_ORDER.length];
}

export const useQuickAddSection: PaletteSectionsHook = (query) => {
  const env = useCaptureEnv();
  const { timeZone } = env;
  const text = query.text;
  const trimmed = text.trim();
  const state = useCaptureState(text, "any", timeZone);
  const commit = useCaptureCommit(timeZone);
  const [forcedFor, setForcedFor] = useState<string | null>(null);
  // Automatic only while capturing: a word typed to search or navigate never costs a model call (⌘↵ still asks).
  const wantAi = !!query.open && env.aiParse && !!trimmed && ((query.mode === "capture" && state.rule.confidence === "low") || forcedFor === trimmed);
  const ai = useAiParse(text, wantAi);

  return useMemo(() => {
    if (!trimmed) return null;
    const now = new Date();
    const parse = state.parse;
    const aiSuggestionId = ai.status === "done" ? ai.result.suggestionId : undefined;
    // Picking the rules' reading leaves the AI's unused: dismiss it so it never lingers.
    const dismissAi = () => {
      if (aiSuggestionId) void api(`/suggestions/${encodeURIComponent(aiSuggestionId)}/dismiss`, send("POST", {})).catch(() => {});
    };
    const target = env.eventTarget === "google" ? PALETTE_CAPTURE.calendarGoogle : PALETTE_CAPTURE.calendarLocal;
    // A weekly event is never added to Google Calendar: a quiet note where Google would otherwise be expected.
    const repeatNote = (item: { type: CaptureType; repeat?: unknown }) => (env.eventTarget === "google" && item.type === "event" && item.repeat ? CAPTURE.localOnly : undefined);
    // The palette closes at once (optimistic); a failed save brings the text back as its draft.
    const keepDraft = () => writeStorage(STORAGE_KEYS.composerDraft, trimmed);

    const options: PaletteOption[] = [{
      id: "capture-rule",
      title: parse.title || trimmed,
      meta: [optionMeta(parse, timeZone, now), repeatNote(parse)].filter(Boolean).join(" · "),
      icon: TYPE_ICONS[parse.type],
      tone: TYPE_TONES[parse.type],
      aside: <><AiTag kind="ruleParse" /><kbd>↵</kbd></>,
      detail: <ParseRow parse={parse} timeZone={timeZone} onType={state.setType} onMoment={state.setMoment} onRepeat={state.setRepeat} />,
      enterLabel: PALETTE_CAPTURE.enter[parse.type],
      run: () => {
        dismissAi();
        void commit(trimmed, parse, { onFailed: keepDraft }).catch(() => {});
      },
    }];

    // A dated todo can also be a calendar block, and a timed event a todo due then.
    if (parse.type !== "idea" && parse.time) {
      const otherType: CaptureType = parse.type === "todo" ? "event" : "todo";
      const other = retypeCapture(parse, otherType, { now, timeZone, text });
      const when = shortWhen(other, timeZone, now);
      options.push({
        id: "capture-alt",
        title: PALETTE_CAPTURE.alternative(otherType, other.title),
        meta: otherType === "event" ? [when, repeatNote(other) ?? target].filter(Boolean).join(" · ") : optionMeta(other, timeZone, now),
        icon: otherType === "event" ? CalendarPlus : ListTodo,
        tone: otherType === "event" ? "cal" : "task",
        enterLabel: PALETTE_CAPTURE.enter[otherType],
        run: () => {
          dismissAi();
          void commit(trimmed, other, { onFailed: keepDraft }).catch(() => {});
        },
      });
    }
    const sections: PaletteSection[] = [{ id: "quick-add", title: PALETTE.sectionQuickAdd, options }];

    const aiOptions: PaletteOption[] = [];
    if (ai.status === "loading") {
      aiOptions.push({ id: "capture-ai-wait", title: PALETTE_CAPTURE.aiLoading, meta: PALETTE_CAPTURE.aiLoadingMeta, icon: Sparkles, tone: "accent", aside: <Spinner />, run: () => false });
    } else if (ai.status === "done") {
      const option = ai.result.option;
      const when = option.type === "idea" ? undefined : chipLabel(option, timeZone);
      const meta = [CAPTURE_TYPE_LABELS[option.type], when, option.location, option.basis ? PALETTE_CAPTURE.aiBasis(option.basis) : undefined].filter(Boolean).join(" · ");
      aiOptions.push({
        id: "capture-ai",
        title: option.title,
        meta,
        icon: Sparkles,
        tone: "accent",
        aside: <AiTag kind="suggestion" />,
        enterLabel: PALETTE_CAPTURE.enter[option.type],
        run: () => { void commit(trimmed, { ...option, tags: parse.tags }, { suggestionId: ai.result.suggestionId, onFailed: keepDraft }).catch(() => {}); },
      });
    } else if (ai.status === "error") {
      aiOptions.push({ id: "capture-ai-error", title: PALETTE_CAPTURE.aiFailed, meta: ai.message, icon: CircleHelp, run: () => false });
    }
    if (aiOptions.length) sections.push({ id: "ai-parse", title: PALETTE.sectionAi, options: aiOptions });

    return {
      sections,
      marks: inputMarks(parse, text),
      onKeyDown: (event) => {
        if (event.key === "Tab" && !event.altKey && !event.metaKey && !event.ctrlKey) {
          state.setType(event.shiftKey ? previousType(parse.type) : nextCaptureType(parse.type));
          return true;
        }
        if (event.key === "Enter" && hasModKey(event, isApplePlatform())) {
          // With AI off there is nothing to ask for: ⌘↵ runs the active option like ↵.
          if (!env.aiParse) return false;
          setForcedFor(trimmed);
          return true;
        }
        return false;
      },
      footer: (
        <>
          <span><kbd>Tab</kbd>{PALETTE.footTab}</span>
          {env.aiParse ? <span><kbd>{modKeyLabel()}↵</kbd>{PALETTE.footAi}</span> : null}
        </>
      ),
    };
  }, [trimmed, text, state, ai, env, timeZone, commit]);
};
