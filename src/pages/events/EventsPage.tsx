/**
 * #/events (SPEC-ux §3.3 活動): filter chips 全部 · 要參加 · CTF · 社群 ·
 * 從信件找到, EventCards by date (date block, title, place, 「還有 N 天」, 要參加 /
 * 加入行事曆 / 略過), events found in mail as AI suggestions, 管理訂閱 →
 * 連線與設定, and the loading, empty, error and stale states.
 * Data: GET /api/events (usePoll, 5 min). Decisions go through the Today
 * action queue (POST /api/actions) so #/today, the badge and the undo
 * window stay one store.
 *
 * `#/events/<id>` (the queue item id: `ctftime:<id>`, `feed:<feed>:<key>` or
 * `ai:<suggestion>`): once the list is in, the card scrolls into view,
 * flashes and takes focus (the filter goes back to 全部 if it hid the card);
 * an id that is not listed shows 「找不到這個活動」.
 */
import { BookOpen, CalendarCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarGoogleInsertResponse } from "../../../shared/calendar";
import type { EventFilter, EventListItem, EventSourceState, EventsResponse } from "../../../shared/events";
import { api, send } from "../../api";
import { AiTag } from "../../components/AiTag";
import { Button } from "../../components/Button";
import { Card, CardHead } from "../../components/Card";
import { ChipGroup } from "../../components/Chip";
import { EmptyState } from "../../components/EmptyState";
import { CalendarPlus, Clock, Flag, Icon, RotateCw, Settings, Ticket } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { PageHead } from "../../components/PageHead";
import { Pill } from "../../components/Pill";
import { SkeletonRow } from "../../components/Skeleton";
import { StaleNote } from "../../components/StaleNote";
import { useToast } from "../../components/toast/ToastProvider";
import { EVENT_MODEL, EVENT_SHARED, EVENTS, EVENTS_PAGE_HEAD, eventServerError } from "../../copy/events";
import { onboardingLocale } from "../../copy/onboarding";
import { cx } from "../../lib/cx";
import { routeHref, type RouteOf } from "../../lib/router";
import { explainThisHref } from "../../suite/ExplainThis";
import { useSuiteLinks } from "../../suite/useSuite";
import { useToday } from "../../lib/today";
import { POLL_INTERVALS, usePoll } from "../../lib/usePoll";
import { syncedLabel } from "../calendar/calendar-model";
import { landOn, useFlash, useLandOnce } from "../not-found/deep-link";
import { MissingObject } from "../not-found/MissingObject";
import { allEntries, dateBlock, explainEventText, filterCounts, groupEntries, matchesFilter, metaLine, untilText, type EventBucket, type EventEntry } from "./events-model";
import "./EventsPage.css";

type Override = "going" | "hidden" | "google";

const errorText = (cause: unknown) => (cause instanceof Error ? eventServerError(cause.message) : EVENT_SHARED.offline);
const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

