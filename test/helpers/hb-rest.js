'use strict';

/*
 * Minimal REST client for a running homebridge-config-ui-x instance.
 *
 * The e2e test drives the plugin UI through a browser, but uses this client for
 * the parts a browser is bad at: establishing a clean config baseline before the
 * run and reading the saved config back afterwards to assert what the UI wrote.
 *
 * Endpoints (config-ui-x):
 *   POST /api/auth/login                        -> { access_token }
 *   GET  /api/config-editor/plugin/:pluginName  -> [ configBlock, ... ]
 *   POST /api/config-editor/plugin/:pluginName  -> replace all blocks (array body)
 *   PUT  /api/server/restart                    -> restart Homebridge (unused by default)
 *
 * Uses the global fetch built into Node 18+.
 */

function createHbRest({ baseUrl, username, password, pluginName }) {
  let accessToken = null;

  async function api(path, { method = 'GET', body, auth = true, raw = false } = {}) {
    const headers = {};
    if (auth) {
      if (!accessToken) throw new Error('not logged in — call login() first');
      headers.Authorization = `Bearer ${accessToken}`;
    }
    // Only advertise a JSON body when we actually send one — config-ui-x rejects a
    // bodyless request (e.g. PUT /server/restart) that still carries this header.
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
    }
    if (raw) return text;
    return text ? JSON.parse(text) : null;
  }

  return {
    async login() {
      const data = await api('/api/auth/login', {
        method: 'POST',
        auth: false,
        body: { username, password },
      });
      accessToken = data && data.access_token;
      if (!accessToken) throw new Error('login returned no access_token');
      return accessToken;
    },

    // First config block for the plugin, or null if unconfigured.
    async getConfig() {
      const blocks = await api(`/api/config-editor/plugin/${encodeURIComponent(pluginName)}`);
      return Array.isArray(blocks) && blocks.length ? blocks[0] : null;
    },

    // Replace the plugin's config with a single block.
    async setConfig(block) {
      return api(`/api/config-editor/plugin/${encodeURIComponent(pluginName)}`, {
        method: 'POST',
        body: [block],
      });
    },

    // Poll getConfig() until predicate(block) is truthy, or throw on timeout.
    async waitForConfig(predicate, { timeoutMs = 12000, intervalMs = 750 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await this.getConfig();
        if (predicate(last)) return last;
        await new Promise(r => setTimeout(r, intervalMs));
      }
      const err = new Error('waitForConfig timed out');
      err.lastConfig = last;
      throw err;
    },

    restart() {
      return api('/api/server/restart', { method: 'PUT' });
    },

    // Homebridge process status: 'up' | 'pending' | 'down' (endpoint returns a
    // bare string or, on some versions, { status }).
    async homebridgeStatus() {
      const res = await api('/api/status/homebridge');
      return (res && typeof res === 'object') ? res.status : res;
    },

    // Poll status until Homebridge is healthy again after a restart. The config-ui-x
    // HomebridgeStatus enum is 'ok' | 'pending' | 'down' ('ok' = running); older
    // versions/docs used 'up', so accept both.
    async waitForHomebridgeUp({ timeoutMs = 90000, intervalMs = 2000 } = {}) {
      const healthy = new Set(['ok', 'up']);
      const deadline = Date.now() + timeoutMs;
      let last = null;
      while (Date.now() < deadline) {
        last = await this.homebridgeStatus().catch(() => 'unreachable');
        if (healthy.has(last)) return true;
        await new Promise(r => setTimeout(r, intervalMs));
      }
      const err = new Error(`Homebridge did not return to a healthy status within ${timeoutMs}ms (last: ${last})`);
      err.lastStatus = last;
      throw err;
    },

    // Empty the log file so a post-restart download contains only the fresh boot.
    // Best-effort: some setups (journald/syslog) have no truncatable file.
    truncateLog() {
      return api('/api/platform-tools/hb-service/log/truncate', { method: 'PUT' });
    },

    // Download the whole log file as plain text (colour codes stripped).
    downloadLog() {
      return api('/api/platform-tools/hb-service/log/download?colour=no', { raw: true });
    },
  };
}

// Keys that survive a "wipe" — structural identity plus the linking credentials, in both
// the legacy single-account shape (token/phoneNumber/tokenType) and the multi-account
// shape (accounts[]). Preserving `accounts` is essential: without it the wipe would delete
// every linked account and leave nothing to test against.
const PRESERVED_KEYS = ['platform', 'name', '_bridge', 'accounts', 'token', 'phoneNumber', 'tokenType'];

function stripToTokenFields(block) {
  const wiped = {};
  for (const key of PRESERVED_KEYS) {
    if (block && block[key] !== undefined) wiped[key] = block[key];
  }
  return wiped;
}

// Normalizes a plugin config block to the list of linked accounts, in either shape.
// Returns [{ label?, token, phoneNumber, tokenType }] (empty if unlinked).
function extractAccounts(block) {
  if (!block) return [];
  if (Array.isArray(block.accounts) && block.accounts.length) {
    return block.accounts
      .filter(a => a && a.token && a.phoneNumber && a.tokenType !== undefined)
      .map(a => ({ label: a.label, token: a.token, phoneNumber: a.phoneNumber, tokenType: a.tokenType }));
  }
  if (block.token && block.phoneNumber && block.tokenType !== undefined) {
    return [{ token: block.token, phoneNumber: block.phoneNumber, tokenType: block.tokenType }];
  }
  return [];
}

module.exports = { createHbRest, stripToTokenFields, extractAccounts, PRESERVED_KEYS };
