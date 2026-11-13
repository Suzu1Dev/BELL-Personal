/**
 * #/ideas — 靈感 (SPEC-ux §3.3): the Composer (靈感 · 待辦 · 筆記, drafts
 * per tab) at the top, a search field and tag chips, then ideas grouped by
 * day with #tags in --m-idea and AI tag proposals as dashed chips the user
 * taps to confirm. Pin, 轉成待辦 (one transaction: the todo is made and the
 * idea archived; 復原 undoes both), archive, edit (text and #tags inline) and
 * delete (with 復原) on each row.
 *
 * `#/ideas/<id>`: once the list is in, the row scrolls into view, flashes
 * and takes focus. An idea that is not listed is looked up with GET
 * /api/ideas/:id — an archived one switches to 已封存的靈感, a filtered-out
 * one clears the search and tag — and a 404 shows 「找不到這則靈感」.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Archive, ArchiveRestore, ListTodo, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import type { Idea, IdeaDeleteResponse, IdeaListResponse, IdeaToTodoResponse, IdeaUpdateRequest, IdeaView } from "../../../shared/ideas";
import { localTime } from "../../../shared/time";
import { api, core, send } from "../../api";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { ChipGroup } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { Icon, Lightbulb, RotateCw, Search, Sparkles, X } from "../../components/Icon";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { SkeletonRow } from "../../components/Skeleton";
import { CAPTURED_EVENT } from "../../components/capture/client";
import { Composer } from "../../components/capture/Composer";
import { editableText, ideaFromText } from "../../components/capture/ideaText";
import { useCaptureEnv } from "../../components/capture/useCapture";
import { useToast } from "../../components/toast/ToastProvider";
import { BUTTONS, ERRORS } from "../../copy/common";
import { IDEAS, ideasCopy, ideasLocale } from "../../copy/ideas";
import { cx } from "../../lib/cx";
import { hasModKey, isApplePlatform, isComposing } from "../../lib/keys";
import { routeHref, type RouteOf } from "../../lib/router";
import { ExplainThis } from "../../suite/ExplainThis";
import { SendToPr } from "../../suite/SendToPr";
import { useToday } from "../../lib/today";
import { explainText, isMissing, landOn, useFlash, useLandOnce } from "../not-found/deep-link";
import { MissingObject } from "../not-found/MissingObject";
import { focusFromHash } from "../tasks/model";
import { groupIdeas } from "./model";
import { HabitMenu, type HabitMenuItem } from "../habits/HabitMenu";
import "./IdeasPage.css";

const ALL = "__all__";
const SEARCH_DEBOUNCE_MS = 250;
const TAG_CHIPS = 8;
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

interface ListState {
  data?: IdeaListResponse;
  loading: boolean;
  error?: string;
}

/** GET /api/ideas for the current filters; a new filter cancels the old request. */
function useIdeaList(params: string) {
  const [state, setState] = useState<ListState>({ loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<IdeaListResponse>(`/ideas?${params}`, { signal: controller.signal })
      .then((data) => setState({ data, loading: false }))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setState((previous) => ({ ...previous, loading: false, error: errorText(cause) }));
      });
    return () => controller.abort();
  }, [params, tick]);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  return { ...state, refresh };
}

