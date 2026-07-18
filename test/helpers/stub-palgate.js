'use strict';

const http = require('node:http');

/**
 * Programmable stub of the PalGate HTTP API for tests.
 *
 * Usage:
 *   const stub = await startStubPalGate();
 *   process.env.PALGATE_API_BASE_URL = stub.baseUrl;  // BEFORE requiring lib/api.js
 *   stub.route('GET /devices/', { devices: [...] });               // static body
 *   stub.route('GET /devices/', (req, res) => { ... });            // full control
 *   stub.failNTimes('GET /devices/', 2, 500);                      // then falls through
 *   stub.requests  // → [{ method, path, headers }]
 */
async function startStubPalGate() {
  const routes = new Map();
  const failCounters = new Map();
  const requests = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const key = `${req.method} ${url.pathname}`;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers });

    const failure = failCounters.get(key);
    if (failure && failure.remaining > 0) {
      failure.remaining--;
      if (failure.status === 'destroy') { req.socket.destroy(); return; }
      if (failure.status === 'hang') { return; } // never respond — exercise timeouts
      res.writeHead(failure.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(failure.body ?? { err: 'stub failure' }));
      return;
    }

    const handler = routes.get(key);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ err: `no stub route for ${key}` }));
      return;
    }
    if (typeof handler === 'function') return handler(req, res, url);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(handler));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}/`,
    requests,
    route(key, handler) { routes.set(key, handler); },
    failNTimes(key, n, status, body) { failCounters.set(key, { remaining: n, status, body }); },
    countRequests(pathname) { return requests.filter(r => r.path === pathname).length; },
    reset() { requests.length = 0; failCounters.clear(); routes.clear(); },
    close() { return new Promise(resolve => server.close(resolve)); },
  };
}

module.exports = { startStubPalGate };
