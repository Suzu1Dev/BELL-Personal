/**
 * The to-do draft that came from a sibling (bell-suite SPEC §4.3), shown by
 * AppShell above #/tasks. Presentation only: the address was already cleaned
 * when the draft was captured (useTaskHandoff), and the form's behaviour —
 * fields, checks, the one write on 建立待辦 — is useTaskDraftForm. The back
 * bar goes only to the route the sender named, on the origin the manifest
 * links now. Text that came from the sender is shown with its own direction
 * (dir="auto", <bdi>), and the sender is named from Personal's own table.
 */
import { useId } from "react";
import { TODO_LIMITS } from "../../shared/todos";
import type { SuiteLinks } from "../../shared/suite";
import { Button } from "../components/Button";
import { Field, Textarea, TextInput } from "../components/Field";
import { ArrowLeft, AudioLines, Check, Icon, ListPlus, Trash2 } from "../components/Icon";
import { Notice } from "../components/Notice";
import { SkeletonStatus } from "../components/Skeleton";
import { suiteCopy } from "../copy/suite";
import { backUrlFor, handoffKindFromBack, type StoredTaskHandoff, type TaskHandoffRejection } from "./handoff";
import { useTaskDraftForm, type TaskDraftForm } from "./useTaskDraftForm";
import { useSuiteLinks } from "./useSuite";
import { discardTaskHandoff, retryTaskHandoff, useTaskHandoff, type TaskHandoffState } from "./useTaskHandoff";
import "./TaskDraftPanel.css";

const KIND_IDS = { 待辦: "task", 靈感: "idea", 郵件: "email", 行程: "event", 筆記: "note", 網頁: "page", 時程: "schedule" } as const;

function sourceLine(sourceName: string, backUrl: string | undefined, copy: ReturnType<typeof suiteCopy>["taskDraft"]): string {
  const kind = handoffKindFromBack(backUrl);
  return kind ? copy.fromSourceKind(sourceName, copy.kinds[KIND_IDS[kind]]) : copy.fromSource(sourceName);
}

function BackBar({ href, name }: { href: string; name: string }) {
  const TASK_DRAFT = suiteCopy().taskDraft;
  return (
    <a className="suite-back" href={href}>
      <span className="suite-back-tile" aria-hidden="true"><Icon icon={AudioLines} size="xs" /></span>
      <Icon icon={ArrowLeft} size="sm" />
      {TASK_DRAFT.back(name)}
    </a>
  );
}

/** The form for a draft, from what useTaskDraftForm returns. */
export function TaskDraftFormView({ form }: { form: TaskDraftForm }) {
  const TASK_DRAFT = suiteCopy().taskDraft;
  const headingId = useId();
  return (
    <section className="suite-draft" aria-labelledby={headingId}>
      {form.backUrl ? <BackBar href={form.backUrl} name={form.sourceName} /> : null}
      <div className="suite-draft-card">
        <div className="suite-draft-head">
          <span className="suite-draft-tile" aria-hidden="true"><Icon icon={ListPlus} /></span>
          <div>
            <h2 id={headingId}>{TASK_DRAFT.title}</h2>
            <p className="kp">{sourceLine(form.sourceName, form.backUrl, TASK_DRAFT)}</p>
          </div>
        </div>
        {form.truncated ? <Notice tone="warn" title={TASK_DRAFT.truncated} className="suite-draft-note" /> : null}
        <div className="suite-draft-fields">
          <Field label={TASK_DRAFT.titleField} error={form.titleError}>
            <TextInput
              value={form.title}
              dir="auto"
              maxLength={TODO_LIMITS.title}
              autoComplete="off"
              onChange={(event) => form.setTitle(event.target.value)}
            />
          </Field>
          <Field label={TASK_DRAFT.notesField}>
            <Textarea value={form.notes} dir="auto" maxLength={TODO_LIMITS.notes} rows={4} onChange={(event) => form.setNotes(event.target.value)} />
          </Field>
        </div>
        {form.error ? <Notice tone="error" title={form.error} role="alert" className="suite-draft-note" /> : null}
        <div className="suite-draft-actions">
          <Button variant="primary" icon={Check} disabled={form.pending} aria-busy={form.pending || undefined} onClick={() => { void form.create(); }}>
            {form.pending ? TASK_DRAFT.creating : TASK_DRAFT.create}
          </Button>
          <Button variant="ghost" icon={Trash2} disabled={form.pending} onClick={form.discard}>
            {TASK_DRAFT.discard}
          </Button>
        </div>
      </div>
    </section>
  );
}

