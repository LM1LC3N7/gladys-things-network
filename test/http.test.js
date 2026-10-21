import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getLines, retryAfterMs } from '../src/http.js';
import { readUplinks, storageUrl } from '../src/ttn.js';
import { API_KEY, APP, installFetch, uplink } from './helpers/fakes.js';

/** A Response whose body arrives in the given chunks. */
const chunked = (chunks, status = 200) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    }),
    { status },
  );

test('lines split across chunks, multi-byte characters cut in two', async () => {
  const text = '{"a":"é"}\n\n{"b":"日本"}\n{"c":1}';
  const bytes = new TextEncoder().encode(text);
  const chunks = [...bytes].map((b) => String.fromCharCode(b));
  const fetch = installFetch([
    [
      /example\.org/,
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const b of bytes) {
                controller.enqueue(new Uint8Array([b]));
              }
              controller.close();
            },
          }),
        ),
    ],
  ]);
  try {
    const lines = [];
    await getLines('https://example.org/x', { onLine: (l) => lines.push(l) });
    assert.deepEqual(lines, ['{"a":"é"}', '', '{"b":"日本"}', '{"c":1}']);
    assert.ok(chunks.length > 20);
  } finally {
    fetch.restore();
  }
});

test('I3: past the byte bound the read stops and keeps what came; a long line is skipped', async () => {
  const fetch = installFetch([
    [/big/, () => chunked(Array.from({ length: 20 }, (_, i) => `${String(i).padEnd(999, 'x')}\n`))],
    [/long/, () => chunked(['a\n', 'y'.repeat(3000), 'y'.repeat(3000), '\nb\n', 'z'.repeat(6000)])],
  ]);
  try {
    const big = [];
    const answer = await getLines('https://example.org/big', {
      onLine: (l) => big.push(l),
      maxBytes: 5500,
    });
    assert.equal(answer.truncated, true);
    assert.equal(big.length, 5, 'the five whole lines; the one cut in two is dropped');
    const long = [];
    const second = await getLines('https://example.org/long', {
      onLine: (l) => long.push(l),
      maxLine: 5000,
    });
    assert.deepEqual(long, ['a', 'b']);
    assert.equal(second.skipped, 2);
    assert.equal(second.truncated, false);
  } finally {
    fetch.restore();
  }
});

test('M2: an error status with a huge body keeps its status and Retry-After', async () => {
  const fetch = installFetch([
    [
      /storage/,
      () =>
        new Response('<html>'.repeat(50_000), { status: 503, headers: { 'retry-after': '900' } }),
    ],
    [/refused/, () => new Response('x'.repeat(200_000), { status: 401 })],
  ]);
  try {
    const answer = await getLines('https://example.org/storage', { onLine: () => {} });
    assert.equal(answer.status, 503);
    assert.equal(answer.retryAfterMs, 900_000);
    await assert.rejects(
      readUplinks({ host: 'example.org', applicationId: APP, apiKey: API_KEY, lastMs: 1 }),
      (err) => err.kind === 'busy' && err.retryAfterMs === 900_000,
    );
    assert.equal((await getLines('https://example.org/refused', { onLine: () => {} })).status, 401);
  } finally {
    fetch.restore();
  }
});

test('a network error names the host and a system code only', async () => {
  const fetch = installFetch([
    [
      /example/,
      () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { code: `ECONNREFUSED ${API_KEY}` },
        });
      },
    ],
  ]);
  try {
    await assert.rejects(getLines('https://example.org/x', { onLine: () => {} }), (err) => {
      assert.equal(err.message, 'network failed on example.org');
      return true;
    });
  } finally {
    fetch.restore();
  }
});

test('Retry-After in seconds or as a date', () => {
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(
    retryAfterMs('Wed, 21 Oct 2026 10:10:00 GMT', Date.parse('2026-10-21T10:00:00Z')),
    600_000,
  );
  assert.equal(retryAfterMs(''), undefined);
  assert.equal(retryAfterMs('soon'), undefined);
});

test('the Storage API URL: the application encoded, the window, newest first', () => {
  const url = new URL(
    storageUrl({
      host: 'eu1.cloud.thethings.network',
      applicationId: APP,
      after: Date.parse('2026-10-21T10:00:00Z'),
    }),
  );
  assert.equal(url.pathname, `/api/v3/as/applications/${APP}/packages/storage/uplink_message`);
  assert.equal(url.searchParams.get('after'), '2026-10-21T10:00:00.000Z');
  assert.equal(url.searchParams.get('order'), '-received_at');
  assert.equal(url.searchParams.get('last'), null);
});

test('readUplinks: results kept up to the limit, junk lines skipped, data: prefix tolerated', async () => {
  const body = [
    JSON.stringify({ result: uplink() }),
    'not json',
    `data: ${JSON.stringify({ result: uplink({ deviceId: 'second-one' }) })}`,
    JSON.stringify([1, 2]),
    JSON.stringify({ result: uplink({ deviceId: 'third-one' }) }),
  ].join('\n');
  const fetch = installFetch([[/storage/, () => new Response(body)]]);
  try {
    const { uplinks, truncated } = await readUplinks({
      host: 'eu1.cloud.thethings.network',
      applicationId: APP,
      apiKey: API_KEY,
      lastMs: 86_400_000,
      limit: 2,
    });
    assert.deepEqual(
      uplinks.map((u) => u.end_device_ids.device_id),
      ['lht65-garden', 'second-one'],
    );
    assert.equal(truncated, true);
  } finally {
    fetch.restore();
  }
});
