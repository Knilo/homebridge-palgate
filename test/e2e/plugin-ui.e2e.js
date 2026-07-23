#!/usr/bin/env node
'use strict';

/*
 * End-to-end test for the plugin's custom settings UI, driven through a real
 * headless Chrome against a running Homebridge + config-ui-x instance.
 *
 * Unlike a smoke test, this exercises the full configuration flow and asserts
 * that each UI action actually persists, verified by reading the saved config
 * back through the config-ui-x REST API (see test/helpers/hb-rest.js):
 *
 *   0. SETUP   — wipe the plugin config down to token fields (via REST), so the
 *                run starts from a known-clean baseline. The original config is
 *                snapshotted and restored at the end, so your real Homebridge is
 *                left exactly as it was.
 *   1. LOGIN   — UI login succeeds; the settings modal + custom iframe load.
 *   2. DISCOVER— on-load auto-discovery resolves to real gate cards (>=1); the
 *                manual Discover button also repopulates the list.
 *   3. GLOBAL  — change Default Settings (accessory type, trigger mode, delays,
 *                poll interval, relay), Save, and assert the values persisted;
 *                then switch the relay type to Valve and assert the valve-default-
 *                duration field appears and its value persists (3b).
 *   4. PER-GATE— open a gate's Configure form, override its accessory type (and,
 *                for a latch-permitted gate, its relay), Save, and assert the
 *                customGates override persisted (4). Then assert the new UI (4c):
 *                Relay Mode is ordered above External Opens, both toggles show a
 *                "(global default)" tag, admin gates expose the External Opens
 *                toggle, and a per-gate valve duration appears + persists; a
 *                non-admin gate shows the admin-locked note + tooltip (4d). Then
 *                hide a second gate and assert hide:true persists (4b).
 *   5. RESTART — (opt-in, E2E_RESTART=1) restart the live Homebridge, wait for it
 *                to come back up, and assert from the plugin's boot log that the
 *                saved config is actually applied (the overridden gate registers
 *                as switch + lock, other gates take the global default). The
 *                finally block then restores the original config AND restarts
 *                again so the live bridge ends on your real config.
 *   6. RESET   — click a gate's "Reset all" and assert its customGates entry is
 *                removed entirely (not left as a hollow { deviceId }).
 *   7. ACCOUNTS— re-point the config at one account, then (if two are linked) at two,
 *                reloading the settings UI each time. Asserts the accounts section
 *                renders one card per account with solid Re-link/Remove + Add Account
 *                buttons, that discovery still resolves, and that per-gate account
 *                affiliation labels appear only in the two-account pass. This is the
 *                multi-account coverage — it needs a second linked account to exercise
 *                the two-account pass (otherwise that half is skipped with a note).
 *   throughout — no uncaught page errors in any frame (TDZ/reference errors etc).
 *
 * This is also the harness that caught the on-load auto-discover TDZ bug: script
 * errors inside the settings iframe surface only as browser page errors —
 * invisible in Homebridge logs and to the UI-server tests.
 *
 * Requirements (local only — not run in CI):
 *   - Homebridge with config-ui-x running, this plugin installed (npm link)
 *   - At least one real, linked PalGate account in the plugin config (legacy token
 *     fields or an accounts[] entry). Link a second account to exercise step 7's
 *     two-account pass.
 *   - Google Chrome installed
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
 *   PLUGIN_ALIAS    platform alias          (default PalGatePlatform)
 *   KEEP_WIPED      if set, skip restoring the original config at the end
 *   E2E_RESTART     if set, run the restart-and-verify-from-logs step (5)
 */

const puppeteer = require('puppeteer-core');
const { createHbRest, stripToTokenFields, extractAccounts } = require('../helpers/hb-rest');

const HB_UI_URL = process.env.HB_UI_URL || 'http://localhost:8581';
const USERNAME = process.env.HB_UI_USERNAME || 'admin';
const PASSWORD = process.env.HB_UI_PASSWORD;
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLUGIN_NAME = process.env.PLUGIN_NAME || 'homebridge-palgate';
const PLUGIN_ALIAS = process.env.PLUGIN_ALIAS || 'PalGatePlatform';
const GATE_LIST_TIMEOUT_MS = 25000;
const DO_RESTART = !!process.env.E2E_RESTART;

if (!PASSWORD) {
  console.error('HB_UI_PASSWORD is required. Usage: HB_UI_PASSWORD=<password> npm run test:e2e');
  process.exit(2);
}

const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const failures = [];
const pageErrors = [];
const cspErrors = [];

