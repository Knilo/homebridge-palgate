const { callApi, callApiOnce, getDevices } = require('../lib/api.js');
const { generateToken } = require('../lib/token-gen.js');
const { detectMultiOutputDevices, generateGateEntries, splitDeviceId } = require('../lib/utils/helpers.js');

// Link sessions expire after 6 minutes — slightly longer than the 5-minute client timeout
// so a completed scan is never lost before the client picks it up.
const SESSION_TTL_MS = 6 * 60 * 1000;

(async () => {
  const { HomebridgePluginUiServer } = await import('@homebridge/plugin-ui-utils');
  const qrcodeModule = await import('qrcode');
  const qrcode = qrcodeModule.default;
  const { v4: uuidv4 } = await import('uuid');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();

      // In-memory store for ongoing link sessions.
      // Maps uniqueId => { done, phoneNumber, sessionToken, tokenType, createdAt }
      this.linkSessions = {};

      // Prune sessions older than SESSION_TTL_MS to prevent unbounded memory growth.
      setInterval(() => {
        const now = Date.now();
        for (const id of Object.keys(this.linkSessions)) {
          if (now - this.linkSessions[id].createdAt > SESSION_TTL_MS) {
            delete this.linkSessions[id];
          }
        }
      }, 60 * 1000);

      // Register endpoints:
      this.onRequest('/link/init', this.initLinkDevice.bind(this));
      this.onRequest('/link/confirm', this.confirmLinkDevice.bind(this));
      this.onRequest('/devices/discover', this.discoverDevices.bind(this));

      // Signal that the UI is ready.
      this.ready();
    }

    /**
     * Step 1: /link/init
     * Generates a uniqueId and returns a QR code. We do NOT call the PalGate API here,
     * because we must wait for the user to scan the code in the PalGate app.
     */
    async initLinkDevice() {
      try {
        const uniqueId = uuidv4();
        const qrData = JSON.stringify({ id: uniqueId });
        const qrCodeDataURI = await qrcode.toDataURL(qrData, { errorCorrectionLevel: 'H' });

        this.linkSessions[uniqueId] = {
          done: false,
          phoneNumber: null,
          sessionToken: null,
          tokenType: null,
          createdAt: Date.now(),
        };

        return { success: true, uniqueId, qrCode: qrCodeDataURI };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }

    /**
     * Step 2: /link/confirm
     * Polls whether the user has scanned the QR code.
     * Returns { waiting: true } while pending, { success: true, ... } on completion,
     * or { success: false, error } only for permanent failures (bad uniqueId).
     *
     * On success the session is marked done and its result cached rather than deleted
     * immediately, so a retried poll (e.g. after a transient network error) can still
     * retrieve the credentials instead of seeing "session not found".
     */
    async confirmLinkDevice(payload) {
      const { uniqueId } = payload;
      if (!uniqueId) {
        return { success: false, error: 'No uniqueId provided.' };
      }

      const session = this.linkSessions[uniqueId];
      if (!session) {
        return { success: false, error: 'Link session not found. Please start the QR flow again.' };
      }

      // Already completed — return cached result so retried polls don't lose credentials.
      if (session.done) {
        return {
          success: true,
          phoneNumber: session.phoneNumber,
          sessionToken: session.sessionToken,
          tokenType: session.tokenType,
        };
      }

      try {
        // Use callApiOnce (no retries) — the client's poll loop handles retry cadence.
        // Retrying inside callApi while the client also polls compounds requests fast
        // enough to trigger PalGate's rate limiter (429).
        const apiResponse = await callApiOnce(`un/secondary/init/${uniqueId}`, '');

        // User hasn't scanned yet.
        if (!apiResponse.user || !apiResponse.secondary) {
          return { success: false, waiting: true };
        }

        // Scan complete — cache result on the session so retried polls can recover it.
        const tokenType = parseInt(apiResponse.secondary, 10);
        session.done = true;
        session.phoneNumber = apiResponse.user.id;
        session.sessionToken = apiResponse.user.token;
        session.tokenType = tokenType;

        return {
          success: true,
          phoneNumber: session.phoneNumber,
          sessionToken: session.sessionToken,
          tokenType: session.tokenType,
        };
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('429')) {
          return { success: false, error: 'Rate limited by PalGate. Please wait a moment before trying again.' };
        }
        // Other transient errors (network, timeout, 5xx): keep the poll alive
        return { success: false, waiting: true };
      }
    }

    /**
     * Discover gates using saved credentials.
     */
    async discoverDevices(payload = {}) {
      try {
        const { token, phoneNumber, tokenType } = payload;
        if (!token || !phoneNumber || tokenType === undefined || tokenType === null) {
          throw new Error('Missing credentials for discovery.');
        }

        const temporalToken = generateToken(
          Buffer.from(token, 'hex'),
          parseInt(phoneNumber, 10),
          parseInt(tokenType, 10)
        );

        const response = await getDevices(temporalToken);
        const devices = Array.isArray(response.devices) ? response.devices : [];

        const gates = devices.flatMap((deviceData) => {
          const deviceId = deviceData.id || deviceData._id;
          if (!deviceId) {
            return [];
          }
          const defaultName = deviceData.name1 || deviceData.name || deviceId;
          const outputs = detectMultiOutputDevices(deviceData);
          const gateEntries = generateGateEntries(deviceId, outputs, defaultName, deviceData);
          return gateEntries.map(entry => {
            const { outputNum } = splitDeviceId(entry.deviceId);
            const isLatchPermitted = outputNum === 2 ? deviceData.output2Latch === true : deviceData.output1Latch === true;
            return {
              deviceId: entry.deviceId,
              defaultName: entry.name,
              admin: deviceData.admin === true,
              latch: isLatchPermitted === true
            };
          });
        });

        return { success: true, gates };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }
  }

  new UiServer();
})();
