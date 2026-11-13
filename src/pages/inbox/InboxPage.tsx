/**
 * #/inbox and #/inbox/:threadId (SPEC-ux §3.3, SPEC-mail-assignments §2–§4):
 * AI-triaged Gmail, with the 收件匣 · 封存 · 全部 views and search.
 *  - ≥1180: the list and the reading pane side by side; moving the cursor
 *    (J/K, click) shows that conversation and rewrites the hash in place.
 *  - below: the list, and #/inbox/:threadId opens the reading pane in place.
 * The view and the query live in the hash (`?view=archive&q=…`) and are
 * rewritten in place as they change. 收件匣 lists the cache; 封存 and 全部
 * are read page by page from Gmail; a search filters what is loaded at once
 * and appends Gmail's other results 400 ms after typing stops (never while
 * an IME composes). Actions go through useToday().act() — the same
 * optimistic flow, undo toast and deferred Gmail write as the Today queue —
 * with the rows edited at once and the inbox refreshed when Today refreshes.
 * 用 AI 處理 in the reader asks the model what in the conversation belongs in
 * the calendar, the todos or the assignments; its proposals join the
 * reader's 從這封信找到 rows, each added with one tap (useMailProcess).
 */
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { INBOX_CATEGORIES, MAIL_SEARCH_LIMITS, type InboxSuggestion, type InboxThread, type MailAddress, type MailBodyView, type MailModuleStatus, type MailView } from "../../../shared/mail";
import type { AppSettings } from "../../../shared/settings";
import type { QueueAction } from "../../../shared/today";
import { queueAction } from "../../../shared/today-format";
import { api, send } from "../../api";
import { Button } from "../../components/Button";
import { ChipGroup, type ChipOption } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { Archive, Inbox, Mail, RefreshCw, Search, Sparkles, Unplug } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { SegmentedControl } from "../../components/SegmentedControl";
import { SkeletonRow, SkeletonStatus } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { Tile } from "../../components/Tile";
import { TOAST_DURATIONS, useToast } from "../../components/toast/ToastProvider";
import { ACTION_TOASTS, ERRORS, PAGE_HEADS } from "../../copy/common";
import { GMAIL_OFFLINE, INBOX, INBOX_CATEGORY_LABELS, INBOX_EMPTY, INBOX_NOTICES, INBOX_VIEWS, MAIL_BODY, MAIL_SEARCH, MAIL_SEARCH_EMPTY, MAIL_SEARCH_NOTICES } from "../../copy/inbox";
import { chooseMailView, useMailView } from "../../lib/preferences";
import { isComposing } from "../../lib/keys";
import { navigate, routeHref, type RouteOf } from "../../lib/router";
import { useShortcuts } from "../../lib/shortcuts";
import { useStatus } from "../../lib/status";
import { useToday } from "../../lib/today";
import { clockTime } from "../../lib/today-model";
import { MEDIA, useMediaQuery } from "../../lib/useMediaQuery";
import {
  applyThreadEdits, assignmentToast, enterOpens, filterThreads, focusFor, gmailBlocked, groupThreads, moveCursor, nextAfter, NO_FOCUS_REQUEST, offersProcess, offlineMessage, processNotice,
  requestFocus, rowStays, searchAnnouncement, searchTerms, threadVersion, toastFor, withoutShown, type InboxEdit, type InboxFilter,
} from "./inbox-model";
import { InboxList, PagesFooter, type ListSection } from "./InboxList";
import { MailReader } from "./MailReader";
import { SearchField } from "./SearchField";
import { useTrayDismiss } from "../today/swipe";
import { useInboxList, useMailPages, useThread, type EditHandle } from "./useInbox";
import { forgetMailBodies, mailBodyLoading, peekMailBody } from "./useMailBody";
import { useMailProcess, type ProcessDone } from "./useMailProcess";
import "./InboxPage.css";

const SPLIT = "(min-width: 1180px)";
const TOUCH = "(pointer: coarse), (max-width: 720px)";
/** Gmail is searched this long after the last keystroke (SPEC-mail-assignments §4.2 item 3). */
const SEARCH_DEBOUNCE_MS = 400;
const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

/** Enter on a focused button or link other than a row title belongs to that control. */
function ownsEnter(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const control = target.closest("button, a, summary, [role='menuitem']");
  return !!control && !control.classList.contains("q-title");
}

const cleanQuery = (text: string) => text.trim().slice(0, MAIL_SEARCH_LIMITS.query);

