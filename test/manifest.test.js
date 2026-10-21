// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here. They also guard
// the text files against mojibake, a BOM and control bytes (a manifest once
// shipped broken), and the texts against the word "encrypted" for a secret
// field (Gladys keeps a secret in clear in its database).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTIONS } from '../src/constants.js';
import { DEFAULT_CONFIG, SERVERS } from '../src/config.js';
import { KINDS, deviceOf } from '../src/readings.js';

const readBuffer = (path) => readFileSync(new URL(`../${path}`, import.meta.url));
const read = (path) => readBuffer(path).toString('utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const pkg = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const index = read('index.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, item] of node.entries()) {
      yield* texts(item, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const USER_DOCS = ['docs/en.md', 'docs/fr.md', 'README.md', 'CHANGELOG.md'];

const listJs = (dir) =>
  readdirSync(new URL(`../${dir}/`, import.meta.url))
    .filter((name) => name.endsWith('.js'))
    .map((name) => `${dir}/${name}`);

test('no mojibake, no BOM and no control byte in the manifest, the docs and the code', () => {
  const files = [
    'gladys-assistant-integration.json',
    ...USER_DOCS,
    'TODO.md',
    'CLAUDE.md',
    'THIRD_PARTY_NOTICES.md',
    'Dockerfile',
    'package.json',
    'index.js',
    '.github/scripts/cover.mjs',
    ...listJs('src'),
    ...listJs('test'),
  ];
  assert.ok(files.length > 20, 'every source file is checked');
  for (const file of files) {
    const buffer = readBuffer(file);
    assert.ok(
      !(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf),
      `${file} starts with a BOM`,
    );
    for (const byte of buffer) {
      assert.ok(byte >= 0x20 || byte === 0x0a || byte === 0x0d, `${file} holds a control byte`);
    }
    const text = buffer.toString('utf8');
    assert.ok(
      !text.includes(String.fromCharCode(0xfffd)),
      `${file} holds an invalid UTF-8 sequence`,
    );
    for (const bad of [[0xc3], [0xc2], [0xe2, 0x20ac]].map((c) => String.fromCharCode(...c))) {
      assert.ok(!text.includes(bad), `${file} holds mojibake (${bad})`);
    }
    assert.doesNotMatch(
      text,
      new RegExp('[\\u0300-\\u036f]'),
      `${file} holds a bare combining mark`,
    );
  }
  assert.match(read('docs/fr.md'), /é/);
  assert.match(manifest.config_schema[0].description.fr, /écrit|décod/);
});

test('a secret is never said "encrypted" ("chiffré") to the user', () => {
  for (const [path, text] of texts(manifest)) {
    assert.doesNotMatch(`${text.en} ${text.fr}`, /encrypt|chiffr/i, path);
  }
  for (const file of USER_DOCS) {
    assert.doesNotMatch(read(file), /encrypt|chiffr/i, file);
  }
});

test('the store basics', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.match(manifest.gladys_version, />=5\.1\.0/);
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const docs = read(`docs/${lang}.md`);
    assert.ok(docs.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.match(docs, /ttn_client/, `docs/${lang}.md credits ttn_client`);
    assert.match(docs, /Storage Integration/, `docs/${lang}.md explains the Storage Integration`);
  }
  assert.match(read('docs/en.md'), /never been tested with a real/i);
  assert.match(read('docs/fr.md'), /jamais été testée avec un vrai/i);
  assert.match(manifest.description.en, /Unofficial/);
  assert.match(manifest.description.fr, /non officiel/);
  assert.match(
    manifest.config_schema[0].description.en,
    /not affiliated with The Things Industries/,
  );
});

test('version 0.1.0 everywhere, and the image is tagged with it', () => {
  assert.equal(manifest.version, pkg.version);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(lock.name, pkg.name);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-things-network:${manifest.version}`);
});

test('the license and the notices ship with the image', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/, 'no personal name');
  assert.equal(pkg.license, 'Apache-2.0');
  const notices = read('THIRD_PARTY_NOTICES.md');
  assert.match(notices, /ttn_client/);
  assert.match(notices, /Permission is hereby granted, free of charge/);
  assert.match(notices, /THE SOFTWARE IS PROVIDED "AS IS"/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
});

test('every text is bilingual', () => {
  for (const [path, text] of texts(manifest)) {
    assert.ok(text.en?.trim() && text.fr?.trim(), `${path} needs en and fr`);
  }
});

test('sections are purely presentational, with https links', () => {
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    assert.equal(section.required, undefined);
    assert.equal(section.default, undefined);
    assert.ok(!(section.key in DEFAULT_CONFIG));
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang} is too long`);
    }
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//);
    }
  }
});

