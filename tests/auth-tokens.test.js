'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse115Callback } = require('../src/auth-tokens');
const fragment = data => Buffer.from(JSON.stringify(data)).toString('base64');
const data = { driver_txt: '115cloud_go', access_token: 'access-fixture', refresh_token: 'refresh-fixture' };
test('115 callback accepts the documented complete payload only on the trusted HTTPS origin', () => {
  assert.deepEqual(parse115Callback('https://api.oplist.org/#' + fragment(data)), { accessToken: 'access-fixture', refreshToken: 'refresh-fixture' });
  for (const origin of ['http://api.oplist.org', 'https://api.oplist.org.attacker.example', 'https://evil.example', 'https://api.oplist.org:444']) assert.equal(parse115Callback(origin + '/#' + fragment(data)), null);
});
test('115 callback rejects other drivers, partial credentials, excessive input and invalid JSON', () => {
  for (const value of [{ ...data, driver_txt: 'quark' }, { ...data, access_token: '' }, { ...data, refresh_token: undefined }, { ...data, access_token: 'a'.repeat(32001) }]) assert.equal(parse115Callback('https://api.oplist.org/#' + fragment(value)), null);
  assert.equal(parse115Callback('https://api.oplist.org/#bad-json'), null);
  assert.equal(parse115Callback('https://api.oplist.org/#' + 'x'.repeat(128000)), null);
});