export default function EventsPage({ route }: { route: RouteOf<"events"> }) {
  const locale = onboardingLocale();
  const toast = useToast();
  const today = useToday();
  const fetcher = useCallback((signal: AbortSignal) => api<EventsResponse>("/events", { signal }), []);
  const poll = usePoll(fetcher, POLL_INTERVALS.calendar);
  const [filter, setFilter] = useState<EventFilter>("all");
  const [overrides, setOverrides] = useState<ReadonlyMap<string, Override>>(new Map());
  const [now] = useState(() => Date.now());
  const { refresh } = poll;

  const setOverride = (id: string, value: Override | undefined) => setOverrides((current) => {
    const next = new Map(current);
    if (value) next.set(id, value);
    else next.delete(id);
    return next;
  });

  const data = poll.data;
  const entries = useMemo(() => (data ? allEntries(data) : [])
    .filter((entry) => overrides.get(entry.id) !== "hidden")
    .map((entry): EventEntry => {
      const override = overrides.get(entry.id);
      if (entry.type !== "event" || !override) return entry;
      return { ...entry, item: { ...entry.item, going: true, inGoogle: entry.item.inGoogle || override === "google" } };
    }), [data, overrides]);
  const counts = filterCounts(entries);
  const visible = entries.filter((entry) => matchesFilter(entry, filter));

  // #/events/<id>: resolved once per id when the list is in (略過 on that card later does not turn it into 找不到).
  const linkId = route.id;
  const [linkState, setLinkState] = useState<{ id: string; found: boolean }>();
  const link = linkId && linkState?.id === linkId ? linkState : undefined;
  const resolved = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!linkId) { resolved.current = undefined; return; }
    if (!data || resolved.current === linkId) return;
    resolved.current = linkId;
    const entry = allEntries(data).find((candidate) => candidate.id === linkId);
    setLinkState({ id: linkId, found: !!entry });
    // A filter that hides the card goes back to 全部.
    if (entry) setFilter((current) => (matchesFilter(entry, current) ? current : "all"));
  }, [linkId, data]);
  const pageRef = useRef<HTMLDivElement>(null);
  const [flash, startFlash] = useFlash();
  useLandOnce(link?.found ? linkId : undefined, !!linkId && visible.some((entry) => entry.id === linkId), (id) => {
    startFlash(id);
    landOn(pageRef.current, "event", id);
  });

  /** 要參加 / 略過 / 加入行事曆 through the action queue, with this page's own undo toast. */
  const decide = async (entry: EventEntry, action: "going" | "calendar" | "dismiss") => {
    const title = entry.item.title;
    const optimistic: Override = action === "going" ? "going" : "hidden";
    setOverride(entry.id, optimistic);
    const result = await today.act(entry.id, action, undefined, { silent: true });
    if (!result.ok) {
      setOverride(entry.id, undefined);
      toast.error(EVENT_SHARED.actionFailed(EVENT_SHARED.actionLabels[action], eventServerError(result.error ?? EVENT_SHARED.offline, locale)), () => { void decide(entry, action); });
      return;
    }
    await refresh();
    setOverride(entry.id, undefined);
    const message = action === "going" ? EVENT_SHARED.actionToasts.going(title) : action === "calendar" ? EVENT_SHARED.actionToasts.calendar(title) : EVENT_SHARED.actionToasts.dismiss(title);
    toast.undo(message, () => {
      api(`/actions/${encodeURIComponent(result.actionId!)}`, send("DELETE"))
        .then(() => Promise.all([refresh(), today.refresh()]))
        .catch((cause: unknown) => toast.error(EVENT_SHARED.undoFailed(errorText(cause))));
    }, { icon: action === "dismiss" ? Trash2 : action === "going" ? Flag : CalendarPlus });
  };

  /** 加入行事曆 for an event already marked 要參加 but not in Google yet. */
  const addToGoogle = async (item: EventListItem) => {
    if (!item.manualEventId) return;
    setOverride(item.id, "google");
    try {
      const result = await api<CalendarGoogleInsertResponse>(`/calendar/events/${encodeURIComponent(item.manualEventId)}/google`, send("POST", {}));
      toast.undo(EVENTS.addedToGoogle(item.title), () => {
        setOverride(item.id, undefined);
        api(result.undoPath.replace(/^\/api/, ""), send("DELETE"))
          .then(() => refresh())
          .catch((cause: unknown) => toast.error(EVENT_SHARED.undoFailed(errorText(cause))));
      }, { icon: CalendarPlus });
      void refresh().then(() => setOverride(item.id, undefined));
    } catch (cause) {
      setOverride(item.id, undefined);
      toast.error(EVENT_SHARED.actionFailed(EVENTS.addToGoogleAction, errorText(cause)), () => { void addToGoogle(item); });
    }
  };

  const resync = async (id: EventSourceState["id"]) => {
    try {
      await api("/sync", send("POST", { sources: [id], force: true }));
      await wait(1500);
    } catch {
      // The notice keeps saying what is wrong.
    }
    await refresh();
  };

  const head = (
    <PageHead
      eyebrow=""
      title={EVENTS_PAGE_HEAD.title}
      sub=""
      actions={<Button variant="secondary" icon={Settings} href="#/settings/sources">{EVENTS.manage}</Button>}
    />
  );

  if (!data) {
    return (
      <div className="ev-page">
        {head}
        {poll.state === "error" ? (
          <Notice tone="error" role="alert" title={EVENTS.loadErrorTitle} actions={<Button variant="secondary" size="sm" icon={RotateCw} onClick={() => void refresh()}>{EVENTS.retry}</Button>}>
            {eventServerError(poll.error ?? EVENT_SHARED.offline, locale)}
          </Notice>
        ) : (
          <Card className="ev-group" aria-busy="true">
            <div className="ev-skel">{Array.from({ length: 4 }, (_, index) => <SkeletonRow key={index} />)}</div>
          </Card>
        )}
      </div>
    );
  }

  const timeZone = data.timeZone;
  const failing = data.sources.filter((source) => source.state === "error" || source.state === "reconnect");
  const stale = data.sources.filter((source) => source.state === "stale" && source.lastSyncedAt);
  const groups = groupEntries(visible, now, timeZone);

  if (link && !link.found) {
    return (
      <div className="ev-page">
        {head}
        <MissingObject icon={Ticket} tone="event" title={EVENTS.linked.missingTitle} hint={EVENTS.linked.missingHint} backHref="#/events" backLabel={EVENTS.linked.back} />
      </div>
    );
  }

  return (
    <div className="ev-page" ref={pageRef}>
      {head}
      <div className="ev-bar">
        <ChipGroup
          label={EVENTS.filterLabel}
          value={filter}
          allValue="all"
          onChange={setFilter}
          options={(["all", "going", "ctf", "community", "mail"] as const).map((value) => ({ value, label: EVENTS.filters[value], count: counts[value] }))}
        />
      </div>

      {failing.map((source) => (
        <Notice
          key={source.id}
          tone="warn"
          title={source.id === "ctftime" ? EVENTS.ctftimeErrorTitle : EVENTS.feedsErrorTitle}
          actions={<Button variant="secondary" size="sm" icon={RotateCw} onClick={() => void resync(source.id)}>{EVENTS.retry}</Button>}
          className="ev-notice"
        >
          {source.lastSyncedAt ? EVENTS.showingAt(syncedLabel(source.lastSyncedAt, data.today, timeZone, locale)) : source.message ? eventServerError(source.message, locale) : ""}
        </Notice>
      ))}

      {!entries.length ? (
        <EmptyState
          icon={Ticket}
          tone="event"
          title={EVENTS.emptyTitle}
          hint={EVENTS.emptyHint}
          action={<Button variant="secondary" icon={Settings} href="#/settings/sources">{EVENTS.manage}</Button>}
        />
      ) : !visible.length ? (
        <Card className="ev-group">
          <p className="ev-none kp">{filter === "ctf" && !data.settings.ctftimeEnabled ? EVENTS.ctftimeOff : EVENTS.noMatch}</p>
          <Button variant="ghost" size="sm" onClick={() => setFilter("all")}>{EVENTS.showAll}</Button>
        </Card>
      ) : (
        groups.map((group) => (
          <Card key={group.bucket} className="ev-group" aria-labelledby={`ev-${group.bucket}`}>
            <CardHead titleId={`ev-${group.bucket}`} title={bucketTitle(group.bucket)} count={group.entries.length} countLabel={EVENTS.countLabel(group.entries.length)} />
            <ul className="ev-list">
              {group.entries.map((entry) => (
                <EventCard
                  key={entry.id}
                  entry={entry}
                  now={now}
                  timeZone={timeZone}
                  canWrite={data.google.canWrite}
                  flash={entry.id === flash}
                  onDecide={(action) => void decide(entry, action)}
                  onAddToGoogle={(item) => void addToGoogle(item)}
                />
              ))}
            </ul>
          </Card>
        ))
      )}

      {stale.map((source) => (
        <EventStaleNote
          key={source.id}
          time={syncedLabel(source.lastSyncedAt!, data.today, timeZone, locale)}
          text={EVENTS.staleSource(EVENT_MODEL.sourceLabels[source.id], syncedLabel(source.lastSyncedAt!, data.today, timeZone, locale))}
          onRefresh={() => void resync(source.id)}
        />
      ))}
      {poll.state === "stale" && poll.updatedAt ? <EventStaleNote time={syncedLabel(new Date(poll.updatedAt).toISOString(), data.today, timeZone, locale)} onRefresh={() => void refresh()} /> : null}
    </div>
  );
}

