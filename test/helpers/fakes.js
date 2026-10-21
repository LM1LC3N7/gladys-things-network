// -----------------------------------------------------------------------------
// Fakes for the tests: fetch (routes requests to handlers, records every call,
// fails loudly on an unexpected URL), Storage API answers, uplinks shaped
// after the ttn_client fixtures, a clock and timers (nothing fires by
// itself). No test touches the network nor the disk.
// -----------------------------------------------------------------------------

import { setFetch } from '../../src/http.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export const API_KEY =
  'NNSXS.ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFG.SECRETPARTSECRETPARTSECRETPART1234567890ABCDEFGHIJKL';
export const APP = 'home-sensors';

export const CONFIG = {
  server: 'eu1',
  application_id: APP,
  api_key: API_KEY,
  poll_interval: 5,
};

/** A Storage API answer: one `{"result": ...}` per line, a blank line between. */
export const stream = (uplinks, { status = 200, headers = {}, extra = [] } = {}) =>
  new Response(
    [...uplinks.map((up) => JSON.stringify({ result: up })), ...extra].join('\n\n') + '\n',
    { status, headers: { 'content-type': 'text/event-stream', ...headers } },
  );

/** An error answer of the API. */
export const httpError = (status, headers = {}) =>
  new Response(JSON.stringify({ code: status === 401 ? 16 : 7, message: 'error' }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** An ApplicationUp (the `result` of a line), after the ttn_client fixtures. */
export function uplink({
  deviceId = 'lht65-garden',
  devEui = 'A84041000181C8B2',
  app = APP,
  at = '2026-10-21T10:00:00.123456789Z',
  payload = { TempC_SHT: 21.5, Hum_SHT: 55.2, BatV: 3.05 },
  brand,
} = {}) {
  return {
    end_device_ids: {
      device_id: deviceId,
      application_ids: { application_id: app },
      ...(devEui ? { dev_eui: devEui } : {}),
    },
    received_at: at,
    uplink_message: {
      f_port: 2,
      decoded_payload: payload,
      received_at: at,
      ...(brand ? { version_ids: { brand_id: brand, model_id: 'x' } } : {}),
    },
  };
}

/** Install a fake fetch; `routes` is a list of [RegExp, handler(call)]. */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const call = { url, init };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) {
      throw new Error(`Unexpected network call in a test: ${url}`);
    }
    return route[1](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

/** A clock the test moves by hand. */
export function createClock(start = Date.parse('2026-10-21T10:05:00Z')) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    set: (ms) => {
      t = ms;
    },
  };
}

export function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  const add = (kind, fn, ms) => {
    const id = nextId++;
    pending.set(id, { id, kind, fn, ms });
    return id;
  };
  return {
    pending,
    setTimeout: (fn, ms) => add('timeout', fn, ms),
    setInterval: (fn, ms) => add('interval', fn, ms),
    clearTimeout: (id) => pending.delete(id),
    clearInterval: (id) => pending.delete(id),
    intervals: () => [...pending.values()].filter((t) => t.kind === 'interval'),
    async runIntervals() {
      for (const t of [...pending.values()].filter((t) => t.kind === 'interval')) {
        await t.fn();
      }
    },
  };
}

/** A logger that keeps every line, to check that no key reaches it. */
export function recordingLogger() {
  const lines = [];
  const keep =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map((a) => String(a?.message ?? a)).join(' ')}`);
  return {
    lines,
    info: keep('info'),
    warn: keep('warn'),
    error: keep('error'),
    debug: keep('debug'),
  };
}

/** A promise and its resolver: an answer the test releases when it wants. */
export function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
