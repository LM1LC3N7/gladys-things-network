// -----------------------------------------------------------------------------
// The only place that talks HTTP: `fetch` with a timeout that covers the whole
// body, a User-Agent that names the integration, no redirection followed (the
// API key never goes to another host) and a body read line by line, bounded
// in size. The tests replace it with `setFetch()`.
//
// An error message carries the host of the URL only: never the key (it
// travels in the Authorization header, never in a URL) nor the answer.
// -----------------------------------------------------------------------------

import { HTTP_TIMEOUT, MAX_BODY, MAX_LINE, USER_AGENT } from './constants.js';

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests only). Returns the previous one. */
export function setFetch(impl) {
  const previous = fetchImpl;
  fetchImpl = impl;
  return previous;
}

/** Retry-After: seconds, or an HTTP date. */
export function retryAfterMs(header, now = Date.now()) {
  if (header === null || header === undefined || header === '') {
    return undefined;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/** The network failed (DNS, timeout, a body too large...): the host only. */
export class NetworkError extends Error {
  constructor(url, reason) {
    super(`network ${reason} on ${new URL(url).host}`);
    this.name = 'NetworkError';
    this.reason = reason;
  }
}

/** A short reason: a system error code (ECONNREFUSED...) or nothing else. */
const reasonOf = (err) => {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'timeout';
  }
  const code = String(err?.cause?.code ?? err?.code ?? '');
  return /^[A-Z][A-Z_]{1,39}$/.test(code) ? code : 'failed';
};

/**
 * Split a body into lines as it arrives, linear in its size: the pieces of
 * the line being read are joined once, when its end arrives. A line longer
 * than `maxLine` is skipped (up to its end) and counted; past `maxBytes`, the
 * read stops, the line cut in two is dropped and what was read is kept
 * (`truncated`). Resolves `{ truncated, skipped }`.
 */
async function readLines(response, { maxBytes, maxLine, onLine }) {
  const decoder = new TextDecoder('utf-8');
  let pieces = [];
  let partial = 0;
  let skipping = false;
  let skipped = 0;
  let truncated = false;
  const feed = (text) => {
    let start = 0;
    for (;;) {
      const end = text.indexOf('\n', start);
      if (end === -1) {
        break;
      }
      const piece = text.slice(start, end);
      start = end + 1;
      if (skipping || partial + piece.length > maxLine) {
        skipped += 1;
      } else {
        onLine(pieces.length > 0 ? pieces.join('') + piece : piece);
      }
      pieces = [];
      partial = 0;
      skipping = false;
    }
    const rest = text.slice(start);
    if (rest && !skipping) {
      partial += rest.length;
      if (partial > maxLine) {
        // Too long: forgotten up to its end, never kept in memory.
        skipping = true;
        pieces = [];
        partial = 0;
      } else {
        pieces.push(rest);
      }
    }
  };
  if (!response.body?.getReader) {
    let text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      text = Buffer.from(text).subarray(0, maxBytes).toString('utf8');
      truncated = true;
    }
    feed(text);
  } else {
    const reader = response.body.getReader();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        size += value.byteLength;
        if (size > maxBytes) {
          truncated = true;
          const keep = value.byteLength - (size - maxBytes);
          feed(decoder.decode(value.subarray(0, Math.max(0, keep)), { stream: true }));
          await reader.cancel().catch(() => {});
          break;
        }
        feed(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    }
    if (!truncated) {
      feed(decoder.decode());
    }
  }
  if (pieces.length > 0 && !truncated && !skipping) {
    onLine(pieces.join(''));
  }
  if (skipping) {
    skipped += 1;
  }
  return { truncated, skipped };
}

/**
 * GET a document read line by line (`onLine(line)` for each). Never throws on
 * an HTTP status: resolves `{ status, retryAfterMs, truncated, skipped }`;
 * the body of an error status is read (at most 64 KB, the rest ignored: the
 * status and Retry-After decide) and passed to `onLine` as well; `onLine`
 * must not throw. Throws a NetworkError when the request or the body read
 * fails (not when the body is only too long). A redirection fails the call.
 */
export async function getLines(
  url,
  { headers = {}, onLine, timeout = HTTP_TIMEOUT, maxBytes = MAX_BODY, maxLine = MAX_LINE },
) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeout)),
    });
  } catch (err) {
    throw new NetworkError(url, reasonOf(err));
  }
  const ok = response.status >= 200 && response.status < 300;
  let read;
  try {
    read = await readLines(response, {
      maxBytes: ok ? maxBytes : 64 * 1024,
      maxLine: ok ? maxLine : 64 * 1024,
      onLine,
    });
  } catch (err) {
    throw err instanceof NetworkError ? err : new NetworkError(url, reasonOf(err));
  }
  return {
    status: response.status,
    retryAfterMs: retryAfterMs(response.headers?.get?.('retry-after')),
    truncated: read.truncated,
    skipped: read.skipped,
  };
}
