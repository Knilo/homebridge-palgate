'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startStubPalGate } = require('../helpers/stub-palgate.js');
const { createMockHomebridgeApi, createMockLog, MockPlatformAccessory } = require('../helpers/mock-homebridge.js');

// The platform lazily requires lib/api.js, which bakes BASE_URL in at require
// time — so the stub must be up and the env var set before anything touches it.
let stub;
let PalGatePlatform;

const SESSION_TOKEN = '000102030405060708090a0b0c0d0e0f';
const BASE_CONFIG = { platform: 'PalGatePlatform', token: SESSION_TOKEN, phoneNumber: '972500000000', tokenType: 1 };

before(async () => {
  stub = await startStubPalGate();
  process.env.PALGATE_API_BASE_URL = stub.baseUrl;
  PalGatePlatform = require('../../lib/palgate.js');
});

after(async () => { await stub.close(); });

beforeEach(() => { stub.reset(); });

function makePlatform(configOverrides = {}, devices = []) {
  stub.route('GET /devices/', { devices });
  const api = createMockHomebridgeApi();
  const log = createMockLog();
  const platform = new PalGatePlatform(log, { ...BASE_CONFIG, ...configOverrides }, api);
  return { platform, api, log };
}

function accessorySummary(api) {
  return api.registered.map(a => `${a.context.deviceId}|${a.context.accessoryType}|${a.displayName}`).sort();
}

test('missing credentials: logs an error and registers nothing, without crashing', async () => {
  const api = createMockHomebridgeApi();
  const log = createMockLog();
  new PalGatePlatform(log, { platform: 'PalGatePlatform' }, api);
  assert.ok(log.has('error', /Missing required configuration properties token, phoneNumber, tokenType/));
  await api.launch(); // no didFinishLaunching handler was registered — must be a no-op
  assert.equal(api.registered.length, 0);
});

test('discovery: single-output device becomes one garage door accessory by default', async () => {
  const { api, log } = makePlatform({}, [{ id: 'DEV1', name1: 'Front Gate', output1: true }]);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV1|garageDoor|Front Gate']);
  assert.ok(log.has('success', /Configured gate accessory/));
});

test('discovery: global accessoryType switch applies to discovered gates', async () => {
  const { api } = makePlatform({ accessoryType: 'switch' }, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV1|switch|Front']);
});

test('discovery: multi-output device registers deviceId:outputNum accessories with per-output names', async () => {
  const { api } = makePlatform({}, [
    { id: 'DEV2', name1: 'North', name2: 'South', output1: true, output2: true },
  ]);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV2:1|garageDoor|North', 'DEV2:2|garageDoor|South']);
});

test('discovery: multi-output device with output2 disabled still uses :outputNum ids (orphaning guard)', async () => {
  const { api } = makePlatform({}, [
    { id: 'DEV2', name1: 'North', output1: true, output2: false },
  ]);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV2:1|garageDoor|North']);
});

test('customGates: hide suppresses the accessory; name and type overrides apply', async () => {
  const { api } = makePlatform(
    { customGates: [
      { deviceId: 'DEV1', hide: true },
      { deviceId: 'DEV3', name: 'Renamed', switch: true },
    ] },
    [
      { id: 'DEV1', name1: 'Hidden Gate', output1: true },
      { id: 'DEV3', name1: 'Original', output1: true },
    ]
  );
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV3|switch|Renamed']);
});

test('customGates: entry not in the device list is registered as a custom-only gate', async () => {
  const { api, log } = makePlatform(
    { customGates: [{ deviceId: 'GHOST1', name: 'Manual Gate' }] },
    [{ id: 'DEV1', name1: 'Front', output1: true }]
  );
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV1|garageDoor|Front', 'GHOST1|garageDoor|Manual Gate']);
  assert.ok(log.has('info', /custom-only gate/));
});

test('relay: latch-permitted device with enableRelayLocks exposes Hold Open + Hold Closed locks', async () => {
  const { api } = makePlatform(
    { enableRelayLocks: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }]
  );
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), [
    'DEV1|garageDoor|Front',
    'DEV1|holdClosedLock|Front Hold Closed',
    'DEV1|holdOpenLock|Front Hold Open',
  ]);
});

test('relay: no latch permission means no relay accessories even when globally enabled', async () => {
  const { api } = makePlatform(
    { enableRelayLocks: true },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: false }]
  );
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV1|garageDoor|Front']);
});

