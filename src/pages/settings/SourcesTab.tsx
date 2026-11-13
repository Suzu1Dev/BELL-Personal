/**
 * 連線與設定 › 帳號與來源 (SPEC-ux §3.3, §5 "Source card", state 04): one
 * `.source-card` per source — Google, NYCU E3, Canvas, GitHub, CTFtime,
 * 活動訂閱, 天氣 — with its pill, last sync and actions. Credentials go
 * straight to the server's vault; nothing secret is kept in the browser.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { FeedSummary, GoogleStatus } from "../../../shared/connect";
import type { SourceId, SourceStatus } from "../../../shared/sources";
import type { SuitePrStatus } from "../../../shared/suite";
import type { WeatherLocation } from "../../../shared/weather";
import { ApiError } from "../../api";
import { ERRORS } from "../../copy/common";
import { SETTINGS, SOURCES } from "../../copy/settings";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Field, Switch, TextInput } from "../../components/Field";
import { Flag, GitPullRequest, GraduationCap, Mail, Plus, RefreshCw, Search, Ticket, Trash2, CloudSun } from "../../components/Icon";
import { TextLink } from "../../components/Link";
import { Notice } from "../../components/Notice";
import { useToast } from "../../components/toast/ToastProvider";
import { useStatus } from "../../lib/status";
import { notifySuiteRefresh } from "../../suite/useSuite";
import { SourceCard } from "./SourceCard";
import { OAUTH_START, settingsApi } from "./settings-api";
import { LmsConnectForm, type LmsKind } from "./LmsConnectForm";
import { checkFeed, checkWeight, type FieldErrors } from "./settings-forms";
import { cardState, syncPhrase } from "./settings-view";
import type { AppSettingsState } from "./useAppSettings";

const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : ERRORS.offline);

function useSyncNow() {
  const toast = useToast();
  const status = useStatus();
  return (ids: SourceId[], label: string) => {
    settingsApi.sync(ids)
      .then(() => {
        toast.success(SETTINGS.syncStarted(label));
        void status.refresh();
      })
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(SETTINGS.syncNow, reasonOf(cause))));
  };
}

function syncMeta(lastSyncedAt: string | undefined, account?: string): string {
  const sync = lastSyncedAt ? SETTINGS.lastSync(syncPhrase(lastSyncedAt)) : SETTINGS.neverSynced;
  return account ? `${account} · ${sync}` : sync;
}

/** A destructive action names both outcomes (brief B6 Dialog). */
function ConfirmDialog({ open, title, body, confirm, keep, onConfirm, onClose }: {
  open: boolean; title: string; body: ReactNode; confirm: string; keep: string; onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>{keep}</Button>
          <Button variant="danger" onClick={() => { onClose(); onConfirm(); }}>{confirm}</Button>
        </>
      )}
    >
      <p className="kp">{body}</p>
    </Dialog>
  );
}

export function SourcesTab({ app }: { app: AppSettingsState }) {
  const status = useStatus();
  const statuses = status.data?.sources;
  const vault = status.data?.vault.enabled ?? true;
  return (
    <div className="settings-stack">
      {!vault ? <Notice tone="warn" title={SETTINGS.vaultOffTitle}>{SETTINGS.vaultOffBody}</Notice> : null}
      <GoogleCard statuses={statuses} />
      <BellPrCard vault={vault} />
      <LmsCard kind="moodle" statuses={statuses} vault={vault} />
      <LmsCard kind="canvas" statuses={statuses} vault={vault} />
      <GithubCard statuses={statuses} login={status.data?.github.authenticated ? status.data.github.login ?? "" : undefined} />
      <CtftimeCard app={app} statuses={statuses} />
      <FeedsCard statuses={statuses} />
      <WeatherCard app={app} statuses={statuses} />
    </div>
  );
}

/* ---------------------------------------------------------------- Google */

export function useGoogleStatus() {
  const [google, setGoogle] = useState<GoogleStatus>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    settingsApi.google(controller.signal)
      .then((value) => {
        setGoogle(value);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(reasonOf(cause));
      });
    return () => controller.abort();
  }, [attempt]);
  return { google, error, reload: () => setAttempt((value) => value + 1), set: setGoogle };
}

