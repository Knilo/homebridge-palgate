'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startStubPalGate } = require('../helpers/stub-palgate.js');
const { createMockHomebridgeApi, createMockLog } = require('../helpers/mock-homebridge.js');

// Covers the switch/lock accessory types and the relay state poller sync —
// syncLockStates is where the device-envelope bug lived (latch fields read off
// the API wrapper came back undefined and latched gates synced as "normal").

let stub;
let PalGatePlatform;

const SESSION_TOKEN = '000102030405060708090a0b0c0d0e0f';
const BASE_CONFIG = {
  platform: 'PalGatePlatform', token: SESSION_TOKEN, phoneNumber: '972500000000', tokenType: 1,
  gateOpeningDelay: 30, gateCloseDelay: 40,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  stub = await startStubPalGate();
  process.env.PALGATE_API_BASE_URL = stub.baseUrl;
  PalGatePlatform = require('../../lib/palgate.js');
});

after(async () => { await stub.close(); });

beforeEach(() => { stub.reset(); });

async function launchPlatform(configOverrides, devices) {
  stub.route('GET /devices/', { devices });
  const api = createMockHomebridgeApi();
  const log = createMockLog();
  const platform = new PalGatePlatform(log, { ...BASE_CONFIG, ...configOverrides }, api);
  await api.launch();
  return { platform, api, log };
}

test('switch accessory: on-tap triggers the gate and auto-resets after the open window', async () => {
  const { api } = await launchPlatform({ accessoryType: 'switch' }, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const acc = api.registered.find(a => a.context.accessoryType === 'switch');
  const service = acc.getService(api.hap.Service.Switch);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.On).triggerSet(true);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 1);
  assert.equal(acc.context.switchOn, true);

  await sleep(100); // past openingDelay + closeDelay
  assert.equal(acc.context.switchOn, false, 'switch must auto-reset');
  api.emit('shutdown');
});

test('switch accessory (stateful): off-tap cancels without triggering the gate', async () => {
  const { api } = await launchPlatform({ accessoryType: 'switch' }, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const acc = api.registered.find(a => a.context.accessoryType === 'switch');
  const service = acc.getService(api.hap.Service.Switch);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.On).triggerSet(false);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 0);
  assert.equal(acc.context.switchOn, false);
  api.emit('shutdown');
});

test('lock accessory: unlocking triggers the gate and re-secures after the open window', async () => {
  const { api } = await launchPlatform({ accessoryType: 'lock' }, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const acc = api.registered.find(a => a.context.accessoryType === 'lock');
  const service = acc.getService(api.hap.Service.LockMechanism);
  const C = api.hap.Characteristic;
  assert.equal(acc.context.lockCurrentState, C.LockCurrentState.SECURED, 'gate lock starts secured');

  await service.getCharacteristic(C.LockTargetState).triggerSet(C.LockTargetState.UNSECURED);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 1);
  assert.equal(acc.context.lockCurrentState, C.LockCurrentState.UNSECURED);

  await sleep(100);
  assert.equal(acc.context.lockCurrentState, C.LockCurrentState.SECURED, 'lock must re-secure');
  api.emit('shutdown');
});

test('poller sync: latched device data secures the Hold Open lock (device-envelope regression)', async () => {
  const { platform, api } = await launchPlatform(
    { enableRelayLocks: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }]
  );
  const C = api.hap.Characteristic;
  const holdOpen = api.registered.find(a => a.context.accessoryType === 'holdOpenLock');
  assert.equal(holdOpen.context.lockCurrentState, C.LockCurrentState.UNSECURED);

  // Simulate what the poller does: fetch device info (stubbed with the real API's
  // wrapped shape) and sync. getDeviceInfoOnce must unwrap, or latch reads undefined.
  stub.route('GET /device/DEV1/', {
    err: null, msg: 'device details', status: 'ok',
    device: { id: 'DEV1', output1: true, output1Latch: true, output1LatchStatus: true, output1Disabled: true },
  });
  const { getDeviceInfoOnce } = require('../../lib/api.js');
  const { generateToken } = require('../../lib/token-gen.js');
  const token = generateToken(Buffer.from(SESSION_TOKEN, 'hex'), 972500000000, 1);
  const deviceData = await getDeviceInfoOnce(token, 'DEV1');
  platform.syncLockStates(new Map([['DEV1', deviceData]]));

  assert.equal(holdOpen.context.lockCurrentState, C.LockCurrentState.SECURED,
    'externally latched gate must sync the Hold Open lock to SECURED');
  api.emit('shutdown');
});

test('poller sync: normal-mode device data releases a secured Hold Open lock', async () => {
  const { platform, api } = await launchPlatform(
    { enableRelayLocks: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true, output1LatchStatus: true, output1Disabled: true }]
  );
  const C = api.hap.Characteristic;
  const holdOpen = api.registered.find(a => a.context.accessoryType === 'holdOpenLock');
  assert.equal(holdOpen.context.lockCurrentState, C.LockCurrentState.SECURED, 'starts latched');

  platform.syncLockStates(new Map([['DEV1', { id: 'DEV1', output1: true, output1Latch: true, output1LatchStatus: false, output1Disabled: false }]]));
  assert.equal(holdOpen.context.lockCurrentState, C.LockCurrentState.UNSECURED,
    'externally released gate must sync the Hold Open lock to UNSECURED');
  api.emit('shutdown');
});

test('poller sync: skips devices written to in the last 15s (no clobbering fresh writes)', async () => {
  const { platform, api } = await launchPlatform(
    { enableRelayLocks: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }]
  );
  const C = api.hap.Characteristic;
  const holdOpen = api.registered.find(a => a.context.accessoryType === 'holdOpenLock');
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  // Lock via HomeKit (records the write timestamp), then feed the poller stale
  // "normal" data — it must NOT undo the fresh write.
  const service = holdOpen.getService(api.hap.Service.LockMechanism);
  await service.getCharacteristic(C.LockTargetState).triggerSet(C.LockTargetState.SECURED);
  assert.equal(holdOpen.context.lockCurrentState, C.LockCurrentState.SECURED);

  platform.syncLockStates(new Map([['DEV1', { id: 'DEV1', output1LatchStatus: false, output1Disabled: false }]]));
  assert.equal(holdOpen.context.lockCurrentState, C.LockCurrentState.SECURED,
    'poller must not clobber a write made moments ago');
  api.emit('shutdown');
});
