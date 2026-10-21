// -----------------------------------------------------------------------------
// Decoded fields -> Gladys features and states. Pure: no clock, no network.
//
// The fields of a LoRaWAN device are whatever its payload formatter writes:
// a field becomes a Gladys feature only when its meaning AND its unit are
// known, from its name (Cayenne LPP, common decoders, SenseCAP types) or from
// the `_sensor_attr` the decoder declares. Each kind has a category, a unit
// the core lists for it (DEVICE_FEATURE_UNITS_BY_CATEGORY of
// server/utils/constants.js) and bounds: a value out of them is left out,
// never clamped into a false reading. Every other field is ignored (the test
// button names them).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as CAT,
  DEVICE_FEATURE_TYPES as TYPES,
  DEVICE_FEATURE_UNITS as UNITS,
} from '@gladysassistant/integration-sdk';
import { DEVICE_TYPE } from './constants.js';

const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

/** A finite number, or null (never NaN, never undefined; a boolean is not a number). */
export const num = (value) =>
  typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' &&
        value.trim() !== '' &&
        value.length <= 32 &&
        Number.isFinite(Number(value))
      ? Number(value)
      : null;

const within = (min, max, digits) => (value) => {
  const n = num(value);
  if (n === null) {
    return null;
  }
  const v = round(n, digits);
  return v >= min && v <= max ? v : null;
};

const decimal = (category, unit, min, max, digits = 1, convert) => ({
  category,
  type: TYPES.SENSOR.DECIMAL,
  unit,
  min,
  max,
  convert: convert ?? within(min, max, digits),
});

/**
 * true/false, or a whole number: 1 when detected. Some decoders give a count
 * (Elsys: `motion` = PIR detections, `occupancy` 0/1/2): any count above 0
 * means detected, never ignored (a stale 0 would say "nothing").
 */
const binaryValue = (value) => {
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  const n = num(value);
  return n !== null && Number.isInteger(n) && n >= 0 ? Math.min(n, 1) : null;
};

/** hPa (or Pa, by its range) within [min, 1100] hPa, or null. */
function atmospheric(min) {
  return (value) => {
    const n = num(value);
    if (n === null) {
      return null;
    }
    const hpa = n >= min * 100 && n <= 110000 ? n / 100 : n;
    return hpa >= min && hpa <= 1100 ? round(hpa, 1) : null;
  };
}

const binary = (category) => ({
  category,
  type: TYPES.SENSOR.BINARY,
  min: 0,
  max: 1,
  convert: binaryValue,
});

// --- Kinds: the key is stored with each field (forever, never rename) ---------------

export const KINDS = {
  temperature: decimal(CAT.TEMPERATURE_SENSOR, UNITS.CELSIUS, -50, 125),
  humidity: decimal(CAT.HUMIDITY_SENSOR, UNITS.PERCENT, 0, 100),
  // An air pressure (barometric_pressure, air_pressure, baro...): hPa (or
  // mbar) as most decoders give it; Pa (SenseCAP, some decoders) is told
  // apart by its range, the two never overlap.
  pressure: decimal(CAT.PRESSURE_SENSOR, UNITS.HECTO_PASCAL, 300, 1100, 1, atmospheric(300)),
  // A bare `pressure` may be a water pressure (kPa, bar: pipe sensors): only
  // a plausible air pressure at the ground is kept (850-1100 hPa or Pa).
  pressure_air_only: decimal(
    CAT.PRESSURE_SENSOR,
    UNITS.HECTO_PASCAL,
    850,
    1100,
    1,
    atmospheric(850),
  ),
  light: decimal(CAT.LIGHT_SENSOR, UNITS.LUX, 0, 200000, 0),
  co2: { ...decimal(CAT.CO2_SENSOR, UNITS.PPM, 0, 40000, 0), type: TYPES.SENSOR.INTEGER },
  pm25: decimal(CAT.PM25_SENSOR, UNITS.MICROGRAM_PER_CUBIC_METER, 0, 2000),
  pm10: decimal(CAT.PM10_SENSOR, UNITS.MICROGRAM_PER_CUBIC_METER, 0, 2000),
  battery: {
    category: CAT.BATTERY,
    type: TYPES.BATTERY.INTEGER,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    convert: within(0, 100, 0),
  },
  // A bare "battery" / "bat" field may be a voltage: only a whole number is
  // read as a percentage (3.6 V is never shown as 3.6 %), and not 0 to 5 (a
  // rounded voltage, 3 V, is never shown as 3 %).
  battery_whole: {
    category: CAT.BATTERY,
    type: TYPES.BATTERY.INTEGER,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    convert: (value) => {
      const n = num(value);
      return n !== null && Number.isInteger(n) && n > 5 && n <= 100 ? n : null;
    },
  },
  // The same field once it gave a level above 5 %: a percentage, 0 to 100.
  battery_whole_seen: {
    category: CAT.BATTERY,
    type: TYPES.BATTERY.INTEGER,
    unit: UNITS.PERCENT,
    min: 0,
    max: 100,
    convert: (value) => {
      const n = num(value);
      return n !== null && Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
    },
  },
  battery_voltage: {
    ...decimal(CAT.ENERGY_SENSOR, UNITS.VOLT, 0, 60, 3),
    type: TYPES.ENERGY_SENSOR.VOLTAGE,
  },
  battery_millivolt: {
    ...decimal(CAT.ENERGY_SENSOR, UNITS.VOLT, 0, 60, 3, (value) => {
      const n = num(value);
      return n !== null && n >= 0 && n <= 60000 ? round(n / 1000, 3) : null;
    }),
    type: TYPES.ENERGY_SENSOR.VOLTAGE,
  },
  voltage: {
    ...decimal(CAT.ENERGY_SENSOR, UNITS.VOLT, 0, 1000, 3),
    type: TYPES.ENERGY_SENSOR.VOLTAGE,
  },
  distance_mm: decimal(CAT.DISTANCE_SENSOR, UNITS.MM, 0, 100000, 0),
  distance_cm: decimal(CAT.DISTANCE_SENSOR, UNITS.CM, 0, 10000, 1),
  distance_m: decimal(CAT.DISTANCE_SENSOR, UNITS.M, 0, 1000, 3),
  soil_moisture: decimal(CAT.SOIL_MOISTURE_SENSOR, UNITS.PERCENT, 0, 100),
  wind_speed: decimal(CAT.SPEED_SENSOR, UNITS.METER_PER_SECOND, 0, 100),
  wind_speed_kmh: decimal(CAT.SPEED_SENSOR, UNITS.KILOMETER_PER_HOUR, 0, 400),
  uv: {
    category: CAT.UV_SENSOR,
    type: TYPES.UV_SENSOR.INTEGER,
    unit: UNITS.UV_INDEX,
    min: 0,
    max: 20,
    convert: within(0, 20, 0),
  },
  leak: binary(CAT.LEAK_SENSOR),
  motion: binary(CAT.MOTION_SENSOR),
};

