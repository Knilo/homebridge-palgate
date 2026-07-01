const { callApi, callApiOnce, getDevices } = require('../lib/api.js');
const { generateToken } = require('../lib/token-gen.js');
const { detectMultiOutputDevices, generateGateEntries, splitDeviceId } = require('../lib/utils/helpers.js');

(async () => {
  const { HomebridgePluginUiServer } = await import('@homebridge/plugin-ui-utils');
  const qrcodeModule = await import('qrcode');
  const qrcode = qrcodeModule.default;
  const { v4: uuidv4 } = await import('uuid');

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();

      // In-memory store for ongoing link sessions.
      // Maps uniqueId => { done, phoneNumber, sessionToken, tokenType }
      this.linkSessions = {};

      // Register endpoints:
      this.onRequest('/link/init', this.initLinkDevice.bind(this));
      this.onRequest('/link/confirm', this.confirmLinkDevice.bind(this));
      this.onRequest('/devices/discover', this.discoverDevices.bind(this));
      this.onRequest('/gate-meta', this.getGateMeta.bind(this));

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
        // Generate a unique ID.
        const uniqueId = uuidv4();

        // Encode { id: uniqueId } into a QR code.
        const qrData = JSON.stringify({ id: uniqueId });
        const qrCodeDataURI = await qrcode.toDataURL(qrData, { errorCorrectionLevel: 'H' });

        // Store a session record so we can poll for completion later.
        this.linkSessions[uniqueId] = {
          done: false,
          phoneNumber: null,
          sessionToken: null,
          tokenType: null,
        };

        return {
          success: true,
          uniqueId,
          qrCode: qrCodeDataURI,
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
        };
      }
    }

    /**
     * Step 2: /link/confirm
     * Polls whether the user has scanned the QR code.
     * Returns { waiting: true } while pending, { success: true, ... } on completion,
     * or { success: false, error } only for permanent failures (bad uniqueId).
     */
    async confirmLinkDevice(payload) {
      const { uniqueId } = payload;
      if (!uniqueId) {
        return { success: false, error: 'No uniqueId provided.' };
      }

      const session = this.linkSessions[uniqueId];
      if (!session) {
        // Permanent failure — the session never existed or was already cleaned up.
        return { success: false, error: 'Link session not found. Please start the QR flow again.' };
      }

      // Already completed — return cached result immediately.
      if (session.done) {
        const result = {
          success: true,
          phoneNumber: session.phoneNumber,
          sessionToken: session.sessionToken,
          tokenType: session.tokenType,
        };
        delete this.linkSessions[uniqueId];
        return result;
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

        // Scan complete — normalize tokenType to a number before storing.
        const tokenType = parseInt(apiResponse.secondary, 10);
        delete this.linkSessions[uniqueId];

        return {
          success: true,
          phoneNumber: apiResponse.user.id,
          sessionToken: apiResponse.user.token,
          tokenType,
        };
      } catch (err) {
        const msg = err.message || '';
        if (msg.includes('429')) {
          // Rate limited — surface this to the client so it can stop and warn the user
          return { success: false, error: 'Rate limited by PalGate. Please wait a moment before trying again.' };
        }
        // Other transient errors (network, timeout, 5xx): keep the poll alive
        return { success: false, waiting: true };
      }
    }

    /**
     * Returns the admin/latch metadata cache written by the plugin at startup.
     * Keyed by deviceId: { admin: bool, latch: bool }
     */
    async getGateMeta() {
      const fs = require('fs');
      const path = require('path');
      try {
        const metaPath = path.join(this.homebridgeStoragePath, 'palgate-gate-meta.json');
        if (!fs.existsSync(metaPath)) return { success: true, meta: {} };
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        return { success: true, meta };
      } catch (_) {
        return { success: true, meta: {} };
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

        return {
          success: true,
          gates
        };
      } catch (err) {
        return {
          success: false,
          error: err.message
        };
      }
    }
  }

  new UiServer();
})();
