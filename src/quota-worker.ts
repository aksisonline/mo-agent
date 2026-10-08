import { DurableObject } from "cloudflare:workers";
import { QuotaLedger } from "./lib/quota";

export class MoQuota extends DurableObject<Env> {
  private ledger: QuotaLedger;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ledger = new QuotaLedger(ctx.storage.sql);
  }
  reserve(turnId: string) {
    const result = this.ctx.storage.transactionSync(() => this.ledger.reserve(turnId, Date.now()));
    // Delete inactive visitor state after two weeks; completed grants expire after ten minutes.
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 14 * 86_400_000));
    return result;
  }
  finish(turnId: string, reservationId: string, succeeded: boolean) {
    this.ctx.storage.transactionSync(() =>
      this.ledger.finish(turnId, reservationId, succeeded, Date.now()),
    );
  }
  claimMemory(turnId: string) {
    return this.ctx.storage.transactionSync(() => this.ledger.claimMemory(turnId, Date.now()));
  }
  async alarm() {
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM turns");
      this.ctx.storage.sql.exec("DELETE FROM attempts");
    });
  }
}