// --- Names: the base name (lower case, letters and digits, Cayenne channel cut) ------

const ALIASES = {
  temperature: [
    'temperature',
    'temp',
    'tempc',
    'temperaturec',
    'tempcsht',
    'tempcds',
    'tempds',
    'airtemperature',
    'ambienttemperature',
    'exttemperature',
    'externaltemperature',
    'tempext',
    'soiltemperature',
    'watertemperature',
  ],
  humidity: ['humidity', 'hum', 'humsht', 'humidityrh', 'relativehumidity', 'airhumidity', 'rh'],
  pressure: ['barometricpressure', 'barometer', 'airpressure', 'baro', 'atmosphericpressure'],
  pressure_air_only: ['pressure', 'pressurehpa'],
  light: ['illuminance', 'luminosity', 'lux', 'light', 'lightintensity', 'illum', 'ill', 'illlx'],
  co2: ['co2', 'co2ppm', 'carbondioxide', 'airco2'],
  pm25: ['pm25', 'pm25ugm3'],
  pm10: ['pm10', 'pm10ugm3'],
  battery: ['batterylevel', 'batterypercent', 'batterypercentage', 'batpercent', 'batterysoc'],
  battery_whole: ['battery', 'bat'],
  battery_voltage: [
    'batv',
    'batteryvoltage',
    'vbat',
    'vbatt',
    'batvoltage',
    'batteryv',
    'battv',
    'batvolt',
  ],
  battery_millivolt: ['batmv', 'batterymv', 'vbatmv', 'batteryvoltagemv', 'batvmv'],
  distance_mm: ['distancemm', 'distmm'],
  distance_cm: ['distancecm', 'distcm'],
  distance_m: ['distancem'],
  soil_moisture: ['soilmoisture', 'moisture', 'watersoil', 'vwc', 'soilhumidity'],
  wind_speed: ['windspeed', 'windspeedms'],
  wind_speed_kmh: ['windspeedkmh'],
  uv: ['uv', 'uvindex'],
  leak: ['leak', 'waterleak', 'leakage', 'leakdetected', 'waterleakstatus'],
  motion: ['motion', 'occupancy', 'pir', 'motiondetected'],
};

const BY_NAME = new Map(
  Object.entries(ALIASES).flatMap(([kind, names]) => names.map((name) => [name, kind])),
);

