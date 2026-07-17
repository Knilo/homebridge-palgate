#!/usr/bin/env node
'use strict';

/*
 * End-to-end test for the plugin's custom settings UI, driven through a real
 * headless Chrome against a running Homebridge + config-ui-x instance.
 *
 * This is the harness that caught the on-load auto-discover TDZ bug: script
 * errors inside the settings iframe surface only as browser page errors —
 * invisible in Homebridge logs and to the UI-server tests — so the only way
 * to catch them is to open the real modal and watch.
 *
 * Requirements (local only — not run in CI):
 *   - Homebridge with config-ui-x running, this plugin installed (npm link)
 *   - Google Chrome installed
 *   - Credentials via environment variables
 *
 * Usage:
 *   HB_UI_PASSWORD=<password> npm run test:e2e
 *
 * Environment:
 *   HB_UI_URL       config-ui-x base URL   (default http://localhost:8581)
 *   HB_UI_USERNAME  UI login username       (default admin)
 *   HB_UI_PASSWORD  UI login password       (required)
 *   CHROME_PATH     Chrome executable       (default macOS app path)
 *   PLUGIN_NAME     plugin to open          (default homebridge-palgate)
 *
 * Checks:
 *   1. UI login succeeds
 *   2. The plugin settings modal opens and the custom UI iframe loads
 *   3. No uncaught page errors in any frame (TDZ/reference errors, etc.)
 *   4. The gate list resolves out of its "Loading gates…" state within 25s
 *      (to discovered gate cards, "No gates found.", or the not-linked hint —
 *      anything but stuck loading)
 */

const puppeteer = require('puppeteer-core');

const HB_UI_URL = process.env.HB_UI_URL || 'http://localhost:8581';
const USERNAME = process.env.HB_UI_USERNAME || 'admin';
const PASSWORD = process.env.HB_UI_PASSWORD;
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLUGIN_NAME = process.env.PLUGIN_NAME || 'homebridge-palgate';
const GATE_LIST_TIMEOUT_MS = 25000;

if (!PASSWORD) {
  console.error('HB_UI_PASSWORD is required. Usage: HB_UI_PASSWORD=<password> npm run test:e2e');
  process.exit(2);
}

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const failures = [];
const pageErrors = [];

function check(ok, label, detail) {
  console.log(`${ts()} ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(label + (detail ? ` (${detail})` : ''));
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new' });
  try {
    const page = await browser.newPage();
    page.on('pageerror', e => pageErrors.push(String(e)));

    // 1. Login
    await page.goto(`${HB_UI_URL}/login`, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.type('input[name="username"], input[formcontrolname="username"]', USERNAME);
    await page.type('input[name="password"], input[formcontrolname="password"]', PASSWORD);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
    ]);
    const loggedIn = !page.url().includes('/login');
    check(loggedIn, 'login succeeds', page.url());
    if (!loggedIn) throw new Error('login failed');

    // 2. Open the plugin settings modal
    await page.goto(`${HB_UI_URL}/plugins`, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.waitForSelector('.card', { timeout: 15000 });
    const opened = await page.evaluate((pluginName) => {
      const card = [...document.querySelectorAll('.card')]
        .find(c => (c.textContent || '').toLowerCase().includes(pluginName.replace('homebridge-', '')));
      if (!card) return 'plugin card not found';
      card.querySelector('button[aria-label="Plugin Actions"]')?.click();
      const item = [...card.querySelectorAll('button.dropdown-item')]
        .find(b => /Plugin Config/i.test(b.textContent || ''));
      if (!item) return 'Plugin Config menu item not found';
      item.click();
      return 'ok';
    }, PLUGIN_NAME);
    check(opened === 'ok', 'plugin settings modal opens', opened);
    if (opened !== 'ok') throw new Error(opened);

    // Wait for the custom UI iframe to appear
    let iframe = null;
    for (let i = 0; i < 30 && !iframe; i++) {
      await new Promise(r => setTimeout(r, 500));
      iframe = page.frames().find(f => f !== page.mainFrame() && f.url().includes('/plugins/settings-ui/'));
    }
    check(!!iframe, 'custom UI iframe loads', iframe ? iframe.url() : 'not found after 15s');
    if (!iframe) throw new Error('iframe missing');

    // 3+4. Poll the gate list until it resolves out of the loading state
    let gateState = null;
    const deadline = Date.now() + GATE_LIST_TIMEOUT_MS;
    while (Date.now() < deadline) {
      gateState = await iframe.evaluate(() => {
        const el = document.getElementById('gateList');
        if (!el) return { phase: 'no-element' };
        const text = el.innerText.replace(/\s+/g, ' ').trim();
        const cards = el.querySelectorAll('.card').length;
        const loading = /Loading gates|Still trying/i.test(text);
        return { phase: loading ? 'loading' : (cards > 0 ? 'gates' : 'resolved-empty'), cards, text: text.slice(0, 120) };
      }).catch(e => ({ phase: 'eval-error', text: String(e).slice(0, 120) }));
      if (gateState.phase === 'gates' || gateState.phase === 'resolved-empty') break;
      await new Promise(r => setTimeout(r, 1000));
    }
    check(
      gateState && (gateState.phase === 'gates' || gateState.phase === 'resolved-empty'),
      `gate list resolves within ${GATE_LIST_TIMEOUT_MS / 1000}s`,
      gateState ? `${gateState.phase}: ${gateState.cards ?? 0} card(s) — "${gateState.text}"` : 'no state'
    );

    check(pageErrors.length === 0, 'no uncaught page errors in any frame',
      pageErrors.length ? pageErrors.join(' | ').slice(0, 300) : undefined);
  } catch (err) {
    if (!failures.length) failures.push('aborted: ' + err.message);
    console.error(ts(), 'aborted:', err.message);
  } finally {
    await browser.close();
  }

  console.log(`\n${failures.length === 0 ? '✓ e2e passed' : '✗ e2e FAILED'}${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
})();
