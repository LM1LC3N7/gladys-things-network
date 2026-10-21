import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { TtnApp } from '../src/app.js';
import { BUSY_MAX, REFUSED_BACKOFF } from '../src/constants.js';
import { deviceOf } from '../src/readings.js';
import { memoryStorage } from '../src/store.js';
import {
  API_KEY,
  APP,
  CONFIG,
  createClock,
  createFakeTimers,
  deferred,
  httpError,
  installFetch,
  recordingLogger,
  stream,
  uplink,
} from './helpers/fakes.js';

const SELECTOR = 'things-network';
const PID = 'eui-a84041000181c8b2';
const STORAGE =
  /^https:\/\/eu1\.cloud\.thethings\.network\/api\/v3\/as\/applications\/home-sensors\/packages\/storage\/uplink_message\?/;

/** Let the pending promises run until `condition` holds (bounded). */
async function until(condition) {
  for (let i = 0; i < 200 && !condition(); i += 1) {
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(condition(), 'condition never reached');
}

/** The device as the user created it from the Discovery tab. */
function createdDevice(
  fields = [
    { key: 'tempc_sht', kind: 'temperature', name: 'TempC_SHT' },
    { key: 'hum_sht', kind: 'humidity', name: 'Hum_SHT' },
    { key: 'batv', kind: 'battery_voltage', name: 'BatV' },
  ],
) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return { ...deviceOf(gladys, { platformId: PID, name: 'lht65-garden', fields }), id: 'd1' };
}

async function setup({
  storage = memoryStorage(),
  devices = [],
  clock = createClock(),
  config = CONFIG,
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, devices, config });
  await gladys.connect();
  const logger = recordingLogger();
  const timers = createFakeTimers();
  const app = new TtnApp({ gladys, logger, now: clock.now, timers, storage });
  return { gladys, app, logger, timers, clock, storage };
}

