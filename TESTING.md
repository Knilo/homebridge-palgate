# Testing

## Running

```bash
npm test                                       # unit + UI-server tests (hermetic, run in CI)
HB_UI_PASSWORD=<pw> npm run test:e2e           # end-to-end UI test (local only)
HB_UI_PASSWORD=<pw> npm run test:e2e:restart   # e2e + restart-and-verify-from-logs (restarts the live bridge)
```

CI runs `npm test` on Node 20/22/24 for every push and PR (`.github/workflows/test.yml`).

## Layers

### 1. Unit tests — `test/unit/` (hermetic, CI)

Pure-logic tests with Node's built-in `node:test` runner, no network:

- **`token-gen.test.js`** — golden vectors for the temporal token algorithm with a
  fixed synthetic session token and timestamp. Locks the crypto pipeline
  (token-gen → aes → helpers) against regressions; any behavioural change fails these.
- **`aes.test.js`** — the custom AES-128 block implementation is compared against
  Node's native `crypto` on fixed and random vectors.
- **`helpers.test.js`** — `splitDeviceId`, `detectMultiOutputDevices` (including the
  relay-hold `outputNDisabled` trap), `generateGateEntries`, byte packing.

### 2. API layer — `test/api/` (hermetic, CI)

Tests `lib/api.js` against a programmable local stub of the PalGate HTTP API
(`test/helpers/stub-palgate.js`, enabled by the `PALGATE_API_BASE_URL`
override): retry-on-5xx, fail-fast-on-4xx, network-error retries, timeout
handling, retry-budget exhaustion, endpoint/query construction for every API
function, and the response-envelope unwrapping for both `device/{id}/` and
`user/log` (regression for the poller bug where fields were read off the wrapper;
`getDeviceLog`/`getDeviceLogOnce` unwrap `{log,...}`, return `[]` when absent, and
build the `?id=` param).

### 3. Platform — `test/platform/` (hermetic, CI)

Instantiates the real `PalGatePlatform` with a mock Homebridge API
(`test/helpers/mock-homebridge.js`) and the stub PalGate server:

- **`platform.test.js`** — accessory lifecycle: discovery/registration for all
  accessory types, the API `data.devices` array expanding into per-output
  accessories and rejecting a malformed array (PR #15), multi-output
  `deviceId:outputNum` stability, customGates hide/rename/type overrides,
  custom-only gates, relay flag precedence (global vs per-gate opt-in/opt-out),
  cached-accessory restore, stale pruning, rename recreation, 4xx discovery
  fail-fast.
- **`handlers.test.js`** — HomeKit set-handler behaviour: garage door
  OPENING→OPEN→CLOSED cycle, API-failure error propagation, stateful vs
  stateless trigger modes, multi-output routing, hold-open lock latch/release
  API params and companion-lock syncing.
- **`timers.test.js`** — fake-timer (`node:test` mock timers) tests for the
  time-driven paths: `setupGarageDoorHandlers`' restart-resume block (resuming a
  mid-cycle door animation from persisted expiry timestamps — opening /
  already-open / expired branches) and `syncPrimaryAccessories`' companion
  animation timers (a gate exposed as several types at once animates and resets
  its companions; momentary/all-zero no-ops; mid-cycle retrigger cancels the
  stale timer).
