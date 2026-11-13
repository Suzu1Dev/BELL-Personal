/**
 * The quick-capture pipeline shared by the palette's 快速新增, the Today
 * capture field (CaptureField), the 待辦 add row and the 靈感 Composer
 * (SPEC-ux §6.6): the rule parse on every keystroke, Tab / chip overrides,
 * the optional AI parse, and the optimistic commit with its undo toast.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EventRepeatInput } from "../../../shared/calendar";
import {
  nextCaptureType, parseCapture, retypeCapture, setCaptureMoment, withRepeat, type CaptureContext, type CaptureParse,
} from "../../../shared/capture-parse";
import type { CaptureParseOption, CaptureParseResult, CaptureResponse, CaptureStatus, CaptureType } from "../../../shared/connect";
import { DEFAULT_TIME_ZONE, type DayKey } from "../../../shared/time";
import { ApiError } from "../../api";
import { CAPTURE_TOASTS, TIDY } from "../../copy/capture";
import { useStatus } from "../../lib/status";
import { useToday } from "../../lib/today";
import { CalendarPlus, Lightbulb, ListPlus, type IconType } from "../Icon";
import { useToast } from "../toast/ToastProvider";
import { aiParse, captureApi, notifyCaptured } from "./client";
import { captureRequest, captureToast } from "./describe";
import { useTidyFollower } from "./tidy";

export const CAPTURE_ICONS: Record<CaptureType, IconType> = { todo: ListPlus, event: CalendarPlus, idea: Lightbulb };

export interface CaptureEnv {
  /** The server's zone (BELLPERSONAL_TZ); days are never read in the browser's zone. */
  timeZone: string;
  /** 使用 AI is on (offer AI 解析 and ⌘↵). */
  aiParse: boolean;
  eventTarget: CaptureStatus["eventTarget"];
}

/** Zone, AI switch and event target from GET /api/status (modules.capture). */
export function useCaptureEnv(): CaptureEnv {
  const { data } = useStatus();
  const module = data?.modules?.capture as Partial<CaptureStatus> | undefined;
  return useMemo(() => ({
    timeZone: data?.timeZone ?? DEFAULT_TIME_ZONE,
    aiParse: module?.aiParse ?? false,
    eventTarget: module?.eventTarget ?? "local",
  }), [data?.timeZone, module?.aiParse, module?.eventTarget]);
}

export interface CaptureState {
  /** What the rules read. */
  rule: CaptureParse;
  /** With the user's Tab / type control and chip edits applied: what ↵ creates. */
  parse: CaptureParse;
  setType(type: CaptureType): void;
  /** Tab: 待辦 → 行程 → 靈感. */
  cycleType(): void;
  /** A chip edit: another day, or a time (null = the day alone). */
  setMoment(day: DayKey, time: string | null): void;
  /** The 重複 chip of a 行程: weekly (optionally until a day), or undefined for 不重複. */
  setRepeat(repeat: EventRepeatInput | undefined): void;
}

export function useCaptureState(text: string, context: CaptureContext, timeZone: string): CaptureState {
  const [type, setType] = useState<CaptureType | null>(null);
  const [moment, setMomentState] = useState<{ day: DayKey; time: string | null } | null>(null);
  const [repeat, setRepeatState] = useState<{ value: EventRepeatInput | undefined } | null>(null);
  const rule = useMemo(() => parseCapture(text, { now: new Date(), timeZone, context }), [text, timeZone, context]);

  // Manual choices last until the field is cleared; a newly typed date replaces a chip edit.
  const empty = !text.trim();
  useEffect(() => { if (empty) { setType(null); setRepeatState(null); } }, [empty]);
  const ruleMoment = `${rule.day ?? ""}|${rule.time ?? ""}`;
  useEffect(() => { setMomentState(null); }, [ruleMoment]);
  // Typing (or dropping) 每週X is the rules' own reading again: it replaces the chip's choice.
  const ruleRepeats = !!rule.repeat;
  useEffect(() => { setRepeatState(null); }, [ruleRepeats]);

  const parse = useMemo(() => {
    let value = type ? retypeCapture(rule, type, { now: new Date(), timeZone, text }) : rule;
    if (moment && value.type !== "idea") value = setCaptureMoment(value, moment.day, moment.time, timeZone);
    if (repeat && value.type === "event") value = withRepeat(value, repeat.value);
    return value;
  }, [rule, type, moment, repeat, timeZone, text]);

  return {
    rule,
    parse,
    setType,
    cycleType: () => setType(nextCaptureType(parse.type)),
    setMoment: (day, time) => setMomentState({ day, time }),
    setRepeat: (value) => setRepeatState({ value }),
  };
}

