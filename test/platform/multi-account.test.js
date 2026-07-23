'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startStubPalGate } = require('../helpers/stub-palgate.js');
const { createMockHomebridgeApi, createMockLog, MockPlatformAccessory } = require('../helpers/mock-homebridge.js');
const { packUint64BE, bytesToHex } = require('../../lib/utils/helpers.js');

// Multi-account support: the platform can manage gates across several linked PalGate
// accounts, each with its own credentials. These tests drive discovery and operations
// against a stub that serves a different device list per account (matched on the phone
// number embedded in the temporal token) and asserts per-account credential routing.

let stub;
let PalGatePlatform;

const TOKEN_A = '000102030405060708090a0b0c0d0e0f';
const TOKEN_B = '0f0e0d0c0b0a09080706050403020100';
const PHONE_A = '972500000000';
const PHONE_B = '972500000042';

// The temporal token embeds the phone number in bytes 1-6 (hex chars 2..14), stable across
// timestamps — so a stub can identify which account a request came from by its token.
function phoneHex(phone) {
  return bytesToHex(packUint64BE(parseInt(phone, 10)).slice(2, 8)).toUpperCase();
}
function tokenPhone(tokenHeader) {
  return String(tokenHeader || '').toUpperCase().slice(2, 14);
}

before(async () => {
  stub = await startStubPalGate();
  process.env.PALGATE_API_BASE_URL = stub.baseUrl;
  PalGatePlatform = require('../../lib/palgate.js');
});

after(async () => { await stub.close(); });

beforeEach(() => { stub.reset(); });

// Route GET /devices/ to serve a per-account device list keyed by the token's phone bytes.
function routeDevicesByAccount(devicesByPhone) {
  stub.route('GET /devices/', (req, res) => {
    const phone = tokenPhone(req.headers['x-bt-token']);
    const match = Object.entries(devicesByPhone).find(([p]) => phoneHex(p) === phone);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ devices: match ? match[1] : [] }));
  });
}

function makePlatform(config) {
  const api = createMockHomebridgeApi();
  const log = createMockLog();
  const platform = new PalGatePlatform(log, { platform: 'PalGatePlatform', ...config }, api);
  return { platform, api, log };
}

function accessorySummary(api) {
  return api.registered.map(a => `${a.context.deviceId}|${a.context.accessoryType}|${a.displayName}`).sort();
}

const TWO_ACCOUNTS = {
  accounts: [
    { label: 'Home', token: TOKEN_A, phoneNumber: PHONE_A, tokenType: 1 },
    { label: 'Office', token: TOKEN_B, phoneNumber: PHONE_B, tokenType: 1 },
  ],
};

test('discovery merges gates from every configured account', async () => {
  routeDevicesByAccount({
    [PHONE_A]: [{ id: 'DEV_A', name1: 'Home Gate', output1: true }],
    [PHONE_B]: [{ id: 'DEV_B', name1: 'Office Gate', output1: true }],
  });
  const { api } = makePlatform(TWO_ACCOUNTS);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV_A|garageDoor|Home Gate', 'DEV_B|garageDoor|Office Gate']);
});

test('each accessory is tagged with the account that discovered it', async () => {
  routeDevicesByAccount({
    [PHONE_A]: [{ id: 'DEV_A', name1: 'Home Gate', output1: true }],
    [PHONE_B]: [{ id: 'DEV_B', name1: 'Office Gate', output1: true }],
  });
  const { api } = makePlatform(TWO_ACCOUNTS);
  await api.launch();
  api.emit('shutdown');
  const a = api.registered.find(x => x.context.deviceId === 'DEV_A');
  const b = api.registered.find(x => x.context.deviceId === 'DEV_B');
  assert.equal(a.context.accountId, PHONE_A);
  assert.equal(b.context.accountId, PHONE_B);
});

test('a gate shared across accounts is registered once; first account in order wins', async () => {
  routeDevicesByAccount({
    [PHONE_A]: [{ id: 'SHARED', name1: 'Shared Gate', output1: true }],
    [PHONE_B]: [{ id: 'SHARED', name1: 'Shared Gate', output1: true }],
  });
  const { api, log } = makePlatform(TWO_ACCOUNTS);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['SHARED|garageDoor|Shared Gate']);
  const shared = api.registered.find(x => x.context.deviceId === 'SHARED');
  assert.equal(shared.context.accountId, PHONE_A, 'first account (Home) owns the shared gate');
  assert.ok(log.has('info', /already managed by "Home"/));
});

