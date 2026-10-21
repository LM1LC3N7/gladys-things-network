import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUSY_MAX, REFUSED_BACKOFF } from '../src/constants.js';
import { normalizeConfig } from '../src/config.js';
import { StateStore, memoryStorage } from '../src/store.js';
import { API_KEY, CONFIG, createClock } from './helpers/fakes.js';

const options = { maxPause: BUSY_MAX, maxRefusal: REFUSED_BACKOFF };

test('times read back are capped; a broken file starts afresh; devices re-validated', () => {
  const clock = createClock();
  const now = clock.now();
  const storage = memoryStorage({
    salt: 'nothex',
    state: {
      lastAttemptAt: now + 10 * 86_400_000,
      pausedUntil: now + 100 * 86_400_000,
      refusedUntil: now + 100 * 86_400_000,
      refusedWhy: 'whatever',
      fp: 'abc',
      streak: 1e9,
      cursor: 'x',
      app: 'Bad App',
    },
    devices: JSON.parse(`{
      "good-one": { "pid": "eui-0011223344556677", "fields": [["tempc", "temperature", "TempC"], ["x", "nope", "X"]] },
      "bad id": { "pid": "eui-0011223344556677" },
      "other-one": { "pid": "../etc" },
      "__proto__": { "pid": "eui-0011223344556677" }
    }`),
  });
  const store = new StateStore({ storage, now: clock.now, ...options });
  const s = store.get();
  assert.equal(s.lastAttemptAt, now);
  assert.equal(s.pausedUntil, now + BUSY_MAX);
  assert.equal(s.refusedUntil, now + REFUSED_BACKOFF);
  assert.equal(s.refusedWhy, '');
  assert.equal(s.fp, '');
  assert.equal(s.streak, 20);
  assert.equal(s.cursor, 0);
  assert.equal(s.app, '');
  assert.match(store.salt, /^[0-9a-f]{32}$/);
  assert.deepEqual([...store.devices.keys()], ['good-one']);
  assert.deepEqual(store.device('good-one').fields, [
    { key: 'tempc', kind: 'temperature', name: 'TempC' },
  ]);
  assert.equal(
    new StateStore({ storage: memoryStorage('junk'), now: clock.now, ...options }).devices.size,
    0,
  );
});

test('the key is never written; only the fingerprint of a refused one, erased by a success', () => {
  const clock = createClock();
  const storage = memoryStorage();
  const config = normalizeConfig(CONFIG);
  const store = new StateStore({ storage, now: clock.now, ...options });
  store.restore(config);
  store.update({ lastAttemptAt: clock.now() }, { urgent: true });
  assert.equal(storage.load().state.fp, '');
  store.update(
    { refusedUntil: clock.now() + REFUSED_BACKOFF, refusedWhy: 'key' },
    { urgent: true, config },
  );
  const text = JSON.stringify(storage.load());
  assert.ok(!text.includes(API_KEY.split('.')[2]));
  assert.ok(!text.includes(API_KEY.split('.')[1]));
  assert.match(storage.load().state.fp, /^[0-9a-f]{32}$/);
  // After a restart: the same refused key stays refused, another one is tried.
  const again = new StateStore({ storage, now: clock.now, ...options });
  assert.equal(again.restore(config).changed, false);
  assert.ok(again.get().refusedUntil > clock.now());
  const other = new StateStore({ storage, now: clock.now, ...options });
  assert.equal(other.restore({ ...config, apiKey: 'NNSXS.ANOTHERKEY123456' }).changed, true);
  assert.equal(other.get().refusedUntil, 0);
  assert.equal(other.get().lastAttemptAt, 0);
  // A success erases the fingerprint.
  again.update({ refusedUntil: 0 }, { urgent: true });
  assert.equal(storage.load().state.fp, '');
});

test('another application drops its devices and its cursor; another host its pause', () => {
  const clock = createClock();
  const store = new StateStore({ storage: memoryStorage(), now: clock.now, ...options });
  const config = normalizeConfig(CONFIG);
  store.restore(config);
  store.setDevice('dev-one', {
    pid: 'eui-0011223344556677',
    devEui: '',
    fields: [],
    lastUplinkAt: 1,
  });
  store.update(
    { cursor: 5, pausedUntil: clock.now() + 60_000, lastAttemptAt: clock.now() },
    { urgent: true },
  );
  store.restore({ ...config, applicationId: 'other-app' });
  assert.equal(store.devices.size, 0);
  assert.equal(store.get().cursor, 0);
  assert.ok(store.get().pausedUntil > clock.now(), 'same server: the pause stays');
  store.restore({ ...config, applicationId: 'other-app', host: 'nam1.cloud.thethings.network' });
  assert.equal(store.get().pausedUntil, 0);
});

test('the cursor and the devices are written at most once a minute; a request at once', () => {
  const clock = createClock();
  const storage = memoryStorage();
  const store = new StateStore({ storage, now: clock.now, ...options });
  store.restore(normalizeConfig(CONFIG));
  const writes = storage.writes();
  store.update({ cursor: 1 });
  store.flush();
  assert.equal(storage.writes(), writes, 'the restore was written less than a minute ago');
  clock.advance(60_000);
  store.flush();
  assert.equal(storage.writes(), writes + 1);
  store.update({ cursor: 2 });
  store.update({ lastAttemptAt: clock.now() }, { urgent: true });
  assert.equal(storage.writes(), writes + 2);
  assert.equal(storage.load().state.cursor, 2);
  store.update({ lastAttemptAt: clock.now() }, { urgent: true });
  assert.equal(storage.writes(), writes + 2, 'nothing changed: nothing written');
});

test('M3: only a refused key (401) leaves a fingerprint; 403 / 404 (a working key) none', () => {
  const clock = createClock();
  const storage = memoryStorage();
  const config = normalizeConfig(CONFIG);
  const store = new StateStore({ storage, now: clock.now, ...options });
  store.restore(config);
  for (const why of ['rights', 'notFound']) {
    store.update(
      { refusedUntil: clock.now() + REFUSED_BACKOFF, refusedWhy: why },
      { urgent: true, config },
    );
    assert.equal(storage.load().state.fp, '', why);
    assert.equal(storage.load().state.refusedWhy, why);
  }
  store.update(
    { refusedUntil: clock.now() + REFUSED_BACKOFF, refusedWhy: 'key' },
    { urgent: true, config },
  );
  assert.match(storage.load().state.fp, /^[0-9a-f]{32}$/);
});