export default function IdeasPage({ route }: { route: RouteOf<"ideas"> }) {
  const locale = ideasLocale();
  const { PAGE_HEAD_TITLE } = ideasCopy(locale);
  const env = useCaptureEnv();
  const toast = useToast();
  const today = useToday();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [tag, setTag] = useState(ALL);
  const [archived, setArchived] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);
  const params = new URLSearchParams({ ...(debounced ? { q: debounced } : {}), ...(tag !== ALL ? { tag } : {}), ...(archived ? { archived: "1" } : {}) }).toString();
  const list = useIdeaList(params);
  const { refresh } = list;

  useEffect(() => {
    const onCaptured = () => refresh();
    window.addEventListener(CAPTURED_EVENT, onCaptured);
    return () => window.removeEventListener(CAPTURED_EVENT, onCaptured);
  }, [refresh]);

  // Rows that just left (archived, deleted) until the list catches up.
  const [gone, setGone] = useState<Set<string>>(new Set());
  useEffect(() => setGone(new Set()), [list.data]);
  const ideas = useMemo(() => (list.data?.ideas ?? []).filter((idea) => !gone.has(idea.id)), [list.data, gone]);
  const groups = useMemo(() => (list.data ? groupIdeas(ideas, list.data.today, env.timeZone, locale) : []), [ideas, list.data, env.timeZone, locale]);
  const tagOptions = useMemo(() => [
    { value: ALL, label: IDEAS.allTags, count: list.data?.total },
    ...(list.data?.tags ?? []).slice(0, TAG_CHIPS).map((item) => ({ value: item.tag, label: `#${item.tag}`, count: item.count })),
  ], [list.data]);

  // #/ideas?focus=<id> (the palette's 搜尋): scroll to that idea and flash it.
  const focusId = focusFromHash(typeof window === "undefined" ? "" : window.location.hash);
  const [flash, startFlash] = useFlash();
  const handled = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!focusId || handled.current === focusId || !ideas.some((idea) => idea.id === focusId)) return;
    handled.current = focusId;
    startFlash(focusId);
    requestAnimationFrame(() => document.querySelector(`[data-idea="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: "center" }));
  }, [focusId, ideas, startFlash]);

  // #/ideas/<id>: resolved once per id. Not on this list → GET /api/ideas/:id: archived switches to 已封存,
  // filtered out clears the search and tag; a 404 is 找不到這則靈感.
  const linkId = route.id;
  const [missing, setMissing] = useState<string | undefined>();
  const resolved = useRef<string | undefined>(undefined);
  const listed = !!linkId && ideas.some((idea) => idea.id === linkId);
  useEffect(() => {
    if (!linkId) { resolved.current = undefined; return; }
    if (!list.data || resolved.current === linkId) return;
    resolved.current = linkId;
    if (listed) return;
    api<Idea>(`/ideas/${encodeURIComponent(linkId)}`)
      .then((idea) => {
        if (resolved.current !== linkId) return;
        setQuery("");
        setDebounced("");
        setTag(ALL);
        setArchived(idea.archived);
        refresh();
      })
      .catch((cause: unknown) => {
        if (resolved.current !== linkId) return;
        if (isMissing(cause)) setMissing(linkId);
        else toast.error(ERRORS.actionFailed(IDEAS.linked.openFailed, errorText(cause)));
      });
  }, [linkId, list.data, listed, refresh, toast]);
  const listRef = useRef<HTMLDivElement>(null);
  useLandOnce(linkId, listed, (id) => {
    startFlash(id);
    landOn(listRef.current, "idea", id);
  });

  const update = async (idea: IdeaView, patch: IdeaUpdateRequest, message?: string) => {
    try {
      await api<Idea>(`/ideas/${encodeURIComponent(idea.id)}`, send("PATCH", patch));
      if (message) toast.success(message);
      refresh();
    } catch (cause) {
      toast.error(ERRORS.actionFailed(IDEAS.toasts.updateFailed, errorText(cause)));
      throw cause;
    }
  };

  const archive = (idea: IdeaView) => {
    setGone((set) => new Set(set).add(idea.id));
    const next = !idea.archived;
    api<Idea>(`/ideas/${encodeURIComponent(idea.id)}`, send("PATCH", { archived: next }))
      .then(() => {
        refresh();
        toast.undo(next ? IDEAS.toasts.archived : IDEAS.toasts.unarchived, () => {
          api(`/ideas/${encodeURIComponent(idea.id)}`, send("PATCH", { archived: !next })).then(refresh).catch((cause: unknown) => toast.error(ERRORS.undoFailed(errorText(cause))));
        }, { icon: next ? Archive : ArchiveRestore });
      })
      .catch((cause: unknown) => {
        setGone((set) => { const copy = new Set(set); copy.delete(idea.id); return copy; });
        toast.error(ERRORS.actionFailed(IDEAS.toasts.updateFailed, errorText(cause)));
      });
  };

  const remove = (idea: IdeaView) => {
    setGone((set) => new Set(set).add(idea.id));
    api<IdeaDeleteResponse>(`/ideas/${encodeURIComponent(idea.id)}`, send("DELETE"))
      .then((result) => {
        refresh();
        const token = result.undoToken;
        if (token) toast.undo(IDEAS.toasts.deleted, () => { core.restore(token).then(refresh).catch((cause: unknown) => toast.error(ERRORS.undoFailed(errorText(cause)))); }, { icon: Trash2 });
      })
      .catch((cause: unknown) => {
        setGone((set) => { const copy = new Set(set); copy.delete(idea.id); return copy; });
        toast.error(ERRORS.actionFailed(IDEAS.toasts.deleteFailed, errorText(cause)));
      });
  };

  // 轉成待辦: the row leaves at once; the server makes the todo and archives the idea in one step, so 復原 (the
  // trash marker it returns) removes the todo and moves the idea back in one step too.
  const toTodo = (idea: IdeaView) => {
    setGone((set) => new Set(set).add(idea.id));
    api<IdeaToTodoResponse>(`/ideas/${encodeURIComponent(idea.id)}/todo`, send("POST", {}))
      .then((result) => {
        refresh();
        void today.refresh();
        toast.undo(IDEAS.toasts.toTodo(result.todo.title), () => {
          core.restore(result.undoToken)
            .then(() => { refresh(); void today.refresh(); })
            .catch((cause: unknown) => toast.error(ERRORS.undoFailed(errorText(cause))));
        }, { icon: ListTodo });
      })
      .catch((cause: unknown) => {
        setGone((set) => { const copy = new Set(set); copy.delete(idea.id); return copy; });
        refresh();
        toast.error(ERRORS.actionFailed(IDEAS.toasts.toTodoFailed, errorText(cause)));
      });
  };

  const acceptTag = (suggestionId: string, value: string) => {
    api(`/suggestions/${encodeURIComponent(suggestionId)}/accept`, send("POST", {}))
      .then(() => { toast.success(IDEAS.toasts.tagAdded(value)); refresh(); })
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(IDEAS.toasts.tagFailed, errorText(cause))));
  };
  const dismissTag = (suggestionId: string) => {
    api(`/suggestions/${encodeURIComponent(suggestionId)}/dismiss`, send("POST", {})).then(refresh).catch(() => refresh());
  };

  const filtering = !!debounced || tag !== ALL;
  const loading = list.loading && !list.data;
  const empty = !!list.data && !ideas.length;

  if (linkId && missing === linkId) {
    return (
      <div className="ideas-page">
        <PageHead title={PAGE_HEAD_TITLE} />
        <MissingObject icon={Lightbulb} tone="idea" title={IDEAS.linked.missingTitle} hint={IDEAS.linked.missingHint} backHref="#/ideas" backLabel={IDEAS.linked.back} />
      </div>
    );
  }

  return (
    <div className="ideas-page" ref={listRef}>
      <PageHead
        title={archived ? IDEAS.archivedHead : PAGE_HEAD_TITLE}
        actions={(
          <Button variant="ghost" size="sm" icon={archived ? Lightbulb : Archive} onClick={() => { setArchived((value) => !value); setTag(ALL); }}>
            {archived ? IDEAS.backToActive : IDEAS.archivedToggle()}
          </Button>
        )}
      />
      {archived ? null : <Composer onSaved={() => refresh()} />}

      <div className="ideas-tools">
        <label className="ideas-search">
          <Icon icon={Search} />
          <span className="sr-only">{IDEAS.searchLabel}</span>
          <input
            type="search"
            className="input"
            placeholder={IDEAS.searchPlaceholder}
            value={query}
            maxLength={80}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (!isComposing(event.nativeEvent) && event.key === "Escape" && query) { event.preventDefault(); setQuery(""); } }}
          />
        </label>
        {tagOptions.length > 1 && !archived ? <ChipGroup label={IDEAS.tagsLabel} options={tagOptions} value={tag} allValue={ALL} onChange={setTag} className="ideas-tags" /> : null}
      </div>

      {list.error && !list.data ? (
        <Notice tone="error" title={IDEAS.loadErrorTitle} role="alert" actions={<Button size="sm" icon={RotateCw} onClick={refresh}>{BUTTONS.retry}</Button>}>
          {list.error}
        </Notice>
      ) : null}
      {loading ? <Card className="ideas-list"><div className="ideas-skeleton"><SkeletonRow /><SkeletonRow /><SkeletonRow /></div></Card> : null}
      {empty ? (
        filtering ? (
          <EmptyState icon={Search} title={IDEAS.noMatchTitle} hint={IDEAS.noMatchHint}
            action={<Button variant="secondary" size="sm" onClick={() => { setQuery(""); setTag(ALL); }}>{IDEAS.clearFilters}</Button>} />
        ) : (
          <EmptyState icon={Lightbulb} tone="idea" title={IDEAS.emptyTitle} hint={IDEAS.emptyHint} />
        )
      ) : null}
      {groups.length ? (
        <Card className="ideas-list">
          {groups.map((group) => (
            <IdeaGroupSection key={group.key} label={group.label} count={group.ideas.length}>
              {group.ideas.map((idea) => (
                <IdeaRow
                  key={idea.id}
                  idea={idea}
                  timeZone={env.timeZone}
                  flash={flash === idea.id}
                  onTag={(value) => { setTag(value); setArchived(false); }}
                  onPin={() => void update(idea, { pinned: !idea.pinned }, idea.pinned ? IDEAS.toasts.unpinned : IDEAS.toasts.pinned).catch(() => {})}
                  onArchive={() => archive(idea)}
                  onDelete={() => remove(idea)}
                  onSave={(text) => update(idea, ideaFromText(text, new Date(), env.timeZone))}
                  onAccept={acceptTag}
                  onDismiss={dismissTag}
                  onToTodo={() => toTodo(idea)}
                />
              ))}
            </IdeaGroupSection>
          ))}
        </Card>
      ) : null}
    </div>
  );
}

function IdeaGroupSection({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const id = useId();
  return (
    <section className="idea-day" aria-labelledby={id}>
      <div className="q-ghead">
        <h3 id={id}>{label}</h3>
        <span className="count" aria-label={IDEAS.count(count)}>{count}</span>
      </div>
      <ul className="idea-list">{children}</ul>
    </section>
  );
}

interface IdeaRowProps {
  idea: IdeaView;
  timeZone: string;
  flash: boolean;
  onTag: (tag: string) => void;
  onPin: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onSave: (text: string) => Promise<void>;
  onAccept: (suggestionId: string, tag: string) => void;
  onDismiss: (suggestionId: string) => void;
  onToTodo: () => void;
}

export function ideaMenuItems(idea: IdeaView, actions: { edit: () => void; pin: () => void; archive: () => void; remove: () => void }): HabitMenuItem[] {
  return [
    { id: "edit", label: IDEAS.actions.edit, icon: Pencil, onSelect: actions.edit },
    ...(idea.archived ? [] : [{ id: "pin", label: idea.pinned ? IDEAS.actions.unpin : IDEAS.actions.pin, icon: idea.pinned ? PinOff : Pin, onSelect: actions.pin }]),
    { id: "archive", label: idea.archived ? IDEAS.actions.unarchive : IDEAS.actions.archive, icon: idea.archived ? ArchiveRestore : Archive, onSelect: actions.archive },
    { id: "delete", label: IDEAS.actions.delete, icon: Trash2, onSelect: actions.remove, danger: true },
  ];
}

function IdeaRow({ idea, timeZone, flash, onTag, onPin, onArchive, onDelete, onSave, onAccept, onDismiss, onToTodo }: IdeaRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing || !areaRef.current) return;
    const area = areaRef.current;
    area.focus();
    area.style.height = "auto";
    area.style.height = `${Math.min(280, area.scrollHeight)}px`;
  }, [editing, draft]);

  const startEdit = () => { setDraft(editableText(idea)); setEditing(true); };
  const save = () => {
    if (!draft.trim()) return;
    onSave(draft).then(() => setEditing(false)).catch(() => {});
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event.nativeEvent)) return;
    if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
    if (event.key === "Enter" && hasModKey(event, isApplePlatform())) { event.preventDefault(); save(); }
  };

  return (
    <li className={cx("idea-row", idea.pinned && "is-pinned", flash && "is-flash", editing && "is-editing")} data-idea={idea.id} tabIndex={-1}>
      <span className="idea-dot" aria-hidden="true" />
      <div className="idea-main">
        {editing ? (
          <div className="idea-edit">
            <textarea ref={areaRef} className="textarea" value={draft} maxLength={8000} aria-label={IDEAS.actions.edit} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} />
            <div className="idea-edit-acts">
              <Button variant="primary" size="sm" onClick={save}>{IDEAS.actions.save}</Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>{IDEAS.actions.cancel}</Button>
            </div>
          </div>
        ) : (
          <>
            {idea.title ? <p className="idea-title">{idea.title}</p> : null}
            <p className="idea-text kp">{idea.text}</p>
          </>
        )}
        {(idea.tags.length || idea.proposals.length) && !editing ? (
          <div className="idea-tags">
            {idea.tags.map((value) => (
              <button key={value} type="button" className="idea-tag" onClick={() => onTag(value)}>#{value}</button>
            ))}
            {idea.proposals.map((proposal) => (
              <span key={proposal.suggestionId} className="tag-proposal" title={IDEAS.proposalsTitle}>
                <button type="button" className="tag-proposal-add" aria-label={IDEAS.proposalLabel(proposal.tag)} onClick={() => onAccept(proposal.suggestionId, proposal.tag)}>
                  <Icon icon={Sparkles} size="xs" />#{proposal.tag}
                </button>
                <button type="button" className="tag-proposal-x" aria-label={IDEAS.proposalDismiss(proposal.tag)} onClick={() => onDismiss(proposal.suggestionId)}>
                  <Icon icon={X} size="xs" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="idea-side">
        <span className="idea-time mono">{localTime(timeZone, idea.createdAt)}</span>
        {editing ? null : (
          <div className="idea-acts">
            {idea.archived ? null : (
              <Button variant="ghost" size="sm" icon={ListTodo} className="idea-todo" aria-label={IDEAS.actions.toTodo} title={IDEAS.actions.toTodo} onClick={onToTodo}>
                <span className="idea-todo-label">{IDEAS.actions.toTodo}</span>
              </Button>
            )}
            <ExplainThis compact text={explainText(idea.title ?? "", idea.text)} title={idea.title || undefined} back={routeHref({ name: "ideas", id: idea.id })} />
            <SendToPr compact text={explainText(idea.title ?? "", idea.text)} title={idea.title || undefined} back={routeHref({ name: "ideas", id: idea.id })} />
            <span className="idea-desktop-actions">
              <Button variant="icon" size="sm" icon={Pencil} aria-label={IDEAS.actions.edit} title={IDEAS.actions.edit} onClick={startEdit} />
              {idea.archived ? null : <Button variant="icon" size="sm" icon={idea.pinned ? PinOff : Pin} aria-label={idea.pinned ? IDEAS.actions.unpin : IDEAS.actions.pin} title={idea.pinned ? IDEAS.actions.unpin : IDEAS.actions.pin} onClick={onPin} />}
              <Button variant="icon" size="sm" icon={idea.archived ? ArchiveRestore : Archive} aria-label={idea.archived ? IDEAS.actions.unarchive : IDEAS.actions.archive} title={idea.archived ? IDEAS.actions.unarchive : IDEAS.actions.archive} onClick={onArchive} />
              <Button variant="icon" size="sm" icon={Trash2} aria-label={IDEAS.actions.delete} title={IDEAS.actions.delete} onClick={onDelete} />
            </span>
            <span className="idea-compact-actions">
              <HabitMenu label={IDEAS.actions.more} items={ideaMenuItems(idea, { edit: startEdit, pin: onPin, archive: onArchive, remove: onDelete })} />
            </span>
          </div>
        )}
      </div>
    </li>
  );
}
