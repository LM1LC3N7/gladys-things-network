// -----------------------------------------------------------------------------
// The integration itself: when the Storage API is due, the pauses and
// refusals, the devices and their fields, the states (through the budget),
// the connection status and the test button. index.js only wires the SDK
// handlers to it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { StateBudget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  BUSY_BASE,
  BUSY_MAX,
  BUSY_MIN,
  FIRST_PUBLISH_MAX_AGE,
  FIRST_WINDOW,
  MAX_DEVICES,
  MAX_FIELDS,
  MAX_UPLINKS,
  REFUSED_BACKOFF,
  TEST_DEADLINE,
  TICK,
  WINDOW_MARGIN,
} from './constants.js';
import { T } from './i18n.js';
import { parseUplink } from './parse.js';
import { createdFeatures, deviceOf, idsOf, kindOf, valueOf } from './readings.js';
import { StateStore, memoryStorage } from './store.js';
import { TtnError, readUplinks } from './ttn.js';

const defaultTimers = { setInterval, clearInterval, setTimeout, clearTimeout };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** 12.54 -> "12.54", "12,54" in French. */
const numberText = (value, lang) =>
  lang === 'fr' ? String(value).replace('.', ',') : String(value);

/** An uplink further in the future than this is not believed. */
const FUTURE_SLACK = 5 * 60_000;

