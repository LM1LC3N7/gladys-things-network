// The fixtures are shaped after the ones of ttn_client (tests/parsers/test_data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseName, fieldKey, parseUplink, timeOf } from '../src/parse.js';
import { kindOf, valueOf } from '../src/readings.js';
import { uplink } from './helpers/fakes.js';

test('default parser: Cayenne LPP fields, nested objects, positions and lists left out', () => {
  const parsed = parseUplink(
    uplink({
      deviceId: 'distance-03',
      devEui: '22D11357891CB769',
      payload: {
        accelerometer_77: { x: 1, y: 0.5, z: 9.8 },
        analog_in_3: 3.1,
        boolean_1: true,
        gps_34: { latitude: 48.76826575, longitude: 9.1596689, altitude: 310 },
        illuminance_44: 2008,
        raw: [1, 0, 8],
        temperature_41: 24.6,
        nothing: null,
      },
    }),
  );
  assert.equal(parsed.deviceId, 'distance-03');
  assert.equal(parsed.devEui, '22d11357891cb769');
  assert.equal(parsed.receivedAt, Date.parse('2026-10-21T10:00:00.123Z'));
  assert.deepEqual(
    parsed.fields.map((f) => [f.key, f.base, kindOf(f) ?? null]),
    [
      ['accelerometer_77_x', 'accelerometer77x', null],
      ['accelerometer_77_y', 'accelerometer77y', null],
      ['accelerometer_77_z', 'accelerometer77z', null],
      ['analog_in_3', 'analogin', null],
      ['boolean_1', 'boolean', null],
      ['illuminance_44', 'illuminance', 'light'],
      ['temperature_41', 'temperature', 'temperature'],
    ],
  );
});

test('SenseCAP parser: valid messages only, nested lists, the battery', () => {
  const payload = {
    err: 0,
    messages: [
      { measurementId: '4097', measurementValue: 13.3, type: 'Air Temperature' },
      [{ measurementId: '4098', measurementValue: 77, type: 'Air Humidity' }],
      { measurementId: '4101', measurementValue: 99660, type: 'Barometric Pressure' },
      { measurementId: '4190', measurementValue: 0, type: 'UV Index' },
      { measurementId: '4104', measurementValue: 127, type: 'Wind Direction Sensor' },
      { 'Battery(%)': 100 },
    ],
    payload: '0100854D',
    valid: true,
  };
  const parsed = parseUplink(uplink({ payload, brand: 'sensecap' }));
  const kinds = parsed.fields.map((f) => [f.key, kindOf(f) ?? null, valueOf(kindOf(f), f.value)]);
  assert.deepEqual(kinds, [
    ['air_temperature_4097', 'temperature', 13.3],
    ['air_humidity_4098', 'humidity', 77],
    ['barometric_pressure_4101', 'pressure', 996.6],
    ['uv_index_4190', 'uv', 0],
    ['wind_direction_sensor_4104', null, null],
    ['battery', 'battery', 100],
  ]);
  assert.deepEqual(
    parseUplink(uplink({ payload: { ...payload, valid: false }, brand: 'sensecap' })).fields,
    [],
  );
});

test('unusable uplinks: no device id, another shape, no time, no decoded payload', () => {
  assert.equal(parseUplink(null), null);
  assert.equal(parseUplink(uplink({ deviceId: 'Bad Id' })), null);
  const noPayload = uplink();
  delete noPayload.uplink_message.decoded_payload;
  assert.equal(parseUplink(noPayload), null);
  const noTime = uplink({ at: 'yesterday' });
  assert.equal(parseUplink(noTime), null);
  assert.equal(parseUplink(uplink({ devEui: 'nothex' })).devEui, '');
});

test('bounded: fields per uplink, nesting depth, key length', () => {
  const payload = {};
  for (let i = 0; i < 500; i += 1) {
    payload[`temperature_${i}`] = i;
  }
  payload.deep = { a: { b: { c: { d: { e: 1 } } } } };
  const parsed = parseUplink(uplink({ payload }));
  assert.ok(parsed.fields.length <= 64);
  assert.ok(parsed.fields.every((f) => f.key.length <= 48));
  assert.equal(fieldKey('x'.repeat(200)).length, 48);
  assert.equal(baseName('TempC_SHT'), 'tempcsht');
  assert.equal(timeOf('2024-03-11T08:49:11.153738893Z'), Date.parse('2024-03-11T08:49:11.153Z'));
});

test('kinds: units of the core, bounds, no guess from the name when a unit is declared', () => {
  const k = (raw, attr) => kindOf({ base: baseName(raw), raw, attr });
  assert.equal(k('BatV'), 'battery_voltage');
  assert.equal(k('battery_mv'), 'battery_millivolt');
  assert.equal(valueOf('battery_millivolt', 3050), 3.05);
  assert.equal(valueOf('battery_whole', 3.6), null);
  assert.equal(valueOf('battery_whole', 87), 87);
  assert.equal(valueOf('pressure', 1013.25), 1013.3);
  assert.equal(valueOf('pressure', 5000), null);
  assert.equal(valueOf('temperature', 'NaN'), null);
  assert.equal(valueOf('temperature', true), null);
  assert.equal(valueOf('temperature', 300), null);
  assert.equal(valueOf('leak', true), 1);
  // I4: a count above 1 means detected; a negative or a fraction is not a state.
  assert.equal(valueOf('leak', 2), 1);
  assert.equal(valueOf('motion', 17), 1);
  assert.equal(valueOf('motion', -1), null);
  assert.equal(valueOf('motion', 0.5), null);
  // I4: a bare pressure is an air pressure only within 850-1100 hPa (or Pa).
  assert.equal(k('pressure'), 'pressure_air_only');
  assert.equal(k('barometric_pressure'), 'pressure');
  assert.equal(valueOf('pressure_air_only', 350), null);
  assert.equal(valueOf('pressure_air_only', 101325), 1013.3);
  assert.equal(valueOf('pressure_air_only', 700), null);
  assert.equal(valueOf('pressure', 700), 700);
  // M9: a whole battery of 0 to 5 may be a rounded voltage: left out.
  assert.equal(valueOf('battery_whole', 3), null);
  assert.equal(valueOf('battery_whole', 6), 6);
  assert.equal(valueOf('constructor', 1), null);
  assert.equal(k('temperature', { unit: '°F', deviceClass: 'temperature' }), undefined);
  assert.equal(k('temperature', { unit: '°C', deviceClass: 'temperature' }), 'temperature');
  assert.equal(k('level', { unit: 'cm', deviceClass: 'distance' }), 'distance_cm');
  assert.equal(k('distance'), undefined, 'a distance without unit is not guessed');
  assert.equal(k('toString'), undefined);
  const [pm] = parseUplink(uplink({ payload: { pm2_5: 12.4 } })).fields;
  assert.equal(kindOf(pm), 'pm25', 'the whole name first: pm2_5 is not channel 5 of "pm2"');
});
