'use strict';

/*
 * Fake-timer unit tests for the time-driven paths in lib/palgate.js that the
 * other platform tests don't reach:
 *
 *   - setupGarageDoorHandlers' restart-resume block — restoring a mid-cycle door
 *     animation from persisted _doorTimerT1Expiry/_doorTimerT2Expiry after a
 *     Homebridge restart (opening / already-open / expired branches).
 *   - syncPrimaryAccessories' companion animation timers — when a gate is exposed
 *     as several accessory types at once (garageDoor + switch + lock share one
 *     deviceId), triggering one animates the others and resets them after a delay.
 *
 * These use node:test's mock timers (setTimeout + Date) so the multi-second door
 * cycles run deterministically and instantly, and are driven by calling the
 * platform methods directly (no launch, no network).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMockHomebridgeApi, createMockLog, MockPlatformAccessory } = require('../helpers/mock-homebridge.js');

const PalGatePlatform = require('../../lib/palgate.js');
const SESSION_TOKEN = '000102030405060708090a0b0c0d0e0f';
const BASE_CONFIG = { platform: 'PalGatePlatform', token: SESSION_TOKEN, phoneNumber: '972500000000', tokenType: 1 };

function makePlatform(configOverrides = {}) {
  const api = createMockHomebridgeApi();
  const log = createMockLog();
  const platform = new PalGatePlatform(log, { ...BASE_CONFIG, ...configOverrides }, api);
  return { platform, api, log };
}

function makeAccessory(api, deviceId, accessoryType, serviceType, uuid, { withService = true } = {}) {
  const acc = new MockPlatformAccessory(`${deviceId}:${accessoryType}`, uuid || `uuid-${deviceId}-${accessoryType}`);
  acc.context.deviceId = deviceId;
  acc.context.accessoryType = accessoryType;
  if (withService) acc.addService(serviceType, deviceId);
  return acc;
}

// ── Garage door restart-resume ──────────────────────────────────────────────

test('door resume: a mid-opening cycle resumes and completes OPENING→OPEN→CLOSED', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { platform, api } = makePlatform();
  const C = api.hap.Characteristic;
  const acc = makeAccessory(api, 'DEV1', 'garageDoor', api.hap.Service.GarageDoorOpener);
  acc.context._doorTimerT1Expiry = 5000;   // opens at t=5s
  acc.context._doorTimerT2Expiry = 10000;  // closes at t=10s

  platform.configureAccessory(acc);
  const svc = acc.getService(api.hap.Service.GarageDoorOpener);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPENING);

  t.mock.timers.tick(5000);
  assert.equal(svc.getCharacteristic(C.CurrentDoorState).value, C.CurrentDoorState.OPEN);

  t.mock.timers.tick(5000);
  assert.equal(svc.getCharacteristic(C.CurrentDoorState).value, C.CurrentDoorState.CLOSED);
  assert.equal(acc.context._doorTimerT1Expiry, null);
  assert.equal(acc.context._doorTimerT2Expiry, null);
});

test('door resume: an already-open cycle closes after the remaining delay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { platform, api } = makePlatform();
  const C = api.hap.Characteristic;
  const acc = makeAccessory(api, 'DEV1', 'garageDoor', api.hap.Service.GarageDoorOpener);
  acc.context._doorTimerT2Expiry = 8000; // no T1 → past opening, waiting to close

  platform.configureAccessory(acc);
  const svc = acc.getService(api.hap.Service.GarageDoorOpener);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPEN);

  t.mock.timers.tick(8000);
  assert.equal(svc.getCharacteristic(C.CurrentDoorState).value, C.CurrentDoorState.CLOSED);
  assert.equal(acc.context._doorTimerT1Expiry, null);
});

test('door resume: an expired cycle snaps straight to CLOSED', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { platform, api } = makePlatform();
  const C = api.hap.Characteristic;
  t.mock.timers.tick(20000); // clock is now past the stored expiries
  const acc = makeAccessory(api, 'DEV1', 'garageDoor', api.hap.Service.GarageDoorOpener);
  acc.context._doorTimerT1Expiry = 8000;
  acc.context._doorTimerT2Expiry = 10000;

  platform.configureAccessory(acc);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED);
  assert.equal(acc.context._doorTimerT1Expiry, null);
  assert.equal(acc.context._doorTimerT2Expiry, null);
});

test('door resume: get handlers return the resumed state', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { platform, api } = makePlatform();
  const C = api.hap.Characteristic;
  const acc = makeAccessory(api, 'DEV1', 'garageDoor', api.hap.Service.GarageDoorOpener);
  acc.context._doorTimerT2Expiry = 8000; // already open

  platform.configureAccessory(acc);
  const svc = acc.getService(api.hap.Service.GarageDoorOpener);
  let cur, tgt;
  svc.getCharacteristic(C.CurrentDoorState).handlers.get((e, v) => { cur = v; });
  svc.getCharacteristic(C.TargetDoorState).handlers.get((e, v) => { tgt = v; });
  assert.equal(cur, C.CurrentDoorState.OPEN);
  assert.equal(tgt, C.TargetDoorState.OPEN);
});

test('door setup: a missing GarageDoorOpener service logs an error and bails', () => {
  const { platform, api, log } = makePlatform();
  const acc = makeAccessory(api, 'DEV1', 'garageDoor', api.hap.Service.GarageDoorOpener, undefined, { withService: false });
  platform.configureAccessory(acc);
  assert.ok(log.has('error', /GarageDoorOpener service not found/));
});

// ── Companion animation sync ────────────────────────────────────────────────

test('companion sync: switch and lock companions animate then reset after the delay', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { platform, api } = makePlatform();
  const S = api.hap.Service, C = api.hap.Characteristic;
  const source = makeAccessory(api, 'DEV1', 'garageDoor', S.GarageDoorOpener, 'u-src');
  const sw = makeAccessory(api, 'DEV1', 'switch', S.Switch, 'u-sw');
  const lk = makeAccessory(api, 'DEV1', 'lock', S.LockMechanism, 'u-lk');
  platform.accessories = [source, sw, lk];

  platform.syncPrimaryAccessories(source, 1000, 5000, 6000);
  assert.equal(sw.getService(S.Switch).getCharacteristic(C.On).value, true);
  assert.equal(lk.getService(S.LockMechanism).getCharacteristic(C.LockCurrentState).value, C.LockCurrentState.UNSECURED);

  t.mock.timers.tick(6000);
  assert.equal(sw.getService(S.Switch).getCharacteristic(C.On).value, false);
  assert.equal(lk.getService(S.LockMechanism).getCharacteristic(C.LockCurrentState).value, C.LockCurrentState.SECURED);
});

test('companion sync: a garageDoor companion walks OPENING→OPEN→CLOSED', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { platform, api } = makePlatform();
  const S = api.hap.Service, C = api.hap.Characteristic;
  const source = makeAccessory(api, 'DEV1', 'switch', S.Switch, 'u-src');
  const gd = makeAccessory(api, 'DEV1', 'garageDoor', S.GarageDoorOpener, 'u-gd');
  platform.accessories = [source, gd];

  platform.syncPrimaryAccessories(source, 1000, 5000, 6000);
  const svc = gd.getService(S.GarageDoorOpener);
  assert.equal(svc.getCharacteristic(C.CurrentDoorState).value, C.CurrentDoorState.OPENING);

  t.mock.timers.tick(1000);
  assert.equal(svc.getCharacteristic(C.CurrentDoorState).value, C.CurrentDoorState.OPEN);

  t.mock.timers.tick(5000);
  assert.equal(svc.getCharacteristic(C.CurrentDoorState).value, C.CurrentDoorState.CLOSED);
});

test('companion sync: momentary (all-zero delays) leaves companions untouched', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { platform, api } = makePlatform();
  const S = api.hap.Service, C = api.hap.Characteristic;
  const source = makeAccessory(api, 'DEV1', 'garageDoor', S.GarageDoorOpener, 'u-src');
  const sw = makeAccessory(api, 'DEV1', 'switch', S.Switch, 'u-sw');
  platform.accessories = [source, sw];

  platform.syncPrimaryAccessories(source, 0, 0, 0);
  assert.equal(sw.getService(S.Switch).getCharacteristic(C.On).value, undefined); // never animated
});

test('companion sync: retriggering mid-cycle cancels the prior animation timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { platform, api } = makePlatform();
  const S = api.hap.Service, C = api.hap.Characteristic;
  const source = makeAccessory(api, 'DEV1', 'garageDoor', S.GarageDoorOpener, 'u-src');
  const sw = makeAccessory(api, 'DEV1', 'switch', S.Switch, 'u-sw');
  platform.accessories = [source, sw];

  platform.syncPrimaryAccessories(source, 1000, 5000, 6000);
  t.mock.timers.tick(3000);
  platform.syncPrimaryAccessories(source, 1000, 5000, 6000); // clears the first timer, starts fresh
  assert.equal(sw.getService(S.Switch).getCharacteristic(C.On).value, true);

  t.mock.timers.tick(6000); // completes the second cycle
  assert.equal(sw.getService(S.Switch).getCharacteristic(C.On).value, false);
});
