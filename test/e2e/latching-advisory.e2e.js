#!/usr/bin/env node
'use strict';

/*
 * Headless UI test for the Latching advisory modal.
 *
 * Unlike plugin-ui.e2e.js, this does NOT need a running Homebridge / config-ui-x login — it
 * loads the plugin's own index.html directly in headless Chrome with a stubbed `homebridge`
 * bridge, so it can run anywhere Chrome is installed. It verifies that selecting the per-gate
 * "Latching" trigger mode surfaces the right advisory (a themed pg-modal, since the config-ui-x
 * iframe blocks native window.confirm) across all three paths:
 *
 *   1. latch but not admin   -> "This may not be your gate" modal
 *   2. admin + looks shared  -> "This looks like a shared gate" modal
 *   3. admin + looks private -> no modal, the selection just proceeds
 *
 * Requirements (local only — not run in CI): Google Chrome installed.
 * Usage: npm run test:e2e:advisory   (override the binary with CHROME_PATH=...)
 */

const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FILE_URL = 'file://' + path.join(__dirname, '..', '..', 'homebridge-ui', 'public', 'index.html');
const DEVICE_ID = 'DEV1';
const SID = DEVICE_ID.replace(/[^a-zA-Z0-9_-]/g, '_');

const failures = [];
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(label + (detail ? ` (${detail})` : ''));
};

// Runs in the page BEFORE index.html's script — defines the window.homebridge bridge the UI
// expects from config-ui-x, with just enough behavior to drive discovery and the advisory.
function bridgeInit(scenario) {
  const gate = { deviceId: 'DEV1', defaultName: 'Front Gate', admin: scenario.admin, latch: true };
  const advisory = scenario.advisory;
  const noop = () => {};
  const base = {
    getPluginConfig: async () => ([{
      platform: 'PalGatePlatform', name: 'PalGate', token: '00', phoneNumber: '972500000000', tokenType: 1, customGates: [],
    }]),
    updatePluginConfig: noop,
    savePluginConfig: async () => {},
    showSpinner: noop, hideSpinner: noop,
    showSchemaForm: noop, hideSchemaForm: noop,
    toast: { success: noop, error: noop, info: noop, warning: noop },
    addEventListener: noop, removeEventListener: noop,
    request: async (p) => {
      if (p === '/devices/discover') return { success: true, gates: [gate] };
      if (p === '/gate/opener-advisory') return advisory || { success: true, looksShared: false, distinctUsers: 1, sampleSize: 10 };
      return { success: false, error: 'unstubbed ' + p };
    },
  };
  // Any unstubbed method resolves to a no-op so init can't throw on a missing bridge call.
  window.homebridge = new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });
}

async function runScenario(browser, name, scenario, expect) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message));
  await page.evaluateOnNewDocument(bridgeInit, scenario);
  await page.goto(FILE_URL, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(() => document.querySelector('#gateList .card'), { timeout: 8000 });
  await page.evaluate((id) => {
    const card = [...document.querySelectorAll('#gateList .card')].find(c => (c.textContent || '').includes(id));
    card.querySelector('.configure-btn').click();
  }, DEVICE_ID);
  await page.waitForFunction((sid) => document.getElementById('customiseTriggerMode-' + sid), { timeout: 8000 }, SID);
  await page.evaluate((sid) => document.getElementById('customiseTriggerMode-' + sid).click(), SID);
  await page.waitForFunction((sid) => document.getElementById('triggerMode-' + sid + '-latching'), { timeout: 4000 }, SID);
  await page.evaluate((sid) => document.getElementById('triggerMode-' + sid + '-latching').click(), SID);

  await new Promise(r => setTimeout(r, 400)); // let the async advisory resolve + render

  const modalTitle = await page.evaluate(() => {
    const el = document.querySelector('.pg-modal-overlay .pg-modal-title');
    return el ? el.textContent.trim() : null;
  });

  if (expect.modal) {
    check(!!modalTitle && modalTitle.includes(expect.titleIncludes), `${name}: modal shown`, `title="${modalTitle}"`);
    await page.evaluate(() => document.querySelector('.pg-modal-overlay [data-act="cancel"]').click());
    await new Promise(r => setTimeout(r, 100));
    const checked = await page.evaluate((sid) => document.getElementById('triggerMode-' + sid + '-latching').checked, SID);
    check(checked === false, `${name}: cancel reverts the selection`);
  } else {
    check(modalTitle === null, `${name}: no modal (proceeds silently)`, modalTitle ? `unexpected "${modalTitle}"` : '');
    const checked = await page.evaluate((sid) => document.getElementById('triggerMode-' + sid + '-latching').checked, SID);
    check(checked === true, `${name}: latching stays selected`);
  }
  check(pageErrors.length === 0, `${name}: no page errors`, pageErrors.join('; '));
  await page.close();
}

(async () => {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new', args: ['--no-sandbox'] });
  } catch (err) {
    console.error(`Could not launch Chrome at ${CHROME_PATH}. Set CHROME_PATH to your Chrome binary.\n${err.message}`);
    process.exit(2);
  }
  try {
    await runScenario(browser, 'latch-not-admin', { admin: false, advisory: null }, { modal: true, titleIncludes: 'may not be your gate' });
    await runScenario(browser, 'admin-shared', { admin: true, advisory: { success: true, looksShared: true, distinctUsers: 9, sampleSize: 25 } }, { modal: true, titleIncludes: 'looks like a shared gate' });
    await runScenario(browser, 'admin-private', { admin: true, advisory: { success: true, looksShared: false, distinctUsers: 2, sampleSize: 20 } }, { modal: false });
  } finally {
    await browser.close();
  }
  console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASSED');
  process.exit(failures.length ? 1 : 0);
})();
