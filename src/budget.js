// -----------------------------------------------------------------------------
// Every state goes to Gladys through here: POST /state admits 300 states per
// minute per integration. The states wait in one queue (the newest value of
// a feature replaces an older one still waiting, the oldest are dropped past
// a bound) and leave in batches of at most 100, one batch at a time, within
// a budget of 300 over a sliding minute. Two publications started at the
// same moment share the same budget: the room is reserved before a batch is
// sent, and only one flush runs at a time.
// -----------------------------------------------------------------------------

import { MAX_PENDING_STATES, STATES_PER_MINUTE } from './constants.js';

const BATCH = 100;
const WINDOW = 60_000;

export class StateBudget {
  constructor({
    gladys,
    now = Date.now,
    logger,
    limit = STATES_PER_MINUTE,
    maxPending = MAX_PENDING_STATES,
  }) {
    this.gladys = gladys;
    this.now = now;
    this.logger = logger;
    this.limit = limit;
    this.maxPending = maxPending;
    /** feature external id -> state */
    this.pending = new Map();
    /** [{ at, count }] sent over the last minute */
    this.sent = [];
    this.chain = Promise.resolve();
    this.dropped = 0;
  }

  /** Queue states; a newer value of a feature replaces the one waiting. */
  enqueue(states) {
    for (const state of states) {
      const id = state.device_feature_external_id;
      const waiting = this.pending.get(id);
      if (waiting && waiting.created_at > state.created_at) {
        continue; // an older uplink never replaces a newer one
      }
      this.pending.delete(id);
      this.pending.set(id, state);
    }
    while (this.pending.size > this.maxPending) {
      this.pending.delete(this.pending.keys().next().value);
      this.dropped += 1;
    }
  }

  /** The room left in the current minute. */
  room() {
    const now = this.now();
    this.sent = this.sent.filter((s) => now - s.at < WINDOW);
    return this.limit - this.sent.reduce((sum, s) => sum + s.count, 0);
  }

  /** Send what the budget allows; never runs twice at once. Resolves the number sent. */
  flush() {
    const run = this.chain.catch(() => 0).then(() => this.send());
    this.chain = run.catch(() => 0);
    return run;
  }

  async send() {
    let total = 0;
    while (this.pending.size > 0) {
      const room = Math.min(BATCH, this.room());
      if (room <= 0) {
        break;
      }
      const batch = [...this.pending.values()].slice(0, room);
      for (const state of batch) {
        this.pending.delete(state.device_feature_external_id);
      }
      // Reserved before the request: a failed batch still counts (Gladys
      // may have accepted part of it), never more than the budget.
      this.sent.push({ at: this.now(), count: batch.length });
      try {
        await this.gladys.publishStates(batch);
        total += batch.length;
      } catch (err) {
        // Back in the queue, unless a newer value arrived meanwhile.
        for (const state of batch) {
          if (!this.pending.has(state.device_feature_external_id)) {
            this.pending.set(state.device_feature_external_id, state);
          }
        }
        this.logger?.warn?.(`Publishing the states failed: ${err?.message ?? err}`);
        break;
      }
    }
    return total;
  }

  /** Forget everything waiting (another application). */
  clear() {
    this.pending.clear();
  }
}