- **`poller-and-types.test.js`** — switch/lock accessory trigger + auto-reset
  behaviour, and `syncLockStates` poller sync (external latch changes reflect
  into HomeKit; fresh writes aren't clobbered).
- **`external-opens.test.js`** — Feature 1 (external-open detection): high-water
  mark (stale log entries don't animate), self-dedupe (own userId inside ±30s is
  skipped, outside the window animates), multi-output `Output 2` → `:2` routing,
  animation fires with **no** open-API call, unknown `type` still animates and
  logs the raw number, backoff doubling/reset/5-min cap, and detection
  enable/disable + per-gate override gating of the log poller.
- **`valve.test.js`** — Feature 2 (valve relay accessories): both directions are
  created for `relayAccessoryType: "valve"`; activate writes latch params + sets
  Active/InUse and counts `RemainingDuration` down; expiry writes normal mode +
  Inactive; `SetDuration=0` is an indefinite hold with no countdown; manual off
  cancels the timer; activating one direction cancels the other's countdown; the
  poller doesn't revert an active countdown but does sync an external latch change
  when idle; restart mid-countdown releases to normal; per-gate `relayValve`
  overrides the global relay type.

### 4. UI-server integration — `test/ui-server/` (hermetic, CI)

Forks `homebridge-ui/server.js` over IPC exactly the way homebridge-config-ui-x
does and exercises the request/response protocol: ready handshake, unknown
routes, `/devices/discover` credential validation, `/link/init` QR generation,
`/link/confirm` session handling, concurrent request isolation. No PalGate
network calls are made.

### 5. End-to-end UI — `test/e2e/plugin-ui.e2e.js` (local only)

Drives the real settings UI in headless Chrome (`puppeteer-core`, uses the
system Chrome) against a running Homebridge, exercising the full configuration
flow and asserting each action **persists** — verified by reading the saved
config back through the config-ui-x REST API (`test/helpers/hb-rest.js`), not
by scraping logs:

0. **Setup** — snapshots the current plugin config, then wipes it down to the
   token/linking fields (`token`, `phoneNumber`, `tokenType` + structural keys)
   via REST, so the run starts from a known-clean baseline. The original config
   is **restored at the end** (in `finally`), so a real Homebridge is left
   exactly as it was. `KEEP_WIPED=1` skips the restore for debugging.
1. **Login** — UI login succeeds; the settings modal and custom iframe load.
2. **Discovery** — on-load auto-discovery resolves to real gate cards (≥1);
   the harness reads back each gate's deviceId and latch permission, then clicks
   the manual **Discover** button and asserts the list repopulates.
   It also asserts the **bundled Font Awesome subset** loaded and icons render,
   and that **no CSP violations** occurred (guards the regression where icons
   loaded from a CDN render blank under config-ui-x's `style-src`/`font-src`
   `'self'` policy — see "Bundled icons" below).
3. **Global settings** — drives the Default Settings form (accessory type,
   trigger mode, opening/close delays, poll interval, relay enable + type),
   Saves, and asserts every value landed in the config.
4. **Per-gate overrides** — opens a gate's Configure form, overrides its
   accessory type (switch + lock, no garage), and — for a latch-permitted gate
   — its relay (relay-as-lock, hold-closed suppressed), Saves, and asserts the
   `customGates` entry persisted with only the real overrides. Then it **hides**
   a second gate (Enable in HomeKit → off) and asserts `hide:true` persists.
5. **Restart verification** (opt-in, `E2E_RESTART=1` / `npm run test:e2e:restart`)
   — truncates the log, restarts the live Homebridge via REST, waits for it to
   return to `up`, then reads the plugin's boot log and asserts the saved config
   is actually applied: the overridden gate re-registers as `[switch]` +
   `[lock]`, the gate hidden in step 4 is **not** registered, and no plugin
   config errors appear. Because this runs the *live* bridge on the test config,
   the `finally` block restores the original config **and restarts again** so the
   bridge ends on your real config. Costs two restarts and briefly interrupts
   real gates — hence opt-in.
6. **Reset** — clicks a gate's "Reset all" and asserts its `customGates` entry
   is removed entirely, not left as a hollow `{ deviceId }`.

The `DataCloneError` that config-ui-x's own SDK throws from `savePluginConfig`
(an un-awaited Promise posted into `postMessage`; the write still persists) is
filtered by its exact signature, so a *real* iframe error still fails the run.

Throughout, it fails on **any uncaught page error in any frame**. Script errors
inside the settings iframe are invisible in Homebridge logs — this harness
exists because exactly such an error (a TDZ `ReferenceError` that killed on-load
gate discovery) could only be caught this way.

Needs: running Homebridge + config-ui-x with this plugin **linked to a real
PalGate account** (the discovery/per-gate steps need real gates), Chrome, and
`HB_UI_PASSWORD` (see the file header for all environment variables).

## Bundled icons

The settings UI ships a **self-hosted Font Awesome 6.5.1 (Free, Solid) subset**
in `homebridge-ui/public/fontawesome/` — only the ~26 glyphs the UI uses (~3KB
woff2 + ~2KB CSS) instead of the ~156KB full face. It's bundled rather than
CDN-loaded because config-ui-x's CSP (`style-src 'self'`; `font-src 'self' data:`)
blocks external stylesheets/fonts, which silently blanked the icons.

To regenerate after changing the icon set (needs `fonttools` + `brotli`):

```bash
# 1. grep the distinct `fa-*` glyphs used in homebridge-ui/public/index.html
# 2. map each to its Unicode codepoint from Font Awesome's fontawesome.css
# 3. subset the full solid woff2 to those codepoints:
pyftsubset fa-solid-900.woff2 --unicodes=<U+xxxx,...> --flavor=woff2 \
  --output-file=homebridge-ui/public/fontawesome/fa-solid-900-subset.woff2
# 4. add any new `.fa-<name>::before{content:"\xxxx"}` rules to palgate-icons.css
```

The e2e (layer 5) asserts the subset loads, icons render, and no CSP violation
occurs, so a regression here fails CI-style checks.

## Roadmap (not yet implemented)

1. **Mock-PalGate e2e mode** — teach the e2e harness to point a linked test
   config at the stub server so the full UI flow (including discovery contents
   and the Configure form) is assertable without a real PalGate account, and can
   eventually run in CI with Homebridge in a container. (The form-exercising and
   config read-back plumbing now exists in layer 5; this item is only about
   removing the real-account dependency.)
2. **Remaining platform coverage** — the garage-door restart-resume and
   companion-animation timer paths are covered (`timers.test.js`), and the
   external-open + valve paths are covered (`external-opens.test.js`,
   `valve.test.js`); still open: switch/lock restart-resume, hold-closed relay
   handlers, `validateToken` fallback in `openGateForAccessory`, and both pollers'
   `setTimeout`/`setInterval` interval bodies (currently `syncLockStates` and
   `_pollExternalOpens`/`_processLogEntries` are tested directly, not via the
   scheduled tick).