/** `_sensor_attr` device_class -> unit (lower case, no spaces) -> kind. */
const BY_ATTR = {
  temperature: {
    '°c': 'temperature',
    c: 'temperature',
    degc: 'temperature',
    celsius: 'temperature',
  },
  humidity: { '%': 'humidity' },
  pressure: { hpa: 'pressure', mbar: 'pressure', pa: 'pressure_air_only' },
  illuminance: { lx: 'light', lux: 'light' },
  carbon_dioxide: { ppm: 'co2' },
  pm25: { 'µg/m³': 'pm25', 'ug/m3': 'pm25', 'μg/m³': 'pm25' },
  pm10: { 'µg/m³': 'pm10', 'ug/m3': 'pm10', 'μg/m³': 'pm10' },
  battery: { '%': 'battery' },
  voltage: { v: 'voltage', mv: 'battery_millivolt' },
  distance: { mm: 'distance_mm', cm: 'distance_cm', m: 'distance_m' },
  moisture: { '%': 'soil_moisture' },
  wind_speed: { 'm/s': 'wind_speed', 'km/h': 'wind_speed_kmh' },
};

/**
 * The kind of a field, or undefined (ignored): what the decoder declares
 * first (a declared unit that is not understood is never guessed from the
 * name), else its name.
 */
export function kindOf(field) {
  if (field.attr && (field.attr.deviceClass || field.attr.unit)) {
    const units = Object.hasOwn(BY_ATTR, field.attr.deviceClass)
      ? BY_ATTR[field.attr.deviceClass]
      : undefined;
    const unit = field.attr.unit.toLowerCase().replace(/\s+/g, '');
    return units && Object.hasOwn(units, unit) ? units[unit] : undefined;
  }
  // The whole name first (`pm2_5`), then without a Cayenne channel (`temperature_41`).
  return BY_NAME.get(field.full) ?? BY_NAME.get(field.base);
}

/** The value of a field for its kind, or null (wrong type, out of bounds). */
export function valueOf(kindName, value) {
  const kind = Object.hasOwn(KINDS, kindName) ? KINDS[kindName] : undefined;
  if (!kind) {
    return null;
  }
  const v = kind.convert(value);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// --- Gladys devices and states ------------------------------------------------------

export const idsOf = (gladys, platformId) => gladys.externalIds(DEVICE_TYPE, platformId);

/** A detector (leak, motion): every recent change is published live. */
export const isBinaryKind = (kindName) =>
  Object.hasOwn(KINDS, kindName) && KINDS[kindName].type === TYPES.SENSOR.BINARY;

/**
 * The kind matching a feature already created (category, type, unit), so a
 * field keeps the unit of its feature even after /data was lost; null when
 * none matches (the field is then left out rather than published wrong).
 */
export function kindOfFeature(feature, only) {
  const match = Object.entries(KINDS).find(
    ([name, k]) =>
      (only === undefined || name === only) &&
      k.category === feature.category &&
      k.type === feature.type &&
      (k.unit ?? null) === (feature.unit ?? null),
  );
  return match ? match[0] : null;
}

/** A name without control characters, bounded. */
export const cleanName = (value, max) =>
  [...String(value ?? '')]
    .filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f)
    .join('')
    .trim()
    .slice(0, max);

const featureOf = (ids, { key, kind: kindName, name }) => {
  const kind = KINDS[kindName];
  return {
    name: cleanName(name, 60) || key,
    external_id: ids.feature(key),
    category: kind.category,
    type: kind.type,
    ...(kind.unit ? { unit: kind.unit } : {}),
    min: kind.min,
    max: kind.max,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
};

/** The features of the device as the user created it (gladys.devices). */
export function createdFeatures(gladys, platformId) {
  const ids = idsOf(gladys, platformId);
  const device = (gladys.devices ?? []).find((d) => d.external_id === ids.device);
  return device?.features ?? [];
}

/**
 * The Gladys device of a LoRaWAN device: every field it has ever given (with
 * the kind chosen the first time), plus every feature of the device already
 * created (so a field the decoder no longer sends never removes a feature:
 * the core would mark the device as changed and "Update" would drop its
 * history).
 */
export function deviceOf(gladys, { platformId, name, fields }) {
  const ids = idsOf(gladys, platformId);
  const features = fields
    .filter((field) => Object.hasOwn(KINDS, field.kind))
    .map((field) => featureOf(ids, field));
  const known = new Set(features.map((f) => f.external_id));
  for (const feature of createdFeatures(gladys, platformId)) {
    if (!known.has(feature.external_id) && typeof feature.external_id === 'string') {
      known.add(feature.external_id);
      features.push({
        name: feature.name,
        external_id: feature.external_id,
        category: feature.category,
        type: feature.type,
        ...(feature.unit ? { unit: feature.unit } : {}),
        min: feature.min,
        max: feature.max,
        read_only: true,
        has_feedback: false,
        keep_history: feature.keep_history !== false,
      });
    }
  }
  return {
    name: cleanName(name, 80),
    external_id: ids.device,
    // The integration reads the Storage API at its own pace: nothing to poll.
    should_poll: false,
    features,
  };
}