function check(ok, label, detail) {
  console.log(`${ts()} ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(label + (detail ? ` (${detail})` : ''));
}
function info(msg) { console.log(`${ts()} ....  ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// sid mirrors the UI's per-gate element-id sanitisation (index.html renderCustomizationForm).
const sidOf = deviceId => deviceId.replace(/[^a-zA-Z0-9_-]/g, '_');

// Open a gate's Configure form (idempotent) and wait for its controls to render.
// Returns 'ok' or a short failure reason.
async function openGateForm(iframe, deviceId, sid) {
  const opened = await iframe.evaluate((deviceId) => {
    const card = [...document.querySelectorAll('#gateList .card')].find(c => (c.textContent || '').includes(deviceId));
    if (!card) return 'card not found';
    const form = card.querySelector('.gate-expand-form');
    if (!form || form.style.display !== 'block') card.querySelector('.configure-btn')?.click();
    return 'ok';
  }, deviceId);
  if (opened !== 'ok') return opened;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    const ready = await iframe.evaluate((sid) =>
      !!document.getElementById('enable-' + sid) || !!document.getElementById('garage-' + sid), sid);
    if (ready) return 'ok';
  }
  return 'form not ready';
}

// Click the Save/Reset/Cancel button inside a gate's expanded form.
function clickFormButton(iframe, sid, selector) {
  return iframe.evaluate(({ sid, selector }) => {
    const anchor = document.getElementById('enable-' + sid) || document.getElementById('garage-' + sid);
    const form = anchor && anchor.closest('.gate-expand-form');
    if (form) form.querySelector(selector)?.click();
  }, { sid, selector });
}

// Navigate to /plugins, open this plugin's config modal, and return its settings iframe.
// Reusable so a scenario can reload the UI after re-pointing the config via REST.
async function openSettings(page) {
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
  if (opened !== 'ok') throw new Error(opened);
  let iframe = null;
  for (let i = 0; i < 30 && !iframe; i++) {
    await new Promise(r => setTimeout(r, 500));
    iframe = page.frames().find(f => f !== page.mainFrame() && f.url().includes('/plugins/settings-ui/'));
  }
  if (!iframe) throw new Error('settings iframe missing');
  return iframe;
}

// Wait for on-load discovery to resolve the gate list, then read the gate rows off the
// cards (deviceId + admin/latch badges). Returns { phase, gates } — phase is 'gates',
// 'resolved-empty', or 'timeout'.
async function waitForGates(iframe, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 25000);
  let phase = 'timeout';
  while (Date.now() < deadline) {
    const state = await iframe.evaluate(() => {
      const el = document.getElementById('gateList');
      if (!el) return { phase: 'no-element' };
      const text = el.innerText.replace(/\s+/g, ' ').trim();
      const cards = el.querySelectorAll('.card').length;
      const loading = /Loading gates|Still trying/i.test(text);
      return { phase: loading ? 'loading' : (cards > 0 ? 'gates' : 'resolved-empty'), cards };
    }).catch(() => ({ phase: 'eval-error' }));
    if (state.phase === 'gates' || state.phase === 'resolved-empty') { phase = state.phase; break; }
    await new Promise(r => setTimeout(r, 1000));
  }
  const gates = await iframe.evaluate(() =>
    [...document.querySelectorAll('#gateList .card')].map(card => ({
      deviceId: (card.querySelector('.gate-id')?.textContent || '').trim(),
      latch: !!card.querySelector('.latch-badge'),
      admin: !!card.querySelector('.admin-badge'),
    })).filter(g => g.deviceId)
  ).catch(() => []);
  return { phase, gates };
}