export type AiParseState =
  | { status: "idle" }
  | { status: "loading"; text: string }
  | { status: "done"; text: string; result: CaptureParseResult }
  | { status: "error"; text: string; message: string };

/** SPEC-ux §6.6: the AI parse waits for a 600 ms pause in typing. */
export const AI_PARSE_DEBOUNCE_MS = 600;

/**
 * Runs the AI parse for `text` while `wanted` (AI on, and the rules were
 * unsure or the user pressed ⌘↵). A result for older text is never shown;
 * leaving (unmount, new text) aborts and cancels the server job.
 */
export function useAiParse(text: string, wanted: boolean): AiParseState {
  const [state, setState] = useState<AiParseState>({ status: "idle" });
  const trimmed = text.trim();
  useEffect(() => {
    if (!wanted || !trimmed) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setState({ status: "loading", text: trimmed });
      aiParse(trimmed, controller.signal)
        .then((result) => { if (!controller.signal.aborted) setState({ status: "done", text: trimmed, result }); })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setState({ status: "error", text: trimmed, message: cause instanceof Error ? cause.message : "" });
        });
    }, AI_PARSE_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, wanted]);
  return state.status !== "idle" && state.text !== trimmed ? { status: "idle" } : state;
}

export interface CommitOptions {
  /** The POST failed: keep the text (the caller puts it back in its field). */
  onFailed?: (message: string) => void;
  onCreated?: (response: CaptureResponse) => void;
  /** The AI suggestion this commit confirms. */
  suggestionId?: string;
}

type Committable = CaptureParse | (CaptureParseOption & { tags?: string[]; durationMinutes?: number });

/**
 * Optimistic commit (SPEC-ux §6.6 step 3): the undo toast shows at once
 * (「已加入待辦「交報告」· 明天 09:00」 [復原]), POST /api/capture runs behind
 * it, 復原 deletes the record through its undoPath. A failed POST swaps the
 * toast for 「沒有記下來：…草稿已保留。」 [重試] and calls `onFailed`.
 * When the server started 自動整理 (§6.6.1) the toast says 「整理中…」 until
 * the tidy ends; a rewrite then shows 「已整理成「…」」 [復原] in its place
 * (or beside a newer undo toast, without taking its Z). Typing is never
 * blocked: the follow runs on after the palette or field is gone.
 */
export function useCaptureCommit(timeZone: string) {
  const toast = useToast();
  const { refresh } = useToday();
  const followTidy = useTidyFollower();
  // A weekly event never goes to Google Calendar: say so when it otherwise would have.
  const localOnly = useCaptureEnv().eventTarget === "google";
  return useCallback(function commit(text: string, item: Committable, options: CommitOptions = {}): Promise<CaptureResponse> {
    const request = captureApi.create(captureRequest(text, item, options.suggestionId));
    let failed = false;
    const toastId = toast.undo(captureToast(item, timeZone, new Date(), { localOnly }), () => {
      request
        .then((response) => captureApi.undo(response.undoPath))
        .then(() => { notifyCaptured(); void refresh(); })
        .catch((cause: unknown) => {
          if (!failed) toast.error(CAPTURE_TOASTS.undoFailed(cause instanceof Error ? cause.message : ""));
        });
    }, { icon: CAPTURE_ICONS[item.type] });
    request.then(
      (response) => {
        notifyCaptured();
        void refresh();
        options.onCreated?.(response);
        if (response.tidy) {
          toast.update(toastId, { note: TIDY.working });
          // A rewrite takes this toast's place while it is visible; else it never takes another action's 復原.
          void followTidy(response.tidy, { toastId }).then(() => toast.update(toastId, { note: undefined }));
        }
      },
      (cause: unknown) => {
        failed = true;
        toast.dismiss(toastId);
        const message = cause instanceof ApiError && cause.status !== 0 ? CAPTURE_TOASTS.failed(cause.message) : CAPTURE_TOASTS.failedOffline;
        options.onFailed?.(message);
        toast.error(message, () => { void commit(text, item, options).catch(() => {}); });
      },
    );
    return request;
  }, [toast, refresh, timeZone, followTidy, localOnly]);
}
