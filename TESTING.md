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

### 2. UI-server integration — `test/ui-server/` (hermetic, CI)

Forks `homebridge-ui/server.js` over IPC exactly the way homebridge-config-ui-x
does and exercises the request/response protocol: ready handshake, unknown
routes, `/devices/discover` credential validation, `/link/init` QR generation,
`/link/confirm` session handling, concurrent request isolation. No PalGate
network calls are made.

### 3. End-to-end UI — `test/e2e/plugin-ui.e2e.js` (local only)

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

Planned next layers, roughly in value order:

1. **API-layer tests with a stub PalGate server** — make `BASE_URL` in
   `lib/utils/constants.js` overridable via environment variable, then test
   `lib/api.js` retry/timeout/error-mapping behaviour (429 vs 5xx vs network
   errors, `callApiOnce` vs `callApi` retry budgets) against a local HTTP stub.
2. **Platform tests** — instantiate `PalGatePlatform` with a mocked Homebridge
   API and the stub PalGate server: accessory registration/removal, multi-output
   `deviceId:outputNum` stability (orphaning regressions), `_resolveRelayFlags`
   per-gate/global precedence, relay state polling transitions.
3. **Mock-PalGate e2e mode** — teach the e2e harness to point a linked test
   config at the stub server so the full UI flow (including discovery contents
   and the Configure form) is assertable without a real PalGate account, and can
   eventually run in CI with Homebridge in a container.
4. **UI form regression tests** — extend the e2e harness to exercise the
   Configure form: per-gate overrides persist as real overrides only, relay
   controls appear for latch-permitted gates, save round-trips through
   `updatePluginConfig` without clobbering manual edits.