test('the configuration matches the code', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(fields[key]?.default, value, key);
  }
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(DEFAULT_CONFIG[field.key], field.default, field.key);
    }
  }
  assert.deepEqual(
    fields.server.options.map((o) => o.value),
    SERVERS,
  );
  assert.equal(fields.custom_host.type, 'string');
  assert.equal(fields.application_id.type, 'string');
  assert.equal(fields.api_key.type, 'secret', 'the key is masked, never shown again');
  assert.match(fields.api_key.description.en, /Kept by Gladys in its database, never shown again/);
  assert.match(fields.api_key.description.fr, /Gardée par Gladys dans sa base, jamais réaffichée/);
  assert.equal(fields.poll_interval.min, 2);
  assert.equal(fields.poll_interval.max, 60);
});

test('the keys of the manifest are the keys of the code; read only', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  assert.ok(index.includes('onAction(ACTIONS.TEST'));
  assert.ok(manifest.actions[0].timeout_seconds <= 120);
  assert.equal(manifest.scene_triggers, undefined);
  assert.equal(manifest.scene_actions, undefined);
  assert.equal(manifest.widgets, undefined);
  assert.ok(!index.includes('onSetValue'), 'no command: read only');
  for (const file of listJs('src')) {
    assert.doesNotMatch(read(file), /method:\s*['"](POST|PUT|PATCH|DELETE)/, `${file} only reads`);
  }
});

// DEVICE_FEATURE_UNITS_BY_CATEGORY of server/utils/constants.js (Gladys core),
// for the categories this integration uses. The binary sensors carry no unit.
const CORE_UNITS = {
  'temperature-sensor': ['celsius', 'fahrenheit', 'kelvin'],
  'humidity-sensor': ['percent'],
  'pressure-sensor': ['pascal', 'hPa', 'kPa', 'bar', 'psi', 'milli-bar'],
  'light-sensor': ['lux'],
  'co2-sensor': ['ppm'],
  'pm25-sensor': [
    'milligram-per-cubic-meter',
    'microgram-per-cubic-meter',
    'nanogram-per-cubic-meter',
  ],
  'pm10-sensor': ['microgram-per-cubic-meter', 'nanogram-per-cubic-meter'],
  battery: ['percent'],
  'energy-sensor': [
    'milliampere',
    'ampere',
    'millivolt',
    'volt',
    'watt',
    'kilowatt',
    'watt-hour',
    'kilowatt-hour',
    'megawatt-hour',
    'kilovolt-ampere',
    'volt-ampere',
    'volt-ampere-reactive',
    'euro',
    'dollar',
  ],
  'distance-sensor': ['mm', 'cm', 'm', 'km', 'inch', 'feet', 'mile'],
  'soil-moisture-sensor': ['percent'],
  'speed-sensor': ['meter-per-second', 'kilometer-per-hour'],
  'uv-sensor': ['uv-index'],
  'leak-sensor': [undefined],
  'motion-sensor': [undefined],
};

test('every kind uses a unit the core lists for its category', async () => {
  const gladys = createFakeGladys({ selector: 'things-network' });
  const fields = Object.keys(KINDS).map((kind) => ({ key: `f_${kind}`, kind, name: kind }));
  const device = deviceOf(gladys, { platformId: 'eui-0011223344556677', name: 'X', fields });
  assert.equal(device.features.length, Object.keys(KINDS).length);
  for (const feature of device.features) {
    assert.ok(feature.category in CORE_UNITS, `${feature.category} is not checked`);
    assert.ok(
      CORE_UNITS[feature.category].includes(feature.unit),
      `${feature.external_id}: ${feature.unit}`,
    );
    assert.equal(feature.read_only, true);
  }
  // The fake Gladys refuses what the host API refuses.
  await gladys.connect();
  await gladys.publishDiscoveredDevices([device]);
});