(async () => {
  const rest = createHbRest({ baseUrl: HB_UI_URL, username: USERNAME, password: PASSWORD, pluginName: PLUGIN_NAME });
  let originalConfig = null;
  let browser = null;

  try {
    // ── 0. SETUP: snapshot + wipe config down to token fields ──────────
    await rest.login();
    originalConfig = await rest.getConfig();
    check(!!originalConfig, 'existing plugin config found', originalConfig ? undefined : 'none — is the plugin configured?');
    if (!originalConfig) throw new Error('no plugin config to test against');

    const wiped = stripToTokenFields(originalConfig);
    wiped.platform = wiped.platform || PLUGIN_ALIAS;
    // Credentials may be in the legacy top-level fields or the accounts[] array — accept
    // either. availableAccounts drives the one- vs two-account scenarios in step 7.
    const availableAccounts = extractAccounts(wiped);
    const hasCredentials = availableAccounts.length > 0;
    check(hasCredentials, 'linking credentials present after wipe',
      hasCredentials ? `${availableAccounts.length} account(s)` : 'no token fields or accounts[] — link a device first');
    if (!hasCredentials) throw new Error('config has no linking credentials to preserve');

    // Structural (non-credential) keys reused when re-pointing the config per scenario.
    const structural = {};
    for (const k of ['platform', 'name', '_bridge']) if (wiped[k] !== undefined) structural[k] = wiped[k];

    await rest.setConfig(wiped);
    const afterWipe = await rest.getConfig();
    const wipedClean = afterWipe && afterWipe.accessoryType === undefined &&
      afterWipe.triggerMode === undefined && !Array.isArray(afterWipe.customGates);
    check(wipedClean, 'config wiped to token fields only',
      wipedClean ? undefined : `residual keys: ${Object.keys(afterWipe || {}).join(',')}`);

    // ── 1. LOGIN + open the settings modal ─────────────────────────────
    browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: 'new' });
    const page = await browser.newPage();
    page.on('pageerror', e => pageErrors.push(String(e)));
    // CSP violations surface as console errors, not pageerrors — capture them so a
    // blocked stylesheet/font (e.g. icons loaded from a CDN) fails the run.
    page.on('console', m => { if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) cspErrors.push(m.text().slice(0, 160)); });

    await page.goto(`${HB_UI_URL}/login`, { waitUntil: 'networkidle2', timeout: 20000 });
    await page.type('input[name="username"], input[formcontrolname="username"]', USERNAME);
    await page.type('input[name="password"], input[formcontrolname="password"]', PASSWORD);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
    ]);
    const loggedIn = !page.url().includes('/login');
    check(loggedIn, 'UI login succeeds', page.url());
    if (!loggedIn) throw new Error('login failed');

    let iframe = null;
    try { iframe = await openSettings(page); } catch (err) { check(false, 'plugin settings modal + iframe load', err.message); throw err; }
    check(!!iframe, 'custom UI iframe loads', iframe.url());

    // ── 2. DISCOVER: on-load auto-discovery resolves to gate cards ─────
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
      await sleep(1000);
    }
    check(gateState && gateState.phase === 'gates',
      'auto-discovery finds gates',
      gateState ? `${gateState.phase}: ${gateState.cards ?? 0} card(s) — "${gateState.text}"` : 'no state');
    if (!gateState || gateState.phase !== 'gates') throw new Error('no gates discovered — cannot exercise the config UI');

    // Read the discovered gates (deviceId + latch badge) straight from the cards.
    const gates = await iframe.evaluate(() => {
      // deviceId is its own .gate-id row; admin/latch are muted .admin-badge/.latch-badge
      // spans in the .gate-caps line (no longer coloured header pills).
      return [...document.querySelectorAll('#gateList .card')].map(card => ({
        deviceId: (card.querySelector('.gate-id')?.textContent || '').trim(),
        latch: !!card.querySelector('.latch-badge'),
        admin: !!card.querySelector('.admin-badge'),
      })).filter(g => g.deviceId);
    });
    info(`discovered ${gates.length} gate(s): ${gates.map(g => `${g.deviceId}${g.latch ? '[latch]' : ''}`).join(', ')}`);

    // ── 2a. ICONS: the bundled Font Awesome subset loads and renders ────
    // Guards the CSP regression where icons loaded from a CDN render blank under
    // config-ui-x's style-src/font-src 'self' policy.
    const icons = await iframe.evaluate(async () => {
      if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (_) {} }
      let subsetApplied = false;
      for (const s of document.styleSheets) {
        if ((s.href || '').includes('palgate-icons.css')) { try { subsetApplied = s.cssRules.length > 0; } catch (_) {} }
      }
      const fontLoaded = document.fonts ? [...document.fonts].some(f => f.family.includes('Font Awesome') && f.status === 'loaded') : false;
      const el = document.querySelector('#gateList .fas, #gateList i[class*="fa-"]');
      const width = el ? el.getBoundingClientRect().width : 0;
      // Verify the specific glyphs added to the subset actually render (a dropped glyph
      // in a future subset rebuild would render blank while the generic check stays green).
      const probeGlyph = (cls) => {
        const i = document.createElement('i'); i.className = 'fas ' + cls; document.body.appendChild(i);
        const w = i.getBoundingClientRect().width;
        const content = getComputedStyle(i, '::before').content;
        i.remove();
        return w > 0 && !!content && content !== 'none' && content !== 'normal';
      };
      const faucet = probeGlyph('fa-faucet');
      const circleInfo = probeGlyph('fa-circle-info');
      const ellipsisV = probeGlyph('fa-ellipsis-v');
      return { subsetApplied, fontLoaded, width, faucet, circleInfo, ellipsisV };
    }).catch(e => ({ error: String(e).slice(0, 120) }));
    check(icons.subsetApplied && icons.fontLoaded && icons.width > 0,
      'bundled Font Awesome subset loads and icons render',
      `subsetApplied=${icons.subsetApplied} fontLoaded=${icons.fontLoaded} iconWidth=${icons.width}${icons.error ? ' err=' + icons.error : ''}`);
    check(icons.faucet && icons.circleInfo && icons.ellipsisV,
      'valve (faucet), info (circle-info) and kebab (ellipsis-v) glyphs render from the subset',
      `faucet=${icons.faucet} circleInfo=${icons.circleInfo} ellipsisV=${icons.ellipsisV}`);
    check(cspErrors.length === 0, 'no Content-Security-Policy violations (no CDN assets)',
      cspErrors.length ? cspErrors[0] : undefined);

    // ── 2b. RE-DISCOVER: the manual Discover button repopulates the list ─
    await iframe.evaluate(() => document.getElementById('discoverGates').click());
    let rediscover = null;
    const rdDeadline = Date.now() + GATE_LIST_TIMEOUT_MS;
    while (Date.now() < rdDeadline) {
      rediscover = await iframe.evaluate(() => {
        const el = document.getElementById('gateList');
        const text = el ? el.innerText : '';
        return { cards: el ? el.querySelectorAll('.card').length : 0, loading: /Loading gates|Still trying/i.test(text) };
      }).catch(() => ({ cards: 0, loading: true }));
      if (!rediscover.loading && rediscover.cards > 0) break;
      await sleep(1000);
    }
    check(rediscover && !rediscover.loading && rediscover.cards >= gates.length,
      'manual Discover button repopulates gate list',
      rediscover ? `${rediscover.cards} card(s)${rediscover.loading ? ' (still loading)' : ''}` : 'no state');

    // ── 3. GLOBAL: change Default Settings and assert persistence ──────
    const GLOBAL = {
      accessoryType: 'switch',
      triggerMode: 'stateless',
      gateOpeningDelay: 1234,
      gateCloseDelay: 6789,
      pollInterval: 45,
      relayAccessoryType: 'switch',
    };
    await iframe.evaluate((g) => {
      document.getElementById('defaultSettingsToggle').click();           // expand the section
      const set = (id, val) => { const el = document.getElementById(id); el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      set('globalAccessoryType', g.accessoryType);
      document.getElementById('globalTriggerMode-' + g.triggerMode).checked = true;
      set('globalOpeningDelay', String(g.gateOpeningDelay));
      set('globalCloseDelay', String(g.gateCloseDelay));
      set('globalPollInterval', String(g.pollInterval));
      const relay = document.getElementById('globalEnableRelay');
      if (!relay.checked) { relay.checked = true; relay.dispatchEvent(new Event('change', { bubbles: true })); }
      set('globalRelayType', g.relayAccessoryType);
    }, GLOBAL);
    await iframe.evaluate(() => document.getElementById('saveGlobalDefaults').click());

    let savedGlobal = null;
    try {
      savedGlobal = await rest.waitForConfig(c => c && c.accessoryType === GLOBAL.accessoryType && c.triggerMode === GLOBAL.triggerMode);
    } catch (err) { savedGlobal = err.lastConfig; }
    const globalOk = savedGlobal &&
      savedGlobal.accessoryType === GLOBAL.accessoryType &&
      savedGlobal.triggerMode === GLOBAL.triggerMode &&
      savedGlobal.gateOpeningDelay === GLOBAL.gateOpeningDelay &&
      savedGlobal.gateCloseDelay === GLOBAL.gateCloseDelay &&
      savedGlobal.pollInterval === GLOBAL.pollInterval &&
      savedGlobal.enableRelayLocks === true &&
      savedGlobal.relayAccessoryType === GLOBAL.relayAccessoryType;
    check(globalOk, 'global default settings persist via UI',
      globalOk ? undefined : `got ${JSON.stringify(pick(savedGlobal, Object.keys(GLOBAL).concat('enableRelayLocks')))}`);

    // ── 3b. GLOBAL VALVE DURATION: field appears for Valve type and persists ─
    await iframe.evaluate(() => {
      const relay = document.getElementById('globalEnableRelay');
      if (!relay.checked) { relay.checked = true; relay.dispatchEvent(new Event('change', { bubbles: true })); }
      const t = document.getElementById('globalRelayType'); t.value = 'valve'; t.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const valveFieldVisible = await iframe.evaluate(() => {
      const g = document.getElementById('globalValveDurationGroup');
      return !!g && getComputedStyle(g).display !== 'none';
    });
    check(valveFieldVisible, 'global valve duration field appears when relay type is Valve');
    await iframe.evaluate(() => {
      const el = document.getElementById('globalValveDuration');
      el.value = '180'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('saveGlobalDefaults').click();
    });
    let savedValve = null;
    try { savedValve = await rest.waitForConfig(c => c && c.valveDefaultDuration === 180); } catch (err) { savedValve = err.lastConfig; }
    const valveGlobalOk = savedValve && savedValve.valveDefaultDuration === 180 && savedValve.relayAccessoryType === 'valve';
    check(valveGlobalOk, 'global valveDefaultDuration + valve type persist via UI',
      valveGlobalOk ? undefined : `got vdd=${savedValve && savedValve.valveDefaultDuration} type=${savedValve && savedValve.relayAccessoryType}`);

    // ── 4. PER-GATE: override accessory type + relay, assert persistence ─
    const relayGate = gates.find(g => g.latch);
    const target = relayGate || gates[0];
    const sid = sidOf(target.deviceId);
    info(`configuring gate ${target.deviceId} (sid=${sid})${relayGate ? ' with relay' : ' (no latch gate — type only)'}`);

    // Open the Configure form for the target gate (may run a discovery round on first open).
    const openedForm = await openGateForm(iframe, target.deviceId, sid);
    check(openedForm === 'ok', 'gate Configure form opens and renders', openedForm);

    // Override the accessory type: switch + lock, no garage door.
    const PER_GATE_RELAY = !!relayGate;
    await iframe.evaluate(({ sid, doRelay }) => {
      const customise = document.getElementById('customiseType-' + sid);
      if (customise) customise.click();                 // reveal the type checkboxes (sets typeOverrideEnabled)
      const setCb = (id, val) => { const el = document.getElementById(id); if (el) { el.checked = val; el.dispatchEvent(new Event('change', { bubbles: true })); } };
      setCb('garage-' + sid, false);
      setCb('switch-' + sid, true);
      setCb('lock-' + sid, true);
      if (doRelay) {
        const relay = document.getElementById('relayEnabled-' + sid);
        if (relay && !relay.checked) { relay.checked = true; relay.dispatchEvent(new Event('change', { bubbles: true })); }
        setCb('relayLock-' + sid, true);               // relay-as-lock override
        setCb('relayHoldClosed-' + sid, false);        // suppress the hold-closed direction
      }
    }, { sid, doRelay: PER_GATE_RELAY });

    await clickFormButton(iframe, sid, '.save-custom');

    let savedGate = null;
    try {
      savedGate = await rest.waitForConfig(c => c && Array.isArray(c.customGates) && c.customGates.some(e => e.deviceId === target.deviceId && e.switch === true));
    } catch (err) { savedGate = err.lastConfig; }
    const entry = savedGate && Array.isArray(savedGate.customGates)
      ? savedGate.customGates.find(e => e.deviceId === target.deviceId) : null;
    const typeOk = entry && entry.garageDoor === false && entry.switch === true && entry.lock === true;
    check(typeOk, 'per-gate accessory-type override persists via UI',
      typeOk ? undefined : `entry: ${JSON.stringify(entry)}`);

    if (PER_GATE_RELAY) {
      // Global relay is ON (from step 3), so relayEnabled isn't rewritten per-gate;
      // the meaningful overrides are relayLock:true and relayHoldClosed:false.
      const relayOk = entry && entry.relayLock === true && entry.relayHoldClosed === false;
      check(relayOk, 'per-gate relay override persists via UI',
        relayOk ? undefined : `entry: ${JSON.stringify(entry)}`);
    } else {
      info('no latch-permitted gate discovered — skipped relay override assertion');
    }

    // ── 4c. NEW UI: reorder, "(global default)" tags, admin gating, valve duration ─
    const reopened = await openGateForm(iframe, target.deviceId, sid);
    if (reopened === 'ok') {
      const ui = await iframe.evaluate((sid) => {
        const anchor = document.getElementById('enable-' + sid);
        const form = anchor && anchor.closest('.gate-expand-form');
        const html = form ? form.innerHTML : '';
        return {
          relayBeforeExternal: html.indexOf('External Opens') > -1 && html.indexOf('Relay Mode') > -1 &&
            html.indexOf('Relay Mode') < html.indexOf('External Opens'),
          detectToggle: !!document.getElementById('detectExternal-' + sid),
          detectTag: !!document.getElementById('detectExternalTag-' + sid),
          relayTag: !!document.getElementById('relayEnabledTag-' + sid),
        };
      }, sid);
      check(ui.relayBeforeExternal, 'Relay Mode section is ordered above External Opens');
      if (target.admin) {
        check(ui.detectToggle && ui.detectTag,
          'admin gate exposes External Opens toggle + "(global default)" tag',
          `toggle=${ui.detectToggle} tag=${ui.detectTag}`);
      }
      if (target.latch) {
        check(ui.relayTag, 'relay enable has a "(global default)" tag');
        // Per-gate valve duration: appears when Relay as Valve is checked; persists on save.
        await iframe.evaluate((sid) => {
          const relay = document.getElementById('relayEnabled-' + sid);
          if (relay && !relay.checked) { relay.checked = true; relay.dispatchEvent(new Event('change', { bubbles: true })); }
          const valve = document.getElementById('relayValve-' + sid);
          if (valve) { valve.checked = true; valve.dispatchEvent(new Event('change', { bubbles: true })); }
        }, sid);
        const valveRowShown = await iframe.evaluate((sid) => {
          const r = document.getElementById('valveDurationRow-' + sid);
          return !!r && !r.classList.contains('d-none');
        }, sid);
        check(valveRowShown, 'per-gate valve duration row appears when Relay as Valve is checked');
        await iframe.evaluate((sid) => {
          const el = document.getElementById('valveDuration-' + sid);
          if (el) { el.value = '240'; el.dispatchEvent(new Event('input', { bubbles: true })); }
        }, sid);
        await clickFormButton(iframe, sid, '.save-custom');
        let savedVd = null;
        try {
          savedVd = await rest.waitForConfig(c => c && Array.isArray(c.customGates) &&
            c.customGates.some(e => e.deviceId === target.deviceId && e.valveDefaultDuration === 240));
        } catch (err) { savedVd = err.lastConfig; }
        const vdEntry = savedVd && Array.isArray(savedVd.customGates)
          ? savedVd.customGates.find(e => e.deviceId === target.deviceId) : null;
        check(vdEntry && vdEntry.valveDefaultDuration === 240, 'per-gate valve duration persists via UI',
          vdEntry ? JSON.stringify(vdEntry) : 'no entry');
      }
    }

    // ── 4d. NON-ADMIN: External Opens shows the admin-locked note + tooltip ─
    const nonAdminGate = gates.find(g => !g.admin);
    if (nonAdminGate) {
      const nsid = sidOf(nonAdminGate.deviceId);
      const openedNa = await openGateForm(iframe, nonAdminGate.deviceId, nsid);
      if (openedNa === 'ok') {
        const na = await iframe.evaluate((sid) => {
          const anchor = document.getElementById('enable-' + sid);
          const form = anchor && anchor.closest('.gate-expand-form');
          const html = form ? form.innerHTML : '';
          return {
            toggle: !!document.getElementById('detectExternal-' + sid),
            lockedMsg: /Admin access to the gate is required to detect external opens/.test(html),
            tip: !!(form && form.querySelector('.pg-tip[data-tip*="Assign Admin"]')),
          };
        }, nsid);
        check(na.lockedMsg && !na.toggle && na.tip,
          'non-admin gate shows External Opens locked note + "Ask an admin" tooltip',
          `locked=${na.lockedMsg} toggle=${na.toggle} tip=${na.tip}`);
      }
    } else {
      info('all discovered gates are admin — skipped non-admin locked-note assertion');
    }

    // ── 4b. HIDE: disable a gate in HomeKit; assert hide:true persists ──
    const hideGate = gates.find(g => g.deviceId !== target.deviceId);
    if (hideGate) {
      const hsid = sidOf(hideGate.deviceId);
      info(`hiding gate ${hideGate.deviceId} (sid=${hsid})`);
      const openedHide = await openGateForm(iframe, hideGate.deviceId, hsid);
      check(openedHide === 'ok', 'hide-gate Configure form opens', openedHide);
      await iframe.evaluate((sid) => {
        const en = document.getElementById('enable-' + sid);
        if (en && en.checked) { en.checked = false; en.dispatchEvent(new Event('change', { bubbles: true })); }
      }, hsid);
      await clickFormButton(iframe, hsid, '.save-custom');

      let savedHide = null;
      try {
        savedHide = await rest.waitForConfig(c => c && Array.isArray(c.customGates) && c.customGates.some(e => e.deviceId === hideGate.deviceId && e.hide === true));
      } catch (err) { savedHide = err.lastConfig; }
      const hideEntry = savedHide && Array.isArray(savedHide.customGates)
        ? savedHide.customGates.find(e => e.deviceId === hideGate.deviceId) : null;
      const hideOk = hideEntry && hideEntry.hide === true;
      check(hideOk, 'gate hide persists via UI', hideOk ? undefined : `entry: ${JSON.stringify(hideEntry)}`);
    } else {
      info('only one gate discovered — skipped hide-gate test');
    }

    // ── 5. RESTART: verify the plugin actually applies the saved config ─
    // Opt-in (E2E_RESTART): restarts the live Homebridge, so it costs two
    // restarts (here + the restore in finally) and briefly interrupts real gates.
    if (DO_RESTART) {
      info('E2E_RESTART set — restarting Homebridge to verify config is applied…');
      await rest.truncateLog().catch(() => info('log truncate unsupported on this setup — scanning full log'));
      await rest.restart();
      await sleep(3000); // let it drop out of 'up' before we start polling
      let up = false;
      try { up = await rest.waitForHomebridgeUp(); } catch (err) { info(err.message); }
      check(up, 'Homebridge restarts and returns to up');

      // After boot, the plugin runs discovery then logs its configured accessories.
      // Poll the log until that line appears (discovery hits the real PalGate API).
      let logText = '';
      let confLine = '';
      const logDeadline = Date.now() + 60000;
      while (Date.now() < logDeadline) {
        logText = await rest.downloadLog().catch(() => '');
        confLine = (logText.split('\n').reverse().find(l => l.includes('Configured gate accessory(ies)')) || '');
        if (confLine) break;
        await sleep(3000);
      }
      check(!!confLine, 'plugin re-registers accessories after restart',
        confLine ? undefined : 'no "Configured gate accessory(ies)" log line within 60s');

      // The per-gate override (switch + lock) must survive a real restart.
      const hasSwitch = confLine.includes(`[switch] (ID: ${target.deviceId})`);
      const hasLock = confLine.includes(`[lock] (ID: ${target.deviceId})`);
      check(hasSwitch && hasLock, 'per-gate type override applied after restart (switch + lock)',
        hasSwitch && hasLock ? undefined : `line: ${confLine.slice(0, 240)}`);

      // The gate we hid in step 4b must NOT be registered after restart.
      if (hideGate) {
        const hiddenAbsent = !confLine.includes(`(ID: ${hideGate.deviceId})`);
        check(hiddenAbsent, 'hidden gate is not registered after restart',
          hiddenAbsent ? undefined : `line: ${confLine.slice(0, 240)}`);
      }

      // No plugin-level config/startup errors in the fresh boot.
      const pluginErrors = logText.split('\n').filter(l =>
        /PalGate/i.test(l) && /Missing required configuration|Failed to generate temporal token|discovery failed: PalGate rejected/i.test(l));
      check(pluginErrors.length === 0, 'no plugin config errors in restart log',
        pluginErrors.length ? pluginErrors[0].slice(0, 200) : undefined);
    } else {
      info('E2E_RESTART not set — skipping restart verification (set E2E_RESTART=1 to enable)');
    }

    // ── 6. RESET: "Reset all" removes the gate's override entirely ──────
    // Runs last: it deletes the override the restart step verifies. Asserts the
    // customGates entry is gone, not left as a hollow { deviceId }.
    const openedReset = await openGateForm(iframe, target.deviceId, sid);
    check(openedReset === 'ok', 'reset Configure form opens', openedReset);
    await clickFormButton(iframe, sid, '.reset-custom');

    let afterReset = null;
    try {
      afterReset = await rest.waitForConfig(c => c &&
        (!Array.isArray(c.customGates) || !c.customGates.some(e => e.deviceId === target.deviceId)));
    } catch (err) { afterReset = err.lastConfig; }
    const residual = afterReset && Array.isArray(afterReset.customGates)
      ? afterReset.customGates.find(e => e.deviceId === target.deviceId) : null;
    check(!residual, 'per-gate "Reset all" removes the override (no hollow entry)',
      residual ? `residual entry: ${JSON.stringify(residual)}` : undefined);

    // ── 7. ACCOUNTS: one-account and two-account scenarios ─────────────
    // Re-point the config at N accounts (as an accounts[] array), reload the settings UI,
    // and assert the accounts section + per-gate affiliation labels for that count. The
    // two-account pass runs only when a second account is actually linked.
    const scenarios = [{ name: 'one account', n: 1 }];
    if (availableAccounts.length >= 2) scenarios.push({ name: 'two accounts', n: 2 });
    else info(`only ${availableAccounts.length} account linked — skipping the two-account pass (link a second to cover it)`);

    const gateCountByScenario = {};
    for (const scenario of scenarios) {
      const accts = availableAccounts.slice(0, scenario.n).map((a, i) => ({
        label: a.label || `Account ${i + 1}`,
        token: a.token, phoneNumber: a.phoneNumber, tokenType: a.tokenType,
      }));
      await rest.setConfig(Object.assign({}, structural, { accounts: accts }));
      const scenIframe = await openSettings(page);
      const { phase, gates: scenGates } = await waitForGates(scenIframe, GATE_LIST_TIMEOUT_MS);
      gateCountByScenario[scenario.n] = scenGates.length;

      const ui = await scenIframe.evaluate((n) => {
        const list = document.getElementById('accountList');
        const kebabs = list ? list.querySelectorAll('[data-kebab]') : [];
        const relink = list ? [...list.querySelectorAll('[data-relink]')] : [];
        const remove = list ? [...list.querySelectorAll('[data-remove]')] : [];
        const addArea = document.getElementById('addAccountArea');
        const countEl = document.getElementById('accountCount');
        return {
          cards: list ? list.querySelectorAll('.card').length : 0,
          kebabs: kebabs.length,
          relink: relink.length,
          remove: remove.length,
          removeDanger: remove.length > 0 && remove.every(b => b.classList.contains('pg-menu-danger')),
          addVisible: !!addArea && !addArea.classList.contains('d-none'),
          countText: countEl ? countEl.textContent.trim() : '',
          countVisible: !!countEl && !countEl.classList.contains('d-none'),
          affiliation: !!document.querySelector('#gateList .card i.fa-link'),
        };
      }, scenario.n);

      const expectedCount = `${scenario.n} account${scenario.n === 1 ? '' : 's'}`;
      check(ui.cards === scenario.n && ui.kebabs === scenario.n && ui.countVisible && ui.countText === expectedCount,
        `[${scenario.name}] accounts section renders ${scenario.n} card(s) + "${expectedCount}" count`,
        `cards=${ui.cards} kebabs=${ui.kebabs} count="${ui.countText}"`);
      check(ui.relink === scenario.n && ui.remove === scenario.n && ui.removeDanger,
        `[${scenario.name}] each account's kebab menu has Re-link + a red Remove`,
        `relink=${ui.relink} remove=${ui.remove} removeDanger=${ui.removeDanger}`);
      check(ui.addVisible, `[${scenario.name}] "Add Account" button is available`);
      check(phase === 'gates',
        `[${scenario.name}] discovery resolves to gate cards`,
        `phase=${phase} gates=${scenGates.length}`);
      // Affiliation labels are shown only when more than one account is linked.
      const affiliationOk = scenario.n > 1 ? ui.affiliation : !ui.affiliation;
      check(affiliationOk,
        `[${scenario.name}] gate cards ${scenario.n > 1 ? 'show' : 'omit'} account affiliation labels`,
        `affiliation=${ui.affiliation}`);
    }

    // Two accounts should surface at least as many gates as one (the union of both).
    if (gateCountByScenario[2] !== undefined) {
      check(gateCountByScenario[2] >= gateCountByScenario[1],
        'two-account discovery surfaces at least as many gates as one account',
        `one=${gateCountByScenario[1]} two=${gateCountByScenario[2]}`);
    }

    // ── final: no page errors anywhere ────────────────────────────────
    // Known-benign: config-ui-x's own SDK throws a DataCloneError when
    // savePluginConfig() posts its un-awaited Promise into postMessage — it fires
    // in the parent frame on every save yet the write still persists server-side
    // (see the resolved save-hang investigation). Filter it so a *real* iframe
    // error — the TDZ-class bug this harness exists to catch — still fails.
    const isConfigUiSaveBug = e =>
      /DataCloneError/.test(e) && /postMessage/.test(e) && /could not be cloned/.test(e);
    const ignored = pageErrors.filter(isConfigUiSaveBug);
    const realErrors = pageErrors.filter(e => !isConfigUiSaveBug(e));
    if (ignored.length) info(`ignored ${ignored.length} known config-ui-x savePluginConfig DataCloneError(s)`);
    check(realErrors.length === 0, 'no uncaught page errors in any frame',
      realErrors.length ? realErrors.join(' | ').slice(0, 300) : undefined);

  } catch (err) {
    if (!failures.length) failures.push('aborted: ' + err.message);
    console.error(ts(), 'aborted:', err.message);
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Restore the user's original config so their real Homebridge is untouched.
    if (originalConfig && !process.env.KEEP_WIPED) {
      try {
        await rest.setConfig(originalConfig);
        info('original config restored');
        // If we restarted the live bridge, it's running the TEST config in memory —
        // restart once more so it reloads the restored original config on disk.
        if (DO_RESTART) {
          info('restarting Homebridge onto the restored config…');
          await rest.restart();
          await sleep(3000);
          await rest.waitForHomebridgeUp().then(() => info('Homebridge back up on original config'))
            .catch(err => console.error(ts(), 'WARNING:', err.message, '— restart manually to reload your config'));
        }
      } catch (err) {
        console.error(ts(), 'WARNING: failed to restore original config —', err.message);
        console.error(ts(), 'your plugin config may be wiped to token fields; re-save from the UI or restore a backup.');
      }
    } else if (process.env.KEEP_WIPED) {
      info('KEEP_WIPED set — leaving wiped config in place');
    }
  }

  console.log(`\n${failures.length === 0 ? '✓ e2e passed' : '✗ e2e FAILED'}${failures.length ? ':\n  - ' + failures.join('\n  - ') : ''}`);
  process.exit(failures.length === 0 ? 0 : 1);
})();

function pick(obj, keys) {
  const out = {};
  if (obj) for (const k of keys) out[k] = obj[k];
  return out;
}
