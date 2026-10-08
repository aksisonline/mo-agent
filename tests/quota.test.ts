import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { QuotaLedger, calendarWeek } from "../src/lib/quota";

function store() {
  const db = new Database(":memory:");
  const sql = {
    exec(query: string, ...params: (string | number)[]) {
      const rows = db.query(query).all(...params);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error("Expected one row");
          return rows[0];
        },
      };
    },
  } as unknown as SqlStorage;
  return new QuotaLedger(sql);
}
const now = Date.parse("2026-10-03T12:00:00Z");

test("calendar weeks reset Monday midnight in UTC, including year boundaries", () => {
  expect(calendarWeek(Date.parse("2026-10-04T23:59:59Z")).resetsAt).toBe(
    "2026-10-05T00:00:00.000Z",
  );
  expect(calendarWeek(Date.parse("2026-10-05T00:00:00Z")).resetsAt).toBe(
    "2026-10-12T00:00:00.000Z",
  );
  expect(calendarWeek(Date.parse("2027-01-01T00:00:00Z")).resetsAt).toBe(
    "2027-01-04T00:00:00.000Z",
  );
});
test("20 completed loops allowed, 21st blocked; next calendar week resets", () => {
  const ledger = store();
  for (let i = 0; i < 20; i++) {
    const at = now + i * 61_000;
    const result = ledger.reserve(String(i), at);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(19 - i);
    ledger.finish(String(i), result.reservationId!, true, at + 1);
  }
  expect(ledger.reserve("21", now + 20 * 61_000).reason).toBe("weekly_limit");
  expect(ledger.reserve("new-week", now + 7 * 86_400_000).remaining).toBe(19);
});
test("one in-flight turn; replay-safe finish and memory; pre-response failure restores quota", () => {
  const ledger = store();
  const first = ledger.reserve("first", now);
  expect(ledger.reserve("first", now + 1).reason).toBe("duplicate_turn");
  expect(ledger.reserve("other", now + 2).reason).toBe("in_flight");
  expect(ledger.claimMemory("first", now + 3)).toBe(false);
  ledger.finish("first", "wrong", false, now + 4);
  expect(ledger.reserve("other", now + 61_000).reason).toBe("in_flight");
  ledger.finish("first", first.reservationId!, false, now + 6);
  ledger.finish("first", first.reservationId!, true, now + 7);
  expect(ledger.claimMemory("first", now + 8)).toBe(false);
  const second = ledger.reserve("second", now + 61_000);
  expect(second.remaining).toBe(19);
  ledger.finish("second", second.reservationId!, true, now + 61_001);
  ledger.finish("second", second.reservationId!, false, now + 61_002);
  expect(ledger.claimMemory("second", now + 61_003)).toBe(true);
  expect(ledger.claimMemory("second", now + 61_004)).toBe(false);
});
test("five rolling attempts per minute, expired pending calls stay charged, memory expires", () => {
  const ledger = store();
  const first = ledger.reserve("one", now);
  for (let i = 0; i < 4; i++) expect(ledger.reserve(`blocked-${i}`, now + 1).allowed).toBe(false);
  expect(ledger.reserve("six", now + 2).reason).toBe("rate_limit");
  ledger.finish("one", first.reservationId!, false, now + 151_000);
  const second = ledger.reserve("two", now + 151_001);
  expect(second.remaining).toBe(18);
  ledger.finish("two", second.reservationId!, true, now + 151_002);
  expect(ledger.claimMemory("two", now + 751_003)).toBe(false);
});

test("five completed chats fit in a minute; rolling boundary releases an attempt", () => {
  const ledger = store();
  for (let i = 0; i < 5; i++) {
    const result = ledger.reserve(`chat-${i}`, now + i * 200);
    expect(result.allowed).toBe(true);
    ledger.finish(`chat-${i}`, result.reservationId!, true, now + i * 200 + 1);
  }
  expect(ledger.reserve("too-soon", now + 59_199).reason).toBe("rate_limit");
  expect(ledger.reserve("after-window", now + 60_000).allowed).toBe(true);
});
