import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseHost } from '../src/config.js';

test('defaults: the eu1 cluster, 5 minutes, nothing ready without an application and a key', () => {
  const config = normalizeConfig();
  assert.equal(config.server, DEFAULT_CONFIG.server);
  assert.equal(config.host, 'eu1.cloud.thethings.network');
  assert.equal(config.pollMinutes, 5);
  assert.equal(config.ready, false);
  assert.deepEqual(config.problems, ['applicationMissing', 'keyMissing']);
});

test('the interval is bounded (2 to 60 minutes); "" or null keep the default', () => {
  const base = { application_id: 'my-app', api_key: 'NNSXS.ABCDEFGHIJKLMNOP' };
  assert.equal(normalizeConfig({ ...base, poll_interval: 1 }).pollMinutes, 2);
  assert.equal(normalizeConfig({ ...base, poll_interval: 600 }).pollMinutes, 60);
  assert.equal(normalizeConfig({ ...base, poll_interval: '' }).pollMinutes, 5);
  assert.equal(normalizeConfig({ ...base, poll_interval: null }).pollMinutes, 5);
  assert.equal(normalizeConfig({ ...base, server: 'nam1' }).host, 'nam1.cloud.thethings.network');
  assert.equal(normalizeConfig({ ...base, server: 'mars' }).server, 'eu1');
  assert.equal(normalizeConfig({ ...base, application_id: ' My-App ' }).applicationId, 'my-app');
  assert.equal(normalizeConfig(base).ready, true);
});

test('an API key with characters a header cannot carry is refused', () => {
  const config = normalizeConfig({ application_id: 'my-app', api_key: 'NNSXS.ABC\r\nX-Evil: 1' });
  assert.deepEqual(config.problems, ['key']);
});

test('a custom host: HTTPS host names only', () => {
  assert.equal(
    parseHost('https://mytenant.eu1.cloud.thethings.industries/'),
    'mytenant.eu1.cloud.thethings.industries',
  );
  assert.equal(parseHost('lns.example.org:8443'), 'lns.example.org:8443');
  assert.equal(parseHost('lns.example.org:443'), 'lns.example.org');
  assert.equal(parseHost('http://lns.example.org'), null);
  assert.equal(parseHost('192.168.1.10'), null);
  assert.equal(parseHost('localhost'), null);
  assert.equal(parseHost('user@lns.example.org'), null);
  assert.equal(parseHost('lns.example.org/path'), null);
  assert.equal(parseHost('lns.example.org:99999'), null);
  // I2: IPv4 addresses the WHATWG parser reads in hexadecimal or octal.
  for (const ip of ['0x7f.0x1', '127.0.0.0x1', '10.0.0.0x1', '0300.0250.0.0x1', '0x7f000001']) {
    assert.equal(parseHost(ip), null, ip);
  }
  assert.equal(parseHost('lns.0x1.example.org'), 'lns.0x1.example.org');
  const config = normalizeConfig({
    server: 'custom',
    application_id: 'my-app',
    api_key: 'NNSXS.ABCDEFGHIJKLMNOP',
  });
  assert.deepEqual(config.problems, ['hostMissing']);
});