function bucketTitle(bucket: EventBucket): string {
  return EVENTS.groups[bucket];
}

function EventStaleNote({ time, text, onRefresh }: { time: string; text?: string; onRefresh: () => void }) {
  if (onboardingLocale() === "zh-TW") return <StaleNote time={time} text={text} onRefresh={onRefresh} />;
  return (
    <p className="stale-note">
      <Icon icon={Clock} size="sm" />
      <span>{text ?? EVENT_SHARED.staleShowing(time)} · </span>
      <button type="button" onClick={onRefresh}>{EVENT_SHARED.staleRefresh}</button>
    </p>
  );
}

function EventExplainThis({ text, title, back }: { text: string; title: string; back: string }) {
  const links = useSuiteLinks();
  const href = explainThisHref(links.explain, { text, title, back });
  if (!href) return null;
  return (
    <Button
      href={href}
      variant="ghost"
      size="sm"
      icon={BookOpen}
      className="explain-this is-compact"
      title={EVENT_SHARED.explainThis.description}
      aria-description={EVENT_SHARED.explainThis.description}
    >
      {EVENT_SHARED.explainThis.label}
    </Button>
  );
}

interface EventCardProps {
  entry: EventEntry;
  now: number;
  timeZone: string;
  canWrite: boolean;
  /** Just landed on from `#/events/<id>`. */
  flash?: boolean;
  onDecide: (action: "going" | "calendar" | "dismiss") => void;
  onAddToGoogle: (item: EventListItem) => void;
}

