import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { prepareEvent } from "../src/event";
import { Store } from "../src/store";

const stores: Store[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function config() {
  const directory = mkdtempSync(join(tmpdir(), "tiny-sentry-retention-"));
  directories.push(directory);
  return { ...loadConfig({ ADMIN_TOKEN: "a".repeat(32), SENTRY_PROJECTS: JSON.stringify({ "1": "b".repeat(32) }) }),
    dbPath: join(directory, "events.sqlite"), maxEvents: 3, retentionDays: 1 };
}

function open(settings: ReturnType<typeof config>) {
  const store = new Store(settings);
  stores.push(store);
  return store;
}

function event(id: number, group = "shared") {
  return prepareEvent({ event_id: id.toString(16).padStart(32, "0"), message: group, fingerprint: [group] }, 1024)!;
}

test("retention keeps the newest events across projects, duplicates, batches and tied receive times", () => {
  const store = open(config());
  const now = Date.now();
  store.ingest("1", [event(1, "old"), event(2), event(3)], now);
  store.ingest("2", [event(4)], now);
  store.ingest("1", [event(3)], now); // Duplicate delivery must not evict anything.
  expect(store.stats()).toEqual({ events: 3, issues: 2 });
  expect(store.event("1", event(1).id)).toBeNull();
  expect(store.event("1", event(2).id)).not.toBeNull();
  // A backwards clock must not evict newer retained events.
  store.ingest("1", [event(5, "backdated")], now - 1);
  expect(store.event("1", event(5).id)).toBeNull();
  store.ingest("1", [event(6), event(7), event(8), event(9)], now + 1);
  expect(store.stats()).toEqual({ events: 3, issues: 1 });
  expect(store.events(store.event("1", event(9).id)!.issue_id, 10, 0).map((row) => row.event_id))
    .toEqual([event(9).id, event(8).id, event(7).id]);
  store.prune(now + 86_400_001); // Equal age boundary is retained.
  expect(store.stats()).toEqual({ events: 3, issues: 1 });
  store.prune(now + 86_400_002);
  expect(store.stats()).toEqual({ events: 0, issues: 0 });
});

test("retention stays exact across independent database connections and reopening with a smaller cap", () => {
  const settings = config();
  const first = open(settings);
  const second = open(settings);
  first.ingest("1", [event(1), event(2)]);
  second.ingest("1", [event(3), event(4)]);
  first.ingest("1", [event(5)]);
  expect(first.stats()).toEqual({ events: 3, issues: 1 });
  expect(first.event("1", event(2).id)).toBeNull();
  const reopened = open({ ...settings, maxEvents: 1 });
  reopened.prune();
  expect(reopened.stats()).toEqual({ events: 1, issues: 1 });
  expect(reopened.event("1", event(5).id)).not.toBeNull();
});

test("upgrades a populated v1 database without losing events or miscounting retention", () => {
  const settings = config();
  const legacy = new Database(settings.dbPath);
  try {
    legacy.exec(`
      CREATE TABLE issues (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        title TEXT NOT NULL, level TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'unresolved',
        first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, event_count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, fingerprint)
      );
      CREATE TABLE events (
        project_id TEXT NOT NULL, event_id TEXT NOT NULL,
        issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        received_at INTEGER NOT NULL, environment TEXT, release TEXT, payload TEXT NOT NULL,
        PRIMARY KEY(project_id, event_id)
      );
      PRAGMA user_version=1;
    `);
    const input = event(1);
    const now = Date.now();
    legacy.query("INSERT INTO issues VALUES (1,?,?,?,?,?,?,?,?)")
      .run("1", input.fingerprint, input.title, input.level, "resolved", now, now, 1);
    legacy.query("INSERT INTO events VALUES (?,?,?,?,?,?,?)")
      .run("1", input.id, 1, now, null, null, input.payload);
  } finally { legacy.close(); }
  const store = open(settings);
  expect(store.event("1", event(1).id)?.event).toEqual(JSON.parse(event(1).payload));
  expect(store.issue(1)?.status).toBe("resolved");
  expect(store.ingest("1", [event(2)])[0]?.kind).toBe("regression");
  store.ingest("1", [event(3), event(4)]);
  expect(store.stats()).toEqual({ events: 3, issues: 1 });
  expect(store.event("1", event(1).id)).toBeNull();
});
