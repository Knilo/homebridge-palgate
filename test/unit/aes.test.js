'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { aesBlock } = require('../../lib/utils/aes.js');

// The custom AES implementation must match Node's native AES-128-ECB for a
// single block (this is what the temporal token derivation relies on).
function nativeEncrypt(data, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]));
}

test('aesBlock matches native AES-128-ECB on fixed vectors', () => {
  const key = Uint8Array.from({ length: 16 }, (_, i) => i);
  const data = Uint8Array.from({ length: 16 }, (_, i) => 0xff - i);
  assert.deepEqual(aesBlock(data, key), nativeEncrypt(data, key));
});

test('aesBlock matches native AES-128-ECB on random vectors', () => {
  for (let i = 0; i < 50; i++) {
    const key = new Uint8Array(crypto.randomBytes(16));
    const data = new Uint8Array(crypto.randomBytes(16));
    assert.deepEqual(aesBlock(data, key), nativeEncrypt(data, key),
      `mismatch for key=${Buffer.from(key).toString('hex')} data=${Buffer.from(data).toString('hex')}`);
  }
});