export function EventCard({ entry, now, timeZone, canWrite, flash, onDecide, onAddToGoogle }: EventCardProps) {
  const block = dateBlock(entry.start, now, timeZone);
  const until = untilText(entry, now, timeZone);
  const suggestion = entry.type === "suggestion";
  const going = entry.type === "event" && entry.item.going;
  const url = entry.item.url;
  const linkLabel = suggestion ? EVENTS.openMail : entry.item.category === "ctf" ? EVENTS.openCtftime : EVENTS.open;
  return (
    <li
      className={cx("event-card", suggestion && "is-ai", going && "is-going", flash && "is-flash")}
      data-event={entry.id}
      tabIndex={-1}
      aria-label={EVENTS.cardAria(entry.item.title, `${block.date} ${block.label}`)}
    >
      <span className="dblock" aria-hidden="true"><b>{block.date}</b><span>{block.label}</span></span>
      <div className="ev-main">
        <div className="ev-top">
          <h3 className="ev-title">
            {suggestion ? <AiTag kind="suggestion" title={EVENTS.aiTitle} /> : null}
            <span className="kp">{entry.item.title}</span>
          </h3>
          <span className={cx("ev-when", until.muted && "is-muted")}>{until.label}</span>
        </div>
        <p className="ev-meta">{metaLine(entry, timeZone)}</p>
        <div className="ev-acts">
          {suggestion ? (
            <>
              <Button variant="secondary" size="sm" icon={CalendarPlus} onClick={() => onDecide("calendar")}>{EVENTS.addToCalendar}</Button>
              <Button variant="ghost" size="sm" onClick={() => onDecide("dismiss")}>{EVENTS.skip}</Button>
            </>
          ) : going ? (
            <>
              <Pill tone="ok" dot>{EVENTS.goingDone}</Pill>
              {entry.item.inGoogle ? (
                <span className="ev-incal"><Icon icon={CalendarCheck} size="sm" />{EVENTS.inCalendar}</span>
              ) : canWrite ? (
                <Button variant="secondary" size="sm" icon={CalendarPlus} onClick={() => onAddToGoogle(entry.item)}>{EVENTS.addToCalendar}</Button>
              ) : null}
            </>
          ) : (
            <>
              <Button variant="secondary" size="sm" icon={Flag} onClick={() => onDecide("going")}>{EVENTS.going}</Button>
              <Button variant="ghost" size="sm" onClick={() => onDecide("dismiss")}>{EVENTS.skip}</Button>
            </>
          )}
          <EventExplainThis text={explainEventText(entry, timeZone)} title={entry.item.title} back={routeHref({ name: "events", id: entry.id })} />
          {url ? <TextLink href={url} external className="ev-link">{linkLabel}</TextLink> : null}
        </div>
      </div>
    </li>
  );
}
