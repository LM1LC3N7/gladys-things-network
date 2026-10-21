// -----------------------------------------------------------------------------
// Every state goes to Gladys through here: POST /state admits 300 states per
// minute per integration. Two queues, each in the order of measure, indexed
// by (feature, uplink time) (the same uplink queued again replaces nothing
// and moves nothing; two uplinks of a feature both wait: a leak 0 -> 1 -> 0
// is never squashed):
//
// - the live states (no `created_at`: the core runs the scenes on them) leave
//   first and are never dropped for the catch-up; one that waited too long
//   (its uplink older than `liveMaxAge()`) leaves dated instead, so a scene
//   never fires late on an old value;
// - the dated states (catch-up, history) leave after; past the bound, only
//   they are dropped, the oldest first.
//
// They leave in batches of at most 100, one batch at a time, within a budget
// of 300 over a sliding minute. Two publications started at the same moment
// share the same budget: the room is reserved before a batch is sent, and
// only one flush runs at a time. A batch counts from the END of its request
// (the core's minute starts when the states arrive).
// -----------------------------------------------------------------------------

import { MAX_PENDING_STATES, STATES_PER_MINUTE } from './constants.js';

const BATCH = 100;
const WINDOW = 60_000;

/** The state as Gladys receives it: without the queue's own `_key` and `_at`. */
const wire = ({ _key, _at, ...state }) => state;

const keyOf = (state) =>
  state._key ?? `${state.device_feature_external_id}|${state.created_at ?? state._at ?? 'live'}`;

export class StateBudget {
  constructor({
    gladys,
    now = Date.now,
    logger,
    limit = STATES_PER_MINUTE,
    maxPending = MAX_PENDING_STATES,
    liveMaxAge = () => Infinity,
  }) {
    this.gladys = gladys;
    this.now = now;
    this.logger = logger;
    this.limit = limit;
    this.maxPending = maxPending;
    this.liveMaxAge = liveMaxAge;
    /** (feature, uplink time) -> state, in the order of measure */
    this.live = new Map();
    this.dated = new Map();
    /** [{ at, count }] sent over the last minute */
    this.sent = [];
    this.chain = Promise.resolve();
    this.dropped = 0;
  }

  /** Everything waiting, live first (tests, status). */
  get pending() {
    return new Map([...this.live, ...this.dated]);
  }

  /** Queue states (oldest first); an uplink already waiting stays where it is. */
  enqueue(states) {
    for (const state of states) {
      const key = keyOf(state);
      if (this.live.has(key) || this.dated.has(key)) {
        continue;
      }
      const queue = state.created_at === undefined ? this.live : this.dated;
      queue.set(key, { ...state, _key: key });
    }
    // Past the bound: the oldest dated states first; live ones only when
    // they alone exceed it.
    while (this.live.size + this.dated.size > this.maxPending) {
      const queue = this.dated.size > 0 ? this.dated : this.live;
      queue.delete(queue.keys().next().value);
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

  /** The next states to send: live first, then dated. */
  take(count) {
    const batch = [];
    for (const queue of [this.live, this.dated]) {
      for (const state of queue.values()) {
        if (batch.length >= count) {
          return batch;
        }
        batch.push(state);
      }
    }
    return batch;
  }

  /** A live state whose uplink is too old for a scene leaves dated. */
  onWire(state) {
    if (
      state.created_at === undefined &&
      typeof state._at === 'number' &&
      state._at < this.now() - this.liveMaxAge()
    ) {
      return { ...wire(state), created_at: new Date(state._at).toISOString() };
    }
    return wire(state);
  }

  async send() {
    let total = 0;
    while (this.live.size + this.dated.size > 0) {
      const room = Math.min(BATCH, this.room());
      if (room <= 0) {
        break;
      }
      const batch = this.take(room);
      for (const state of batch) {
        this.live.delete(state._key);
        this.dated.delete(state._key);
      }
      // Reserved before the request, dated again when it ends: a failed
      // batch still counts (Gladys may have accepted part of it), never more
      // than the budget.
      const record = { at: this.now(), count: batch.length };
      this.sent.push(record);
      try {
        await this.gladys.publishStates(batch.map((s) => this.onWire(s)));
        record.at = this.now();
        total += batch.length;
      } catch (err) {
        record.at = this.now();
        // Back in front of their queues, in the same order.
        const live = [...this.live.values()];
        const dated = [...this.dated.values()];
        this.live = new Map();
        this.dated = new Map();
        this.enqueue([...batch, ...live, ...dated]);
        this.logger?.warn?.(`Publishing the states failed: ${err?.message ?? err}`);
        break;
      }
    }
    return total;
  }

  /** Forget everything waiting (another application). */
  clear() {
    this.live.clear();
    this.dated.clear();
  }
}