function DraftForm({ draft }: { draft: StoredTaskHandoff }) {
  return <TaskDraftFormView form={useTaskDraftForm(draft)} />;
}

/** Every state but the draft itself: checking, unverified, rejected, created. */
export function TaskHandoffNotice({ state, links, onRetry, onDismiss }: {
  state: Exclude<TaskHandoffState, { kind: "none" } | { kind: "draft" }>;
  links: SuiteLinks;
  onRetry(): void;
  onDismiss(): void;
}) {
  const copy = suiteCopy();
  const TASK_DRAFT = copy.taskDraft;
  const REJECTED: Record<TaskHandoffRejection, string> = {
    duplicate: TASK_DRAFT.rejectedDuplicate,
    from: TASK_DRAFT.rejectedFrom,
    missing: TASK_DRAFT.rejectedEmpty,
    empty: TASK_DRAFT.rejectedEmpty,
  };
  switch (state.kind) {
    case "checking":
      return (
        <section className="suite-draft is-quiet" aria-label={TASK_DRAFT.checking}>
          <SkeletonStatus>{TASK_DRAFT.checking}</SkeletonStatus>
        </section>
      );
    case "unverified":
      return (
        <section className="suite-draft" aria-label={TASK_DRAFT.checkFailed}>
          <Notice
            tone="warn"
            title={TASK_DRAFT.checkFailed}
            role="alert"
            actions={(
              <>
                <Button size="sm" onClick={onRetry}>{TASK_DRAFT.retry}</Button>
                <Button size="sm" variant="ghost" onClick={onDismiss}>{TASK_DRAFT.discard}</Button>
              </>
            )}
          />
        </section>
      );
    case "rejected": {
      const title = REJECTED[state.reason];
      return (
        <section className="suite-draft" aria-label={title}>
          <Notice
            title={title}
            role="status"
            actions={<Button size="sm" variant="ghost" onClick={onDismiss}>{TASK_DRAFT.dismiss}</Button>}
          />
        </section>
      );
    }
    case "created": {
      const name = copy.apps[state.from].name;
      const backUrl = state.backUrl && backUrlFor({ from: state.from, backUrl: state.backUrl }, links);
      return (
        <section className="suite-draft" aria-label={TASK_DRAFT.created}>
          {backUrl ? <BackBar href={backUrl} name={name} /> : null}
          <Notice
            tone="ok"
            title={TASK_DRAFT.created}
            role="status"
            actions={(
              <>
                <Button size="sm" href={`#/tasks/${encodeURIComponent(state.id)}`}>{TASK_DRAFT.openCreated}</Button>
                <Button size="sm" variant="ghost" onClick={onDismiss}>{TASK_DRAFT.dismiss}</Button>
              </>
            )}
          >
            <bdi>{state.title}</bdi>
          </Notice>
        </section>
      );
    }
  }
}

export function TaskDraftPanel() {
  const state = useTaskHandoff();
  const links = useSuiteLinks();
  if (state.kind === "none") return null;
  // A new draft (another handoff) starts a fresh form.
  if (state.kind === "draft") return <DraftForm key={`${state.draft.receivedAt}\u0000${state.draft.text.length}`} draft={state.draft} />;
  return <TaskHandoffNotice state={state} links={links} onRetry={retryTaskHandoff} onDismiss={discardTaskHandoff} />;
}
