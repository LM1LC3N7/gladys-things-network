// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized so
// the rest of the code never deals with strings or `undefined`.
// -----------------------------------------------------------------------------

import { CLUSTERS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest
// (test/manifest.test.js checks it).
export const DEFAULT_CONFIG = {
  server: 'eu1',
  poll_interval: 5,
};

export const SERVERS = [...Object.keys(CLUSTERS), 'custom'];

const number = (value, fallback, min, max) => {
  const n = Number(value);
  return value !== '' && value !== null && value !== undefined && Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The host of a The Things Stack server as the user may type it: a host name
 * with at least one dot and an optional port. A leading `https://` and a
 * trailing `/` are tolerated; `http://`, a path, credentials or an IP address
 * are refused (the API key is only ever sent over HTTPS to a named host).
 * Returns `host[:port]` in lower case, or null.
 */
export function parseHost(text) {
  let value = clean(text)
    .replace(/^https:\/\//i, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!value || value.length > 253) {
    return null;
  }
  let port = '';
  const colon = value.lastIndexOf(':');
  if (colon !== -1) {
    const digits = value.slice(colon + 1);
    value = value.slice(0, colon);
    const n = Number(digits);
    if (!/^\d{1,5}$/.test(digits) || n < 1 || n > 65535) {
      return null;
    }
    port = n === 443 ? '' : `:${n}`;
  }
  const labels = value.split('.');
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return null;
  }
  if (/^\d+$/.test(labels[labels.length - 1])) {
    return null; // an IPv4 address
  }
  return `${value}${port}`;
}

/** An application id of The Things Stack: 3 to 36 of a-z, 0-9 and single dashes. */
export const APPLICATION_ID = /^[a-z0-9](?:-?[a-z0-9]){2,35}$/;

/** An API key (`NNSXS.<id>.<secret>`): only characters a header may carry. */
const API_KEY = /^[A-Za-z0-9._-]{16,512}$/;

/**
 * The configuration, normalized. `problems` names what is missing or not
 * understood (never the content of the key).
 */
export function normalizeConfig(raw = {}) {
  const problems = [];
  const server = SERVERS.includes(raw.server) ? raw.server : DEFAULT_CONFIG.server;
  let host = CLUSTERS[server] ?? null;
  if (server === 'custom') {
    host = parseHost(raw.custom_host);
    if (!host) {
      problems.push(clean(raw.custom_host) ? 'host' : 'hostMissing');
    }
  }
  const applicationId = clean(raw.application_id).toLowerCase();
  if (!applicationId) {
    problems.push('applicationMissing');
  } else if (!APPLICATION_ID.test(applicationId)) {
    problems.push('application');
  }
  const apiKey = clean(raw.api_key);
  if (!apiKey) {
    problems.push('keyMissing');
  } else if (!API_KEY.test(apiKey)) {
    problems.push('key');
  }
  return {
    server,
    host,
    applicationId,
    apiKey,
    problems,
    ready: problems.length === 0,
    pollMinutes: number(raw.poll_interval, DEFAULT_CONFIG.poll_interval, 2, 60),
  };
}
