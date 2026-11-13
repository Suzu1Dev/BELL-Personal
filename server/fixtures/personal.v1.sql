-- Frozen copy of personal.sqlite at schema version 1 (2026-10-12). Never edit:
-- later migrations must upgrade it, and server/db/database.test.ts must keep reading it.
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE todos (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        due_day TEXT,
        project_id TEXT,
        created_at TEXT NOT NULL
      );
INSERT INTO todos VALUES('fixture-todo','{"id":"fixture-todo","title":"繳電費","status":"open","priority":"normal","dueDay":"2026-10-13","origin":"manual","createdAt":"2026-10-12T00:00:00.000Z","updatedAt":"2026-10-12T00:00:00.000Z"}','2026-10-12T00:00:00.000Z','open','2026-10-13',NULL,'2026-10-12T00:00:00.000Z');
CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
CREATE TABLE habits (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
INSERT INTO habits VALUES('fixture-habit','{"id":"fixture-habit","name":"喝水","cadence":"daily","targetPerDay":1,"archived":false,"order":0,"createdAt":"2026-10-12T00:00:00.000Z","updatedAt":"2026-10-12T00:00:00.000Z"}','2026-10-12T00:00:00.000Z',0,0,'2026-10-12T00:00:00.000Z');
CREATE TABLE habit_logs (
        habit_id TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1 CHECK (count >= 0),
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (habit_id, day)
      );
INSERT INTO habit_logs VALUES('fixture-habit','2026-10-11',1,NULL,'2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z');
INSERT INTO habit_logs VALUES('fixture-habit','2026-10-12',1,NULL,'2026-10-12T00:00:00.000Z','2026-10-12T00:00:00.000Z');
CREATE TABLE ideas (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
INSERT INTO ideas VALUES('fixture-idea','{"id":"fixture-idea","text":"做一個每日儀表板","tags":["產品"],"pinned":false,"archived":false,"origin":"manual","createdAt":"2026-10-12T00:00:00.000Z","updatedAt":"2026-10-12T00:00:00.000Z"}','2026-10-12T00:00:00.000Z',0,0,'2026-10-12T00:00:00.000Z');
CREATE TABLE manual_events (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        starts_at TEXT NOT NULL,
        ends_at TEXT,
        created_at TEXT NOT NULL
      );
CREATE TABLE daily_briefs (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        source TEXT NOT NULL
      );
CREATE INDEX todos_status_due ON todos(status, due_day);
CREATE INDEX todos_project ON todos(project_id);
CREATE INDEX projects_status ON projects(status);
CREATE INDEX habit_logs_day ON habit_logs(day);
CREATE INDEX ideas_created ON ideas(archived, created_at);
CREATE INDEX manual_events_start ON manual_events(starts_at);
COMMIT;
PRAGMA user_version = 1;
