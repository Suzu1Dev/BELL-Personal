import type { Migration } from "./migrate.js";

/**
 * Every table of every database, as ordered migration steps. Greenfield: all
 * DDL lives here, none in constructors. Rules (AGENTS.md, docs/ARCHITECTURE.md):
 *  - Never edit a step that may have run anywhere; append a new step instead.
 *  - Versions are consecutive integers per database. When two branches both
 *    append, the one merged second renumbers its step.
 *  - New columns are nullable or have a default; new JSON fields are optional.
 *
 * Document tables share one shape: (id TEXT PRIMARY KEY, json TEXT NOT NULL,
 * updated_at TEXT NOT NULL) plus derived index columns written by DocTable
 * from the document. Relational columns exist only where a query needs an
 * index (time windows, habit_logs).
 */

export const PERSONAL_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => db.exec(`
      CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        due_day TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX todos_status_due ON todos(status, due_day);
      CREATE INDEX todos_project ON todos(project_id);

      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX projects_status ON projects(status);

      CREATE TABLE habits (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE habit_logs (
        habit_id TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0),
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (habit_id, day)
      );
      CREATE INDEX habit_logs_day ON habit_logs(day);

      CREATE TABLE ideas (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE INDEX ideas_created ON ideas(archived, created_at);

      CREATE TABLE manual_events (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX manual_events_start ON manual_events(starts_at);

      CREATE TABLE daily_briefs (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL
      );
    `),
  },
  {
    // Today queue state (server/today): what the user did to each queue item,
    // and the log behind counts, pace, the handled list and undo.
    version: 2,
    up: (db) => db.exec(`
      CREATE TABLE item_state (
        item_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        until TEXT,
        day TEXT,
        fingerprint TEXT,
        action TEXT,
        action_id TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX item_state_state ON item_state(state, until);

      CREATE TABLE action_log (
        id TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        item_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        action TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        params TEXT,
        at TEXT NOT NULL,
        undone INTEGER NOT NULL DEFAULT 0,
        closes INTEGER NOT NULL DEFAULT 0,
        remote TEXT NOT NULL DEFAULT 'none',
        commit_at TEXT,
        error TEXT,
        previous TEXT,
        actor TEXT NOT NULL DEFAULT 'user',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX action_log_day ON action_log(day, undone);
      CREATE INDEX action_log_item ON action_log(item_id, at);
    `),
  },
  {
    // Event and calendar feed subscriptions (events module, FeedSubscription):
    // RSS/Atom/iCal URLs the user added. Secret URLs live in the vault as
    // ics.<id>; the row keeps only a display form.
    version: 3,
    up: (db) => db.exec(`
      CREATE TABLE event_feeds (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        target TEXT NOT NULL DEFAULT 'events',
        created_at TEXT NOT NULL
      );
    `),
  },
  {
    // Native assignments (lms module, SPEC-mail-assignments §5.1): announced in
    // a teacher's mail (origin mail, with the message id for 轉成作業's
    // one-per-mail check) or added on #/work (origin manual). The owner's own
    // records: mail retention, purge and disconnect never delete them.
    version: 4,
    up: (db) => db.exec(`
      CREATE TABLE local_assignments (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        origin TEXT NOT NULL,
        due_at TEXT,
        source_message_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX local_assignments_due ON local_assignments(due_at);
      CREATE INDEX local_assignments_message ON local_assignments(source_message_id);
    `),
  },
  {
    // Personal Bot conversation sessions and operation broker history (#/today).
    version: 5,
    up: (db) => db.exec(`
      CREATE TABLE bot_sessions (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX bot_sessions_updated ON bot_sessions(updated_at DESC);
    `),
  },
];

export const SOURCES_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => db.exec(`
      CREATE TABLE source_items (
        source TEXT NOT NULL,
        kind TEXT NOT NULL,
        external_id TEXT NOT NULL,
        json TEXT NOT NULL,
        starts_at TEXT,
        due_at TEXT,
        updated_at TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (source, external_id)
      );
      CREATE INDEX source_items_kind_start ON source_items(kind, starts_at);
      CREATE INDEX source_items_kind_due ON source_items(kind, due_at);
      CREATE INDEX source_items_fetched ON source_items(source, fetched_at);

      CREATE TABLE sync_state (
        source TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        cursor TEXT,
        last_synced_at TEXT,
        last_attempt_at TEXT,
        last_error TEXT,
        items INTEGER,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE ai_suggestions (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        dedupe_key TEXT UNIQUE,
        created_at TEXT NOT NULL
      );
      CREATE INDEX ai_suggestions_status ON ai_suggestions(status, kind, created_at);
    `),
  },
];

export const SETTINGS_MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => db.exec(`
      CREATE TABLE provider_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      );
      CREATE TABLE app_settings (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `),
  },
  {
    // The full settings key set (shared/settings.ts): two keys were renamed and
    // two retired by the Today redesign. Values keep their JSON shape.
    version: 2,
    up: (db) => db.exec(`
      UPDATE OR IGNORE app_settings SET key = 'brief.autoTime' WHERE key = 'brief.time';
      UPDATE OR IGNORE app_settings SET key = 'ctftime.enabled' WHERE key = 'events.ctftime';
      DELETE FROM app_settings WHERE key IN ('brief.time', 'events.ctftime', 'brief.enabled', 'today.widgetOrder');
    `),
  },
  {
    // CTFtime became opt-in (shared/settings.ts): a fresh install no longer fills the queue with
    // contests. An install that already tuned CTFtime (any `ctftime.*` row) was using it, so it
    // keeps it on instead of silently losing its events. An install that relied on the old default
    // without any row keeps it through the legacy onboarding migration (PRE_ONBOARDING_DEFAULTS).
    version: 3,
    up: (db) => db.exec(`
      INSERT OR IGNORE INTO app_settings (key, json, updated_at)
      SELECT 'ctftime.enabled', 'true', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE EXISTS (SELECT 1 FROM app_settings WHERE key LIKE 'ctftime.%');
    `),
  },
];
