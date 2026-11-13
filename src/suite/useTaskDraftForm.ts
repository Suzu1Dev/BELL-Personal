/**
 * The behaviour of the to-do draft form (bell-suite SPEC §4.3), apart from its
 * look: the starting fields, the checks, and the one write — 建立待辦 — which
 * no second press can repeat. TaskDraftPanel only shows what this returns.
 */
import { useRef, useState } from "react";
import type { Todo, TodoCreateRequest } from "../../shared/todos";
import { TODO_LIMITS } from "../../shared/todos";
import { api, ApiError, offlineMessage, send } from "../api";
import { notifyCaptured } from "../components/capture/client";
import { suiteCopy } from "../copy/suite";
import { useToday } from "../lib/today";
import { backUrlFor, clipUnits, draftFields, type StoredTaskHandoff } from "./handoff";
import { useSuiteLinks } from "./useSuite";
import { discardTaskHandoff, holdTaskHandoff, taskHandoffCreated } from "./useTaskHandoff";

export interface TaskDraftForm {
  /** The sender's name from Personal's own table (SUITE_APPS), never from the handoff. */
  sourceName: string;
  /** Where 「← 回到 …」 goes: the sender's route on the origin the manifest links now. */
  backUrl?: string;
  truncated: boolean;
  title: string;
  notes: string;
  titleError?: string;
  error?: string;
  pending: boolean;
  setTitle(value: string): void;
  setNotes(value: string): void;
  create(): Promise<void>;
  discard(): void;
}

export async function submitTaskDraft(
  draft: StoredTaskHandoff,
  fields: { title: string; notes: string },
  backUrl: string | undefined,
  refreshToday: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; titleError?: string; error?: string }> {
  const copy = suiteCopy();
  const cleanTitle = clipUnits(fields.title.trim(), TODO_LIMITS.title);
  if (!cleanTitle) return { ok: false, titleError: copy.taskDraft.titleRequired };
  // The stored draft leaves sessionStorage before the request, so a reload while it
  // is out cannot offer the same draft again; it is put back if the request fails.
  const restore = holdTaskHandoff(draft);
  const cleanNotes = clipUnits(fields.notes.trim(), TODO_LIMITS.notes);
  const body: TodoCreateRequest = { title: cleanTitle, ...(cleanNotes ? { notes: cleanNotes } : {}) };
  try {
    const todo = await api<Todo>("/todos", send("POST", body));
    taskHandoffCreated(todo, draft, backUrl);
    notifyCaptured();
    void refreshToday();
    return { ok: true };
  } catch (cause) {
    restore();
    return { ok: false, error: copy.taskDraft.failed(cause instanceof ApiError || cause instanceof Error ? cause.message : offlineMessage()) };
  }
}

export function useTaskDraftForm(draft: StoredTaskHandoff): TaskDraftForm {
  const copy = suiteCopy();
  const links = useSuiteLinks();
  const today = useToday();
  const [initial] = useState(() => draftFields(draft.text));
  const [title, setTitleValue] = useState(initial.title);
  const [notes, setNotes] = useState(initial.notes);
  const [titleError, setTitleError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  /** Set before the request goes out: a second press (or Enter on a focused button) never writes twice. */
  const submitting = useRef(false);
  const backUrl = backUrlFor(draft, links);

  const create = async () => {
    if (submitting.current) return;
    const cleanTitle = clipUnits(title.trim(), TODO_LIMITS.title);
    if (!cleanTitle) {
      setTitleError(copy.taskDraft.titleRequired);
      return;
    }
    submitting.current = true;
    setPending(true);
    setTitleError(undefined);
    setError(undefined);
    try {
      const outcome = await submitTaskDraft(draft, { title, notes }, backUrl, () => today.refresh());
      if (!outcome.ok) {
        if (outcome.titleError) setTitleError(outcome.titleError);
        if (outcome.error) setError(outcome.error);
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return {
    sourceName: copy.apps[draft.from].name,
    ...(backUrl ? { backUrl } : {}),
    truncated: !!draft.truncated,
    title,
    notes,
    ...(titleError ? { titleError } : {}),
    ...(error ? { error } : {}),
    pending,
    setTitle(value) {
      setTitleValue(value);
      if (titleError) setTitleError(undefined);
    },
    setNotes,
    create,
    discard: discardTaskHandoff,
  };
}
