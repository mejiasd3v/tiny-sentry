import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config";
import type { PreparedEvent } from "./event";
import { Outbox } from "./integrations/outbox";

export interface Issue {
  id: number;
  project_id: string;
  fingerprint: string;
  title: string;
  level: string;
  status: "unresolved" | "resolved";
  first_seen: number;
  last_seen: number;
  event_count: number;
}

export interface Notice { kind: "new_issue" | "regression"; issue: Issue }
export interface Ingestion { project: string; events: PreparedEvent[]; receivedAt: number }

export class Store {
  private db: Database;
  readonly outbox: Outbox;

  constructor(private config: Config) {
    if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
    this.db = new Database(config.dbPath, { create: true, strict: true });
    try {
      const version = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
      if (version > 3) throw new Error("Database schema is newer than this tiny-sentry version");
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
      const pageSize = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
      const maxPages = Math.floor(config.maxDbMb * 1024 * 1024 / pageSize);
      const actual = this.db.query<{ max_page_count: number }, []>(`PRAGMA max_page_count=${maxPages}`).get()!.max_page_count;
      if (actual > maxPages) throw new Error("Existing database exceeds MAX_DB_MB; raise the limit or prune it first");
      this.db.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS issues (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          title TEXT NOT NULL,
          level TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','resolved')),
          first_seen INTEGER NOT NULL,
          last_seen INTEGER NOT NULL,
          event_count INTEGER NOT NULL DEFAULT 0,
          UNIQUE(project_id, fingerprint)
        );
        CREATE TABLE IF NOT EXISTS events (
          project_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
          received_at INTEGER NOT NULL,
          environment TEXT,
          release TEXT,
          payload TEXT NOT NULL,
          PRIMARY KEY(project_id, event_id)
        );
        CREATE INDEX IF NOT EXISTS events_age ON events(received_at);
        CREATE INDEX IF NOT EXISTS events_issue ON events(issue_id, received_at DESC);
        CREATE INDEX IF NOT EXISTS issues_project ON issues(project_id, last_seen DESC);
        CREATE TABLE IF NOT EXISTS retention_state (
          id INTEGER PRIMARY KEY CHECK (id=1),
          event_count INTEGER NOT NULL CHECK (event_count>=0)
        );
        INSERT OR IGNORE INTO retention_state SELECT 1, COUNT(*) FROM events;
        CREATE TRIGGER IF NOT EXISTS events_insert_count AFTER INSERT ON events BEGIN
          UPDATE retention_state SET event_count=event_count+1 WHERE id=1;
        END;
        CREATE TRIGGER IF NOT EXISTS events_delete_cleanup AFTER DELETE ON events BEGIN
          UPDATE retention_state SET event_count=event_count-1 WHERE id=1;
          DELETE FROM issues WHERE id=old.issue_id
            AND NOT EXISTS (SELECT 1 FROM events WHERE issue_id=old.issue_id);
        END;
        CREATE TABLE IF NOT EXISTS integration_deliveries (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL,
          revision TEXT NOT NULL,
          issue_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('pending','delivering','delivered','failed','cancelled')),
          attempts INTEGER NOT NULL DEFAULT 0,
          available_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          lease TEXT
        );
        CREATE INDEX IF NOT EXISTS deliveries_due ON integration_deliveries(status,available_at);
        CREATE TABLE IF NOT EXISTS integration_state (id INTEGER PRIMARY KEY CHECK (id=1), dropped INTEGER NOT NULL);
        INSERT OR IGNORE INTO integration_state VALUES (1,0);
        PRAGMA user_version=3;
      `)).immediate();
      this.outbox = new Outbox(this.db, config.maxDeliveries);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  ingest(project: string, events: PreparedEvent[], now = Date.now()): Notice[] {
    return this.db.transaction(() => this.write(project, events, now)).immediate();
  }

  private write(project: string, events: PreparedEvent[], now: number): Notice[] {
    const notices = new Map<number, Notice>();
    for (const event of events) {
      if (this.db.query("SELECT 1 FROM events WHERE project_id=? AND event_id=?").get(project, event.id)) continue;
      const previous = this.db.query<Issue, [string, string]>("SELECT * FROM issues WHERE project_id=? AND fingerprint=?").get(project, event.fingerprint);
      const issue = this.db.query<Issue, [string, string, string, string, number, number]>(`
        INSERT INTO issues(project_id,fingerprint,title,level,first_seen,last_seen,event_count)
        VALUES (?,?,?,?,?,?,1)
        ON CONFLICT(project_id,fingerprint) DO UPDATE SET
          title=excluded.title, level=excluded.level, last_seen=excluded.last_seen,
          event_count=issues.event_count+1, status='unresolved'
        RETURNING *
      `).get(project, event.fingerprint, event.title, event.level, now, now)!;
      this.db.query("INSERT INTO events VALUES (?,?,?,?,?,?,?)").run(project, event.id, issue.id, now, event.environment, event.release, event.payload);
      if (this.config.integrations.length) this.outbox.enqueue(this.config.integrations, issue, previous, now);
      if (!previous || previous.status === "resolved") {
        notices.set(issue.id, { kind: previous ? "regression" : "new_issue", issue });
      } else if (notices.has(issue.id)) {
        notices.get(issue.id)!.issue = issue;
      }
    }
    this.pruneEvents(now);
    return [...notices.values()];
  }

  ingestBatch(requests: Ingestion[]): Notice[][] {
    return this.db.transaction(() => requests.map(({ project, events, receivedAt }) =>
      this.write(project, events, receivedAt),
    )).immediate();
  }

  prune(now = Date.now()) {
    this.db.transaction(() => this.pruneEvents(now)).immediate();
  }

  private pruneEvents(now: number) {
    this.db.query("DELETE FROM events WHERE received_at < ?").run(now - this.config.retentionDays * 86_400_000);
    const { event_count } = this.db.query<{ event_count: number }, []>(
      "SELECT event_count FROM retention_state WHERE id=1",
    ).get()!;
    const excess = event_count - this.config.maxEvents;
    if (excess > 0) this.db.query(`DELETE FROM events WHERE rowid IN (
      SELECT rowid FROM events ORDER BY received_at, rowid LIMIT ?
    )`).run(excess);
  }

  issues(project: string | null, status: string | null, limit: number, offset: number) {
    return this.db.query<Issue, [string | null, string | null, string | null, string | null, number, number]>(`
      SELECT * FROM issues WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR status=?)
      ORDER BY last_seen DESC, id DESC LIMIT ? OFFSET ?
    `).all(project, project, status, status, limit, offset);
  }

  issue(id: number) {
    return this.db.query<Issue, [number]>("SELECT * FROM issues WHERE id=?").get(id);
  }

  setStatus(id: number, status: "resolved" | "unresolved") {
    return this.db.query<Issue, [string, number]>("UPDATE issues SET status=? WHERE id=? RETURNING *").get(status, id);
  }

  events(issue: number, limit: number, offset: number) {
    return this.db.query<{ event_id: string; project_id: string; received_at: number; environment: string | null; release: string | null }, [number, number, number]>(`
      SELECT event_id,project_id,received_at,environment,release FROM events
      WHERE issue_id=? ORDER BY received_at DESC, rowid DESC LIMIT ? OFFSET ?
    `).all(issue, limit, offset);
  }

  event(project: string, id: string) {
    const row = this.db.query<{ payload: string; received_at: number; issue_id: number }, [string, string]>(
      "SELECT payload,received_at,issue_id FROM events WHERE project_id=? AND event_id=?",
    ).get(project, id);
    return row ? { issue_id: row.issue_id, received_at: row.received_at, event: JSON.parse(row.payload) as unknown } : null;
  }

  stats() {
    return {
      events: this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events").get()!.count,
      issues: this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM issues").get()!.count,
    };
  }

  healthy() { this.db.query("SELECT 1").get(); }
  backup(path: string) { this.db.query("VACUUM INTO ?").run(path); }
  close() { this.db.close(); }
}