export default function InboxPage({ route }: { route: RouteOf<"inbox"> }) {
  const split = useMediaQuery(SPLIT);
  const touch = useMediaQuery(TOUCH);
  const phone = useMediaQuery(MEDIA.mobile);
  const today = useToday();
  const status = useStatus();
  const toast = useToast();
  const timeZone = status.data?.timeZone ?? "Asia/Taipei";

  /* ---------------------------------------------------------------- view and query */
  const [view, setView] = useState<MailView>(route.view ?? "inbox");
  const [text, setText] = useState(route.q ?? "");
  /** The query as typed and final (never mid-composition): drives the local filter and the hash. */
  const [query, setQuery] = useState(cleanQuery(route.q ?? ""));
  /** The query Gmail is asked, 400 ms behind. */
  const [gmailQuery, setGmailQuery] = useState(cleanQuery(route.q ?? ""));
  const searchInput = useRef<HTMLInputElement | null>(null);

  // A navigation (the palette's 搜尋信件, a link, back/forward) brings its own view and query.
  useEffect(() => {
    const q = route.q ?? "";
    setView(route.view ?? "inbox");
    setText((current) => (cleanQuery(current) === cleanQuery(q) ? current : q));
    setQuery(cleanQuery(q));
    setGmailQuery(cleanQuery(q));
  }, [route]);

  useEffect(() => {
    if (!query) { setGmailQuery(""); return; }
    if (query === gmailQuery) return;
    const timer = window.setTimeout(() => setGmailQuery(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, gmailQuery]);

  const searching = !!query;
  const terms = useMemo(() => searchTerms(query), [query]);

  /* ---------------------------------------------------------------- data */
  const inbox = useInboxList();
  const list = inbox.data;
  const viewPages = useMailPages(view !== "inbox" ? view : undefined, "");
  const search = useMailPages(gmailQuery ? view : undefined, gmailQuery);
  const [pageEdits, setPageEdits] = useState<Array<{ id: number; edit: InboxEdit }>>([]);
  const pageEditId = useRef(1);
  const edits = useMemo(() => pageEdits.map((entry) => entry.edit), [pageEdits]);

  /** One optimistic edit on every list it may touch (the cached inbox, and the 封存 / 全部 / search pages). */
  const edit = useCallback((change: InboxEdit): EditHandle => {
    const id = pageEditId.current++;
    const handle = inbox.edit(change);
    setPageEdits((current) => [...current, { id, edit: change }]);
    return {
      settle: () => handle.settle(),
      revert: () => { handle.revert(); setPageEdits((current) => current.filter((entry) => entry.id !== id)); },
    };
  }, [inbox]);

  const [filter, setFilter] = useState<InboxFilter>("all");
  const [cursor, setCursor] = useState<string | undefined>(route.threadId);
  const [snoozeFor, setSnoozeFor] = useState<string | undefined>();
  const [syncing, setSyncing] = useState(false);
  const [trayFor, setTrayFor] = useState<string>();
  const [announce, setAnnounce] = useState("");
  const titles = useRef(new Map<string, HTMLButtonElement>());
  const snoozeButton = useRef<HTMLButtonElement | null>(null);
  const [focusRequest, setFocusRequest] = useState(NO_FOCUS_REQUEST);
  /** Puts focus on a row's title after the render this causes (once; see requestFocus). */
  const focusRow = useCallback((target: string | undefined) => setFocusRequest((previous) => requestFocus(previous, target)), []);

  // Back/forward and links (#/inbox/:threadId) move the cursor.
  useEffect(() => {
    if (route.threadId) setCursor(route.threadId);
  }, [route.threadId]);

  const inboxThreads = useMemo(() => list?.threads ?? [], [list]);
  const viewThreads = useMemo(() => applyThreadEdits(viewPages.threads, edits, view), [viewPages.threads, edits, view]);
  const baseThreads = view === "inbox" ? inboxThreads : viewThreads;
  const local = useMemo(() => (searching ? filterThreads(baseThreads, terms) : []), [searching, baseThreads, terms]);
  const searchDone = searching && gmailQuery === query && search.state !== "loading" && search.state !== "idle";
  const remote = useMemo(
    () => (searching && gmailQuery === query ? withoutShown(local, applyThreadEdits(search.threads, edits, view)) : []),
    [searching, gmailQuery, query, local, search.threads, edits, view],
  );

  const sections = useMemo<ListSection[]>(() => {
    if (searching) {
      return [
        ...(local.length ? [{ key: "local", title: MAIL_SEARCH.matches(query), threads: local }] : []),
        ...(remote.length ? [{ key: "gmail", title: local.length ? MAIL_SEARCH.moreInGmail : MAIL_SEARCH.matches(query), threads: remote }] : []),
      ];
    }
    if (view === "inbox") {
      return groupThreads(inboxThreads, filter).map((group) => ({
        key: group.category, title: group.label, count: group.threads.length, category: group.category, unread: group.unread, threads: group.threads,
      }));
    }
    return viewThreads.length ? [{ key: view, title: view === "archive" ? MAIL_SEARCH.archiveGroup : MAIL_SEARCH.allGroup, hint: MAIL_SEARCH.byDate, threads: viewThreads }] : [];
  }, [searching, local, remote, query, view, inboxThreads, filter, viewThreads]);

  const order = useMemo(() => sections.flatMap((section) => section.threads.map((thread) => thread.threadId)), [sections]);
  const byId = useMemo(() => {
    const map = new Map<string, InboxThread>();
    for (const thread of [...inboxThreads, ...viewThreads, ...applyThreadEdits(search.threads, edits)]) if (!map.has(thread.threadId)) map.set(thread.threadId, thread);
    return map;
  }, [inboxThreads, viewThreads, search.threads, edits]);

  // On load the cursor is the first row (SPEC-ux §4.3), in the split view and the single list alike.
  const active = cursor && (order.includes(cursor) || cursor === route.threadId) ? cursor : order[0];
  const cursorRow = useRef(active);
  cursorRow.current = active;
  const readerId = split ? active : route.threadId;
  const reading = !split && !!route.threadId;
  const thread = useThread(readerId, threadVersion(readerId ? byId.get(readerId) : undefined));
  const readerThread = (readerId && byId.get(readerId)) || thread.data?.thread;

  // The live region: how many conversations matched, once Gmail answered (or failed and only local rows count).
  useEffect(() => {
    if (searchDone) setAnnounce(searchAnnouncement(local.length + remote.length));
  }, [searchDone, local.length, remote.length]);

  /** The hash for the list as it is now (the view and the query; a conversation when given). */
  const hashFor = useCallback((threadId?: string, next?: { view?: MailView; q?: string }) => routeHref({
    name: "inbox", ...(threadId ? { threadId } : {}), view: next?.view ?? view, q: next?.q ?? query,
  }), [view, query]);

  const replaceHash = (hash: string) => {
    if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
  };

  // Clearing a search restores the list as it was: its cursor comes back with it.
  const cursorBeforeSearch = useRef<string | undefined>(undefined);
  const wasSearching = useRef(searching);
  useEffect(() => {
    if (searching && !wasSearching.current) cursorBeforeSearch.current = cursorRow.current;
    if (!searching && wasSearching.current && cursorBeforeSearch.current) setCursor(cursorBeforeSearch.current);
    wasSearching.current = searching;
  }, [searching]);

  const onSearchInput = (value: string, final: boolean) => {
    setText(value);
    if (!final) return;
    const q = cleanQuery(value);
    setQuery(q);
    setTrayFor(undefined);
    replaceHash(hashFor(undefined, { q }));
  };

  const chooseView = (next: MailView) => {
    if (next === view) return;
    setView(next);
    setCursor(undefined);
    setSnoozeFor(undefined);
    setTrayFor(undefined);
    replaceHash(hashFor(undefined, { view: next }));
  };

  // Keyboard focus follows J/K and row actions onto a row's title: one request, used by the render it causes and never again.
  useLayoutEffect(() => {
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || !focused.isConnected;
    const target = focusFor(focusRequest, titles.current, lost);
    if (target === "main") document.getElementById("main")?.focus({ preventScroll: true });
    else target?.focus({ preventScroll: false });
  }, [focusRequest]);

  // A deep link (#/inbox/:threadId) brings its row into view once the list is there.
  const revealed = useRef(false);
  useEffect(() => {
    if (revealed.current || !list || !route.threadId) return;
    revealed.current = true;
    titles.current.get(route.threadId)?.scrollIntoView({ block: "center" });
  }, [list, route.threadId]);

  // Below 1180 a conversation replaces the list (#/inbox/:threadId). The shell leaves scroll and focus to
  // this page for that: opening one starts at the top, and coming back returns to where the list was, with
  // focus on the conversation just read, so triage goes on from there.
  const listScroll = useRef<number | null>(null);
  const rememberListScroll = () => { if (!split && !route.threadId) listScroll.current = window.scrollY; };
  const shownThread = useRef(reading ? route.threadId : undefined);
  useLayoutEffect(() => {
    const before = shownThread.current;
    const now = reading ? route.threadId : undefined;
    if (before === now) return;
    shownThread.current = now;
    const activeElement = document.activeElement;
    const lost = !activeElement || activeElement === document.body || !activeElement.isConnected;
    if (now) {
      window.scrollTo(0, 0);
      if (lost) document.getElementById("main")?.focus({ preventScroll: true });
      return;
    }
    const saved = listScroll.current;
    listScroll.current = null;
    if (saved !== null) window.scrollTo(0, saved);
    // Esc, 回到收件匣 or the back button: focus was in the reading view or on <main>; the topbar keeps its own.
    if (!lost && !activeElement.closest("#main")) return;
    const row = cursorRow.current ? titles.current.get(cursorRow.current) : undefined;
    row?.focus({ preventScroll: saved !== null });
  }, [reading, route.threadId]);

  // One swipe tray at a time: scrolling, Esc or touching anywhere else closes it (SPEC-mail-assignments §2.4).
  useTrayDismiss(trayFor, () => setTrayFor(undefined));

  const titleRef = useCallback((threadId: string, element: HTMLButtonElement | null) => {
    if (element) titles.current.set(threadId, element);
    else titles.current.delete(threadId);
  }, []);

  /** Moves the cursor; in the split view the reading pane follows and the hash is rewritten without a navigation. */
  const select = useCallback((threadId: string | undefined, options: { open?: boolean; focus?: boolean } = {}) => {
    setCursor(threadId);
    setSnoozeFor(undefined);
    if (options.focus) focusRow(threadId);
    if (!threadId) return;
    const hash = hashFor(threadId);
    if (split) {
      if (window.location.hash !== hash) window.history.replaceState(window.history.state, "", hash);
    } else if (options.open) {
      rememberListScroll();
      navigate(hash);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [split, route.threadId, hashFor, focusRow]);

  const leave = useCallback((threadId: string) => {
    const next = nextAfter(order, threadId);
    if (!split && route.threadId === threadId) {
      // Back to the list: the return to it focuses the cursor row (the reading view's effect above).
      navigate(hashFor());
      setCursor(next);
      return;
    }
    select(next, { focus: true });
  }, [order, split, route.threadId, select, hashFor]);

  // Without Gmail the actions that write to it would only come back refused (503): they say why instead.
  const source = (view === "inbox" ? list?.source : viewPages.source) ?? list?.source;
  const connected = source?.connected ?? true;
  const refuseOffline = useCallback((actions: QueueAction["id"][]) => {
    const message = offlineMessage(actions);
    if (message) toast.show({ kind: "error", message, icon: Unplug, duration: TOAST_DURATIONS.undo });
  }, [toast]);

  /** What runs an action on a conversation and the edit it makes (the server's answer replaces it later). */
  const run = useCallback((target: InboxThread, action: QueueAction) => {
    if (gmailBlocked(action.id, connected)) { refuseOffline([action.id]); return; }
    const title = target.subject;
    const settleOn = (handle: EditHandle) => (result: { ok: boolean }) => (result.ok ? handle.settle() : handle.revert());
    // The row stays but its hover buttons change: focus on one of them goes back to the row's title, never to <body>.
    const focused = document.activeElement;
    if (rowStays(action.id, view) && focused instanceof HTMLElement && focused.closest(`[data-row-id="${CSS.escape(target.threadId)}"] .q-acts`)) focusRow(target.threadId);
    switch (action.id) {
      case "reply": {
        window.open(target.webUrl, "_blank", "noopener,noreferrer");
        const handle = edit({ kind: "state", threadId: target.threadId, state: { kind: "replying" } });
        void today.act(target.itemId, "reply", undefined, { silent: true }).then(settleOn(handle));
        return;
      }
      case "open":
        window.open(target.webUrl, "_blank", "noopener,noreferrer");
        return;
      case "snooze":
        setCursor(target.threadId);
        if (!split && !route.threadId) {
          // The list is all there is: open the conversation, where 延後 has its menu.
          rememberListScroll();
          navigate(hashFor(target.threadId));
        }
        setSnoozeFor(target.threadId);
        return;
      case "archive":
      case "unarchive": {
        // In 全部 the row stays and changes sides; in 收件匣 and 封存 it leaves the list (applyThreadEdits).
        const handle = edit({ kind: "moved", threadIds: [target.threadId], location: action.id === "archive" ? "archive" : "inbox" });
        if (view !== "all") leave(target.threadId);
        void today.act(target.itemId, action.id, undefined, { message: toastFor(action.id, title), onUndo: handle.revert, onFailed: handle.revert }).then(settleOn(handle));
        return;
      }
      case "trash": {
        const handle = edit({ kind: "hide", threadIds: [target.threadId] });
        leave(target.threadId);
        void today.act(target.itemId, "trash", undefined, { message: toastFor("trash", title), onUndo: handle.revert, onFailed: handle.revert }).then(settleOn(handle));
        return;
      }
      case "read": {
        const handle = edit({ kind: "read", threadIds: [target.threadId] });
        void today.act(target.itemId, "read", undefined, { message: toastFor("read", title), onUndo: handle.revert, onFailed: handle.revert }).then(settleOn(handle));
        return;
      }
      case "todo": {
        const handle = edit({ kind: "state", threadId: target.threadId, state: { kind: "handled", action: "todo" } });
        void today.act(target.itemId, "todo", undefined, { message: toastFor("todo", title), onUndo: handle.revert }).then(settleOn(handle));
        return;
      }
      case "assignment": {
        const handle = edit({ kind: "state", threadId: target.threadId, state: { kind: "handled", action: "assignment" } });
        const latest = thread.data?.thread.threadId === target.threadId ? thread.data.messages.at(-1) : undefined;
        const message = assignmentToast(target, { text: latest?.excerpt ?? latest?.snippet, now: new Date(), timeZone });
        void today.act(target.itemId, "assignment", undefined, { message, onUndo: handle.revert }).then(settleOn(handle));
        return;
      }
      default:
        void today.act(target.itemId, action.id, undefined, { message: toastFor(action.id, title) });
    }
  }, [edit, today, leave, split, route.threadId, hashFor, view, searching, thread.data, timeZone, focusRow, connected, refuseOffline]);

  const pickSnooze = useCallback((until: string, label: string) => {
    const pick = { until, label };
    const target = snoozeFor ? byId.get(snoozeFor) ?? (thread.data?.thread.threadId === snoozeFor ? thread.data.thread : undefined) : undefined;
    setSnoozeFor(undefined);
    if (!target) return;
    const handle = edit({ kind: "hide", threadIds: [target.threadId], snoozed: true });
    leave(target.threadId);
    void today.act(target.itemId, "snooze", { until: pick.until, label: pick.label }, { message: toastFor("snooze", target.subject, { label: pick.label }), onUndo: handle.revert, onFailed: handle.revert })
      .then((result) => (result.ok ? handle.settle() : handle.revert()));
  }, [snoozeFor, byId, thread.data, edit, leave, today]);

  const closeSnooze = useCallback(() => {
    setSnoozeFor(undefined);
    snoozeButton.current?.focus();
  }, []);

  const markCategory = useCallback((category: InboxThread["category"], threads: InboxThread[]) => {
    const unread = threads.filter((item) => item.unread);
    if (!unread.length) return;
    if (gmailBlocked("read", connected)) { refuseOffline(["read"]); return; }
    const handle = edit({ kind: "read", threadIds: unread.map((item) => item.threadId) });
    void today.act(`gmail:category:${category}`, "read", undefined, { message: ACTION_TOASTS.readMany(unread.length), onUndo: handle.revert })
      .then((result) => (result.ok ? handle.settle() : handle.revert()));
  }, [edit, today, connected, refuseOffline]);

  /* ---------------------------------------------------------------- original layout (SPEC-mail-html §5) */
  const bodyView = useMailView();
  const pickBodyView = useCallback(function pick(next: MailBodyView) {
    // The reader follows at once; a failed save says the choice will not be remembered, with 重試.
    chooseMailView(next).catch((cause: unknown) => {
      toast.error(MAIL_BODY.viewFailed(cause instanceof Error ? cause.message : ERRORS.offline), () => pick(next));
    });
  }, [toast]);
  // How many times each message's images were asked for: asking again (顯示圖片 or I after a failed load) retries.
  const [imagesAsked, setImagesAsked] = useState<ReadonlyMap<string, number>>(new Map());
  const showImages = useCallback((messageId: string) => {
    setImagesAsked((current) => new Map(current).set(messageId, (current.get(messageId) ?? 0) + 1));
  }, []);
  /** Adds (or with `remove`, drops) an entry of 信任的寄件者; resolves whether the server stored it. */
  const saveTrusted = useCallback(async (entry: string, remove = false) => {
    const settings = await api<AppSettings>("/settings/app");
    const current = settings["mail.trustedImageSenders"] ?? [];
    const next = remove ? current.filter((item) => item !== entry) : [...current.filter((item) => item !== entry), entry];
    await api<AppSettings>("/settings/app", send("PUT", { "mail.trustedImageSenders": next }));
    forgetMailBodies();
  }, []);
  const trustSender = useCallback((sender: MailAddress, messageId: string) => {
    const entry = sender.email.trim().toLowerCase();
    const label = entry;
    // The images show at once (this message); the list is saved behind it, with 復原.
    showImages(messageId);
    saveTrusted(entry)
      .then(() => toast.undo(MAIL_BODY.trustToast(label), () => { void saveTrusted(entry, true).catch(() => undefined); }))
      .catch((cause: unknown) => toast.error(MAIL_BODY.trustFailed(cause instanceof Error ? cause.message : ERRORS.offline), () => trustSender(sender, messageId)));
  }, [saveTrusted, showImages, toast]);

  const [hiddenSuggestions, setHiddenSuggestions] = useState<ReadonlySet<string>>(new Set());
  const runSuggestion = useCallback((suggestion: InboxSuggestion, action: QueueAction) => {
    setHiddenSuggestions((current) => new Set([...current, suggestion.itemId]));
    const when = suggestion.meta.find((part) => part.endsWith("截止"));
    const show = () => setHiddenSuggestions((current) => new Set([...current].filter((id) => id !== suggestion.itemId)));
    void today.act(suggestion.itemId, action.id, undefined, { message: toastFor(action.id, suggestion.meta[0] ?? suggestion.title, { when }), onUndo: show }).then((result) => {
      if (!result.ok) show();
    });
  }, [today]);

  /* ---------------------------------------------------------------- 用 AI 處理 */
  const aiProcess = (status.data?.modules?.gmail as Partial<MailModuleStatus> | undefined)?.aiProcess ?? false;
  const refreshThread = thread.refresh;
  const processDone = useCallback<ProcessDone>((_threadId, outcome, retry) => {
    const notice = processNotice(outcome);
    if (notice.kind === "error") {
      toast.error(notice.message, retry);
      return;
    }
    toast.success(notice.message, Sparkles);
    // The reader lists the new suggestions under 從這封信找到; Today (and this list after it) has them as rows.
    refreshThread();
    void today.refresh();
  }, [toast, refreshThread, today]);
  const processor = useMailProcess(processDone);
  const processThread = thread.data?.thread ?? readerThread;

  const loadMore = useCallback(async (pages: typeof viewPages) => {
    const focused = document.activeElement;
    const fromButton = focused instanceof HTMLElement && focused.hasAttribute("data-load-more");
    const result = await pages.loadMore();
    // 載入更多 keeps focus while there is more; after the last page it is gone, so focus goes to the first new row (§9).
    if (result.ok && fromButton && !result.more) focusRow(result.firstAdded);
    if (result.ok) setAnnounce(MAIL_SEARCH.loaded(result.added));
    else if (result.expired) toast.error(MAIL_SEARCH.expired);
    else if (result.error) toast.error(MAIL_SEARCH.loadMoreFailed(result.error), () => { void loadMore(pages); });
  }, [toast, focusRow]);

  const syncNow = useCallback(async () => {
    setSyncing(true);
    try {
      await api("/sync", send("POST", { sources: ["gmail"], force: true }));
      for (let attempt = 0; attempt < 10; attempt++) {
        await wait(1500);
        const fresh = await api<{ source: { state: string } }>("/gmail/threads");
        if (fresh.source.state !== "syncing") break;
      }
    } catch { /* the notices and the sync chip report the outcome */ }
    finally {
      setSyncing(false);
      await Promise.allSettled([inbox.refresh(), today.refresh(), status.refresh()]);
    }
  }, [inbox, today, status]);

  /* ---------------------------------------------------------------- keys */
  const current = active ? byId.get(active) : undefined;
  const keyTarget = reading || split ? readerThread : current;
  const byKey = (key: QueueAction["key"]) => keyTarget?.actions.find((action) => action.key === key);
  const runKey = (key: QueueAction["key"]) => { const action = byKey(key); if (keyTarget && action) run(keyTarget, action); };
  const step = (delta: number) => {
    if (!reading) {
      // The first J or ↓ only steps into the list, onto the cursor row (SPEC-ux §6.1, like Today's queue).
      const focused = document.activeElement;
      const onRow = focused instanceof HTMLElement && focused.classList.contains("q-title") && !!focused.closest(".inbox-list");
      if (!onRow && active) {
        titles.current.get(active)?.focus();
        return;
      }
    }
    const next = moveCursor(order, reading ? route.threadId : active, delta);
    if (reading) { if (next && next !== route.threadId) navigate(hashFor(next)); }
    else select(next, { focus: true });
  };
  const focusSearch = () => {
    const input = searchInput.current;
    if (!input) return false;
    input.focus();
    input.select();
  };
  useShortcuts({
    j: () => step(1),
    arrowdown: () => { if (reading) return false; step(1); },
    k: () => step(-1),
    arrowup: () => { if (reading) return false; step(-1); },
    enter: (event) => {
      if (ownsEnter(event.target) || isComposing(event)) return false;
      // ↵ on a title in 封存, 全部 or a search opens the conversation (its first action would move the mail).
      const row = event.target instanceof HTMLElement && event.target.classList.contains("q-title") ? event.target.closest<HTMLElement>(".inbox-list [data-row-id]") : null;
      if (row?.dataset.rowId && !reading && enterOpens(view, searching)) {
        select(row.dataset.rowId, { open: true });
        return;
      }
      const action = keyTarget?.actions[0];
      if (!keyTarget || !action) return false;
      run(keyTarget, action);
    },
    e: () => runKey("E"),
    s: () => runKey("S"),
    t: () => runKey("T"),
    "#": () => runKey("#"),
    delete: () => runKey("#"),
    a: () => {
      // 加入作業 on the reader's assignment suggestion first (the model read it), else 轉成作業 on the conversation.
      const suggestion = (reading || split) ? thread.data?.suggestions.find((item) => !hiddenSuggestions.has(item.itemId) && item.kind === "suggestion.assignment") : undefined;
      if (suggestion?.actions[0]) { runSuggestion(suggestion, suggestion.actions[0]); return; }
      if (keyTarget) run(keyTarget, byKey("A") ?? queueAction("assignment"));
    },
    c: () => {
      const suggestion = thread.data?.suggestions.find((item) => !hiddenSuggestions.has(item.itemId) && item.actions[0]?.key === "C");
      if (suggestion) runSuggestion(suggestion, suggestion.actions[0]);
    },
    i: () => {
      // 顯示圖片 on the newest message of the open conversation, when its images are blocked.
      if (!(reading || split) || bodyView !== "original") return false;
      const latest = thread.data?.messages.at(-1);
      const body = latest ? peekMailBody(latest.id) : undefined;
      if (!latest || body?.kind !== "html" || !body.images.remote || body.images.shown) return false;
      // Already shown, or on its way; after a failed load I asks again.
      if (peekMailBody(latest.id, true) || mailBodyLoading(latest.id, true)) return false;
      showImages(latest.id);
    },
    "/": () => (reading ? false : focusSearch()),
    escape: () => {
      if (snoozeFor) { closeSnooze(); return; }
      if (reading) { navigate(hashFor()); return; }
      return false;
    },
  });

  /* ---------------------------------------------------------------- render */
  const offlineLine = (
    <>
      {" "}<span id="inbox-offline">{offlineMessage(["archive", "read", "trash", "unarchive"])}</span>{" "}
      <TextLink href={routeHref({ name: "settings", tab: "sources" })}>{GMAIL_OFFLINE.settings}</TextLink>
    </>
  );
  const connectButton = <Button size="sm" href={routeHref({ name: "google-guide" })}>{INBOX_EMPTY.connect}</Button>;

  const reconnectNotice = source?.state === "reconnect" ? (
    <div className="inbox-notes">
      <Notice tone="warn" role="alert" title={INBOX_NOTICES.reconnectTitle} actions={<Button size="sm" href={routeHref({ name: "settings", tab: "sources" })}>{INBOX_NOTICES.reconnect}</Button>}>
        {INBOX_NOTICES.reconnectBody(source.lastSyncedAt ? clockTime(source.lastSyncedAt, timeZone) : undefined)}
      </Notice>
    </div>
  ) : null;

  const inboxNotices = (
    <>
      {inbox.state === "stale" && inbox.updatedAt ? <div className="inbox-notes"><StaleNote time={clockTime(new Date(inbox.updatedAt).toISOString(), timeZone)} onRefresh={() => void inbox.refresh()} /></div> : null}
      {list && !connected && list.threads.length ? (
        <div className="inbox-notes">
          <Notice title={INBOX_NOTICES.notConnectedTitle} icon={Unplug} actions={connectButton}>{INBOX_NOTICES.notConnectedBody}{offlineLine}</Notice>
        </div>
      ) : null}
      {reconnectNotice}
      {source?.state === "error" ? (
        <div className="inbox-notes">
          <Notice tone="warn" title={INBOX_NOTICES.errorTitle} actions={<Button size="sm" onClick={() => void syncNow()} disabled={syncing}>{INBOX.syncNow}</Button>}>
            {INBOX_NOTICES.errorBody(source.message ?? "")}
          </Notice>
        </div>
      ) : null}
    </>
  );

  const viewNotices = (
    <>
      {viewPages.state === "error" ? (
        <div className="inbox-notes">
          <Notice tone="error" title={MAIL_SEARCH_NOTICES.archiveFailedTitle} actions={<Button size="sm" onClick={viewPages.reload}>{ERRORS.retry}</Button>}>{viewPages.error ?? ERRORS.offline}</Notice>
        </div>
      ) : null}
      {viewPages.gmailError ? (
        <div className="inbox-notes">
          <Notice tone="error" title={MAIL_SEARCH_NOTICES.archiveFailedTitle} actions={<Button size="sm" onClick={viewPages.reload}>{ERRORS.retry}</Button>}>{viewPages.gmailError}</Notice>
          {viewThreads.length ? <p className="inbox-cached">{MAIL_SEARCH_NOTICES.cachedRows}</p> : null}
        </div>
      ) : null}
      {!connected && viewThreads.length ? (
        <div className="inbox-notes">
          <Notice title={MAIL_SEARCH_NOTICES.notConnectedTitle} icon={Unplug} actions={connectButton}>{MAIL_SEARCH_NOTICES.notConnectedArchive}{offlineLine}</Notice>
        </div>
      ) : null}
      {reconnectNotice}
    </>
  );

  const searchNotices = (
    <>
      {search.state === "error" ? (
        <div className="inbox-notes">
          <Notice tone="warn" title={MAIL_SEARCH_NOTICES.searchFailedTitle} actions={<Button size="sm" onClick={search.reload}>{ERRORS.retry}</Button>}>
            {MAIL_SEARCH_NOTICES.searchFailedBody(search.error ?? ERRORS.offline)}
          </Notice>
        </div>
      ) : null}
      {search.gmailError ? (
        <div className="inbox-notes">
          <Notice tone="warn" title={MAIL_SEARCH_NOTICES.searchFailedTitle} actions={<Button size="sm" onClick={search.reload}>{ERRORS.retry}</Button>}>
            {MAIL_SEARCH_NOTICES.searchFailedBody(search.gmailError)}
          </Notice>
        </div>
      ) : null}
      {search.source && !search.source.connected ? (
        <div className="inbox-notes">
          <Notice title={MAIL_SEARCH_NOTICES.notConnectedTitle} icon={Unplug} actions={connectButton}>{MAIL_SEARCH_NOTICES.notConnectedSearch}{offlineLine}</Notice>
        </div>
      ) : null}
    </>
  );

  const pagesFooter = (pages: typeof viewPages, rows: number) => (
    <PagesFooter
      ready={pages.state === "ready"}
      nextPageToken={pages.nextPageToken}
      loadingMore={pages.loadingMore}
      origin={pages.origin}
      rows={rows}
      onLoadMore={() => void loadMore(pages)}
    />
  );

  let notices: ReactNode;
  let empty: ReactNode | undefined;
  let after: ReactNode = null;
  if (searching) {
    // Gmail's answer lands below the local results, never above them (§4.2 item 3, §4.3): its notices go there too.
    const waiting = gmailQuery !== query || search.state === "loading";
    after = (
      <>
        {waiting ? <div className="inbox-searching"><SkeletonStatus>{MAIL_SEARCH.searching}</SkeletonStatus></div> : null}
        {searchNotices}
        {waiting ? null : pagesFooter(search, local.length + remote.length)}
      </>
    );
    if (!waiting && !local.length && !remote.length && search.state !== "error" && !search.nextPageToken) {
      empty = (
        <div className="inbox-empty">
          {searchNotices}
          <EmptyState
            icon={Search}
            tone="mail"
            title={MAIL_SEARCH_EMPTY.noResultTitle(query)}
            hint={view === "all" ? MAIL_SEARCH_EMPTY.noResultHintAll : MAIL_SEARCH_EMPTY.noResultHint}
            action={view === "all" ? undefined : <Button onClick={() => chooseView("all")}>{MAIL_SEARCH.searchAll}</Button>}
          />
        </div>
      );
    }
  } else if (view === "inbox") {
    notices = inboxNotices;
    if (list && !list.threads.length) {
      empty = connected
        ? <div className="inbox-empty"><EmptyState icon={Inbox} tone="mail" title={INBOX_EMPTY.title} hint={INBOX_EMPTY.hint} /></div>
        : <div className="inbox-empty"><EmptyState icon={Unplug} title={INBOX_EMPTY.notConnectedTitle} hint={INBOX_EMPTY.notConnectedHint} action={<Button href={routeHref({ name: "google-guide" })}>{INBOX_EMPTY.connect}</Button>} /></div>;
    } else if (list && !sections.length) {
      empty = <p className="inbox-none">{INBOX_EMPTY.category(filter === "all" ? INBOX.all : INBOX_CATEGORY_LABELS[filter])}</p>;
    }
  } else {
    notices = viewNotices;
    if (viewPages.state === "loading" && !viewThreads.length) {
      empty = (
        <div className="inbox-skel" aria-busy="true">
          <p className="sr-only" role="status">{view === "archive" ? MAIL_SEARCH.loadingArchive : MAIL_SEARCH.loadingAll}</p>
          <SkeletonRow /><SkeletonRow /><SkeletonRow /><SkeletonRow />
        </div>
      );
    } else if (viewPages.state === "ready" && !viewThreads.length && !viewPages.nextPageToken) {
      empty = !connected
        ? <div className="inbox-empty"><EmptyState icon={Unplug} title={MAIL_SEARCH_EMPTY.notConnectedTitle} hint={MAIL_SEARCH_EMPTY.notConnectedHint} action={<Button href={routeHref({ name: "google-guide" })}>{INBOX_EMPTY.connect}</Button>} /></div>
        : view === "archive"
          ? <div className="inbox-empty"><EmptyState icon={Archive} tone="mail" title={MAIL_SEARCH_EMPTY.archiveTitle} hint={MAIL_SEARCH_EMPTY.archiveHint} /></div>
          : <div className="inbox-empty"><EmptyState icon={Inbox} tone="mail" title={MAIL_SEARCH_EMPTY.allTitle} hint={MAIL_SEARCH_EMPTY.allHint} /></div>;
    } else if (viewPages.state === "error" && !viewThreads.length) {
      empty = <></>;
    }
    after = pagesFooter(viewPages, viewThreads.length);
  }

  const chipOptions: ChipOption<InboxFilter>[] = [
    { value: "all", label: INBOX.all, count: inboxThreads.length },
    ...INBOX_CATEGORIES.map((category) => ({ value: category, label: INBOX_CATEGORY_LABELS[category], count: list?.counts[category] ?? 0 })),
  ];
  const chips = view === "inbox" && !searching && inboxThreads.length
    ? <ChipGroup label={INBOX.filterLabel} options={chipOptions} value={filter} allValue="all" onChange={(next) => { setFilter(next); setSnoozeFor(undefined); }} />
    : undefined;

  const tools = (
    <>
      <SearchField
        value={text}
        inputRef={searchInput}
        onInput={onSearchInput}
        onSubmit={() => { if (query) { setGmailQuery(query); if (gmailQuery === query) search.reload(); } }}
        onFirstResult={() => {
          if (!order[0]) return;
          select(order[0]);
          titles.current.get(order[0])?.focus();
        }}
        onLeave={() => {
          searchInput.current?.blur();
          const row = active ? titles.current.get(active) : undefined;
          if (row) row.focus();
          else document.getElementById("main")?.focus();
        }}
      />
      <SegmentedControl
        label={INBOX_VIEWS.label}
        className="inbox-views"
        value={view}
        onChange={chooseView}
        options={[{ value: "inbox", label: INBOX_VIEWS.inbox }, { value: "archive", label: INBOX_VIEWS.archive }, { value: "all", label: INBOX_VIEWS.all }]}
      />
    </>
  );

  const head = (
    <PageHead
      eyebrow={PAGE_HEADS.inbox.eyebrow}
      title={PAGE_HEADS.inbox.title}
      sub={list ? INBOX.sub(list.unread) : PAGE_HEADS.inbox.sub}
      actions={connected ? (
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => void syncNow()} disabled={syncing} className={syncing ? "is-busy" : undefined}>
          {syncing ? INBOX.syncing : INBOX.syncNow}
        </Button>
      ) : undefined}
    />
  );

  const reader = (
    <MailReader
      thread={readerThread}
      detail={thread.data}
      state={thread.state}
      error={thread.error}
      missing={thread.status === 404}
      onRetry={thread.refresh}
      onRun={run}
      offline={!connected}
      onSuggestion={runSuggestion}
      hiddenSuggestions={hiddenSuggestions}
      snooze={{
        open: !!snoozeFor && snoozeFor === readerThread?.threadId,
        now: new Date(),
        limit: readerThread?.snoozeLimit,
        sheet: phone,
        onPick: pickSnooze,
        onClose: closeSnooze,
      }}
      snoozeButtonRef={snoozeButton}
      touch={touch}
      timeZone={timeZone}
      bodyView={bodyView}
      onBodyView={pickBodyView}
      imagesAsked={imagesAsked}
      onShowImages={showImages}
      onTrust={trustSender}
      processMail={processThread && offersProcess(processThread, aiProcess) ? {
        running: processor.running.has(processThread.threadId),
        progress: processor.running.get(processThread.threadId) ?? "",
        onStart: () => { void processor.start(processThread.threadId); },
      } : undefined}
    />
  );

  if (reading) {
    return (
      <div className="inbox is-reading">
        <div className="inbox-back">
          <Button variant="ghost" size="sm" icon={ArrowLeft} href={hashFor()}>{INBOX.back}</Button>
        </div>
        {reader}
      </div>
    );
  }

  // A count only where it is the whole truth: 封存, 全部 and Gmail's results are partial pages (SPEC-mail-assignments §3.2).
  const count = view === "inbox" && !searching ? inboxThreads.length : undefined;
  const showReader = split && order.length > 0;
  return (
    <div className="inbox">
      {head}
      {inbox.state === "loading" && !list && view === "inbox" ? (
        <div className="inbox-layout">
          <section className="card queue inbox-list" aria-busy="true" aria-labelledby="inbox-list-title">
            <header className="q-head"><div className="card-head"><Tile icon={Inbox} tone="mail" /><h2 id="inbox-list-title">{INBOX.listTitle}</h2></div></header>
            <div className="inbox-skel"><SkeletonRow /><SkeletonRow /><SkeletonRow /><SkeletonRow /></div>
          </section>
        </div>
      ) : !list && view === "inbox" && !searching ? (
        <Notice tone="error" title={INBOX_NOTICES.loadFailedTitle} actions={<Button size="sm" onClick={() => void inbox.refresh()}>{ERRORS.retry}</Button>}>
          {inbox.error ?? ERRORS.offline}
        </Notice>
      ) : (
        <div className={showReader ? "inbox-layout is-split" : "inbox-layout"}>
          <InboxList
            count={count}
            rows={order.length}
            tools={tools}
            chips={chips}
            sections={sections}
            after={after}
            view={view}
            terms={terms}
            cursor={active}
            split={split}
            onSelect={(target) => select(target.threadId, { open: true })}
            onRun={run}
            offline={!connected}
            onMarkCategory={markCategory}
            titleRef={titleRef}
            notices={notices}
            empty={empty}
            snoozed={view === "inbox" && !searching ? list?.snoozed ?? 0 : 0}
            trayFor={trayFor}
            onTray={setTrayFor}
            announce={announce}
          />
          {showReader ? (readerId ? reader : (
            <section className="card mail-reader is-empty" id="mail-reader" aria-label={INBOX.readerLabel}>
              <EmptyState icon={Mail} tone="mail" title={INBOX_EMPTY.pickTitle} hint={INBOX_EMPTY.pickHint} />
            </section>
          )) : null}
        </div>
      )}
    </div>
  );
}