test('relay: per-gate relayEnabled opts in even when the global default is off', async () => {
  const { api } = makePlatform(
    { enableRelayLocks: false, relayAccessoryType: 'switch', customGates: [{ deviceId: 'DEV1', relayEnabled: true }] },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }]
  );
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), [
    'DEV1|garageDoor|Front',
    'DEV1|holdClosedSwitch|Front Hold Closed',
    'DEV1|holdOpenSwitch|Front Hold Open',
  ]);
});

test('relay: per-gate relayEnabled=false opts out of a globally enabled relay', async () => {
  const { api } = makePlatform(
    { enableRelayLocks: true, customGates: [{ deviceId: 'DEV1', relayEnabled: false }] },
    [{ id: 'DEV1', name1: 'Front', output1: true, output1Latch: true }]
  );
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV1|garageDoor|Front']);
});

test('cached accessory no longer in the device list is unregistered', async () => {
  const { platform, api } = makePlatform({}, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  const stale = new MockPlatformAccessory('Old Gate', api.hap.uuid.generate('GONE1_garageDoor'));
  stale.context = { deviceId: 'GONE1', name: 'Old Gate', accessoryType: 'garageDoor' };
  stale.addService(api.hap.Service.GarageDoorOpener, 'Old Gate');
  platform.configureAccessory(stale);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(api.unregistered.map(a => a.displayName), ['Old Gate']);
  assert.deepEqual(accessorySummary(api), ['DEV1|garageDoor|Front']);
});

test('cached accessory with an unchanged name is kept in place (no re-registration)', async () => {
  const { platform, api } = makePlatform({}, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  const cached = new MockPlatformAccessory('Front', api.hap.uuid.generate('DEV1_garageDoor'));
  cached.context = { deviceId: 'DEV1', name: 'Front', accessoryType: 'garageDoor' };
  cached.addService(api.hap.Service.GarageDoorOpener, 'Front');
  platform.configureAccessory(cached);
  await api.launch();
  api.emit('shutdown');
  assert.equal(api.registered.length, 0, 'existing accessory must not be re-registered');
  assert.equal(api.unregistered.length, 0);
});

test('rename: cached accessory is recreated (unregister + register) to surface the new name', async () => {
  const { platform, api, log } = makePlatform(
    { customGates: [{ deviceId: 'DEV1', name: 'New Name' }] },
    [{ id: 'DEV1', name1: 'Front', output1: true }]
  );
  const cached = new MockPlatformAccessory('Front', api.hap.uuid.generate('DEV1_garageDoor'));
  cached.context = { deviceId: 'DEV1', name: 'Front', accessoryType: 'garageDoor' };
  cached.addService(api.hap.Service.GarageDoorOpener, 'Front');
  platform.configureAccessory(cached);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(api.unregistered.map(a => a.displayName), ['Front']);
  assert.deepEqual(accessorySummary(api), ['DEV1|garageDoor|New Name']);
  assert.ok(log.has('info', /Recreating accessory to apply new name/));
});

test('discovery failure with 4xx: stops immediately without the retry ladder', async () => {
  stub.failNTimes('GET /devices/', 99, 401, { err: 'bad token' });
  const api = createMockHomebridgeApi();
  const log = createMockLog();
  new PalGatePlatform(log, BASE_CONFIG, api);
  await api.launch();
  api.emit('shutdown');
  assert.equal(stub.countRequests('/devices/'), 1, '4xx must not be retried');
  assert.ok(log.has('error', /PalGate rejected the request/));
  assert.equal(api.registered.length, 0);
});

test('accessory information service carries manufacturer, model, serial and version', async () => {
  const { api } = makePlatform({}, [{ id: 'DEV1', name1: 'Front', output1: true }]);
  await api.launch();
  api.emit('shutdown');
  const info = api.registered[0].getService(api.hap.Service.AccessoryInformation);
  assert.equal(info.getCharacteristic(api.hap.Characteristic.Manufacturer).value, 'PAL Electronics Systems Ltd.');
  assert.equal(info.getCharacteristic(api.hap.Characteristic.Model).value, 'garageDoor');
  assert.equal(info.getCharacteristic(api.hap.Characteristic.SerialNumber).value, 'DEV1');
  assert.equal(info.getCharacteristic(api.hap.Characteristic.FirmwareRevision).value, require('../../package.json').version);
});