/** Gmail and Calendar capabilities that were not granted, by name. */
export function missingCapabilities(google: GoogleStatus, scopes: Record<keyof typeof SOURCES.google.scopes, string> = SOURCES.google.scopes): string[] {
  const names: string[] = [];
  if (!google.capabilities.gmail) names.push(scopes.gmail);
  if (!google.capabilities.calendarRead) names.push(scopes.calendarRead);
  if (!google.capabilities.calendarWrite) names.push(scopes.calendarWrite);
  return names;
}

function GoogleCard({ statuses }: { statuses: SourceStatus[] | undefined }) {
  const { google, reload } = useGoogleStatus();
  const toast = useToast();
  const status = useStatus();
  const syncNow = useSyncNow();
  const [confirm, setConfirm] = useState(false);
  const card = cardState(statuses, ["gmail", "google-calendar"]);
  const connected = !!google?.connected;
  const vaultEnabled = google?.vaultEnabled ?? status.data?.vault.enabled ?? true;
  const guide = "#/settings/sources/google";
  const needsGuide = google?.clientKind === "desktop" || google?.clientConfigured === false;
  const start = () => {
    if (needsGuide) window.location.hash = guide;
    else window.location.assign(OAUTH_START);
  };

  const disconnect = () => {
    settingsApi.disconnectGoogle()
      .then((result) => {
        toast.success(result.revoked ? SOURCES.google.disconnected : SOURCES.google.disconnectedLocal);
        reload();
        void status.refresh();
      })
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(SETTINGS.disconnect, reasonOf(cause))));
  };

  const pill = connected
    ? { state: card.configured ? card.state : ("ok" as const) }
    : { state: "not_configured" as const, label: SOURCES.google.notAuthorized };
  const missing = google && connected ? missingCapabilities(google) : [];

  let actions: ReactNode;
  if (!connected) {
    actions = (
      <>
        <Button variant="primary" size="sm" disabled={!vaultEnabled} onClick={start}>{SOURCES.google.connect}</Button>
        <Button variant="ghost" size="sm" href={guide}>{SOURCES.google.guide}</Button>
      </>
    );
  } else if (card.state === "needs_reconnect") {
    actions = (
      <>
        <Button variant="primary" size="sm" onClick={start}>{SOURCES.google.reconnect}</Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>{SETTINGS.disconnect}</Button>
      </>
    );
  } else {
    actions = (
      <>
        <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => syncNow(["gmail", "google-calendar"], SOURCES.google.name)}>{SETTINGS.syncNow}</Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>{SETTINGS.disconnect}</Button>
        <TextLink href={guide}>{SOURCES.google.guide}</TextLink>
      </>
    );
  }

  return (
    <SourceCard
      id="google"
      icon={Mail}
      tone="mail"
      name={SOURCES.google.name}
      purpose={SOURCES.google.purpose}
      pill={pill}
      error={connected ? card.error : undefined}
      meta={connected ? syncMeta(card.lastSyncedAt, google?.email) : undefined}
      actions={actions}
      after={(
        <ConfirmDialog
          open={confirm}
          title={SOURCES.google.disconnectTitle}
          body={SOURCES.google.disconnectBody}
          confirm={SOURCES.google.disconnectConfirm}
          keep={SOURCES.google.disconnectKeep}
          onConfirm={disconnect}
          onClose={() => setConfirm(false)}
        />
      )}
    >
      {missing.length ? <p className="sc-note">{SOURCES.google.missing(missing.join("、"))}</p> : null}
    </SourceCard>
  );
}

/* ---------------------------------------------------------------- Moodle / Canvas */

