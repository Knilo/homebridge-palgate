'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startStubPalGate } = require('../helpers/stub-palgate.js');

// lib/api.js bakes BASE_URL into its axios instance at require time, so the
// stub server must be up and PALGATE_API_BASE_URL exported before the require.
let stub;
let api;

before(async () => {
  stub = await startStubPalGate();
  process.env.PALGATE_API_BASE_URL = stub.baseUrl;
  api = require('../../lib/api.js');
});

after(async () => { await stub.close(); });

beforeEach(() => { stub.reset(); });

test('getDevices: returns parsed body and sends the token header', async () => {
  stub.route('GET /devices/', { devices: [{ id: 'DEV1' }] });
  const data = await api.getDevices('TOKEN123');
  assert.deepEqual(data, { devices: [{ id: 'DEV1' }] });
  assert.equal(stub.requests[0].headers['x-bt-token'], 'TOKEN123');
});

test('callApi: retries 5xx then succeeds', async () => {
  stub.route('GET /devices/', { devices: [] });
  stub.failNTimes('GET /devices/', 2, 500);
  const data = await api.callApi('devices/', 't', { retryDelays: [10, 10, 10] });
  assert.deepEqual(data, { devices: [] });
  assert.equal(stub.countRequests('/devices/'), 3);
});

test('callApi: does NOT retry 4xx (auth/rate-limit failures fail fast)', async () => {
  stub.failNTimes('GET /devices/', 99, 429, { msg: 'too many requests' });
  await assert.rejects(
    api.callApi('devices/', 't', { retryDelays: [10, 10] }),
    /API call error: 429/
  );
  assert.equal(stub.countRequests('/devices/'), 1, 'must not retry a 4xx');
});

test('callApi: retries network errors (destroyed connection) then succeeds', async () => {
  stub.route('GET /devices/', { ok: true });
  stub.failNTimes('GET /devices/', 1, 'destroy');
  const data = await api.callApi('devices/', 't', { retryDelays: [10] });
  assert.deepEqual(data, { ok: true });
  assert.equal(stub.countRequests('/devices/'), 2);
});

test('callApi: exhausts the retry budget on persistent 5xx and reports the status', async () => {
  stub.failNTimes('GET /devices/', 99, 503, { down: true });
  await assert.rejects(
    api.callApi('devices/', 't', { retryDelays: [10, 10] }),
    /API call error: 503.*down/s
  );
  assert.equal(stub.countRequests('/devices/'), 3, 'initial attempt + 2 retries');
});

test('callApi: request timeout is honoured and surfaces as a failure', async () => {
  stub.failNTimes('GET /devices/', 99, 'hang'); // server never responds
  await assert.rejects(
    api.callApi('devices/', 't', { retryDelays: [], timeout: 100 }),
    /API call failed: timeout/
  );
});

test('callApiOnce: never retries', async () => {
  stub.failNTimes('GET /devices/', 99, 500);
  await assert.rejects(api.callApiOnce('devices/', 't'), /API call error: 500/);
  assert.equal(stub.countRequests('/devices/'), 1);
});

test('callApiOnce: object error bodies are JSON-stringified in the message', async () => {
  stub.failNTimes('GET /devices/', 1, 500, { err: 1000, msg: 'Invalid Token' });
  await assert.rejects(api.callApiOnce('devices/', 't'), /Invalid Token/);
});

test('openGate: builds the endpoint with outputNum and encoded openBy', async () => {
  stub.route('GET /device/DEV1/open-gate', { ok: 1 });
  await api.openGate('DEV1:2', 'tok', 100);
  const req = stub.requests[0];
  assert.equal(req.path, '/device/DEV1/open-gate');
  assert.deepEqual(req.query, { outputNum: '2', openBy: '100' });
});

test('openGate: plain deviceId defaults to output 1', async () => {
  stub.route('GET /device/DEV1/open-gate', { ok: 1 });
  await api.openGate('DEV1', 'tok');
  assert.deepEqual(stub.requests[0].query, { outputNum: '1' });
});

test('getDeviceInfo / getDeviceInfoOnce: unwrap the device envelope the live API returns', async () => {
  // The real device/{id}/ endpoint wraps the payload — regression guard for the
  // poller bug where latch fields were read off the wrapper and came back undefined.
  stub.route('GET /device/DEV9/', {
    err: null, msg: 'device details', status: 'ok',
    device: { id: 'DEV9', output1LatchStatus: true, output1Disabled: true },
  });
  const a = await api.getDeviceInfo('tok', 'DEV9');
  const b = await api.getDeviceInfoOnce('tok', 'DEV9');
  assert.equal(a.output1LatchStatus, true);
  assert.equal(a.output1Disabled, true);
  assert.deepEqual(a, b);
  assert.equal(stub.countRequests('/device/DEV9/'), 2);
});

test('getDeviceInfoOnce: flat (unwrapped) responses still pass through unchanged', async () => {
  stub.route('GET /device/DEV8/', { id: 'DEV8', output1LatchStatus: false });
  const data = await api.getDeviceInfoOnce('tok', 'DEV8');
  assert.equal(data.id, 'DEV8');
});

test('validateToken: calls check-token with timestamp params', async () => {
  stub.route('GET /user/check-token', { valid: true });
  const data = await api.validateToken('tok');
  assert.equal(data.valid, true);
  const q = stub.requests[0].query;
  assert.ok(Number(q.ts) > 0, 'ts param present');
  assert.equal(q.ts_diff, '0');
});
