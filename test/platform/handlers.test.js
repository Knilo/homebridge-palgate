'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startStubPalGate } = require('../helpers/stub-palgate.js');
const { createMockHomebridgeApi, createMockLog } = require('../helpers/mock-homebridge.js');

// Behavioural tests for the HomeKit set handlers: a "tap" is simulated by
// invoking the characteristic's set handler, and the resulting PalGate API
// traffic and state transitions are asserted against the stub server.

let stub;
let PalGatePlatform;

const SESSION_TOKEN = '000102030405060708090a0b0c0d0e0f';
const BASE_CONFIG = {
  platform: 'PalGatePlatform', token: SESSION_TOKEN, phoneNumber: '972500000000', tokenType: 1,
  // keep door-cycle timers fast so tests don't crawl
  gateOpeningDelay: 40, gateCloseDelay: 80,
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
  new PalGatePlatform(log, { ...BASE_CONFIG, ...configOverrides }, api);
  await api.launch();
  return { api, log };
}

function findAccessory(api, type) {
  const acc = api.registered.find(a => a.context.accessoryType === type);
  assert.ok(acc, `expected a registered ${type} accessory`);
  return acc;
}

test('garage door: tap runs open-gate and walks OPENING → OPEN → CLOSED', async () => {
  const { api } = await launchPlatform({}, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const acc = findAccessory(api, 'garageDoor');
  const service = acc.getService(api.hap.Service.GarageDoorOpener);
  const C = api.hap.Characteristic;
  const target = service.getCharacteristic(C.TargetDoorState);

  await target.triggerSet(C.TargetDoorState.OPEN);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 1);
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '1' });
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPENING);

  await sleep(60); // past gateOpeningDelay
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPEN);

  await sleep(90); // past gateCloseDelay
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED);
  assert.equal(acc.context.targetDoorState, C.TargetDoorState.CLOSED);
  api.emit('shutdown');
});

test('garage door: API failure surfaces as a set error and door state stays CLOSED', async () => {
  const { api } = await launchPlatform({}, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  stub.failNTimes('GET /device/DEV1/open-gate', 99, 401, { err: 'bad token' });

  const acc = findAccessory(api, 'garageDoor');
  const service = acc.getService(api.hap.Service.GarageDoorOpener);
  const C = api.hap.Characteristic;

  await assert.rejects(
    service.getCharacteristic(C.TargetDoorState).triggerSet(C.TargetDoorState.OPEN),
    /API call error: 401/
  );
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED);
  api.emit('shutdown');
});

test('garage door (stateful): setting CLOSED does not fire the API', async () => {
  const { api } = await launchPlatform({}, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const acc = findAccessory(api, 'garageDoor');
  const service = acc.getService(api.hap.Service.GarageDoorOpener);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.TargetDoorState).triggerSet(C.TargetDoorState.CLOSED);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 0, 'stateful close must not trigger the gate');
  api.emit('shutdown');
});

test('garage door (stateless): setting CLOSED also triggers an opening', async () => {
  const { api } = await launchPlatform({ triggerMode: 'stateless' }, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const acc = findAccessory(api, 'garageDoor');
  const service = acc.getService(api.hap.Service.GarageDoorOpener);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.TargetDoorState).triggerSet(C.TargetDoorState.CLOSED);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 1);
  api.emit('shutdown');
});

test('multi-output gate: tap sends the right outputNum', async () => {
  const { api } = await launchPlatform({}, [
    { id: 'DEV2', name1: 'North', name2: 'South', output1: true, output2: true },
  ]);
  stub.route('GET /device/DEV2/open-gate', { status: 'ok' });

  const south = api.registered.find(a => a.context.deviceId === 'DEV2:2');
  const service = south.getService(api.hap.Service.GarageDoorOpener);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.TargetDoorState).triggerSet(C.TargetDoorState.OPEN);
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '2' });
  api.emit('shutdown');
});

test('hold-open lock: locking sends latch params and secures the lock', async () => {
  const { api } = await launchPlatform(
    { enableRelayLocks: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }]
  );
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const acc = findAccessory(api, 'holdOpenLock');
  const service = acc.getService(api.hap.Service.LockMechanism);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.LockTargetState).triggerSet(C.LockTargetState.SECURED);
  const req = stub.requests.at(-1);
  assert.equal(req.path, '/device/DEV1/open-gate');
  assert.deepEqual(req.query, { outputNum: '1', output1LatchStatus: 'true', output1Disabled: 'true' });
  assert.equal(acc.context.lockCurrentState, C.LockCurrentState.SECURED);
  api.emit('shutdown');
});

test('hold-open lock: unlocking returns the relay to normal mode', async () => {
  const { api } = await launchPlatform(
    { enableRelayLocks: true },
    // Device starts latched open so the lock initialises as SECURED
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true, output1LatchStatus: true, output1Disabled: true }]
  );
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const acc = findAccessory(api, 'holdOpenLock');
  const service = acc.getService(api.hap.Service.LockMechanism);
  const C = api.hap.Characteristic;
  assert.equal(acc.context.lockCurrentState, C.LockCurrentState.SECURED, 'initial state from device data');

  await service.getCharacteristic(C.LockTargetState).triggerSet(C.LockTargetState.UNSECURED);
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '1', output1LatchStatus: 'false', output1Disabled: 'false' });
  assert.equal(acc.context.lockCurrentState, C.LockCurrentState.UNSECURED);
  api.emit('shutdown');
});

test('hold-open lock: setting the value it already has is a no-op (no API call)', async () => {
  const { api } = await launchPlatform(
    { enableRelayLocks: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }]
  );
  const acc = findAccessory(api, 'holdOpenLock');
  const service = acc.getService(api.hap.Service.LockMechanism);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.LockTargetState).triggerSet(C.LockTargetState.UNSECURED);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 0);
  api.emit('shutdown');
});

test('locking hold-open releases a secured hold-closed companion', async () => {
  const { api } = await launchPlatform(
    { enableRelayLocks: true },
    // hold_closed active: latch false, disabled true
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true, output1LatchStatus: false, output1Disabled: true }]
  );
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });

  const holdOpen = findAccessory(api, 'holdOpenLock');
  const holdClosed = findAccessory(api, 'holdClosedLock');
  const C = api.hap.Characteristic;
  assert.equal(holdClosed.context.lockCurrentState, C.LockCurrentState.SECURED, 'hold closed starts secured');

  const service = holdOpen.getService(api.hap.Service.LockMechanism);
  await service.getCharacteristic(C.LockTargetState).triggerSet(C.LockTargetState.SECURED);

  assert.equal(holdOpen.context.lockCurrentState, C.LockCurrentState.SECURED);
  assert.equal(holdClosed.context.lockCurrentState, C.LockCurrentState.UNSECURED, 'companion must release');
  api.emit('shutdown');
});