test('first read: one request for the last 24 h, the devices and their values in Gladys', async () => {
  const fetch = installFetch([[STORAGE, () => stream([uplink()])]]);
  try {
    const { gladys, app } = await setup({ devices: [createdDevice()] });
    await app.start(CONFIG);
    assert.equal(fetch.calls.length, 1);
    const url = new URL(fetch.calls[0].url);
    assert.equal(url.searchParams.get('last'), '86400s');
    assert.equal(url.searchParams.get('order'), '-received_at');
    assert.equal(url.searchParams.get('limit'), '1000');
    assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${API_KEY}`);
    assert.equal(fetch.calls[0].init.headers.Accept, 'text/event-stream');
    assert.equal(fetch.calls[0].init.redirect, 'error');
    assert.ok(!fetch.calls[0].url.includes('NNSXS'), 'the key never travels in the URL');

    const [device] = gladys.fake.discoveredDevices;
    assert.equal(device.external_id, `ext:${SELECTOR}:ttn:${PID}`);
    assert.deepEqual(
      device.features.map((f) => [f.category, f.unit]),
      [
        ['temperature-sensor', 'celsius'],
        ['humidity-sensor', 'percent'],
        ['energy-sensor', 'volt'],
      ],
    );
    const states = gladys.fake.states;
    assert.equal(states.length, 3);
    assert.equal(gladys.fake.lastState(`${device.external_id}:tempc_sht`), 21.5);
    assert.equal(
      states[0].created_at,
      undefined,
      'received since the last read: live (scenes run)',
    );
    assert.equal(gladys.fake.connectionStatus.connected, true);
    assert.match(gladys.fake.connectionStatus.message.fr, /Application home-sensors : 1 appareil/);
  } finally {
    fetch.restore();
  }
});

test('an uplink is never published twice, and the next read asks only for what came after', async () => {
  let answer = [uplink()];
  const fetch = installFetch([[STORAGE, () => stream(answer)]]);
  try {
    const { gladys, app, clock, timers } = await setup({ devices: [createdDevice()] });
    await app.start(CONFIG);
    clock.advance(5 * 60_000);
    await timers.runIntervals();
    assert.equal(fetch.calls.length, 2);
    assert.equal(
      new URL(fetch.calls[1].url).searchParams.get('after'),
      '2026-10-21T09:59:00.123Z',
      'the newest uplink seen, minus one minute',
    );
    assert.equal(gladys.fake.states.length, 3, 'the same uplink again publishes nothing');
    answer = [uplink({ at: '2026-10-21T10:08:00Z', payload: { TempC_SHT: 22 } }), uplink()];
    clock.advance(5 * 60_000);
    await timers.runIntervals();
    assert.equal(gladys.fake.states.length, 4);
    assert.deepEqual(gladys.fake.states[3], {
      device_feature_external_id: `ext:${SELECTOR}:ttn:${PID}:tempc_sht`,
      state: 22,
    });
  } finally {
    fetch.restore();
  }
});

test('never faster than the interval: reconnection, unchanged configuration, test button, restart', async () => {
  const fetch = installFetch([[STORAGE, () => stream([uplink()])]]);
  try {
    const storage = memoryStorage();
    const clock = createClock();
    const { app, gladys, timers } = await setup({ storage, clock });
    await app.start(CONFIG);
    assert.equal(fetch.calls.length, 1);
    app.stop();
    await app.start(CONFIG); // reconnection
    await app.start({ ...CONFIG }); // the same configuration saved again
    const answer = await app.testConnection();
    assert.match(answer.en, /Next read possible at 10:10 UTC/);
    clock.advance(4 * 60_000);
    await timers.runIntervals();
    assert.equal(fetch.calls.length, 1);
    // The status and the Discovery list were published again at each start.
    assert.ok(gladys.fake.connectionStatuses.length >= 3);

    // A restart of the container: the instant of the last request is in /data.
    const second = await setup({ storage, clock });
    await second.app.start(CONFIG);
    assert.equal(fetch.calls.length, 1);
    clock.advance(60_000);
    await second.timers.runIntervals();
    assert.equal(fetch.calls.length, 2);
    // A longer interval applies to the last request at once.
    await second.app.start({ ...CONFIG, poll_interval: 30 });
    clock.advance(10 * 60_000);
    await second.timers.runIntervals();
    assert.equal(fetch.calls.length, 2);
  } finally {
    fetch.restore();
  }
});

test('a reconnection during a read starts no other read, and the answer is used', async () => {
  const gate = deferred();
  const fetch = installFetch([[STORAGE, () => gate.promise]]);
  try {
    const { app, gladys } = await setup({ devices: [createdDevice()] });
    const first = app.start(CONFIG);
    await until(() => fetch.calls.length === 1);
    app.stop();
    const again = app.start(CONFIG);
    await until(() => gladys.fake.connectionStatuses.length >= 2);
    assert.equal(fetch.calls.length, 1);
    gate.resolve(stream([uplink()]));
    await Promise.all([first, again]);
    assert.equal(fetch.calls.length, 1);
    assert.equal(gladys.fake.states.length, 3);
  } finally {
    fetch.restore();
  }
});

test('a late answer of a previous configuration publishes nothing and sets no status', async () => {
  const gate = deferred();
  const fetch = installFetch([
    [STORAGE, () => gate.promise],
    [/applications\/other-app\//, () => stream([])],
  ]);
  try {
    const { app, gladys } = await setup({ devices: [createdDevice()] });
    const first = app.start(CONFIG);
    await until(() => fetch.calls.length === 1);
    const second = app.start({ ...CONFIG, application_id: 'other-app' });
    await until(() =>
      gladys.fake.connectionStatuses.some((s) => /other-app/.test(s.message?.en ?? '')),
    );
    const statuses = gladys.fake.connectionStatuses.length;
    gate.resolve(stream([uplink()]));
    await Promise.all([first, second]);
    assert.equal(gladys.fake.states.length, 0);
    assert.equal(gladys.fake.discoveredDevices.length, 0);
    assert.ok(
      gladys.fake.connectionStatuses
        .slice(statuses)
        .every((s) => !/home-sensors/.test(s.message.en)),
      'no status about the previous application',
    );
  } finally {
    fetch.restore();
  }
});

test('a refused key stops the reads for 6 hours, survives a restart, and a new key is tried at once', async () => {
  const fetch = installFetch([
    [
      STORAGE,
      (call) =>
        call.init.headers.Authorization.endsWith('NEWKEY1234567890')
          ? stream([uplink()])
          : httpError(401),
    ],
  ]);
  try {
    const storage = memoryStorage();
    const clock = createClock();
    const { app, gladys, timers } = await setup({ storage, clock });
    await app.start(CONFIG);
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(gladys.fake.connectionStatus.message.en, /API key refused/);
    const saved = storage.load();
    assert.match(saved.state.fp, /^[0-9a-f]{32}$/, 'the fingerprint of the refused key only');
    clock.advance(60 * 60_000);
    await timers.runIntervals();
    assert.equal(fetch.calls.length, 1);
    assert.ok(storage.load().state.refusedUntil <= clock.now() + REFUSED_BACKOFF);

    const second = await setup({ storage, clock });
    await second.app.start(CONFIG);
    assert.equal(fetch.calls.length, 1, 'still refused after a restart');
    assert.match(second.gladys.fake.connectionStatus.message.fr, /clé API refusée/);
    // The test button may try the refused key again once the interval has passed.
    await second.app.testConnection();
    assert.equal(fetch.calls.length, 2);

    await second.app.start({ ...CONFIG, api_key: 'NNSXS.NEWKEY1234567890' });
    assert.equal(fetch.calls.length, 3, 'a new key is tried at once');
    assert.equal(second.gladys.fake.connectionStatus.connected, true);
    assert.equal(storage.load().state.fp, '', 'erased by the first success');
    assert.equal(storage.load().state.refusedUntil, 0);
  } finally {
    fetch.restore();
  }
});

test('403 and 404 tell the right and the Storage Integration apart', async () => {
  for (const [code, text] of [
    [403, /Read application traffic/],
    [404, /Storage Integration is not activated/],
  ]) {
    const fetch = installFetch([[STORAGE, () => httpError(code)]]);
    try {
      const { app, gladys } = await setup();
      await app.start(CONFIG);
      assert.match(gladys.fake.connectionStatus.message.en, text);
    } finally {
      fetch.restore();
    }
  }
});

test('429 pauses every path (Retry-After), across a restart; the pause is bounded', async () => {
  const fetch = installFetch([[STORAGE, () => httpError(429, { 'retry-after': '1200' })]]);
  try {
    const storage = memoryStorage();
    const clock = createClock();
    const { app, timers } = await setup({ storage, clock });
    await app.start(CONFIG);
    assert.equal(storage.load().state.pausedUntil, clock.now() + 1_200_000);
    clock.advance(10 * 60_000);
    await timers.runIntervals();
    await app.testConnection();
    const second = await setup({ storage, clock });
    await second.app.start(CONFIG);
    await second.app.testConnection();
    assert.equal(fetch.calls.length, 1);
    clock.advance(11 * 60_000);
    await second.timers.runIntervals();
    assert.equal(fetch.calls.length, 2);
  } finally {
    fetch.restore();
  }
  const huge = installFetch([[STORAGE, () => httpError(503, { 'retry-after': '999999' })]]);
  try {
    const storage = memoryStorage();
    const clock = createClock();
    const { app } = await setup({ storage, clock });
    await app.start(CONFIG);
    assert.equal(storage.load().state.pausedUntil, clock.now() + BUSY_MAX);
  } finally {
    huge.restore();
  }
});

test('the API key never reaches a log, a status, /data nor an error', async () => {
  const fetch = installFetch([
    [
      STORAGE,
      () => {
        throw Object.assign(new Error(`connect failed ${API_KEY}`), { cause: { code: API_KEY } });
      },
    ],
  ]);
  try {
    const storage = memoryStorage();
    const { app, gladys, logger } = await setup({ storage });
    await app.start(CONFIG);
    const answer = await app.testConnection();
    const secret = API_KEY.split('.')[2];
    const everything = JSON.stringify([
      logger.lines,
      gladys.fake.connectionStatuses,
      storage.load(),
      answer,
    ]);
    assert.ok(!everything.includes(secret));
    assert.ok(!everything.includes(API_KEY));
    assert.equal(app.scrub(new Error(`x ${API_KEY} y`)), 'x *** y');
  } finally {
    fetch.restore();
  }
});

test('free fields: only known names with a core unit, values in bounds; the rest is named', async () => {
  // Hum_SHT out of bounds and battery 3.6 (not a whole percentage) are left
  // out; the pressure in Pa reads in hPa; `__proto__` is an own key here.
  const payload = JSON.parse(`{
    "TempC_SHT": 21.5,
    "Hum_SHT": 140,
    "temperature_3": "19.25",
    "barometric_pressure_5": 101325,
    "battery": 3.6,
    "mystery_value": 42,
    "Work_mode": "IIC",
    "__proto__": { "polluted": true },
    "_sensor_attr": {
      "soil": { "unit": "%", "device_class": "moisture" },
      "odd": { "unit": "furlong", "device_class": "distance" }
    },
    "soil": 33.3,
    "odd": 3,
    "water_leak": true,
    "gps_1": { "latitude": 48.8, "longitude": 2.3 }
  }`);
  const fetch = installFetch([[STORAGE, () => stream([uplink({ payload })])]]);
  try {
    const { app, gladys } = await setup();
    await app.start(CONFIG);
    const [device] = gladys.fake.discoveredDevices;
    assert.deepEqual(
      device.features.map((f) => f.external_id.split(':').pop()),
      [
        'tempc_sht',
        'hum_sht',
        'temperature_3',
        'barometric_pressure_5',
        'battery',
        'soil',
        'water_leak',
      ],
    );
    assert.equal({}.polluted, undefined);
    const answer = await app.testConnection();
    assert.match(answer.en, /ignored fields: mystery_value, Work_mode, __proto___polluted, odd/);
    assert.match(answer.en, /barometric_pressure_5 1013\.3/);
    assert.ok(!/Hum_SHT/.test(answer.en.split('\n').find((l) => l.startsWith('- '))));
  } finally {
    fetch.restore();
  }
});

test('the DevEUI is the identity: another one under the same id is another device; a missing one is not', async () => {
  let answer = [uplink({ devEui: '' })];
  const fetch = installFetch([[STORAGE, () => stream(answer)]]);
  try {
    const { app, gladys, clock, timers } = await setup();
    await app.start(CONFIG);
    assert.equal(
      gladys.fake.discoveredDevices[0].external_id,
      `ext:${SELECTOR}:ttn:${APP}.lht65-garden`,
    );
    answer = [uplink({ at: '2026-10-21T10:06:00Z' })]; // the DevEUI now readable: same device
    clock.advance(5 * 60_000);
    await timers.runIntervals();
    assert.equal(gladys.fake.discoveredDevices.length, 1);
    assert.equal(
      gladys.fake.discoveredDevices[0].external_id,
      `ext:${SELECTOR}:ttn:${APP}.lht65-garden`,
    );
  } finally {
    fetch.restore();
  }
  let otherAnswer = [uplink()];
  const other = installFetch([[STORAGE, () => stream(otherAnswer)]]);
  try {
    const { app, gladys, clock, timers } = await setup();
    await app.start(CONFIG);
    otherAnswer = [uplink({ devEui: '0011223344556677', at: '2026-10-21T10:06:00Z' })];
    clock.advance(5 * 60_000);
    await timers.runIntervals();
    assert.deepEqual(
      gladys.fake.discoveredDevices.map((d) => d.external_id),
      [`ext:${SELECTOR}:ttn:eui-0011223344556677`],
    );
  } finally {
    other.restore();
  }
});

test('an old uplink at the very first start is history, not published as current', async () => {
  const fetch = installFetch([[STORAGE, () => stream([uplink({ at: '2026-10-21T02:00:00Z' })])]]);
  try {
    const { app, gladys } = await setup({ devices: [createdDevice()] });
    await app.start(CONFIG);
    assert.equal(gladys.fake.discoveredDevices.length, 1);
    assert.equal(gladys.fake.states.length, 0);
  } finally {
    fetch.restore();
  }
});

test('a device created later gets its latest values at once, without a request', async () => {
  const fetch = installFetch([[STORAGE, () => stream([uplink()])]]);
  try {
    const { app, gladys } = await setup();
    await app.start(CONFIG);
    assert.equal(gladys.fake.states.length, 0);
    gladys.onDeviceCreated(() => app.onDeviceCreated());
    await gladys.fake.deviceCreated(createdDevice());
    assert.equal(gladys.fake.states.length, 3);
    // Created again (deleted, then created): the latest values again, with
    // the same date (the core ignores a state it already has) (M7).
    await app.onDeviceCreated();
    assert.equal(gladys.fake.states.length, 6);
    assert.deepEqual(gladys.fake.states.slice(3), gladys.fake.states.slice(0, 3));
    assert.equal(gladys.fake.states[0].created_at, '2026-10-21T10:00:00.123Z');
    assert.equal(fetch.calls.length, 1);
  } finally {
    fetch.restore();
  }
});

test('a stream error line fails the read; a line too long is skipped, the rest kept (I3)', async () => {
  const fetch = installFetch([
    [STORAGE, () => stream([uplink()], { extra: [JSON.stringify({ error: { code: 16 } })] })],
  ]);
  try {
    const { app, gladys } = await setup();
    await app.start(CONFIG);
    assert.match(gladys.fake.connectionStatus.message.en, /API key refused/);
    assert.equal(gladys.fake.discoveredDevices.length, 0);
  } finally {
    fetch.restore();
  }
  const big = JSON.stringify({
    result: uplink({ deviceId: 'chatty-one', payload: { x: 'y'.repeat(300 * 1024) } }),
  });
  const body = `${JSON.stringify({ result: uplink() })}\n\n${big}\n\n`;
  const long = installFetch([[STORAGE, () => new Response(body)]]);
  try {
    const { app, gladys } = await setup({ devices: [createdDevice()] });
    await app.start(CONFIG);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    assert.match(
      gladys.fake.connectionStatus.message.en,
      /1 uplink\(s\) too large \(over 256 KB\) were skipped/,
    );
    assert.equal(gladys.fake.states.length, 3, 'the other uplinks are published');
    assert.equal(app.store.get().cursor, Date.parse('2026-10-21T10:00:00.123Z'), 'cursor moved');
  } finally {
    long.restore();
  }
});

test('not configured: no request, a status that says what is missing', async () => {
  const fetch = installFetch([]);
  try {
    const { app, gladys } = await setup();
    await app.start({ server: 'custom', custom_host: 'http://x', application_id: 'Bad App!' });
    assert.equal(gladys.fake.connectionStatus.connected, false);
    assert.match(gladys.fake.connectionStatus.message.en, /server address not understood/);
    assert.match(gladys.fake.connectionStatus.message.fr, /clé API manquante/);
    assert.match((await app.testConnection()).en, /application ID not understood/);
    assert.equal(fetch.calls.length, 0);
  } finally {
    fetch.restore();
  }
});

// --- Review 1 ------------------------------------------------------------------------

const leakDevice = () => createdDevice([{ key: 'water_leak', kind: 'leak', name: 'water_leak' }]);

test('B1+I1: a leak 0 -> 1 -> 0 within one read is published live, in order, and triggers', async () => {
  const fetch = installFetch([
    [
      STORAGE,
      () =>
        stream([
          uplink({ at: '2026-10-21T10:04:00Z', payload: { water_leak: false } }),
          uplink({ at: '2026-10-21T10:02:00Z', payload: { water_leak: true } }),
          uplink({ at: '2026-10-21T10:01:00Z', payload: { water_leak: false } }),
        ]),
    ],
  ]);
  try {
    const { app, gladys } = await setup({ devices: [leakDevice()] });
    await app.start(CONFIG);
    assert.deepEqual(
      gladys.fake.states.map((s) => [s.state, s.created_at]),
      [
        [0, undefined],
        [1, undefined],
        [0, undefined],
      ],
      'no created_at: the core runs saveState and the scenes on each',
    );
  } finally {
    fetch.restore();
  }
});

test('B1+I1: catching up, each uplink once, oldest first; only the recent newest is live', async () => {
  let answer = [uplink({ at: '2026-10-21T10:04:00Z', payload: { TempC_SHT: 20 } })];
  const fetch = installFetch([[STORAGE, () => stream(answer)]]);
  try {
    const { app, gladys, clock, timers } = await setup({ devices: [createdDevice()] });
    await app.start(CONFIG);
    assert.equal(gladys.fake.states.length, 1);
    // An hour later (a pause): four uplinks, three older than the interval.
    clock.advance(60 * 60_000);
    answer = ['11:03', '10:50', '10:30', '10:10'].map((hm, i) =>
      uplink({ at: `2026-10-21T${hm}:00Z`, payload: { TempC_SHT: 30 - i } }),
    );
    await timers.runIntervals();
    assert.deepEqual(
      gladys.fake.states.slice(1).map((s) => [s.state, s.created_at]),
      [
        [27, '2026-10-21T10:10:00.000Z'],
        [28, '2026-10-21T10:30:00.000Z'],
        [29, '2026-10-21T10:50:00.000Z'],
        [30, undefined],
      ],
    );
  } finally {
    fetch.restore();
  }
});

test('B1: at the very first start, a value of 2 h is dated, one of 4 h never published', async () => {
  const fetch = installFetch([
    [
      STORAGE,
      () =>
        stream([
          uplink({ at: '2026-10-21T08:05:00Z', payload: { TempC_SHT: 18 } }),
          uplink({ at: '2026-10-21T06:00:00Z', payload: { TempC_SHT: 17 } }),
        ]),
    ],
  ]);
  try {
    const { app, gladys } = await setup({ devices: [createdDevice()] });
    await app.start(CONFIG);
    assert.deepEqual(gladys.fake.states, [
      {
        device_feature_external_id: `ext:${SELECTOR}:ttn:${PID}:tempc_sht`,
        state: 18,
        created_at: '2026-10-21T08:05:00.000Z',
      },
    ]);
  } finally {
    fetch.restore();
  }
});

test('I4: a motion count above 1 is "detected"; a bare pressure of 350 is left out', async () => {
  const fetch = installFetch([
    [STORAGE, () => stream([uplink({ payload: { motion: 5, pressure: 350, TempC_SHT: 21 } })])],
  ]);
  try {
    const devices = [
      createdDevice([
        { key: 'motion', kind: 'motion', name: 'motion' },
        { key: 'pressure', kind: 'pressure_air_only', name: 'pressure' },
      ]),
    ];
    const { app, gladys } = await setup({ devices });
    await app.start(CONFIG);
    assert.deepEqual(
      gladys.fake.states.map((s) => [s.device_feature_external_id.split(':').pop(), s.state]),
      [['motion', 1]],
    );
  } finally {
    fetch.restore();
  }
});

test('M4: a new interval during a read keeps its answer', async () => {
  const gate = deferred();
  const fetch = installFetch([[STORAGE, () => gate.promise]]);
  try {
    const { app, gladys } = await setup({ devices: [createdDevice()] });
    const first = app.start(CONFIG);
    await until(() => fetch.calls.length === 1);
    const second = app.start({ ...CONFIG, poll_interval: 10 });
    gate.resolve(stream([uplink()]));
    await Promise.all([first, second]);
    assert.equal(gladys.fake.states.length, 3);
    assert.equal(fetch.calls.length, 1);
    assert.match(gladys.fake.connectionStatus.message.en, /read every 10 min/);
  } finally {
    fetch.restore();
  }
});

test('M5: the configuration is asked again a few times when Gladys fails to give it', async () => {
  const fetch = installFetch([[STORAGE, () => stream([])]]);
  try {
    const { app, gladys } = await setup();
    const waits = [];
    app.sleep = async (ms) => {
      waits.push(ms);
    };
    let calls = 0;
    const ok = await app.startFromGladys(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error('HTTP 503');
      }
      return CONFIG;
    });
    assert.equal(ok, true);
    assert.deepEqual(waits, [2_000, 10_000]);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    const never = await app.startFromGladys(async () => {
      throw new Error('down');
    });
    assert.equal(never, false, 'bounded: no loop');
  } finally {
    fetch.restore();
  }
});

test('M6: after a loss of /data, a field keeps the unit of its created feature', async () => {
  const fetch = installFetch([
    [STORAGE, () => stream([uplink({ payload: { temperature_3: 21.5, BatV: 3.1 } })])],
  ]);
  try {
    const gladys0 = createFakeGladys({ selector: SELECTOR });
    const device = {
      ...deviceOf(gladys0, {
        platformId: PID,
        name: 'x',
        fields: [{ key: 'temperature_3', kind: 'temperature', name: 'temperature_3' }],
      }),
      id: 'd1',
    };
    // The user's feature is in Fahrenheit (no kind of this integration gives it).
    device.features.push({
      ...device.features[0],
      external_id: `${device.external_id}:batv`,
      unit: 'fahrenheit',
    });
    const { app, gladys } = await setup({ devices: [device] });
    await app.start(CONFIG);
    assert.deepEqual(
      gladys.fake.states.map((s) => s.device_feature_external_id.split(':').pop()),
      ['temperature_3'],
    );
    assert.deepEqual(
      app.store.device('lht65-garden').fields.map((f) => [f.key, f.kind]),
      [['temperature_3', 'temperature']],
    );
  } finally {
    fetch.restore();
  }
});

test('M8: a device unheard of for 30 days and not created is forgotten', async () => {
  const fetch = installFetch([[STORAGE, () => stream([uplink({ deviceId: 'new-one' })])]]);
  try {
    const clock = createClock();
    const storage = memoryStorage({
      state: { app: APP, host: 'eu1.cloud.thethings.network' },
      devices: {
        'gone-one': {
          pid: 'eui-0011223344556677',
          fields: [['tempc', 'temperature', 'TempC']],
          lastUplinkAt: clock.now() - 31 * 86_400_000,
        },
      },
    });
    const { app } = await setup({ storage, clock });
    await app.start(CONFIG);
    assert.deepEqual([...app.store.devices.keys()], ['new-one']);
  } finally {
    fetch.restore();
  }
});

test('M10: field names are cleaned of control characters in the test button text', async () => {
  const fetch = installFetch([
    [STORAGE, () => stream([uplink({ payload: { 'odd\u0007name': 1 } })])],
  ]);
  try {
    const { app } = await setup();
    await app.start(CONFIG);
    const answer = await app.testConnection();
    assert.match(answer.en, /ignored fields: oddname/);
    assert.ok(!answer.en.includes('\u0007'));
  } finally {
    fetch.restore();
  }
});
