// -----------------------------------------------------------------------------
// What must survive a restart of the container (a file under /data): the
// instant of the last request, the end of a pause (429/5xx) and of a refusal
// (key refused, no right, unknown application), so a container restarting in
// a loop never reads the Storage API faster than the interval; the newest
// uplink seen (the next read asks only for what came after it); and, for each
// device, its identity (device id, DevEUI), its fields with the kind chosen
// the first time, and the time of its last uplink published (not secret: the
// Discovery list is not empty after a restart, and an uplink is never
// published twice).
//
// The API key is never written. Only while a key is refused, the file keeps
// a salted scrypt fingerprint (16 bytes, a random salt per file) of that
// refused (host, application, key), to know after a restart whether the
// refusal still concerns the configured one; it is erased by the first
// successful read. Nothing in the file can confirm a key that works.
//
// The instant of a request, a pause and a refusal are written at once (before
// the request leaves); the rest (cursor, devices) at most once a minute.
// -----------------------------------------------------------------------------

import { randomBytes, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { MAX_DEVICES, MAX_FIELDS } from './constants.js';
import { DEVICE_ID } from './parse.js';
import { KINDS } from './readings.js';

/** A storage in memory (tests, and the fallback). */
export function memoryStorage(initial) {
  let value = initial;
  let writes = 0;
  return {
    load: () => value,
    save: (next) => {
      writes += 1;
      value = JSON.parse(JSON.stringify(next));
    },
    writes: () => writes,
  };
}

/**
 * A JSON file, written atomically (a .tmp file, then a rename). A missing or
 * unreadable file is a first start (warned once, without its content); a
 * write failure is warned once: memory only then.
 */
export function fileStorage(path, { logger } = {}) {
  const warned = new Set();
  const warnOnce = (kind, text) => {
    if (!warned.has(kind)) {
      warned.add(kind);
      logger?.warn?.(text);
    }
  };
  return {
    load() {
      let text;
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          warnOnce('read', `State file unreadable (${err.code ?? 'error'}): starting afresh`);
        }
        return undefined;
      }
      if (text.length > 1024 * 1024) {
        warnOnce('read', 'State file too large: starting afresh');
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        warnOnce('read', 'State file corrupt: starting afresh');
        return undefined;
      }
    },
    save(value) {
      try {
        mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, JSON.stringify(value));
        renameSync(tmp, path);
      } catch (err) {
        warnOnce('write', `State file not writable (${err.code ?? 'error'}): kept in memory`);
      }
    },
  };
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const cleanText = (value, max) =>
  typeof value === 'string'
    ? [...value]
        .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
        .join('')
        .trim()
        .slice(0, max)
    : '';

const PLATFORM_ID = /^(eui-[0-9a-f]{16}|[a-z0-9-]{3,36}\.[a-z0-9-]{3,36})$/;
const WHY = ['key', 'rights', 'notFound'];

/** The fields read back: [key, kind, name], valid kinds only. */
const fieldsOf = (value) =>
  Array.isArray(value)
    ? value
        .filter(
          (f) =>
            Array.isArray(f) &&
            typeof f[0] === 'string' &&
            /^[a-z0-9_]{1,48}$/.test(f[0]) &&
            typeof f[1] === 'string' &&
            Object.hasOwn(KINDS, f[1]),
        )
        .slice(0, MAX_FIELDS)
        .map(([key, kind, name]) => ({ key, kind, name: cleanText(name, 60) || key }))
    : [];

function deviceOfSaved(deviceId, value, at) {
  if (!DEVICE_ID.test(deviceId) || !isObject(value) || !PLATFORM_ID.test(value.pid ?? '')) {
    return undefined;
  }
  return {
    pid: value.pid,
    devEui:
      typeof value.devEui === 'string' && /^[0-9a-f]{16}$/.test(value.devEui) ? value.devEui : '',
    fields: fieldsOf(value.fields),
    lastUplinkAt: Math.min(finite(value.lastUplinkAt), at),
  };
}

