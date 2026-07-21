'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startStubPalGate } = require('../helpers/stub-palgate.js');
const { createMockHomebridgeApi, createMockLog } = require('../helpers/mock-homebridge.js');

// Feature 1: external-open detection via the operation log. Drives the poller helpers
// (_processLogEntries / _pollExternalOpens) directly, mirroring poller-and-types.test.js.

let stub;
let PalGatePlatform;

const SESSION_TOKEN = '000102030405060708090a0b0c0d0e0f';
const PHONE = '972500000000';
const BASE_CONFIG = {
  platform: 'PalGatePlatform', token: SESSION_TOKEN, phoneNumber: PHONE, tokenType: 1,
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

test('high-water mark: only entries newer than the mark animate', async () => {
  const { platform, api, log } = await launchPlatform(
    { detectExternalOpens: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  const C = api.hap.Characteristic;

  // Seed a high-water mark; a stale entry (at/below the mark) must NOT animate.
  platform._lastSeenLogTime = new Map([['DEV1', 1000]]);
  platform._processLogEntries('DEV1', [
    { userId: 'someone', operation: 'Output 1', time: 900, type: 100 },
    { userId: 'someone', operation: 'Output 1', time: 1000, type: 100 },
  ]);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED, 'stale entries do not animate');

  // A fresh entry animates.
  platform._processLogEntries('DEV1', [
    { userId: 'someone', operation: 'Output 1', time: 2000, type: 100, firstname: 'Ada' },
  ]);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPENING);
  assert.equal(platform._lastSeenLogTime.get('DEV1'), 2000, 'high-water mark advances');
  assert.ok(log.has('info', /opened externally by Ada \(app\)/));
  api.emit('shutdown');
});

test('self-dedupe: our own open inside ±30s is skipped, outside the window animates', async () => {
  const { platform, api } = await launchPlatform(
    { detectExternalOpens: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  const C = api.hap.Characteristic;
  platform._lastSeenLogTime = new Map([['DEV1', 0]]);

  // Record a HomeKit-initiated open at "now".
  const nowSec = Math.floor(Date.now() / 1000);
  platform._selfOpens = new Map([['DEV1:1', [nowSec]]]);

  // Our own phone number within ±30s of that trigger → our HomeKit tap → skipped.
  platform._processLogEntries('DEV1', [
    { userId: PHONE, operation: 'Output 1', time: nowSec + 5, type: 100 },
  ]);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED, 'self-open within window is skipped');

  // Same phone number but OUTSIDE ±30s (owner opening from the PalGate app later) → animates.
  platform._processLogEntries('DEV1', [
    { userId: PHONE, operation: 'Output 1', time: nowSec + 100, type: 100 },
  ]);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPENING, 'own userId outside window animates');
  api.emit('shutdown');
});

test('self-dedupe window scales with the poll interval (30s floor)', async () => {
  const { platform, api } = await launchPlatform(
    { detectExternalOpens: true, logPollInterval: 90 },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  const C = api.hap.Characteristic;
  platform._lastSeenLogTime = new Map([['DEV1', 0]]);
  const nowSec = Math.floor(Date.now() / 1000);
  platform._selfOpens = new Map([['DEV1:1', [nowSec]]]);

  // 60s after our trigger: beyond the 30s floor but within the 90s poll-interval window.
  platform._processLogEntries('DEV1', [
    { userId: PHONE, operation: 'Output 1', time: nowSec + 60, type: 100 },
  ]);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED, 'self-open within the scaled window is skipped');
  api.emit('shutdown');
});

test('multi-output routing: "Output 2" animates only the :2 gate', async () => {
  const { platform, api } = await launchPlatform(
    { detectExternalOpens: true },
    [{ id: 'DEV2', name1: 'North', name2: 'South', output1: true, output2: true, admin: true }]
  );
  const C = api.hap.Characteristic;
  const north = api.registered.find(a => a.context.deviceId === 'DEV2:1');
  const south = api.registered.find(a => a.context.deviceId === 'DEV2:2');
  platform._lastSeenLogTime = new Map([['DEV2', 0]]);

  platform._processLogEntries('DEV2', [
    { userId: 'someone', operation: 'Output 2', time: 100, type: 8, sn: '0555' },
  ]);
  assert.equal(south.context.currentDoorState, C.CurrentDoorState.OPENING, ':2 gate animates');
  assert.equal(north.context.currentDoorState, C.CurrentDoorState.CLOSED, ':1 gate untouched');
  api.emit('shutdown');
});

test('animation fires without an API open call', async () => {
  const { platform, api } = await launchPlatform(
    { detectExternalOpens: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  const C = api.hap.Characteristic;
  platform._lastSeenLogTime = new Map([['DEV1', 0]]);

  platform._processLogEntries('DEV1', [
    { userId: 'someone', operation: 'Output 1', time: 100, type: 100 },
  ]);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPENING);
  // Full cycle completes without ever calling open-gate.
  await sleep(120);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.CLOSED);
  assert.equal(stub.countRequests('/device/DEV1/open-gate'), 0, 'external detection must NOT call the open API');
  api.emit('shutdown');
});

test('unknown type still animates and logs the raw type number', async () => {
  const { platform, api, log } = await launchPlatform(
    { detectExternalOpens: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  const acc = api.registered.find(a => a.context.accessoryType === 'garageDoor');
  const C = api.hap.Characteristic;
  platform._lastSeenLogTime = new Map([['DEV1', 0]]);

  platform._processLogEntries('DEV1', [
    { userId: 'someone', operation: 'Output 1', time: 100, type: 42 },
  ]);
  assert.equal(acc.context.currentDoorState, C.CurrentDoorState.OPENING);
  assert.ok(log.has('info', /type 42/));
  api.emit('shutdown');
});

test('backoff: 429 doubles the interval, a clean tick resets it', async () => {
  const { platform, api } = await launchPlatform(
    { detectExternalOpens: true, logPollInterval: 10 },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  platform._logPollBaseMs = 10000;
  platform._logPollCurrentMs = 10000;
  platform._lastSeenLogTime = new Map([['DEV1', 0]]);

  // 429 → back off (double).
  stub.failNTimes('GET /user/log', 99, 429, { msg: 'rate limited' });
  await platform._pollExternalOpens();
  assert.equal(platform._logPollCurrentMs, 20000, 'doubles on 429');

  await platform._pollExternalOpens();
  assert.equal(platform._logPollCurrentMs, 40000, 'doubles again');

  // Clean tick → reset to base.
  stub.reset();
  stub.route('GET /user/log', { log: [] });
  await platform._pollExternalOpens();
  assert.equal(platform._logPollCurrentMs, 10000, 'resets on success');
  api.emit('shutdown');
});

test('backoff caps at 5 minutes', async () => {
  const { platform, api } = await launchPlatform(
    { detectExternalOpens: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  platform._logPollBaseMs = 15000;
  platform._logPollCurrentMs = 4 * 60 * 1000; // 4 min
  platform._lastSeenLogTime = new Map([['DEV1', 0]]);
  stub.failNTimes('GET /user/log', 99, 429);
  await platform._pollExternalOpens();
  assert.equal(platform._logPollCurrentMs, 5 * 60 * 1000, 'caps at 5 min');
  api.emit('shutdown');
});

test('detection disabled globally → no log poller started', async () => {
  const { platform, api } = await launchPlatform(
    {}, // detectExternalOpens defaults to false
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  assert.equal(platform._logPollerTimer, undefined, 'poller not scheduled when detection is off');
  api.emit('shutdown');
});

test('per-gate override enables detection even when the global default is off', async () => {
  const { platform, api } = await launchPlatform(
    { detectExternalOpens: false, customGates: [{ deviceId: 'DEV1', detectExternalOpens: true }] },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: true }]
  );
  assert.deepEqual(platform._detectionBaseIds(), ['DEV1']);
  api.emit('shutdown');
});

test('non-admin gate is excluded from detection (operation log is admin-only)', async () => {
  const { platform, api } = await launchPlatform(
    { detectExternalOpens: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, admin: false }]
  );
  assert.deepEqual(platform._detectionBaseIds(), [], 'non-admin gate is not polled');
  assert.equal(platform._logPollerTimer, undefined, 'poller not scheduled when only non-admin gates are enabled');
  api.emit('shutdown');
});
