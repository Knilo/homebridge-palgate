'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  galoisMul2,
  bytesToHex,
  packUint64BE,
  detectMultiOutputDevices,
  generateGateEntries,
  splitDeviceId,
} = require('../../lib/utils/helpers.js');

test('splitDeviceId: plain id defaults to output 1', () => {
  assert.deepEqual(splitDeviceId('4G600216305'), { baseId: '4G600216305', outputNum: 1 });
});

test('splitDeviceId: id:outputNum splits into parts', () => {
  assert.deepEqual(splitDeviceId('4G600216305:2'), { baseId: '4G600216305', outputNum: 2 });
});

test('splitDeviceId: invalid or zero output suffix falls back to output 1 on the full id', () => {
  assert.deepEqual(splitDeviceId('ABC:0'), { baseId: 'ABC:0', outputNum: 1 });
  assert.deepEqual(splitDeviceId('ABC:x'), { baseId: 'ABC:x', outputNum: 1 });
});

test('splitDeviceId: non-string input is passed through with output 1', () => {
  assert.deepEqual(splitDeviceId(undefined), { baseId: undefined, outputNum: 1 });
});

test('detectMultiOutputDevices: single-output device returns empty array', () => {
  assert.deepEqual(detectMultiOutputDevices({ output1: true }), []);
  assert.deepEqual(detectMultiOutputDevices({}), []);
});

test('detectMultiOutputDevices: two-output device lists enabled outputs with names', () => {
  const device = { output1: true, output2: true, name1: 'Front', name2: 'Back' };
  assert.deepEqual(detectMultiOutputDevices(device), [
    { outputNum: 1, name: 'Front' },
    { outputNum: 2, name: 'Back' },
  ]);
});

test('detectMultiOutputDevices: disabled second output is excluded but device stays multi-output', () => {
  const device = { output1: true, output2: false, name1: 'Front' };
  assert.deepEqual(detectMultiOutputDevices(device), [{ outputNum: 1, name: 'Front' }]);
});

test('detectMultiOutputDevices: outputNDisabled (relay hold state) does not hide outputs', () => {
  const device = { output1: true, output2: true, output1Disabled: true, output2Disabled: true };
  assert.deepEqual(detectMultiOutputDevices(device), [
    { outputNum: 1, name: null },
    { outputNum: 2, name: null },
  ]);
});

test('generateGateEntries: single-output uses plain deviceId and default name', () => {
  assert.deepEqual(generateGateEntries('DEV1', [], 'My Gate', {}), [
    { deviceId: 'DEV1', name: 'My Gate' },
  ]);
});

test('generateGateEntries: multi-output uses deviceId:outputNum and per-output names', () => {
  const outputs = [{ outputNum: 1, name: 'Front' }, { outputNum: 2, name: null }];
  assert.deepEqual(generateGateEntries('DEV1', outputs, 'My Gate', {}), [
    { deviceId: 'DEV1:1', name: 'Front' },
    { deviceId: 'DEV1:2', name: 'My Gate - Output 2' },
  ]);
});

test('packUint64BE: packs a phone-number-sized integer big-endian', () => {
  assert.equal(bytesToHex(packUint64BE(972500000000)), '000000e26d845d00');
  assert.equal(bytesToHex(packUint64BE(0)), '0000000000000000');
});

test('galoisMul2: GF(2^8) doubling with AES reduction polynomial', () => {
  assert.equal(galoisMul2(0x00), 0x00);
  assert.equal(galoisMul2(0x01), 0x02);
  assert.equal(galoisMul2(0x80), 0x1b); // high bit set → reduce with 0x1b
  assert.equal(galoisMul2(0xff), 0xe5);
});
