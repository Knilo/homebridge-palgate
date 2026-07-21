'use strict';

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { startStubPalGate } = require('../helpers/stub-palgate.js');
const { createMockHomebridgeApi, createMockLog } = require('../helpers/mock-homebridge.js');

// Feature 2: valve relay accessories. Active/InUse mirror latch state; activating starts
// a SetDuration countdown that writes normal mode at zero. Uses real (short) timers where
// a countdown is exercised, driving the set handlers directly like handlers.test.js.

let stub;
let PalGatePlatform;

const SESSION_TOKEN = '000102030405060708090a0b0c0d0e0f';
const BASE_CONFIG = {
  platform: 'PalGatePlatform', token: SESSION_TOKEN, phoneNumber: '972500000000', tokenType: 1,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  stub = await startStubPalGate();
  process.env.PALGATE_API_BASE_URL = stub.baseUrl;
  PalGatePlatform = require('../../lib/palgate.js');
});

after(async () => { await stub.close(); });

// Track launched platforms so afterEach always tears down their pollers/timers, even
// when a test fails mid-body before reaching its own shutdown — otherwise a leaked
// status-poller interval would keep node --test alive and hang the whole suite.
let launched = [];
beforeEach(() => { stub.reset(); launched = []; });
afterEach(() => { launched.forEach(api => api.emit('shutdown')); });

async function launchPlatform(configOverrides, devices) {
  stub.route('GET /devices/', { devices });
  const api = createMockHomebridgeApi();
  const log = createMockLog();
  const platform = new PalGatePlatform(log, { ...BASE_CONFIG, ...configOverrides }, api);
  await api.launch();
  launched.push(api);
  return { platform, api, log };
}

const VALVE_GATE = [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }];

