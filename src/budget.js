// -----------------------------------------------------------------------------
// Every state goes to Gladys through here: POST /state admits 300 states per
// minute per integration. The states wait in one queue, in the order they
// were measured, indexed by (feature, uplink time): the same uplink queued
// again replaces nothing and moves nothing, two uplinks of a feature both
// wait (a leak 0 -> 1 -> 0 is never squashed). Past a bound, the oldest are
// dropped. They leave in batches of at most 100, one batch at a time, within
// a budget of 300 over a sliding minute. Two publications started at the
// same moment share the same budget: the room is reserved before a batch is
// sent, and only one flush runs at a time. A batch counts from the END of its
// request (the core's minute starts when the states arrive).
// -----------------------------------------------------------------------------

import { MAX_PENDING_STATES, STATES_PER_MINUTE } from './constants.js';

const BATCH = 100;
const WINDOW = 60_000;

/** The state as Gladys receives it: without the queue's own `_key`. */
const wire = ({ _key, ...state }) => state;

const keyOf = (state) =>
  state._key ?? `${state.device_feature_external_id}|${state.created_at ?? 'live'}`;

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
    /** (feature, uplink time) -> state, in the order of measure */
    this.pending = new Map();
    /** [{ at, count }] sent over the last minute */
    this.sent = [];
    this.chain = Promise.resolve();
    this.dropped = 0;
  }

  /** Queue states (oldest first); an uplink already waiting stays where it is. */
  enqueue(states) {
    for (const state of states) {
      const key = keyOf(state);
      if (!this.pending.has(key)) {
        this.pending.set(key, { ...state, _key: key });
      }
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
        this.pending.delete(state._key);
      }
      // Reserved before the request, dated again when it ends: a failed
      // batch still counts (Gladys may have accepted part of it), never more
      // than the budget.
      const record = { at: this.now(), count: batch.length };
      this.sent.push(record);
      try {
        await this.gladys.publishStates(batch.map(wire));
        record.at = this.now();
        total += batch.length;
      } catch (err) {
        record.at = this.now();
        // Back in front of the queue, in the same order.
        const rest = [...this.pending.values()];
        this.pending = new Map();
        this.enqueue([...batch, ...rest]);
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
