/**
 * 新增專案 / 編輯專案 in a native <dialog>: name, description, colour, status,
 * linked repositories and the progress mode. Deleting is reversible (trash +
 * undo toast), so it needs no confirmation (AGENTS.md product rules).
 */
import { useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { PROJECT_COLORS, PROJECT_STATUSES, type Project, type ProjectColor, type ProjectCreateRequest, type ProjectStatus, type ProjectUpdateRequest } from "../../../shared/projects";
import { api, send } from "../../api";
import { ASSIGNMENT_FORM, PROJECT_COLOR_LABELS, PROJECT_FORM, PROJECT_STATUS_LABELS } from "../../copy/work";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field, Select, Switch, TextInput, Textarea } from "../../components/Field";
import { TextLink } from "../../components/Link";
import { isComposing } from "../../lib/keys";
import { projectColorVar } from "../../lib/today-model";
import { moduleHiddenRoles, parseRepos } from "./work-model";
import { reasonOf } from "./useWork";

export interface ProjectDialogProps {
  open: boolean;
  /** Absent: create a new project. */
  project?: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onDelete?: () => void;
}

interface FormState {
  name: string;
  description: string;
  color: ProjectColor;
  status: ProjectStatus;
  repos: string;
  manual: boolean;
  progress: string;
  milestone: string;
}

function initial(project?: Project): FormState {
  const repos = project?.repos ?? (project?.repo ? [project.repo] : []);
  return {
    name: project?.name ?? "",
    description: project?.description ?? "",
    color: project?.color ?? "accent",
    status: project?.status ?? "active",
    repos: repos.join("\n"),
    manual: typeof project?.progress === "number",
    progress: typeof project?.progress === "number" ? String(project.progress) : "0",
    milestone: "",
  };
}

/** Enter that commits an IME composition (Bopomofo) must not submit the form. */
function guardEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key === "Enter" && isComposing(event.nativeEvent)) event.preventDefault();
}

export function ProjectDialog({ open, project, onClose, onSaved, onDelete }: ProjectDialogProps) {
  const [form, setForm] = useState<FormState>(() => initial(project));
  const [errors, setErrors] = useState<{ name?: string; repos?: string; form?: ReactNode }>({});
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) { setForm(initial(project)); setErrors({}); setSaving(false); }
  }, [open, project]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((current) => ({ ...current, [key]: value }));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const name = form.name.trim();
    const repos = parseRepos(form.repos);
    const next: typeof errors = {};
    if (!name) next.name = PROJECT_FORM.nameRequired;
    if (repos.invalid) next.repos = PROJECT_FORM.reposError(repos.invalid);
    setErrors(next);
    if (next.name || next.repos) return;
    const progress = form.manual ? Math.max(0, Math.min(100, Math.round(Number(form.progress) || 0))) : null;
    setSaving(true);
    try {
      let saved: Project;
      if (project) {
        const body: ProjectUpdateRequest = { name, description: form.description.trim() || null, color: form.color, status: form.status, repos: repos.repos, progress };
        saved = await api<Project>(`/projects/${encodeURIComponent(project.id)}`, send("PATCH", body));
      } else {
        const milestone = form.milestone.trim();
        const body: ProjectCreateRequest = {
          name, color: form.color, repos: repos.repos,
          ...(form.description.trim() ? { description: form.description.trim() } : {}),
          ...(progress !== null ? { progress } : {}),
          ...(milestone ? { milestones: [{ title: milestone }] } : {}),
        };
        saved = await api<Project>("/projects", send("POST", body));
      }
      onSaved(saved);
    } catch (cause) {
      const hidden = moduleHiddenRoles(cause);
      setErrors({ form: <>{reasonOf(cause)}{hidden ? <> <TextLink href="#/settings/roles" onClick={onClose}>{ASSIGNMENT_FORM.openRoles}</TextLink></> : null}</> });
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={project ? PROJECT_FORM.editTitle : PROJECT_FORM.createTitle}
      className="project-dialog"
      initialFocus={() => nameRef.current}
      footer={(
        <>
          {project && onDelete ? <Button variant="ghost" className="dialog-foot-start" onClick={onDelete}>{PROJECT_FORM.delete}</Button> : null}
          <Button variant="ghost" onClick={onClose}>{PROJECT_FORM.cancel}</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving}>{project ? PROJECT_FORM.save : PROJECT_FORM.create}</Button>
        </>
      )}
    >
      <form className="project-form" onSubmit={(event) => void submit(event)} noValidate>
        <Field label={PROJECT_FORM.name} error={errors.name}>
          <TextInput
            ref={nameRef}
            value={form.name}
            maxLength={120}
            placeholder={PROJECT_FORM.namePlaceholder}
            onChange={(event) => set("name", event.target.value)}
            onKeyDown={guardEnter}
          />
        </Field>
        <Field label={PROJECT_FORM.description} hint={PROJECT_FORM.descriptionHint}>
          <Textarea value={form.description} maxLength={2000} rows={2} onChange={(event) => set("description", event.target.value)} />
        </Field>
        <div className="field">
          <span className="field-label" id="project-color-label">{PROJECT_FORM.color}</span>
          <div className="color-pick" role="group" aria-labelledby="project-color-label">
            {PROJECT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                aria-pressed={form.color === color}
                aria-label={PROJECT_COLOR_LABELS[color]}
                title={PROJECT_COLOR_LABELS[color]}
                onClick={() => set("color", color)}
              >
                <span style={{ "--c": projectColorVar(color) } as CSSProperties} aria-hidden="true" />
              </button>
            ))}
          </div>
        </div>
        {project ? (
          <Field label={PROJECT_FORM.status}>
            <Select value={form.status} onChange={(event) => set("status", event.target.value as ProjectStatus)}>
              {PROJECT_STATUSES.map((status) => <option key={status} value={status}>{PROJECT_STATUS_LABELS[status]}</option>)}
            </Select>
          </Field>
        ) : (
          <Field label={PROJECT_FORM.firstMilestone}>
            <TextInput value={form.milestone} maxLength={160} placeholder={PROJECT_FORM.firstMilestonePlaceholder} onChange={(event) => set("milestone", event.target.value)} onKeyDown={guardEnter} />
          </Field>
        )}
        <Field label={PROJECT_FORM.repos} hint={PROJECT_FORM.reposHint} error={errors.repos}>
          <Textarea className="mono" value={form.repos} rows={2} spellCheck={false} placeholder="owner/name" onChange={(event) => set("repos", event.target.value)} />
        </Field>
        <Switch checked={form.manual} onChange={(checked) => set("manual", checked)} label={PROJECT_FORM.progressManual} hint={PROJECT_FORM.progressHint} />
        {form.manual ? (
          <Field label={PROJECT_FORM.progress}>
            <TextInput type="number" inputMode="numeric" min={0} max={100} step={5} value={form.progress} onChange={(event) => set("progress", event.target.value)} />
          </Field>
        ) : null}
        {errors.form ? <p className="field-error" role="alert">{errors.form}</p> : null}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