export class TtnApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'things-network' }),
    now = Date.now,
    timers = defaultTimers,
    storage = memoryStorage(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.timers = timers;
    this.config = normalizeConfig();
    this.configKey = undefined;
    // The pace, pauses and refusals live as long as the process, across
    // reconnections to Gladys, and in /data across restarts of the container.
    this.store = new StateStore({ storage, now, maxPause: BUSY_MAX, maxRefusal: REFUSED_BACKOFF });
    this.budget = new StateBudget({ gladys, now, logger });
    /** device id -> { pid, values: Map<key, { value, at, queued }>, ignored: Set } */
    this.track = new Map();
    this.error = undefined;
    this.lastRead = undefined;
    this.interval = undefined;
    this.chain = Promise.resolve();
    this.lastDiscovered = undefined;
    this.lastStatus = undefined;
    this.generation = 0;
    this.started = false;
    this.connected = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * (Re)start with a configuration. The same configuration again (a
   * reconnection to Gladys, an unchanged configuration saved) keeps
   * everything, a read in flight included, and only publishes the status and
   * the Discovery list again (the core keeps them in memory only). Another
   * configuration starts a new generation: an answer to the previous one
   * publishes nothing.
   */
  async start(raw = {}) {
    const config = normalizeConfig(raw);
    const key = JSON.stringify(config);
    this.connected = true;
    this.lastStatus = undefined;
    this.lastDiscovered = undefined;
    if (!this.started || key !== this.configKey) {
      this.generation += 1;
      const previous = this.config;
      this.config = config;
      this.configKey = key;
      this.started = true;
      this.error = undefined;
      if (config.ready) {
        this.store.restore(config);
        if (previous.applicationId !== config.applicationId || previous.host !== config.host) {
          this.track.clear();
          this.budget.clear();
          this.lastRead = undefined;
        }
        const saved = this.store.get();
        // After a restart, the status says at once that the key is refused or
        // the server paused, without asking it.
        if (saved.refusedUntil > this.now()) {
          this.error = new TtnError('refused', { why: saved.refusedWhy || 'key' });
        } else if (saved.pausedUntil > this.now()) {
          this.error = new TtnError('busy');
        }
      }
    }
    if (this.interval === undefined) {
      this.interval = this.timers.setInterval(
        () => this.tick().catch((err) => this.logger.warn(`Refresh failed: ${this.scrub(err)}`)),
        TICK,
      );
    }
    // Published first: a read still in flight (it is never started again)
    // does not delay them; the read due, if any, publishes them again.
    await this.publishDiscovered();
    await this.refreshStatus();
    await this.tick();
  }

  /** Disconnected or shutting down: no timer, nothing published; a read in flight may finish. */
  stop() {
    this.connected = false;
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
    this.store.flush({ force: true });
  }

  /** An error message without the API key. */
  scrub(err) {
    let message = String(err?.message ?? err);
    const key = this.config.apiKey;
    if (key && key.length >= 8) {
      message = message.split(key).join('***');
    }
    return message.replace(/NNSXS\.[A-Za-z0-9.]+/g, 'NNSXS.***');
  }

  /** Run `fn` after every read already queued: never two reads at once. */
  exclusive(fn) {
    const run = this.chain.catch(() => {}).then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // --- Reading -----------------------------------------------------------------------

  /** Read if due, then send the states the budget allows. */
  async tick() {
    await this.exclusive(() => this.readDue());
    if (this.connected) {
      await this.budget.flush();
    }
    this.store.flush();
  }

  async readDue() {
    if (!this.config.ready || this.now() < this.earliestRead()) {
      return;
    }
    const generation = this.generation;
    await this.read();
    if (generation === this.generation && this.connected) {
      await this.publishDiscovered();
      await this.refreshStatus();
    }
  }

  intervalMs() {
    return this.config.pollMinutes * 60_000;
  }

  /** The earliest periodic read: interval, pause and refusal kept. */
  earliestRead() {
    const s = this.store.get();
    return Math.max(s.lastAttemptAt + this.intervalMs(), s.pausedUntil, s.refusedUntil);
  }

  /**
   * Read the Storage API if the interval has passed; never throws. Nothing,
   * not even the test button (`manual`), reads before the last request + the
   * interval, nor during a pause asked by the server; `manual` may try a
   * refused key again once the interval has passed. Returns whether a
   * request was sent.
   */
  async read({ manual = false } = {}) {
    if (!this.config.ready) {
      return false;
    }
    const generation = this.generation;
    const config = this.config;
    const s = this.store.get();
    const now = this.now();
    if (now < Math.max(s.lastAttemptAt + this.intervalMs(), s.pausedUntil)) {
      if (now < s.pausedUntil) {
        this.error = this.error ?? new TtnError('busy');
      }
      return false;
    }
    if (!manual && now < s.refusedUntil) {
      this.error = new TtnError('refused', { why: s.refusedWhy || 'key' });
      return false;
    }
    // The request may leave now: recorded first (and written), so neither a
    // reconnection, a saved configuration nor a restart reads again sooner.
    this.store.update({ lastAttemptAt: now }, { urgent: true });
    const after = s.cursor > 0 ? Math.max(s.cursor - WINDOW_MARGIN, now - FIRST_WINDOW) : undefined;
    let result;
    try {
      result = await readUplinks({
        host: config.host,
        applicationId: config.applicationId,
        apiKey: config.apiKey,
        after,
        lastMs: FIRST_WINDOW,
        limit: MAX_UPLINKS,
      });
    } catch (err) {
      const error = err instanceof TtnError ? err : new TtnError('failed');
      const at = this.now();
      if (generation !== this.generation) {
        // Reconfigured meanwhile: a refusal is dropped (it concerned the
        // previous configuration), a pause asked by the same server is kept.
        if (error.kind === 'busy' && this.config.host === config.host) {
          this.recordBusy(error, at);
        }
        return true;
      }
      this.error = error;
      if (error.kind === 'refused') {
        this.store.update(
          { refusedUntil: at + REFUSED_BACKOFF, refusedWhy: error.why ?? 'key' },
          { urgent: true, config },
        );
      } else if (error.kind === 'busy') {
        this.recordBusy(error, at);
      }
      this.logger.warn(`Storage API: ${this.scrub(error)}`);
      return true;
    }
    if (generation !== this.generation) {
      return true; // an answer to a previous configuration publishes nothing
    }
    this.error = undefined;
    this.store.update({ pausedUntil: 0, streak: 0, refusedUntil: 0 });
    this.lastRead = { at: this.now(), uplinks: result.uplinks.length, truncated: result.truncated };
    this.apply(result.uplinks);
    return true;
  }

  /** A 429 / 5xx: Retry-After, else 5 minutes doubling; 1 minute to 6 hours. */
  recordBusy(error, at) {
    const streak = this.store.get().streak + 1;
    const pause = clamp(
      error.retryAfterMs ?? BUSY_BASE * 2 ** Math.min(streak - 1, 10),
      BUSY_MIN,
      BUSY_MAX,
    );
    this.store.update({ streak, pausedUntil: at + pause }, { urgent: true });
  }

  /**
   * The uplinks (newest first) -> the newest value of each field of each
   * device, the new fields, and the states of the uplinks not published yet.
   */
  apply(uplinks) {
    const now = this.now();
    const app = this.config.applicationId;
    /** device id -> { devEui, receivedAt, fields: Map<key, { field, at }> } */
    const byDevice = new Map();
    let newest = 0;
    for (const up of uplinks) {
      const parsed = parseUplink(up);
      if (!parsed || parsed.applicationId !== app || parsed.receivedAt > now + FUTURE_SLACK) {
        continue;
      }
      newest = Math.max(newest, parsed.receivedAt);
      let device = byDevice.get(parsed.deviceId);
      if (!device) {
        device = { devEui: parsed.devEui, receivedAt: parsed.receivedAt, fields: new Map() };
        byDevice.set(parsed.deviceId, device);
      } else if (parsed.devEui && device.devEui && parsed.devEui !== device.devEui) {
        continue; // an older uplink of another device under the same id
      }
      for (const field of parsed.fields) {
        if (!device.fields.has(field.key)) {
          device.fields.set(field.key, { field, at: parsed.receivedAt });
        }
      }
    }
    this.tooMany = false;
    const states = [];
    for (const [deviceId, device] of byDevice) {
      states.push(...this.applyDevice(deviceId, device, now));
    }
    if (newest > this.store.get().cursor) {
      this.store.update({ cursor: newest });
    }
    this.budget.enqueue(states);
  }

  applyDevice(deviceId, device, now) {
    const app = this.config.applicationId;
    let saved = this.store.device(deviceId);
    // The DevEUI is the identity of the hardware: another one under the same
    // device id is another device. A missing DevEUI is not "another device".
    if (saved && device.devEui && saved.devEui && saved.devEui !== device.devEui) {
      saved = undefined;
      this.track.delete(deviceId);
    }
    const next = saved
      ? { ...saved, devEui: saved.devEui || device.devEui, fields: [...saved.fields] }
      : {
          pid: device.devEui ? `eui-${device.devEui}` : `${app}.${deviceId}`,
          devEui: device.devEui,
          fields: [],
          lastUplinkAt: 0,
        };
    let entry = this.track.get(deviceId);
    if (!entry || entry.pid !== next.pid) {
      entry = { pid: next.pid, values: new Map(), ignored: new Set() };
    }
    const kinds = new Map(next.fields.map((f) => [f.key, f.kind]));
    const fresh = [];
    for (const [key, { field, at }] of device.fields) {
      let kind = kinds.get(key);
      if (!kind) {
        // The kind is chosen once, at the first sight of the field, and kept
        // (the unit of a created feature never changes).
        kind = kindOf(field);
        if (!kind || next.fields.length >= MAX_FIELDS) {
          if (entry.ignored.size < 30) {
            entry.ignored.add(field.raw.slice(0, 40));
          }
          continue;
        }
        next.fields.push({ key, kind, name: field.raw });
        kinds.set(key, kind);
      }
      const value = valueOf(kind, field.value);
      if (value === null) {
        continue;
      }
      const old = entry.values.get(key);
      if (!old || old.at < at) {
        entry.values.set(key, { value, at, queued: false });
      }
      // Never twice the same uplink; at the very first read, only the last
      // few hours (an old value is history, not the current state).
      const firstSight = saved === undefined || saved.lastUplinkAt === 0;
      if (at > next.lastUplinkAt && (!firstSight || at >= now - FIRST_PUBLISH_MAX_AGE)) {
        fresh.push(key);
      }
    }
    next.lastUplinkAt = Math.max(next.lastUplinkAt, device.receivedAt);
    if (!this.store.setDevice(deviceId, next)) {
      this.tooMany = true;
      return [];
    }
    this.track.set(deviceId, entry);
    return this.statesOf(entry, fresh);
  }

  /** The states of `keys` of a device whose feature exists in Gladys. */
  statesOf(entry, keys) {
    const ids = idsOf(this.gladys, entry.pid);
    const created = new Set(createdFeatures(this.gladys, entry.pid).map((f) => f.external_id));
    const states = [];
    for (const key of keys) {
      const value = entry.values.get(key);
      const id = ids.feature(key);
      if (value && created.has(id) && Number.isFinite(value.value)) {
        value.queued = true;
        states.push({
          device_feature_external_id: id,
          state: value.value,
          created_at: new Date(value.at).toISOString(),
        });
      }
    }
    return states;
  }

  /** A device was created in Gladys: its latest values not sent yet go now. */
  async onDeviceCreated() {
    for (const entry of this.track.values()) {
      const keys = [...entry.values].filter(([, v]) => !v.queued).map(([key]) => key);
      this.budget.enqueue(this.statesOf(entry, keys));
    }
    if (this.connected) {
      await this.budget.flush();
    }
  }

  // --- Gladys devices and status ---------------------------------------------------

  /** One Gladys device per platform id (the most recent device id wins). */
  devices() {
    const list = [...this.store.devices]
      .sort((a, b) => b[1].lastUplinkAt - a[1].lastUplinkAt)
      .map(([deviceId, d]) =>
        deviceOf(this.gladys, { platformId: d.pid, name: deviceId, fields: d.fields }),
      )
      .filter((device) => device.features.length > 0);
    const seen = new Set();
    return list.filter((device) => {
      if (seen.has(device.external_id)) {
        return false;
      }
      seen.add(device.external_id);
      return true;
    });
  }

  /** The Discovery tab, published again only when it changed. */
  async publishDiscovered({ force = false } = {}) {
    if (!this.connected) {
      return;
    }
    const devices = this.config.ready ? this.devices() : [];
    const key = JSON.stringify(devices);
    if (!force && key === this.lastDiscovered) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.lastDiscovered = key;
    } catch (err) {
      this.logger.warn(`publishDiscoveredDevices failed: ${err.message}`);
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus || !this.connected) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  /** The status text: what is read, then what fails, then the hints. */
  statusText() {
    const s = this.store.get();
    const withValues = [...this.store.devices.values()].filter((d) => d.fields.length > 0).length;
    const parts = [
      T.ok({
        application: this.config.applicationId,
        devices: withValues,
        interval: this.config.pollMinutes,
        lastRead: this.lastRead?.at,
      }),
    ];
    if (this.error) {
      const until =
        this.error.kind === 'busy' && s.pausedUntil > this.now() ? s.pausedUntil : undefined;
      parts.push(T.failing(this.error, until));
      if (this.error.kind === 'refused') {
        parts.push(T.refusedHelp);
      }
    } else if (this.lastRead && this.store.devices.size === 0) {
      parts.push(T.noUplink);
    }
    if (this.lastRead?.truncated) {
      parts.push(T.truncated(MAX_UPLINKS));
    }
    if (this.tooMany) {
      parts.push(T.tooMany(MAX_DEVICES));
    }
    return {
      en: parts.map((p) => p.en).join(' '),
      fr: parts.map((p) => p.fr).join(' '),
    };
  }

  async refreshStatus() {
    if (!this.config.ready) {
      return this.setStatus(false, T.notConfigured(this.config.problems));
    }
    const connected =
      !this.error ||
      (this.error.kind !== 'refused' && (this.store.devices.size > 0 || Boolean(this.lastRead)));
    return this.setStatus(connected, this.statusText());
  }

  // --- Configuration screen button -------------------------------------------------

  line(deviceId, lang) {
    const entry = this.track.get(deviceId);
    const colon = lang === 'fr' ? ' :' : ':';
    const saved = this.store.device(deviceId);
    const values = [];
    for (const field of saved?.fields ?? []) {
      const v = entry?.values.get(field.key);
      if (v && values.length < 8) {
        values.push(`${field.name} ${numberText(v.value, lang)}`);
      }
    }
    const parts = [];
    parts.push(
      values.length > 0
        ? values.join(', ')
        : lang === 'fr'
          ? 'aucune valeur lue depuis le démarrage'
          : 'no value read since the start',
    );
    if (entry?.ignored.size > 0) {
      const list = [...entry.ignored].slice(0, 8).join(', ');
      parts.push(lang === 'fr' ? `champs ignorés : ${list}` : `ignored fields: ${list}`);
    }
    return `- ${deviceId}${colon} ${parts.join(' ; ')}`;
  }

  async testConnection() {
    if (!this.config.ready) {
      return T.notConfigured(this.config.problems);
    }
    // Gladys waits 120 s for the answer: past ~100 s, the last values are
    // shown (a read still running finishes in the background).
    const generation = this.generation;
    const reads = this.exclusive(async () => {
      if (generation === this.generation) {
        await this.read({ manual: true });
      }
    });
    let timer;
    const timeout = new Promise((resolve) => {
      timer = this.timers.setTimeout(resolve, TEST_DEADLINE);
    });
    try {
      await Promise.race([reads, timeout]);
    } finally {
      this.timers.clearTimeout(timer);
    }
    if (this.connected) {
      await this.budget.flush();
      await this.publishDiscovered();
      await this.refreshStatus();
    }
    const s = this.store.get();
    const next = Math.max(s.lastAttemptAt + this.intervalMs(), s.pausedUntil, this.now());
    const status = this.statusText();
    const en = [status.en];
    const fr = [status.fr];
    for (const deviceId of [...this.store.devices.keys()].slice(0, 20)) {
      en.push(this.line(deviceId, 'en'));
      fr.push(this.line(deviceId, 'fr'));
    }
    en.push(`${T.nextRead(next).en[0].toUpperCase()}${T.nextRead(next).en.slice(1)}.`);
    fr.push(`${T.nextRead(next).fr[0].toUpperCase()}${T.nextRead(next).fr.slice(1)}.`);
    return { en: en.join('\n'), fr: fr.join('\n') };
  }
}
