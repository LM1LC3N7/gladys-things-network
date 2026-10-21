import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateBudget } from '../src/budget.js';
import { createClock, deferred } from './helpers/fakes.js';

const state = (i, at = '2026-10-21T10:00:00.000Z') => ({
  device_feature_external_id: `ext:t:ttn:x:f${i}`,
  state: i,
  created_at: at,
});

function fakeGladys({ gate } = {}) {
  const batches = [];
  return {
    batches,
    async publishStates(batch) {
      batches.push({ size: batch.length });
      if (gate) {
        await gate.promise;
      }
      return { success: true };
    },
  };
}

test('at most 300 states over a sliding minute, in batches of at most 100', async () => {
  const clock = createClock();
  const gladys = fakeGladys();
  const budget = new StateBudget({ gladys, now: clock.now });
  budget.enqueue(Array.from({ length: 450 }, (_, i) => state(i)));
  assert.equal(await budget.flush(), 300);
  assert.deepEqual(
    gladys.batches.map((b) => b.size),
    [100, 100, 100],
  );
  clock.advance(59_999);
  assert.equal(await budget.flush(), 0);
  clock.advance(1);
  assert.equal(await budget.flush(), 150);
  assert.equal(budget.pending.size, 0);
});

test('two publications at the same moment share one budget', async () => {
  const clock = createClock();
  const gate = deferred();
  const gladys = fakeGladys({ gate });
  const budget = new StateBudget({ gladys, now: clock.now });
  budget.enqueue(Array.from({ length: 250 }, (_, i) => state(i)));
  const first = budget.flush();
  budget.enqueue(Array.from({ length: 250 }, (_, i) => state(1000 + i)));
  const second = budget.flush();
  gate.resolve();
  const sent = (await first) + (await second);
  assert.equal(sent, 300);
  assert.equal(
    gladys.batches.reduce((sum, b) => sum + b.size, 0),
    300,
  );
});

test('indexed by (feature, uplink time): two uplinks of a feature both wait, the same one once', async () => {
  const clock = createClock();
  const gladys = fakeGladys();
  const budget = new StateBudget({ gladys, now: clock.now, maxPending: 5 });
  budget.enqueue([state(1, '2026-10-21T10:00:00.000Z')]);
  budget.enqueue([{ ...state(1, '2026-10-21T10:05:00.000Z'), state: 7 }]);
  budget.enqueue([{ ...state(1, '2026-10-21T10:00:00.000Z'), state: 9 }]);
  assert.equal(budget.pending.size, 2);
  assert.deepEqual(
    [...budget.pending.values()].map((s) => s.state),
    [1, 7],
  );
  budget.enqueue(Array.from({ length: 10 }, (_, i) => state(100 + i)));
  assert.equal(budget.pending.size, 5);
  assert.equal(budget.dropped, 7);
  const sent = [];
  gladys.publishStates = async (batch) => sent.push(...batch);
  await budget.flush();
  assert.ok(
    sent.every((s) => !('_key' in s)),
    'the queue key never reaches Gladys',
  );
});

test('M1: a batch counts from the end of its request (the core minute starts at arrival)', async () => {
  const clock = createClock();
  const gladys = {
    async publishStates() {
      clock.advance(50);
      return { success: true };
    },
  };
  const budget = new StateBudget({ gladys, now: clock.now });
  budget.enqueue(Array.from({ length: 300 }, (_, i) => state(i)));
  await budget.flush();
  budget.enqueue(Array.from({ length: 100 }, (_, i) => state(500 + i)));
  clock.advance(60_000 - 150);
  assert.equal(await budget.flush(), 0, 'the last batch arrived less than a minute ago');
  clock.advance(51);
  assert.equal(await budget.flush(), 100);
});

test('a failed batch goes back to the queue and still counts', async () => {
  const clock = createClock();
  let fail = true;
  const gladys = {
    async publishStates() {
      if (fail) {
        throw new Error('HTTP 429');
      }
      return { success: true };
    },
  };
  const warnings = [];
  const budget = new StateBudget({
    gladys,
    now: clock.now,
    logger: { warn: (t) => warnings.push(t) },
  });
  budget.enqueue(Array.from({ length: 50 }, (_, i) => state(i)));
  assert.equal(await budget.flush(), 0);
  assert.equal(budget.pending.size, 50);
  assert.equal(budget.room(), 250);
  fail = false;
  assert.equal(await budget.flush(), 50);
  assert.equal(warnings.length, 1);
});
