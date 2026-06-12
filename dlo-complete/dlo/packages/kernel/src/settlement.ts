import type { RunToken } from "@dlo/core";
import { SettlementViolationError } from "@dlo/core";
import type { KernelIntent } from "./state-machine.js";

export interface JournalAppender {
  append(type: string, payload: unknown): Promise<void>;
}

export class SettlementTracker {
  #pending = new Map<
    RunToken,
    { epoch: number; intent: KernelIntent; registeredAt: number }
  >();
  #journal: JournalAppender;

  constructor(journal: JournalAppender) {
    this.#journal = journal;
  }

  register(token: RunToken, epoch: number, intent: KernelIntent): void {
    const existing = this.#pending.get(token);
    if (existing) {
      throw new SettlementViolationError(
        `RunToken ${token} is already registered`,
        "duplicate-token"
      );
    }
    this.#pending.set(token, { epoch, intent, registeredAt: Date.now() });
  }

  async trySettle(
    token: RunToken,
    currentEpoch: number
  ): Promise<
    | { accepted: true; intent: KernelIntent }
    | { accepted: false; reason: "unknown-token" | "epoch-mismatch" }
  > {
    const entry = this.#pending.get(token);

    if (!entry) {
      await this.#journal.append("settlement.discarded", {
        token,
        reason: "unknown-token",
      });
      return { accepted: false, reason: "unknown-token" };
    }

    if (entry.epoch !== currentEpoch) {
      this.#pending.delete(token);
      await this.#journal.append("settlement.discarded", {
        token,
        reason: "epoch-mismatch",
        tokenEpoch: entry.epoch,
        currentEpoch,
      });
      return { accepted: false, reason: "epoch-mismatch" };
    }

    this.#pending.delete(token);
    return { accepted: true, intent: entry.intent };
  }

  clear(): void {
    this.#pending.clear();
  }
}
