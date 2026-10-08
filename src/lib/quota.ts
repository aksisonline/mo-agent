const DAY = 86_400_000;
const WEEK = 7 * DAY;
const IST = 0; // Monday 00:00 UTC; change this fixed offset if your policy requires it.
export function calendarWeek(now: number) {
  const local = new Date(now + IST);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const start = midnight - ((local.getUTCDay() + 6) % 7) * DAY - IST;
  return { start, resetsAt: new Date(start + WEEK).toISOString() };
}
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type Reservation = {
  allowed: boolean;
  remaining: number;
  resetsAt: string;
  reason?: "weekly_limit" | "rate_limit" | "in_flight" | "duplicate_turn";
  reservationId?: string;
};

// SQL operations run inside the Durable Object's transactionSync; no network I/O in the critical section.
export class QuotaLedger {
  constructor(private sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY, week INTEGER NOT NULL, reservation TEXT NOT NULL,
      status TEXT NOT NULL, expires INTEGER NOT NULL, memory_claimed INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec("CREATE TABLE IF NOT EXISTS attempts (at INTEGER NOT NULL)");
  }
  private used(week: number) {
    return this.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM turns WHERE week = ? AND status != 'failed'",
        week,
      )
      .one().count;
  }
  reserve(turnId: string, now: number): Reservation {
    const { start, resetsAt } = calendarWeek(now);
    this.sql.exec("DELETE FROM turns WHERE week < ?", start);
    this.sql.exec("DELETE FROM attempts WHERE at <= ?", now - 60_000);
    const remaining = Math.max(0, 20 - this.used(start));
    const denied = (reason: Reservation["reason"]): Reservation => ({
      allowed: false,
      reason,
      remaining,
      resetsAt,
    });
    if (this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM attempts").one().count >= 5)
      return denied("rate_limit");
    this.sql.exec("INSERT INTO attempts (at) VALUES (?)", now);
    if (this.sql.exec("SELECT id FROM turns WHERE id = ?", turnId).toArray().length)
      return denied("duplicate_turn");
    if (!remaining) return denied("weekly_limit");
    if (
      this.sql.exec("SELECT id FROM turns WHERE status = 'pending' AND expires > ?", now).toArray()
        .length
    )
      return denied("in_flight");
    const reservationId = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO turns (id, week, reservation, status, expires) VALUES (?, ?, ?, 'pending', ?)",
      turnId,
      start,
      reservationId,
      now + 150_000,
    );
    return { allowed: true, reservationId, remaining: remaining - 1, resetsAt };
  }
  finish(turnId: string, reservationId: string, succeeded: boolean, now: number) {
    this.sql.exec(
      `UPDATE turns SET status = ?, expires = ?
      WHERE id = ? AND reservation = ? AND status = 'pending' AND expires > ?`,
      succeeded ? "completed" : "failed",
      now + 600_000,
      turnId,
      reservationId,
      now,
    );
  }
  claimMemory(turnId: string, now: number) {
    return (
      this.sql
        .exec(
          `UPDATE turns SET memory_claimed = 1
      WHERE id = ? AND status = 'completed' AND expires > ? AND memory_claimed = 0 RETURNING id`,
          turnId,
          now,
        )
        .toArray().length === 1
    );
  }
}
