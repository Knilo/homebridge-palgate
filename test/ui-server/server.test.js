'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { join } = require('node:path');

// Integration test for the custom UI server: fork it over IPC exactly the way
// homebridge-config-ui-x does (plugins-settings-ui.service), then exercise the
// request/response protocol. Everything here is hermetic — no PalGate network
// calls (discovery is only tested with missing credentials, which fails before
// any HTTP request is made).

const SERVER_PATH = join(__dirname, '..', '..', 'homebridge-ui', 'server.js');

let child;
let requestSeq = 0;

function request(path, body, timeoutMs = 5000) {
  const requestId = 'test-' + (++requestSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.removeListener('message', onMessage);
      reject(new Error(`no response for ${path} within ${timeoutMs}ms`));
    }, timeoutMs);
    const onMessage = (msg) => {
      if (msg.action === 'response' && msg.payload && msg.payload.requestId === requestId) {
        clearTimeout(timer);
        child.removeListener('message', onMessage);
        resolve(msg.payload);
      }
    };
    child.addListener('message', onMessage);
    child.send({ action: 'request', path, body: body || {}, requestId });
  });
}

before(async () => {
  child = fork(SERVER_PATH, [], { silent: true });
  child.stderr.on('data', d => process.stderr.write('[ui-server] ' + d));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('UI server never signalled ready')), 10000);
    child.on('message', (msg) => {
      if (msg.action === 'ready') { clearTimeout(timer); resolve(); }
    });
  });
});

after(() => {
  if (child && child.connected) child.disconnect();
  child?.kill();
});

test('unknown route responds with Not Found instead of hanging', async () => {
  const res = await request('/no/such/route');
  assert.equal(res.success, false);
  assert.match(res.data.message, /Not Found/);
});

test('/devices/discover with missing credentials returns success:false with an error', async () => {
  const res = await request('/devices/discover', {});
  assert.equal(res.success, true); // transport-level success
  assert.equal(res.data.success, false); // application-level failure
  assert.match(res.data.error, /Missing credentials/);
});

test('/devices/discover with malformed token fails cleanly, not with a crash', async () => {
  const res = await request('/devices/discover', { token: 'zz', phoneNumber: '123', tokenType: 1 });
  assert.equal(res.data.success, false);
  assert.ok(res.data.error, 'expected an error message');
});

test('/link/init returns a QR code and a session id', async () => {
  const res = await request('/link/init');
  assert.equal(res.data.success, true);
  assert.match(res.data.uniqueId, /^[0-9a-f-]{36}$/);
  assert.match(res.data.qrCode, /^data:image\/png;base64,/);
});

test('/link/confirm with an unknown session id fails permanently (no waiting flag)', async () => {
  const res = await request('/link/confirm', { uniqueId: 'does-not-exist' });
  assert.equal(res.data.success, false);
  assert.equal(res.data.waiting, undefined);
  assert.match(res.data.error, /session not found/i);
});

test('/link/confirm with no uniqueId fails with a clear error', async () => {
  const res = await request('/link/confirm', {});
  assert.equal(res.data.success, false);
  assert.match(res.data.error, /No uniqueId/);
});

test('concurrent requests are answered independently', async () => {
  const [a, b, c] = await Promise.all([
    request('/link/init'),
    request('/link/init'),
    request('/devices/discover', {}),
  ]);
  assert.equal(a.data.success, true);
  assert.equal(b.data.success, true);
  assert.notEqual(a.data.uniqueId, b.data.uniqueId);
  assert.equal(c.data.success, false);
});