test('valve SetDuration seeds to the 300s default when no config is given', async () => {
  const { api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const svc = acc.getService(api.hap.Service.Valve);
  assert.equal(acc.context.valveSetDuration, 300);
  assert.equal(svc.getCharacteristic(api.hap.Characteristic.SetDuration).value, 300);
  api.emit('shutdown');
});

test('valveDefaultDuration global setting seeds new valves and clamps to 3600', async () => {
  const { api } = await launchPlatform(
    { enableRelayLocks: true, relayAccessoryType: 'valve', valveDefaultDuration: 9999 }, VALVE_GATE);
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  assert.equal(acc.context.valveSetDuration, 3600, 'clamped to HAP max of 3600s');
  api.emit('shutdown');
});

test('per-gate valveDefaultDuration overrides the global default', async () => {
  const { api } = await launchPlatform(
    { enableRelayLocks: true, relayAccessoryType: 'valve', valveDefaultDuration: 600,
      customGates: [{ deviceId: 'DEV1', valveDefaultDuration: 120 }] }, VALVE_GATE);
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  assert.equal(acc.context.valveSetDuration, 120);
  api.emit('shutdown');
});

test('SetDuration set-handler clamps a HomeKit-set value to the 0–3600 range', async () => {
  const { api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const svc = acc.getService(api.hap.Service.Valve);
  const C = api.hap.Characteristic;

  await svc.getCharacteristic(C.SetDuration).triggerSet(9999);
  assert.equal(acc.context.valveSetDuration, 3600, 'above HAP max clamps to 3600');
  await svc.getCharacteristic(C.SetDuration).triggerSet(-50);
  assert.equal(acc.context.valveSetDuration, 0, 'below zero clamps to 0');
  await svc.getCharacteristic(C.SetDuration).triggerSet(120);
  assert.equal(acc.context.valveSetDuration, 120, 'in-range value passes through');
  api.emit('shutdown');
});

test('valve accessories are created for both directions when relayAccessoryType=valve', async () => {
  const { api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  const open = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const closed = api.registered.find(a => a.context.accessoryType === 'holdClosedValve');
  assert.ok(open, 'Hold Open valve created');
  assert.ok(closed, 'Hold Closed valve created');
  api.emit('shutdown');
});

test('activate: writes hold_open latch params, sets Active/InUse, and counts RemainingDuration down', async () => {
  const { api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const svc = acc.getService(api.hap.Service.Valve);
  const C = api.hap.Characteristic;

  // Set a 1s hold, then activate.
  await svc.getCharacteristic(C.SetDuration).triggerSet(1);
  await svc.getCharacteristic(C.Active).triggerSet(C.Active.ACTIVE);

  const req = stub.requests.at(-1);
  assert.deepEqual(req.query, { outputNum: '1', output1LatchStatus: 'true', output1Disabled: 'true' });
  assert.equal(acc.context.valveActive, true);
  assert.equal(svc.getCharacteristic(C.Active).value, C.Active.ACTIVE);
  assert.equal(svc.getCharacteristic(C.InUse).value, C.InUse.IN_USE);
  assert.ok(svc.getCharacteristic(C.RemainingDuration).value > 0, 'RemainingDuration set');

  // Past the 1s countdown: relay returns to normal and valve goes Inactive.
  await sleep(1200);
  assert.equal(acc.context.valveActive, false, 'valve deactivates at expiry');
  assert.equal(svc.getCharacteristic(C.Active).value, C.Active.INACTIVE);
  const expiryReq = stub.requests.at(-1);
  assert.deepEqual(expiryReq.query, { outputNum: '1', output1LatchStatus: 'false', output1Disabled: 'false' }, 'normal mode written at expiry');
  api.emit('shutdown');
});

test('SetDuration=0 → indefinite hold, no countdown, no auto-expiry', async () => {
  const { api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const svc = acc.getService(api.hap.Service.Valve);
  const C = api.hap.Characteristic;

  // Explicitly choose an indefinite hold (0) — the seeded default is now 300s.
  await svc.getCharacteristic(C.SetDuration).triggerSet(0);
  await svc.getCharacteristic(C.Active).triggerSet(C.Active.ACTIVE);
  assert.equal(acc.context.valveActive, true);
  assert.equal(svc.getCharacteristic(C.RemainingDuration).value, 0, 'no countdown for indefinite hold');
  assert.equal(acc.context._valveTimer, null, 'no expiry timer scheduled');

  await sleep(100);
  assert.equal(acc.context.valveActive, true, 'stays active indefinitely');
  api.emit('shutdown');
});

test('manual deactivate cancels the countdown and writes normal mode', async () => {
  const { api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const svc = acc.getService(api.hap.Service.Valve);
  const C = api.hap.Characteristic;

  await svc.getCharacteristic(C.SetDuration).triggerSet(60);
  await svc.getCharacteristic(C.Active).triggerSet(C.Active.ACTIVE);
  assert.equal(acc.context.valveActive, true);
  assert.ok(acc.context._valveTimer, 'countdown timer running');

  await svc.getCharacteristic(C.Active).triggerSet(C.Active.INACTIVE);
  assert.equal(acc.context.valveActive, false);
  assert.equal(acc.context._valveTimer, null, 'countdown cancelled');
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '1', output1LatchStatus: 'false', output1Disabled: 'false' });
  api.emit('shutdown');
});

test('activating hold-open cancels a hold-closed countdown (companion release)', async () => {
  const { api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });
  const C = api.hap.Characteristic;
  const open = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const closed = api.registered.find(a => a.context.accessoryType === 'holdClosedValve');
  const closedSvc = closed.getService(api.hap.Service.Valve);
  const openSvc = open.getService(api.hap.Service.Valve);

  await closedSvc.getCharacteristic(C.SetDuration).triggerSet(60);
  await closedSvc.getCharacteristic(C.Active).triggerSet(C.Active.ACTIVE);
  assert.equal(closed.context.valveActive, true);
  assert.ok(closed.context._valveTimer);

  await openSvc.getCharacteristic(C.Active).triggerSet(C.Active.ACTIVE);
  assert.equal(open.context.valveActive, true);
  assert.equal(closed.context.valveActive, false, 'hold-closed companion released');
  assert.equal(closed.context._valveTimer, null, 'hold-closed countdown cancelled');
  api.emit('shutdown');
});

test('poller does not revert an active countdown', async () => {
  const { platform, api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const svc = acc.getService(api.hap.Service.Valve);
  const C = api.hap.Characteristic;

  await svc.getCharacteristic(C.SetDuration).triggerSet(60);
  await svc.getCharacteristic(C.Active).triggerSet(C.Active.ACTIVE);
  assert.equal(acc.context.valveActive, true);

  // Force the write cooldown to expire so the guard under test is the active-timer check.
  platform._lastRelayWriteByDevice.set('DEV1', Date.now() - 60000);

  // Poller sees "normal" state — but must not revert a running countdown.
  platform.syncLockStates(new Map([['DEV1', { id: 'DEV1', output1LatchStatus: false, output1Disabled: false }]]));
  assert.equal(acc.context.valveActive, true, 'active countdown is not reverted by the poller');
  api.emit('shutdown');
});

test('poller syncs an external latch change when no countdown is running', async () => {
  const { platform, api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  const acc = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  const svc = acc.getService(api.hap.Service.Valve);
  const C = api.hap.Characteristic;
  assert.equal(acc.context.valveActive, false);

  // Someone else latched the gate open externally.
  platform.syncLockStates(new Map([['DEV1', { id: 'DEV1', output1LatchStatus: true, output1Disabled: true }]]));
  assert.equal(acc.context.valveActive, true);
  assert.equal(svc.getCharacteristic(C.Active).value, C.Active.ACTIVE);
  api.emit('shutdown');
});

test('restart mid-countdown releases the hold to normal', async () => {
  // First platform: a valve marked active (as if persisted mid-countdown).
  const { api } = await launchPlatform({ enableRelayLocks: true, relayAccessoryType: 'valve' }, VALVE_GATE);
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });
  const C = api.hap.Characteristic;

  // Simulate a cached accessory that was active before the restart.
  const cached = api.registered.find(a => a.context.accessoryType === 'holdOpenValve');
  cached.context.valveActive = true;

  // Re-run setup (what configureAccessory does on restart) — must release to normal.
  const platform2 = new (require('../../lib/palgate.js'))(createMockLog(), { ...BASE_CONFIG, enableRelayLocks: true, relayAccessoryType: 'valve' }, api);
  stub.reset();
  stub.route('GET /device/DEV1/open-gate', { status: 'ok' });
  platform2.configureAccessory(cached);

  assert.equal(cached.context.valveActive, false, 'released to inactive on startup');
  const svc = cached.getService(api.hap.Service.Valve);
  assert.equal(svc.getCharacteristic(C.Active).value, C.Active.INACTIVE);
  // Give the fire-and-forget normal-mode write a moment to land.
  await sleep(50);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 1, 'normal mode written on restart release');
  assert.deepEqual(stub.requests.at(-1).query, { outputNum: '1', output1LatchStatus: 'false', output1Disabled: 'false' });
  api.emit('shutdown');
});

test('per-gate relayValve exposes valves even when global relay type differs', async () => {
  const { api } = await launchPlatform(
    { enableRelayLocks: true, relayAccessoryType: 'lock', customGates: [{ deviceId: 'DEV1', relayValve: true }] },
    VALVE_GATE
  );
  assert.ok(api.registered.find(a => a.context.accessoryType === 'holdOpenValve'), 'per-gate valve created');
  assert.ok(!api.registered.find(a => a.context.accessoryType === 'holdOpenLock'), 'no lock when per-gate valve chosen');
  api.emit('shutdown');
});
