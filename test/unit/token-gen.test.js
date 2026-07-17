'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateToken } = require('../../lib/token-gen.js');

// Golden vectors: fixed synthetic session token + fixed timestamp make the output
// deterministic. These lock the token algorithm against regressions — if any of
// aes.js, helpers.js, or token-gen.js changes behaviour, these fail.
const SESSION_TOKEN = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const PHONE = 972500000000;
const TS = 1700000000; // seconds

test('generateToken: golden vector, SMS token (type 0)', () => {
  assert.equal(generateToken(SESSION_TOKEN, PHONE, 0, TS), '0100E26D845D009D5046C334E5D64A4B21D74F0DE80208');
});

test('generateToken: golden vector, primary linked device (type 1)', () => {
  assert.equal(generateToken(SESSION_TOKEN, PHONE, 1, TS), '1100E26D845D009D5046C334E5D64A4B21D74F0DE80208');
});

test('generateToken: golden vector, secondary linked device (type 2)', () => {
  assert.equal(generateToken(SESSION_TOKEN, PHONE, 2, TS), '2100E26D845D009D5046C334E5D64A4B21D74F0DE80208');
});

test('generateToken: token type only changes the leading marker byte', () => {
  const t0 = generateToken(SESSION_TOKEN, PHONE, 0, TS);
  const t1 = generateToken(SESSION_TOKEN, PHONE, 1, TS);
  assert.equal(t0.slice(2), t1.slice(2));
  assert.notEqual(t0.slice(0, 2), t1.slice(0, 2));
});

test('generateToken: bytes 1-6 encode the phone number', () => {
  const token = generateToken(SESSION_TOKEN, PHONE, 1, TS);
  assert.equal(token.slice(2, 14), '00E26D845D00'); // packUint64BE(phone)[2..8]
});

test('generateToken: rejects a session token of the wrong length', () => {
  assert.throws(() => generateToken(Buffer.from('0001', 'hex'), PHONE, 1, TS), /Invalid session token/);
});

test('generateToken: rejects an unknown token type', () => {
  assert.throws(() => generateToken(SESSION_TOKEN, PHONE, 9, TS), /unknown token type/);
});