function LmsCard({ kind, statuses, vault }: { kind: LmsKind; statuses: SourceStatus[] | undefined; vault: boolean }) {
  const copy = SOURCES[kind];
  const toast = useToast();
  const status = useStatus();
  const syncNow = useSyncNow();
  const card = cardState(statuses, [kind]);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // 連接 / 重新連線 unmounts when the form opens and the form's buttons when it closes: give focus back to
  // the card's main button (連接, or 立即同步 once the status shows the new connection), never to <body>.
  const actionRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const closeForm = () => {
    refocus.current = true;
    setOpen(false);
  };
  useEffect(() => {
    if (!refocus.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected) {
      if (active !== actionRef.current) refocus.current = false;
      return;
    }
    actionRef.current?.focus();
  });

  const disconnect = () => {
    (kind === "moodle" ? settingsApi.disconnectMoodle() : settingsApi.disconnectCanvas())
      .then(() => {
        toast.success(copy.disconnected);
        void status.refresh();
      })
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(SETTINGS.disconnect, reasonOf(cause))));
  };

  const connected = card.configured;
  const reconnect = card.state === "needs_reconnect";
  return (
    <SourceCard
      id={kind}
      icon={GraduationCap}
      tone="task"
      name={copy.name}
      purpose={copy.purpose}
      pill={{ state: card.state }}
      error={card.error}
      meta={connected ? syncMeta(card.lastSyncedAt) : undefined}
      actions={connected && !open ? (
        <>
          {reconnect
            ? <Button ref={actionRef} variant="primary" size="sm" onClick={() => setOpen(true)}>{SETTINGS.reconnect}</Button>
            : <Button ref={actionRef} variant="secondary" size="sm" icon={RefreshCw} onClick={() => syncNow([kind], copy.name)}>{SETTINGS.syncNow}</Button>}
          <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>{SETTINGS.disconnect}</Button>
        </>
      ) : !open ? (
        <Button ref={actionRef} variant={kind === "moodle" ? "primary" : "secondary"} size="sm" disabled={!vault} onClick={() => setOpen(true)}>{copy.connect}</Button>
      ) : undefined}
      after={(
        <ConfirmDialog
          open={confirm}
          title={copy.disconnectTitle}
          body={copy.disconnectBody}
          confirm={SETTINGS.disconnect}
          keep={SOURCES.google.disconnectKeep}
          onConfirm={disconnect}
          onClose={() => setConfirm(false)}
        />
      )}
    >
      {open ? <LmsConnectForm kind={kind} autoFocus onDone={closeForm} onCancel={closeForm} /> : null}
    </SourceCard>
  );
}

/* ---------------------------------------------------------------- GitHub */

function GithubCard({ statuses, login }: { statuses: SourceStatus[] | undefined; login: string | undefined }) {
  const syncNow = useSyncNow();
  const card = cardState(statuses, ["github"]);
  const detected = login !== undefined;
  return (
    <SourceCard
      id="github"
      icon={GitPullRequest}
      tone="info"
      name={SOURCES.github.name}
      purpose={detected ? `${SOURCES.github.purpose} ${SOURCES.github.detected(login || "")}` : SOURCES.github.purpose}
      pill={{ state: card.configured ? card.state : detected ? "ok" : "not_configured" }}
      error={card.error}
      meta={card.configured ? syncMeta(card.lastSyncedAt) : undefined}
      actions={card.configured ? <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => syncNow(["github"], SOURCES.github.name)}>{SETTINGS.syncNow}</Button> : undefined}
    >
      {detected ? null : <p className="sc-note">{SOURCES.github.missing}</p>}
    </SourceCard>
  );
}

/* ---------------------------------------------------------------- CTFtime */

function CtftimeCard({ app, statuses }: { app: AppSettingsState; statuses: SourceStatus[] | undefined }) {
  const card = cardState(statuses, ["ctftime"]);
  const enabled = app.settings?.["ctftime.enabled"] ?? false;
  const saved = app.settings?.["ctftime.minWeight"];
  const [weight, setWeight] = useState<string>();
  const [error, setError] = useState<string>();
  const value = weight ?? (saved !== undefined ? String(saved) : "");

  const commit = () => {
    if (weight === undefined || weight === String(saved)) return;
    const checked = checkWeight(weight);
    if (!checked.ok) {
      setError(checked.errors.weight);
      return;
    }
    setError(undefined);
    void app.save({ "ctftime.minWeight": checked.value }).then(() => setWeight(undefined));
  };

  return (
    <SourceCard
      id="ctftime"
      icon={Flag}
      tone="event"
      name={SOURCES.ctftime.name}
      purpose={SOURCES.ctftime.purpose}
      pill={{ state: !enabled ? "disabled" : card.configured ? card.state : "ok" }}
      error={enabled ? card.error : undefined}
      meta={enabled && card.lastSyncedAt ? syncMeta(card.lastSyncedAt) : undefined}
    >
      <div className="sc-rows">
        <Switch label={SOURCES.ctftime.enabled} checked={enabled} disabled={!app.settings} onChange={(on) => void app.save({ "ctftime.enabled": on })} />
        <Field label={SOURCES.ctftime.minWeight} hint={SOURCES.ctftime.minWeightHint} error={error} className="sc-short">
          <TextInput
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            value={value}
            disabled={!app.settings || !enabled}
            onChange={(event) => setWeight(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) commit(); }}
          />
        </Field>
      </div>
    </SourceCard>
  );
}

