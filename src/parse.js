// -----------------------------------------------------------------------------
// One uplink of the Storage API -> the identity of its device and its decoded
// fields. Pure: no clock, no network. Port of the parsers of ttn_client (MIT):
//
// - default: every own key of `decoded_payload` (the output of the payload
//   formatter of the device, Cayenne LPP or a custom decoder); a nested
//   object becomes `<field>_<key>` (bounded depth), a `{latitude, longitude}`
//   object is a position (left out here), `_sensor_attr` declares the unit
//   and the class of other fields (`{ BatV: { unit: "V", device_class:
//   "voltage" } }`), a list or null is left out;
// - SenseCAP (`version_ids.brand_id` "sensecap"): only a payload with
//   `valid: true`; `messages` (a list, possibly of lists) of
//   `{ measurementId, measurementValue, type }` and `{ "Battery(%)": n }`.
//
// The fields are free (anyone writes a decoder): nothing here decides what
// they mean, see readings.js. Only own keys are read, and the result is built
// in Maps: a `__proto__` key pollutes nothing.
// -----------------------------------------------------------------------------

/** At most this many fields per uplink, nested at most this deep. */
const MAX_FIELDS_PER_UPLINK = 64;
const MAX_DEPTH = 3;

export const DEVICE_ID = /^[a-z0-9](?:-?[a-z0-9]){2,35}$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const ownEntries = (object) =>
  Object.keys(object)
    .slice(0, MAX_FIELDS_PER_UPLINK * 2)
    .map((key) => [key, object[key]]);

/** "Air Temperature_4097" -> "air_temperature_4097": the feature key (forever). */
export const fieldKey = (raw) =>
  String(raw)
    .slice(0, 80)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);

/** "TempC_SHT" -> "tempcsht", "temperature_41" -> "temperature": the name looked up. */
export const baseName = (raw, { channel = true } = {}) => {
  let text = String(raw).slice(0, 80).toLowerCase();
  if (channel) {
    text = text.replace(/_\d+$/, '');
  }
  return text.replace(/[^a-z0-9]+/g, '');
};

/** "2024-07-06T09:19:21.381960868Z" -> ms (nanoseconds cut to milliseconds), or null. */
export function timeOf(value) {
  if (typeof value !== 'string' || value.length > 40) {
    return null;
  }
  const ms = Date.parse(value.replace(/(\.\d{3})\d+/, '$1'));
  return Number.isFinite(ms) ? ms : null;
}

/** A declared `_sensor_attr` entry: short strings only. */
function attrOf(value) {
  if (!isObject(value)) {
    return undefined;
  }
  const text = (v) =>
    typeof v === 'string' ? v.slice(0, 24) : typeof v === 'number' ? String(v) : '';
  return {
    unit: text(value.unit),
    deviceClass: text(value.device_class).toLowerCase(),
  };
}

function defaultFields(payload, fields) {
  const attrs = new Map();
  const visit = (prefix, value, depth) => {
    if (fields.length >= MAX_FIELDS_PER_UPLINK) {
      return;
    }
    if (isObject(value)) {
      if (depth === 0 && prefix === '_sensor_attr') {
        for (const [name, attr] of ownEntries(value)) {
          const parsed = attrOf(attr);
          if (parsed) {
            attrs.set(name, parsed);
          }
        }
        return;
      }
      if (Object.hasOwn(value, 'latitude') && Object.hasOwn(value, 'longitude')) {
        return; // a position: not a Gladys feature (see TODO.md)
      }
      if (depth >= MAX_DEPTH) {
        return;
      }
      for (const [key, item] of ownEntries(value)) {
        visit(`${prefix}_${key}`, item, depth + 1);
      }
      return;
    }
    if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      fields.push({
        key: fieldKey(prefix),
        full: baseName(prefix, { channel: false }),
        base: baseName(prefix),
        raw: prefix,
        value,
      });
    }
  };
  for (const [key, value] of ownEntries(payload)) {
    visit(key, value, 0);
  }
  for (const field of fields) {
    const attr = attrs.get(field.raw);
    if (attr) {
      field.attr = attr;
    }
  }
}

function sensecapFields(payload, fields) {
  if (payload.valid !== true || !Array.isArray(payload.messages)) {
    return;
  }
  const messages = payload.messages
    .slice(0, MAX_FIELDS_PER_UPLINK)
    .flatMap((item) => (Array.isArray(item) ? item.slice(0, MAX_FIELDS_PER_UPLINK) : [item]));
  for (const message of messages) {
    if (fields.length >= MAX_FIELDS_PER_UPLINK || !isObject(message)) {
      continue;
    }
    if (Object.hasOwn(message, 'Battery(%)')) {
      fields.push({
        key: 'battery',
        full: 'batterypercent',
        base: 'batterypercent',
        raw: 'Battery(%)',
        value: message['Battery(%)'],
      });
      continue;
    }
    const { measurementId, measurementValue, type } = message;
    if (
      (typeof measurementId === 'string' || typeof measurementId === 'number') &&
      typeof type === 'string' &&
      (typeof measurementValue === 'number' || typeof measurementValue === 'string')
    ) {
      const raw = `${type}_${measurementId}`;
      fields.push({
        key: fieldKey(raw),
        full: baseName(type, { channel: false }),
        base: baseName(type, { channel: false }),
        raw,
        value: measurementValue,
      });
    }
  }
}

/**
 * An ApplicationUp -> `{ deviceId, applicationId, devEui, receivedAt, fields }`,
 * or null when it is not a usable uplink (no device id, no time, no decoded
 * payload). Fields with the same key: the first one is kept.
 */
export function parseUplink(up) {
  if (!isObject(up)) {
    return null;
  }
  const ids = isObject(up.end_device_ids) ? up.end_device_ids : {};
  const deviceId = typeof ids.device_id === 'string' ? ids.device_id : '';
  const applicationId =
    isObject(ids.application_ids) && typeof ids.application_ids.application_id === 'string'
      ? ids.application_ids.application_id
      : '';
  if (!DEVICE_ID.test(deviceId) || !DEVICE_ID.test(applicationId)) {
    return null;
  }
  const devEui =
    typeof ids.dev_eui === 'string' && /^[0-9a-fA-F]{16}$/.test(ids.dev_eui)
      ? ids.dev_eui.toLowerCase()
      : '';
  const message = isObject(up.uplink_message) ? up.uplink_message : null;
  const receivedAt = timeOf(up.received_at) ?? timeOf(message?.received_at);
  if (!message || receivedAt === null || !isObject(message.decoded_payload)) {
    return null;
  }
  const brand = isObject(message.version_ids) ? message.version_ids.brand_id : undefined;
  const fields = [];
  if (brand === 'sensecap') {
    sensecapFields(message.decoded_payload, fields);
  } else {
    defaultFields(message.decoded_payload, fields);
  }
  const seen = new Set();
  return {
    deviceId,
    applicationId,
    devEui,
    receivedAt,
    fields: fields.filter((field) => {
      if (!field.key || seen.has(field.key)) {
        return false;
      }
      seen.add(field.key);
      return true;
    }),
  };
}