test('opening a gate uses its owning account credentials', async () => {
  routeDevicesByAccount({
    [PHONE_A]: [{ id: 'DEV_A', name1: 'Home Gate', output1: true }],
    [PHONE_B]: [{ id: 'DEV_B', name1: 'Office Gate', output1: true }],
  });
  stub.route('GET /device/DEV_B/open-gate', { status: 'ok' });
  const { api } = makePlatform(TWO_ACCOUNTS);
  await api.launch();

  const office = api.registered.find(x => x.context.deviceId === 'DEV_B');
  const C = api.hap.Characteristic;
  await office.getService(api.hap.Service.GarageDoorOpener)
    .getCharacteristic(C.TargetDoorState)
    .triggerSet(C.TargetDoorState.OPEN);

  const openReq = stub.requests.find(r => r.path === '/device/DEV_B/open-gate');
  assert.ok(openReq, 'expected an open-gate request for the Office gate');
  assert.equal(tokenPhone(openReq.headers['x-bt-token']), phoneHex(PHONE_B),
    'open-gate must be signed with the Office account token');
  api.emit('shutdown');
});

test('legacy top-level credentials still work as a single implicit account', async () => {
  routeDevicesByAccount({ [PHONE_A]: [{ id: 'DEV_A', name1: 'Front', output1: true }] });
  const { api } = makePlatform({ token: TOKEN_A, phoneNumber: PHONE_A, tokenType: 1 });
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV_A|garageDoor|Front']);
  assert.equal(api.registered[0].context.accountId, PHONE_A);
});

test('one account failing does not abort discovery of the others', async () => {
  routeDevicesByAccount({ [PHONE_A]: [{ id: 'DEV_A', name1: 'Home Gate', output1: true }] });
  // PHONE_B has no route match → served an empty devices array; Home still discovers.
  const { api } = makePlatform(TWO_ACCOUNTS);
  await api.launch();
  api.emit('shutdown');
  assert.deepEqual(accessorySummary(api), ['DEV_A|garageDoor|Home Gate']);
});

test('cached accessory with no accountId is kept in place under an accounts config', async () => {
  routeDevicesByAccount({ [PHONE_A]: [{ id: 'DEV_A', name1: 'Front', output1: true }] });
  const { platform, api } = makePlatform({
    accounts: [{ label: 'Home', token: TOKEN_A, phoneNumber: PHONE_A, tokenType: 1 }],
  });
  const cached = new MockPlatformAccessory('Front', api.hap.uuid.generate('DEV_A_garageDoor'));
  cached.context = { deviceId: 'DEV_A', name: 'Front', accessoryType: 'garageDoor' };
  cached.addService(api.hap.Service.GarageDoorOpener, 'Front');
  platform.configureAccessory(cached);
  await api.launch();
  api.emit('shutdown');
  assert.equal(api.registered.length, 0, 'cached accessory must not be re-registered');
  assert.equal(api.unregistered.length, 0);
  assert.equal(cached.context.accountId, PHONE_A, 'cached accessory is re-tagged with its account');
});

test('self-open dedup uses the owning account phone number', async () => {
  routeDevicesByAccount({
    [PHONE_A]: [{ id: 'DEV_A', name1: 'Home Gate', output1: true, admin: true }],
    [PHONE_B]: [{ id: 'DEV_B', name1: 'Office Gate', output1: true, admin: true }],
  });
  const { platform, api } = makePlatform({ ...TWO_ACCOUNTS, detectExternalOpens: true });
  await api.launch();

  const office = api.registered.find(x => x.context.deviceId === 'DEV_B');
  const accountB = platform.accounts.find(a => a.id === PHONE_B);

  // Record a self-open for the Office gate, then feed a log entry attributed to the Office
  // account's phone within the match window — it must be treated as our own open and skipped.
  const nowSec = Math.floor(Date.now() / 1000);
  platform._recordSelfOpen('DEV_B');
  const before = office.context.currentDoorState;
  platform._processLogEntries('DEV_B', [
    { time: nowSec, operation: 'Output 1', userId: PHONE_B, type: 100 },
  ], accountB);
  assert.equal(office.context.currentDoorState, before, 'own open (matching account phone) is not animated');
  api.emit('shutdown');
});