/** The persisted state of the account and of its devices. */
export class StateStore {
  constructor({ storage = memoryStorage(), now = Date.now, maxPause, maxRefusal }) {
    this.storage = storage;
    this.now = now;
    this.lastWrite = -Infinity;
    this.dirty = false;
    const saved = storage.load();
    const valid = isObject(saved);
    this.salt =
      valid && typeof saved.salt === 'string' && /^[0-9a-f]{32}$/.test(saved.salt)
        ? saved.salt
        : randomBytes(16).toString('hex');
    const at = now();
    const s = valid && isObject(saved.state) ? saved.state : {};
    // A time read back is capped (a request never "in the future", a pause
    // never longer than a fresh one): a clock that jumped, or a hand-edited
    // file, never stops the integration for longer.
    const refusedUntil = Math.min(finite(s.refusedUntil), at + maxRefusal);
    this.state = {
      host: cleanText(s.host, 260),
      app: typeof s.app === 'string' && DEVICE_ID.test(s.app) ? s.app : '',
      lastAttemptAt: Math.min(finite(s.lastAttemptAt), at),
      pausedUntil: Math.min(finite(s.pausedUntil), at + maxPause),
      streak: Math.min(Math.max(0, Math.floor(finite(s.streak))), 20),
      refusedUntil,
      refusedWhy: WHY.includes(s.refusedWhy) ? s.refusedWhy : '',
      fp: typeof s.fp === 'string' && /^[0-9a-f]{32}$/.test(s.fp) && refusedUntil > at ? s.fp : '',
      cursor: Math.min(finite(s.cursor), at),
    };
    /** device id -> { pid, devEui, fields: [{ key, kind, name }], lastUplinkAt } */
    this.devices = new Map();
    const devices = valid && isObject(saved.devices) ? saved.devices : {};
    for (const deviceId of Object.keys(devices).slice(0, MAX_DEVICES)) {
      const device = deviceOfSaved(deviceId, devices[deviceId], at);
      if (device) {
        this.devices.set(deviceId, device);
      }
    }
  }

  /** The salted fingerprint of a (host, application, key) (never the key). */
  fingerprint({ host, applicationId, apiKey }) {
    return scryptSync(`${host}\n${applicationId}\n${apiKey}`, this.salt, 16).toString('hex');
  }

  /**
   * Align the saved state with the configuration. Another host drops the
   * pause and the pace (another server); another application drops the
   * devices and the cursor too; another key (told apart in memory while the
   * process runs; after a restart, only against the fingerprint of a key
   * still refused) drops the refusal and the pace: tried at once. Anything
   * else (a reconnection, a restart, the same configuration saved again)
   * keeps everything. Returns `{ changed }`.
   */
  restore(config) {
    const s = { ...this.state };
    let changed = false;
    if (s.host !== config.host) {
      Object.assign(s, { host: config.host, pausedUntil: 0, streak: 0, lastAttemptAt: 0 });
      changed = true;
    }
    if (s.app !== config.applicationId) {
      Object.assign(s, { app: config.applicationId, cursor: 0, lastAttemptAt: 0 });
      this.devices.clear();
      changed = true;
    }
    const credentials = `${config.host}\n${config.applicationId}\n${config.apiKey}`;
    if (this.credentials !== undefined) {
      changed = changed || this.credentials !== credentials;
    } else if (s.fp && s.refusedUntil > this.now()) {
      changed = changed || s.fp !== this.fingerprint(config);
    }
    this.credentials = credentials;
    if (changed) {
      Object.assign(s, { refusedUntil: 0, refusedWhy: '', fp: '', lastAttemptAt: 0 });
    }
    if (!(s.refusedUntil > this.now())) {
      s.fp = '';
      s.refusedWhy = '';
    }
    this.set(s, { urgent: true });
    return { changed };
  }

  get() {
    return this.state;
  }

  /**
   * Update the account state. `urgent` (the instant of a request, a pause, a
   * refusal) writes at once; anything else at most once a minute (see
   * flush). A refused key (401, with the refused `config`) keeps its
   * fingerprint; a missing right or application (403, 404: the key itself
   * works) keeps none; anything else erases it.
   */
  update(changes, { urgent = false, config } = {}) {
    const next = { ...this.state, ...changes };
    if (changes.refusedUntil > 0) {
      next.fp = config && next.refusedWhy === 'key' ? this.fingerprint(config) : '';
    } else if (!(next.refusedUntil > this.now())) {
      next.fp = '';
      next.refusedWhy = '';
    }
    this.set(next, { urgent });
  }

  set(next, { urgent }) {
    if (JSON.stringify(next) === JSON.stringify(this.state)) {
      if (urgent && this.dirty) {
        this.save();
      }
      return;
    }
    this.state = next;
    this.dirty = true;
    if (urgent) {
      this.save();
    }
  }

  device(deviceId) {
    return this.devices.get(deviceId);
  }

  /** Remember a device (bounded: a new device past the limit is refused). */
  setDevice(deviceId, device) {
    if (!this.devices.has(deviceId) && this.devices.size >= MAX_DEVICES) {
      return false;
    }
    this.devices.set(deviceId, device);
    this.dirty = true;
    return true;
  }

  deleteDevice(deviceId) {
    if (this.devices.delete(deviceId)) {
      this.dirty = true;
    }
  }

  /** Write what changed when the last write is a minute old or more. */
  flush({ force = false } = {}) {
    if (this.dirty && (force || this.now() - this.lastWrite >= 60_000)) {
      this.save();
    }
  }

  save() {
    this.dirty = false;
    this.lastWrite = this.now();
    const devices = {};
    for (const [deviceId, d] of this.devices) {
      devices[deviceId] = {
        pid: d.pid,
        devEui: d.devEui,
        fields: d.fields.map((f) => [f.key, f.kind, f.name]),
        lastUplinkAt: d.lastUplinkAt,
      };
    }
    this.storage.save({ salt: this.salt, state: this.state, devices });
  }
}
