'use strict';

/**
 * Compares the custom AES implementation against Node.js native crypto,
 * then benchmarks both. Run with: node lib/test/aes-comparison.js
 */

const crypto = require('crypto');
const { aesEncryptDecrypt } = require('../utils/aes.js');
const { generateToken } = require('../token-gen.js');
const { T_C_KEY, TokenType } = require('../utils/constants.js');

// ─── Native AES-128-ECB helpers ──────────────────────────────────────────────

function nativeEncrypt(data, key) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null);
  cipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]));
}

function nativeDecrypt(data, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(key), null);
  decipher.setAutoPadding(false);
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]));
}

function hex(bytes) {
  return Buffer.from(bytes).toString('hex').toUpperCase();
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Test vectors ─────────────────────────────────────────────────────────────

// Known AES test vectors (NIST FIPS-197 Appendix B)
const NIST_KEY       = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
const NIST_PLAINTEXT = Buffer.from('3243f6a8885a308d313198a2e0370734', 'hex');
// Expected AES-128-ECB ciphertext for the above: 3925841d02dc09fbdc118597196a0b32

const testVectors = [
  { label: 'NIST Appendix B', state: NIST_PLAINTEXT, key: NIST_KEY },
  { label: 'Zero key / zero state', state: Buffer.alloc(16, 0), key: Buffer.alloc(16, 0) },
  { label: 'Random 1', state: Buffer.from('deadbeefcafebabe0102030405060708', 'hex'), key: Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex') },
  { label: 'Random 2', state: Buffer.from('ffffffffffffffffffffffffffffffff', 'hex'), key: Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex') },
  // Simulate what token-gen does with the T_C_KEY
  { label: 'T_C_KEY step1-like', state: Buffer.from('aabbccddeeff00112233445566778899', 'hex'), key: Buffer.from(T_C_KEY) },
];

// ─── Phase 1: Map isEncrypt flags to native operations ────────────────────────

console.log('=== Phase 1: Mapping custom isEncrypt flags to native crypto ===\n');

let step1Mode = null;
let step2Mode = null;

for (const { label, state, key } of testVectors) {
  const customTrue  = hex(aesEncryptDecrypt(new Uint8Array(state), new Uint8Array(key), true));
  const customFalse = hex(aesEncryptDecrypt(new Uint8Array(state), new Uint8Array(key), false));
  const nativeEnc   = hex(nativeEncrypt(state, key));
  const nativeDec   = hex(nativeDecrypt(state, key));

  const trueIsEnc  = customTrue  === nativeEnc;
  const trueIsDec  = customTrue  === nativeDec;
  const falseIsEnc = customFalse === nativeEnc;
  const falseIsDec = customFalse === nativeDec;

  console.log(`[${label}]`);
  console.log(`  custom(true)  = ${customTrue}`);
  console.log(`  custom(false) = ${customFalse}`);
  console.log(`  native enc    = ${nativeEnc}`);
  console.log(`  native dec    = ${nativeDec}`);
  console.log(`  isEncrypt=true  matches native: ${trueIsEnc ? 'ENCRYPT ✓' : trueIsDec ? 'DECRYPT ✓' : 'NEITHER ✗'}`);
  console.log(`  isEncrypt=false matches native: ${falseIsEnc ? 'ENCRYPT ✓' : falseIsDec ? 'DECRYPT ✓' : 'NEITHER ✗'}`);
  console.log();

  // Track what mappings are consistent
  if (trueIsEnc)  step1Mode = 'encrypt';
  if (trueIsDec)  step1Mode = 'decrypt';
  if (falseIsEnc) step2Mode = 'encrypt';
  if (falseIsDec) step2Mode = 'decrypt';
}

console.log(`→ isEncrypt=true  maps to native: ${step1Mode ?? 'UNKNOWN'}`);
console.log(`→ isEncrypt=false maps to native: ${step2Mode ?? 'UNKNOWN'}`);
console.log();

// ─── Phase 2: End-to-end token comparison ─────────────────────────────────────

console.log('=== Phase 2: End-to-end generateToken comparison ===\n');

// Build a native replacement for aesEncryptDecrypt based on what we found above
function nativeAes(data, key, isEncrypt) {
  if (isEncrypt) {
    return step1Mode === 'encrypt' ? nativeEncrypt(data, key) : nativeDecrypt(data, key);
  } else {
    return step2Mode === 'encrypt' ? nativeEncrypt(data, key) : nativeDecrypt(data, key);
  }
}

// Patch generateToken to use native AES
const { packUint64BE, bytesToHex } = require('../utils/helpers.js');
const { BLOCK_SIZE, TOKEN_SIZE, TIMESTAMP_OFFSET } = require('../utils/constants.js');

function generateTokenNative(sessionToken, phoneNumber, tokenType, timestampMs = null) {
  if (sessionToken.length !== BLOCK_SIZE) throw new Error('Invalid session token');
  if (timestampMs === null) timestampMs = Math.floor(Date.now() / 1000);

  // Step 1
  const key = new Uint8Array(T_C_KEY);
  const phonePacked = packUint64BE(phoneNumber);
  for (let i = 0; i < 6; i++) key[6 + i] = phonePacked[2 + i];
  const step2Key = nativeAes(sessionToken, key, true);

  // Step 2
  const nextState = new Uint8Array(BLOCK_SIZE);
  nextState[1] = 0xa0a & 0xff;
  nextState[2] = (0xa0a >> 8) & 0xff;
  const val32 = timestampMs + TIMESTAMP_OFFSET;
  nextState[10] = (val32 >> 24) & 0xff;
  nextState[11] = (val32 >> 16) & 0xff;
  nextState[12] = (val32 >> 8) & 0xff;
  nextState[13] = val32 & 0xff;
  const step2Result = nativeAes(nextState, step2Key, false);

  const result = new Uint8Array(TOKEN_SIZE);
  if (tokenType === TokenType.SMS)       result[0] = 0x01;
  else if (tokenType === TokenType.PRIMARY)   result[0] = 0x11;
  else if (tokenType === TokenType.SECONDARY) result[0] = 0x21;
  else throw new Error(`unknown token type: ${tokenType}`);

  result.set(phonePacked.slice(2, 8), 1);
  result.set(step2Result, 7);
  return bytesToHex(result).toUpperCase();
}

const testCases = [
  { token: Buffer.alloc(16, 0xab), phone: 972500000000, type: TokenType.PRIMARY,   ts: 1700000000 },
  { token: Buffer.alloc(16, 0x12), phone: 15550001234,  type: TokenType.SECONDARY, ts: 1700000001 },
  { token: Buffer.from('deadbeefcafebabe0102030405060708', 'hex'), phone: 972501234567, type: TokenType.SMS, ts: 1700000002 },
];

let allMatch = true;
for (const { token, phone, type, ts } of testCases) {
  const orig   = generateToken(token, phone, type, ts);
  const native = generateTokenNative(token, phone, type, ts);
  const match  = orig === native;
  if (!match) allMatch = false;
  console.log(`  original: ${orig}`);
  console.log(`  native:   ${native}`);
  console.log(`  match:    ${match ? '✓' : '✗ MISMATCH'}`);
  console.log();
}

if (allMatch) {
  console.log('✓ All tokens match — native replacement is functionally correct.\n');
} else {
  console.log('✗ Token mismatch — native mapping is wrong, do NOT replace.\n');
  process.exit(1);
}

// ─── Phase 3: Performance benchmark ──────────────────────────────────────────

console.log('=== Phase 3: Performance benchmark ===\n');

const ITERATIONS = 100_000;
const benchToken  = Buffer.alloc(16, 0xab);
const benchPhone  = 972500000000;
const benchType   = TokenType.PRIMARY;
const benchTs     = 1700000000;

// Warm up
for (let i = 0; i < 1000; i++) {
  generateToken(benchToken, benchPhone, benchType, benchTs);
  generateTokenNative(benchToken, benchPhone, benchType, benchTs);
}

const t0 = process.hrtime.bigint();
for (let i = 0; i < ITERATIONS; i++) generateToken(benchToken, benchPhone, benchType, benchTs);
const t1 = process.hrtime.bigint();
for (let i = 0; i < ITERATIONS; i++) generateTokenNative(benchToken, benchPhone, benchType, benchTs);
const t2 = process.hrtime.bigint();

const customMs = Number(t1 - t0) / 1e6;
const nativeMs = Number(t2 - t1) / 1e6;
const speedup  = customMs / nativeMs;

console.log(`  Custom JS  (${ITERATIONS.toLocaleString()} runs): ${customMs.toFixed(1)}ms  (${(customMs / ITERATIONS * 1000).toFixed(2)}µs/call)`);
console.log(`  Native crypto (${ITERATIONS.toLocaleString()} runs): ${nativeMs.toFixed(1)}ms  (${(nativeMs / ITERATIONS * 1000).toFixed(2)}µs/call)`);
console.log(`  Speedup: ${speedup.toFixed(1)}x ${speedup > 1 ? 'faster' : 'slower'} with native crypto`);
console.log();
