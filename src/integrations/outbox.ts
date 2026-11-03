import type { Database } from "bun:sqlite";
import type { Issue } from "../store";
import type { IntegrationRule, Notification } from "./types";

export interface DeliveryJob {
  id: string;
  integration_id: string;
  revision: string;
  issue_id: number;
  kind: Notification["kind"];
  payload: string;
  status: "pending" | "delivering" | "delivered" | "failed" | "cancelled";
  attempts: number;
  available_at: number;
  created_at: number;
  updated_at: number;
  lease: string | null;
}

export const maxAttempts = 6;
export const leaseMs = 30_000;

/** All enqueue operations run inside the event's existing transaction. */
export class Outbox {
  constructor(private db: Database, private limit: number) {}

  enqueue(rules: IntegrationRule[], issue: Issue, previous: Issue | null, now: number, eventId: string) {
    for (const rule of rules) {
      if (rule.projects && !rule.projects.includes(issue.project_id)) continue;
      if (rule.levels && !rule.levels.includes(issue.level)) continue;
      const trigger = rule.trigger;
      const matches = trigger.type === "threshold" ? issue.event_count === trigger.count
        : trigger.type === "new_issue" ? !previous : previous?.status === "resolved";
      if (!matches) continue;
      const count = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM integration_deliveries").get()!.count;
      if (count >= this.limit) {
        this.db.query(`DELETE FROM integration_deliveries WHERE id IN (
          SELECT id FROM integration_deliveries WHERE status IN ('delivered','failed','cancelled') ORDER BY updated_at, rowid LIMIT ?
        )`).run(count - this.limit + 1);
        if (this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM integration_deliveries").get()!.count >= this.limit) {
          this.db.exec("UPDATE integration_state SET dropped=dropped+1 WHERE id=1");
          continue;
        }
      }
      const notification: Notification = { kind: trigger.type, issue };
      if (rule.includeStacktrace) notification.event_id = eventId;
      this.db.query(`INSERT INTO integration_deliveries
        (id,integration_id,revision,issue_id,kind,payload,status,attempts,available_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'pending',0,?,?,?)`)
        .run(crypto.randomUUID(), rule.id, rule.revision, issue.id, trigger.type, JSON.stringify(notification), now, now, now);
    }
  }

  reconcile(rules: IntegrationRule[], now = Date.now()) {
    // A removed or edited rule cancels old jobs instead of retargeting them.
    this.db.transaction(() => {
      const active = new Set(rules.map((rule) => `${rule.id}:${rule.revision}`));
      const jobs = this.db.query<Pick<DeliveryJob, "id" | "integration_id" | "revision">, []>(
        "SELECT id,integration_id,revision FROM integration_deliveries WHERE status IN ('pending','delivering')",
      ).all();
      for (const job of jobs) if (!active.has(`${job.integration_id}:${job.revision}`)) {
        this.db.query("UPDATE integration_deliveries SET status='cancelled',lease=NULL,updated_at=? WHERE id=?").run(now, job.id);
      }
    }).immediate();
  }

  claim(now = Date.now()): DeliveryJob | null {
    return this.db.transaction(() => {
      this.db.query(`UPDATE integration_deliveries SET status='failed',lease=NULL,updated_at=?
        WHERE status='delivering' AND available_at<=? AND attempts>=?`).run(now, now, maxAttempts);
      return this.db.query<DeliveryJob, [string, number, number, number, number]>(`
        UPDATE integration_deliveries SET status='delivering',attempts=attempts+1,lease=?,available_at=?,updated_at=?
        WHERE id=(SELECT id FROM integration_deliveries WHERE status IN ('pending','delivering')
          AND available_at<=? AND attempts<? ORDER BY available_at, rowid LIMIT 1) RETURNING *
      `).get(crypto.randomUUID(), now + leaseMs, now, now, maxAttempts);
    }).immediate();
  }

  finish(job: DeliveryJob, status: "delivered" | "pending" | "failed", availableAt: number, now = Date.now()) {
    this.db.query(`UPDATE integration_deliveries SET status=?,available_at=?,updated_at=?,lease=NULL
      WHERE id=? AND status='delivering' AND lease=?`).run(status, availableAt, now, job.id, job.lease);
  }

  next() {
    return this.db.query<{ time: number | null }, []>(
      "SELECT MIN(available_at) AS time FROM integration_deliveries WHERE status IN ('pending','delivering')",
    ).get()!.time;
  }

  list(limit: number, offset: number) {
    return this.db.query<Omit<DeliveryJob, "payload" | "revision" | "lease">, [number, number]>(`
      SELECT id,integration_id,issue_id,kind,status,attempts,available_at,created_at,updated_at
      FROM integration_deliveries ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  stats() {
    return {
      dropped: this.db.query<{ dropped: number }, []>("SELECT dropped FROM integration_state WHERE id=1").get()!.dropped,
      counts: this.db.query<{ status: DeliveryJob["status"]; count: number }, []>(
        "SELECT status,COUNT(*) AS count FROM integration_deliveries GROUP BY status",
      ).all(),
    };
  }

  retry(id: string, rules: IntegrationRule[], now = Date.now()) {
    return this.db.transaction(() => {
      const job = this.db.query<DeliveryJob, [string]>("SELECT * FROM integration_deliveries WHERE id=? AND status='failed'").get(id);
      if (!job || !rules.some((rule) => rule.id === job.integration_id && rule.revision === job.revision)) return false;
      this.db.query("UPDATE integration_deliveries SET status='pending',attempts=0,available_at=?,updated_at=? WHERE id=?")
        .run(now, now, id);
      return true;
    }).immediate();
  }
}
