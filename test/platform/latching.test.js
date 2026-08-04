'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startStubPalGate } = require('../helpers/stub-palgate.js');
const { createMockHomebridgeApi, createMockLog } = require('../helpers/mock-homebridge.js');

// "Stateful (latching)" trigger mode: a GarageDoorOpener whose open/closed state is backed
// by the latch relay (hold_open on open, normal on close) instead of a momentary pulse, so
// the tile reflects the real gate state. Pure indefinite hold — no auto-close.

let stub;
let PalGatePlatform;

const SESSION_TOKEN = '000102030405060708090a0b0c0d0e0f';
const BASE_CONFIG = {
  platform: 'PalGatePlatform', token: SESSION_TOKEN, phoneNumber: '972500000000', tokenType: 1,
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
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });
  const api = createMockHomebridgeApi();
  const log = createMockLog();
  const platform = new PalGatePlatform(log, { ...BASE_CONFIG, ...configOverrides }, api);
  await api.launch();
  return { platform, api, log };
}

const LATCH_GATE = [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }];

test('latching open engages hold_open and stays open (no auto-close)', async () => {
  const { api } = await launchPlatform({ triggerMode: 'latching' }, LATCH_GATE);

  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  assert.ok(acc, 'expected a garageDoor accessory');
  const service = acc.getService(api.hap.Service.GarageDoorOpener);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.TargetDoorState).triggerSet(C.TargetDoorState.OPEN);

  // Open writes the hold_open latch, not a momentary pulse.
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '1', output1LatchStatus: 'true', output1Disabled: 'true' });
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPENING);

  await sleep(60); // past gateOpeningDelay
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPEN);

  await sleep(120); // well past gateCloseDelay — must NOT auto-close
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPEN, 'latching hold must not auto-close');
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 1, 'no second API call');
  api.emit('shutdown');
});

test('latching close releases the latch (normal) and walks CLOSING → CLOSED', async () => {
  const { api } = await launchPlatform({ triggerMode: 'latching' }, LATCH_GATE);

  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  const service = acc.getService(api.hap.Service.GarageDoorOpener);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.TargetDoorState).triggerSet(C.TargetDoorState.OPEN);
  await sleep(60);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPEN);

  await service.getCharacteristic(C.TargetDoorState).triggerSet(C.TargetDoorState.CLOSED);
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '1', output1LatchStatus: 'false', output1Disabled: 'false' });
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSING);

  await sleep(120); // past gateCloseDelay
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED);
  assert.equal(acc.context.targetDoorState, C.TargetDoorState.CLOSED);
  api.emit('shutdown');
});

test('latching without latch permission falls back to a momentary pulse', async () => {
  const { api } = await launchPlatform(
    { triggerMode: 'latching' },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: false }]
  );

  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  assert.equal(acc.context.latchCapable, false);
  const service = acc.getService(api.hap.Service.GarageDoorOpener);
  const C = api.hap.Characteristic;

  await service.getCharacteristic(C.TargetDoorState).triggerSet(C.TargetDoorState.OPEN);
  // Plain open-gate with no latch params — the latch path was correctly skipped.
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '1' });
  api.emit('shutdown');
});

test('poller reconciles a latching garage door to the real latch state', async () => {
  const { platform, api } = await launchPlatform({ triggerMode: 'latching' }, LATCH_GATE);

  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  const C = api.hap.Characteristic;
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED);

  // Latch engaged out-of-band → tile opens.
  platform.syncLockStates(new Map([['DEV1', { id: 'DEV1', output1: true, output1Latch: true, output1LatchStatus: true, output1Disabled: true }]]));
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPEN);
  assert.equal(acc.context.targetDoorState, C.TargetDoorState.OPEN);

  // Latch released → tile closes.
  platform.syncLockStates(new Map([['DEV1', { id: 'DEV1', output1: true, output1Latch: true, output1LatchStatus: false, output1Disabled: false }]]));
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED);
  assert.equal(acc.context.targetDoorState, C.TargetDoorState.CLOSED);
  api.emit('shutdown');
});

test('latching suppresses the redundant Hold-Open relay accessory on the same output', async () => {
  const { api } = await launchPlatform(
    { triggerMode: 'latching', enableRelayLocks: true, relayAccessoryType: 'lock' },
    LATCH_GATE
  );

  assert.ok(api.registered.some(a => a.context.accessoryType === 'garageDoor'), 'garage door present');
  const relayTypes = ['holdOpenLock', 'holdClosedLock', 'holdOpenSwitch', 'holdClosedSwitch', 'holdOpenValve', 'holdClosedValve'];
  const relays = api.registered.filter(a => relayTypes.includes(a.context.accessoryType));
  assert.equal(relays.length, 0, 'no separate relay accessories when latching owns the latch');
  api.emit('shutdown');
});

test('a non-garage primary ignores latching and uses a momentary pulse', async () => {
  const { api } = await launchPlatform({ accessoryType: 'switch', triggerMode: 'latching' }, LATCH_GATE);

  const acc = api.registered.find(a => a.context.accessoryType === 'switch');
  const C = api.hap.Characteristic;
  await acc.getService(api.hap.Service.Switch).getCharacteristic(C.On).triggerSet(true);
  // Plain open-gate, no latch params — latching does not apply to a Switch primary.
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '1' });
  api.emit('shutdown');
});
