// -----------------------------------------------------------------------------
// The Storage API of The Things Stack, read only (after ttn_client, MIT):
//
//   GET https://<host>/api/v3/as/applications/<app>/packages/storage/uplink_message
//       ?order=-received_at&limit=<n>&last=24h | &after=<RFC 3339>
//   Authorization: Bearer <API key>, Accept: text/event-stream
//
// The answer is one JSON object per line: `{"result": <ApplicationUp>}`, or
// `{"error": {...}}` when the stream fails. Nothing else of the API is ever
// called (no downlink, no device registry write): the key only needs the
// "Read application traffic" right.
// -----------------------------------------------------------------------------

import { MAX_UPLINKS } from './constants.js';
import { NetworkError, getLines } from './http.js';

/** Why a read failed: `refused` (key, rights, notFound), `busy`, `failed`. */
export class TtnError extends Error {
  constructor(kind, { why, retryAfterMs, status } = {}) {
    super(`${kind}${why ? ` (${why})` : ''}${status ? ` HTTP ${status}` : ''}`);
    this.name = 'TtnError';
    this.kind = kind;
    this.why = why;
    this.retryAfterMs = retryAfterMs;
  }
}

/** The URL of a read: `after` (ms) when an uplink was already seen, else `lastMs`. */
export function storageUrl({ host, applicationId, after, lastMs, limit = MAX_UPLINKS }) {
  const params = new URLSearchParams({ order: '-received_at', limit: String(limit) });
  if (after !== undefined) {
    params.set('after', new Date(after).toISOString());
  } else {
    params.set('last', `${Math.max(60, Math.round(lastMs / 1000))}s`);
  }
  return `https://${host}/api/v3/as/applications/${encodeURIComponent(applicationId)}/packages/storage/uplink_message?${params}`;
}

/** gRPC codes of a stream error line -> error kind. */
const STREAM_CODES = {
  16: ['refused', 'key'],
  7: ['refused', 'rights'],
  5: ['refused', 'notFound'],
  8: ['busy'],
  14: ['busy'],
};

/** HTTP status -> error, or undefined for a success. */
function statusError(status, retryAfterMs) {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 401) {
    return new TtnError('refused', { why: 'key', status });
  }
  if (status === 403) {
    return new TtnError('refused', { why: 'rights', status });
  }
  if (status === 404) {
    return new TtnError('refused', { why: 'notFound', status });
  }
  if (status === 429 || status >= 500) {
    return new TtnError('busy', { retryAfterMs, status });
  }
  return new TtnError('failed', { status });
}

/**
 * Read the uplinks. Resolves `{ uplinks, truncated }`, `uplinks` being the
 * `result` objects (newest first, at most `limit`); throws a TtnError.
 */
export async function readUplinks({ host, applicationId, apiKey, after, lastMs, limit }) {
  const url = storageUrl({ host, applicationId, after, lastMs, limit });
  const uplinks = [];
  const max = limit ?? MAX_UPLINKS;
  let streamError;
  let lines = 0;
  const onLine = (raw) => {
    let line = raw.trim();
    if (line.startsWith('data:')) {
      line = line.slice(5).trim();
    }
    if (line.length < 8 || streamError) {
      return;
    }
    lines += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    if (Object.hasOwn(parsed, 'error')) {
      const code = Number(parsed.error?.code);
      const [kind, why] = STREAM_CODES[code] ?? ['failed'];
      streamError = new TtnError(kind, {
        why: why ?? (Number.isFinite(code) ? `code ${code}` : ''),
      });
      return;
    }
    const result = parsed.result;
    if (result && typeof result === 'object' && !Array.isArray(result) && uplinks.length < max) {
      uplinks.push(result);
    }
  };
  let answer;
  try {
    answer = await getLines(url, {
      headers: { Accept: 'text/event-stream', Authorization: `Bearer ${apiKey}` },
      onLine,
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      throw new TtnError('failed', { why: err.reason });
    }
    throw new TtnError('failed');
  }
  const error = statusError(answer.status, answer.retryAfterMs);
  if (error) {
    throw error;
  }
  if (streamError) {
    throw streamError;
  }
  return { uplinks, truncated: uplinks.length >= max, lines };
}