/* ---------------------------------------------------------------- Feeds */

function FeedsCard({ statuses }: { statuses: SourceStatus[] | undefined }) {
  const toast = useToast();
  const syncNow = useSyncNow();
  const card = cardState(statuses, ["feeds", "ics"]);
  const [feeds, setFeeds] = useState<FeedSummary[]>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [errors, setErrors] = useState<FieldErrors<"url" | "label">>({});
  const [busy, setBusy] = useState(false);
  /** Feeds hidden by 移除 whose DELETE waits for the undo toast to pass. */
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const listRef = useRef<HTMLUListElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const shown = feeds?.filter((feed) => !removing.has(feed.id));

  // The list exists once the events module registers its feeds source (a stub has no route).
  const available = statuses?.some((status) => status.id === "feeds");
  useEffect(() => {
    if (!available) return;
    const controller = new AbortController();
    settingsApi.feeds(controller.signal)
      .then((value) => {
        setFeeds(value.feeds);
        setLoadError(undefined);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setLoadError(reasonOf(cause));
      });
    return () => controller.abort();
  }, [attempt, available]);

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const checked = checkFeed({ url, label });
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      const feed = await settingsApi.addFeed(checked.value);
      setFeeds((list) => [...(list ?? []), feed]);
      setUrl("");
      setLabel("");
      toast.success(SOURCES.feeds.added(feed.label));
    } catch (cause) {
      // The address was refused (not a feed, a duplicate, unreachable): say so at the field, like the checks above.
      if (cause instanceof ApiError && [400, 409, 502, 504].includes(cause.status)) setErrors({ url: cause.message });
      else toast.error(ERRORS.actionFailed(SOURCES.feeds.add, reasonOf(cause)));
    } finally {
      setBusy(false);
    }
  };

  /**
   * 移除 is optimistic with an undo toast (AGENTS.md): the row leaves at once and DELETE is sent only when
   * the toast passes, because a private iCal address is shown masked and could not be added back from here.
   * Closing the page before then keeps the subscription.
   */
  const remove = (feed: FeedSummary) => {
    const visible = shown ?? [];
    const index = visible.findIndex((entry) => entry.id === feed.id);
    const next = visible[index + 1] ?? visible[index - 1];
    const keep = () => setRemoving((set) => {
      const copy = new Set(set);
      copy.delete(feed.id);
      return copy;
    });
    setRemoving((set) => new Set(set).add(feed.id));
    // Its 移除 button leaves with it: focus the neighbour's, or the address field.
    requestAnimationFrame(() => {
      const button = next ? listRef.current?.querySelector<HTMLButtonElement>(`[data-feed="${CSS.escape(next.id)}"]`) : null;
      (button ?? urlRef.current)?.focus();
    });
    toast.undo(SOURCES.feeds.removed(feed.label), keep, {
      icon: Trash2,
      onExpire: () => {
        settingsApi.removeFeed(feed.id)
          .then(() => {
            setFeeds((list) => list?.filter((entry) => entry.id !== feed.id));
            keep();
          })
          .catch((cause: unknown) => {
            keep();
            toast.error(ERRORS.actionFailed(SOURCES.feeds.remove, reasonOf(cause)), () => remove(feed));
          });
      },
    });
  };

  return (
    <SourceCard
      id="feeds"
      icon={Ticket}
      tone="event"
      name={SOURCES.feeds.name}
      purpose={SOURCES.feeds.purpose}
      pill={{ state: card.configured ? card.state : shown?.length ? "ok" : "not_configured" }}
      error={card.error}
      meta={card.lastSyncedAt ? syncMeta(card.lastSyncedAt) : undefined}
      actions={shown?.length ? <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => syncNow(["feeds", "ics"], SOURCES.feeds.name)}>{SETTINGS.syncNow}</Button> : undefined}
    >
      {loadError ? (
        <p className="sc-note">
          {SOURCES.feeds.failedToLoad}
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={() => setAttempt((value) => value + 1)}>{SETTINGS.retry}</Button>
        </p>
      ) : (shown && !shown.length) || (statuses && !available) ? (
        <p className="sc-note">{SOURCES.feeds.empty}</p>
      ) : shown ? (
        <ul className="feed-list" aria-label={SOURCES.feeds.listLabel} ref={listRef}>
          {shown.map((feed) => (
            <li key={feed.id}>
              <div>
                <b>{feed.label}</b>
                <span>
                  {[SOURCES.feeds.kinds[feed.kind] ?? feed.kind, feed.secret ? SOURCES.feeds.secret : feed.urlHint, SOURCES.feeds.events(feed.events)].join(" · ")}
                </span>
                {feed.lastError ? <span className="sc-error">{feed.lastError}</span> : null}
              </div>
              <Button variant="ghost" size="sm" data-feed={feed.id} aria-label={SOURCES.feeds.removeLabel(feed.label)} onClick={() => remove(feed)}>{SOURCES.feeds.remove}</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="sc-form sc-form-inline" onSubmit={add} noValidate>
        <Field label={SOURCES.feeds.url} hint={SOURCES.feeds.urlHint} error={errors.url}>
          <TextInput ref={urlRef} type="url" inputMode="url" value={url} placeholder="https://" onChange={(event) => setUrl(event.target.value)} />
        </Field>
        <Field label={SOURCES.feeds.label} error={errors.label}>
          <TextInput value={label} placeholder={SOURCES.feeds.labelPlaceholder} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <div className="sc-form-acts">
          <Button variant="secondary" type="submit" icon={Plus} disabled={busy}>{SOURCES.feeds.add}</Button>
        </div>
      </form>
    </SourceCard>
  );
}

/* ---------------------------------------------------------------- Weather */

function WeatherCard({ app, statuses }: { app: AppSettingsState; statuses: SourceStatus[] | undefined }) {
  const toast = useToast();
  const card = cardState(statuses, ["weather"]);
  const enabled = app.settings?.["weather.enabled"] ?? true;
  const location = app.settings?.["weather.location"];
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<(WeatherLocation & { label: string })[]>();
  const [busy, setBusy] = useState(false);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    try {
      setResults((await settingsApi.geocode(query.trim())).results);
    } catch (cause) {
      toast.error(ERRORS.actionFailed(SOURCES.weather.search, reasonOf(cause)));
    } finally {
      setBusy(false);
    }
  };

  const choose = (result: WeatherLocation & { label: string }) => {
    const { label: _label, ...rest } = result as WeatherLocation & { label: string; country?: string; admin?: string };
    const next: WeatherLocation = { name: rest.name, latitude: rest.latitude, longitude: rest.longitude, ...(rest.timezone ? { timezone: rest.timezone } : {}) };
    void app.save({ "weather.location": next }).then((ok) => {
      if (!ok) return;
      toast.success(SOURCES.weather.chosen(next.name));
      setResults(undefined);
      setQuery("");
    });
  };

  return (
    <SourceCard
      id="weather"
      icon={CloudSun}
      tone="event"
      name={SOURCES.weather.name}
      purpose={SOURCES.weather.purpose}
      pill={{ state: !enabled ? "disabled" : card.configured ? card.state : "ok" }}
      error={enabled ? card.error : undefined}
      meta={location ? SOURCES.weather.current(location.name) : undefined}
    >
      <div className="sc-rows">
        <Switch label={SOURCES.weather.enabled} checked={enabled} disabled={!app.settings} onChange={(on) => void app.save({ "weather.enabled": on })} />
        <form className="sc-search" onSubmit={search} role="search" noValidate>
          <Field label={SOURCES.weather.search}>
            <TextInput type="search" value={query} placeholder={SOURCES.weather.searchPlaceholder} disabled={!enabled} onChange={(event) => setQuery(event.target.value)} />
          </Field>
          <Button variant="secondary" type="submit" icon={Search} disabled={busy || !enabled}>{SOURCES.weather.searchSubmit}</Button>
        </form>
        {results ? (
          results.length ? (
            <ul className="geo-results" aria-label={SOURCES.weather.resultsLabel}>
              {results.map((result) => (
                <li key={`${result.latitude},${result.longitude}`}>
                  <span>{result.label}</span>
                  <Button variant="ghost" size="sm" aria-label={SOURCES.weather.chooseLabel(result.label)} onClick={() => choose(result)}>{SOURCES.weather.choose}</Button>
                </li>
              ))}
            </ul>
          ) : <p className="sc-note">{SOURCES.weather.noResults}</p>
        ) : null}
      </div>
    </SourceCard>
  );
}

/* ---------------------------------------------------------------- BELL PR (Suite) */

function BellPrCard({ vault }: { vault: boolean }) {
  const copy = SOURCES.bellPr;
  const toast = useToast();
  const [pr, setPr] = useState<SuitePrStatus>();
  const [open, setOpen] = useState(false);
  const [useToken, setUseToken] = useState(false);
  const [code, setCode] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    settingsApi.suitePr(controller.signal)
      .then(setPr)
      .catch(() => {});
    return () => controller.abort();
  }, []);

  if (!pr || (!pr.configured && !pr.connected)) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(undefined);
    const value = (useToken ? token : code).trim();
    if (!value) {
      setError(useToken ? copy.tokenPlaceholder : copy.codePlaceholder);
      return;
    }
    setBusy(true);
    try {
      const next = useToken ? await settingsApi.saveSuitePrToken(value) : await settingsApi.pairSuitePr(value);
      setPr(next);
      setCode("");
      setToken("");
      setOpen(false);
      notifySuiteRefresh();
      toast.success(copy.paired);
    } catch (cause) {
      setError(reasonOf(cause));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = () => {
    settingsApi.disconnectSuitePr()
      .then((next) => {
        setPr(next);
        notifySuiteRefresh();
        toast.success(copy.disconnected);
      })
      .catch((cause: unknown) => toast.error(ERRORS.actionFailed(SETTINGS.disconnect, reasonOf(cause))));
  };

  const meta = pr.connected
    ? pr.source === "env"
      ? copy.connectedEnv
      : copy.connectedDevice(pr.deviceName ?? "BELL Personal")
    : undefined;

  return (
    <SourceCard
      id="bell-pr"
      icon={GitPullRequest}
      tone="info"
      name={copy.name}
      purpose={copy.purpose}
      pill={{ state: pr.connected ? "ok" : "not_configured" }}
      meta={meta}
      actions={pr.connected ? (
        <>
          {pr.link ? <Button variant="secondary" size="sm" href={`${pr.link}/`}>{copy.openPr}</Button> : null}
          {pr.source !== "env" ? <Button variant="ghost" size="sm" onClick={() => setConfirm(true)}>{SETTINGS.disconnect}</Button> : null}
        </>
      ) : !open && pr.fetchConfigured ? (
        <Button variant="primary" size="sm" disabled={!vault} onClick={() => setOpen(true)}>{copy.connect}</Button>
      ) : pr.link ? (
        <Button variant="secondary" size="sm" href={`${pr.link}/`}>{copy.openPr}</Button>
      ) : undefined}
      after={(
        <ConfirmDialog
          open={confirm}
          title={copy.disconnectTitle}
          body={copy.disconnectBody}
          confirm={SETTINGS.disconnect}
          keep={SOURCES.google.disconnectKeep}
          onConfirm={disconnect}
          onClose={() => setConfirm(false)}
        />
      )}
    >
      {open && !pr.connected ? (
        <form className="sc-form" onSubmit={submit} noValidate>
          <Field label={useToken ? copy.tokenLabel : copy.codeLabel} hint={useToken ? undefined : copy.codeHint} error={error}>
            <TextInput
              type={useToken ? "password" : "text"}
              value={useToken ? token : code}
              placeholder={useToken ? copy.tokenPlaceholder : copy.codePlaceholder}
              autoComplete="off"
              onChange={(event) => (useToken ? setToken(event.target.value) : setCode(event.target.value))}
            />
          </Field>
          <div className="sc-form-acts">
            <Button variant="primary" size="sm" type="submit" disabled={busy}>
              {useToken ? copy.tokenSubmit : copy.pairSubmit}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => { setUseToken((v) => !v); setError(undefined); }}>
              {useToken ? copy.codeLabel : copy.tokenToggle}
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => { setOpen(false); setError(undefined); }}>
              {SETTINGS.cancel}
            </Button>
          </div>
        </form>
      ) : null}
    </SourceCard>
  );
}


