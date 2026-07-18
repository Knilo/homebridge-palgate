# Testing

## Running

```bash
npm test                              # unit + UI-server tests (hermetic, run in CI)
HB_UI_PASSWORD=<pw> npm run test:e2e  # end-to-end UI test (local only)
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
function, and the `device/{id}/` response-envelope unwrapping (regression for
the poller bug where latch fields were read off the wrapper).

### 3. Platform — `test/platform/` (hermetic, CI)

Instantiates the real `PalGatePlatform` with a mock Homebridge API
(`test/helpers/mock-homebridge.js`) and the stub PalGate server:

- **`platform.test.js`** — accessory lifecycle: discovery/registration for all
  accessory types, multi-output `deviceId:outputNum` stability, customGates
  hide/rename/type overrides, custom-only gates, relay flag precedence
  (global vs per-gate opt-in/opt-out), cached-accessory restore, stale pruning,
  rename recreation, 4xx discovery fail-fast.
- **`handlers.test.js`** — HomeKit set-handler behaviour: garage door
  OPENING→OPEN→CLOSED cycle, API-failure error propagation, stateful vs
  stateless trigger modes, multi-output routing, hold-open lock latch/release
  API params and companion-lock syncing.
- **`poller-and-types.test.js`** — switch/lock accessory trigger + auto-reset
  behaviour, and `syncLockStates` poller sync (external latch changes reflect
  into HomeKit; fresh writes aren't clobbered).

### 4. UI-server integration — `test/ui-server/` (hermetic, CI)

Forks `homebridge-ui/server.js` over IPC exactly the way homebridge-config-ui-x
does and exercises the request/response protocol: ready handshake, unknown
routes, `/devices/discover` credential validation, `/link/init` QR generation,
`/link/confirm` session handling, concurrent request isolation. No PalGate
network calls are made.

### 5. End-to-end UI — `test/e2e/plugin-ui.e2e.js` (local only)

Drives the real settings UI in headless Chrome (`puppeteer-core`, uses the
system Chrome) against a running Homebridge: logs in, opens the plugin's
settings modal, and asserts that the custom UI iframe loads, the gate list
resolves out of its loading state, and **no uncaught page errors occur in any
frame**. Script errors inside the settings iframe are invisible in Homebridge
logs — this harness exists because exactly such an error (a TDZ
`ReferenceError` that killed on-load gate discovery) could only be caught this
way.

Needs: running Homebridge + config-ui-x with this plugin linked, Chrome, and
`HB_UI_PASSWORD` (see the file header for all environment variables).

## Roadmap (not yet implemented)

1. **Mock-PalGate e2e mode** — teach the e2e harness to point a linked test
   config at the stub server so the full UI flow (including discovery contents
   and the Configure form) is assertable without a real PalGate account, and can
   eventually run in CI with Homebridge in a container.
2. **UI form regression tests** — extend the e2e harness to exercise the
   Configure form: per-gate overrides persist as real overrides only, relay
   controls appear for latch-permitted gates, save round-trips through
   `updatePluginConfig` without clobbering manual edits.
3. **Remaining platform coverage** — restart-resume timer paths (mid-cycle
   door/switch/lock state restoration), hold-closed handlers, `validateToken`
   fallback in `openGateForAccessory`, and the poller's interval body (currently
   only `syncLockStates` is tested directly).
