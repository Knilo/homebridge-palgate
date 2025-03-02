(async () => {
  const { HomebridgePluginUiServer } = await import('@homebridge/plugin-ui-utils');
  const qrcodeModule = await import('qrcode');
  const qrcode = qrcodeModule.default;
  const { v4: uuidv4 } = await import('uuid');
  const { callApi } = require('../lib/api.js'); // adjust path if needed

  class UiServer extends HomebridgePluginUiServer {
    constructor() {
      super();

      // In-memory store for ongoing link sessions.
      // Maps uniqueId => { done, phoneNumber, sessionToken, tokenType }
      this.linkSessions = {};

      // Register endpoints:
      this.onRequest('/link/init', this.initLinkDevice.bind(this));
      this.onRequest('/link/confirm', this.confirmLinkDevice.bind(this));

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
     * Checks if the user has scanned the QR code. If not, we return { success: false, waiting: true }.
     * If the user has scanned, the PalGate API should return user + secondary fields.
     */
    async confirmLinkDevice(payload) {
      try {
        const { uniqueId } = payload;
        if (!uniqueId) {
          throw new Error("No uniqueId provided.");
        }

        const session = this.linkSessions[uniqueId];
        if (!session) {
          throw new Error(`No link session found for uniqueId: ${uniqueId}`);
        }

        // If we already have a successful link, just return it immediately.
        if (session.done) {
          return {
            success: true,
            phoneNumber: session.phoneNumber,
            sessionToken: session.sessionToken,
            tokenType: session.tokenType,
          };
        }

        // Otherwise, call the PalGate API to see if the user has scanned yet.
        const endpoint = `https://api1.pal-es.com/v1/bt/un/secondary/init/${uniqueId}`;

        // Updated: Use async/await since callApi returns a promise.
        const apiResponse = await callApi(endpoint, '');

        // If the API doesn't yet return user + secondary, the user hasn't scanned yet.
        if (!apiResponse.user || !apiResponse.secondary) {
          return { success: false, waiting: true };
        }

        // The user has scanned and the server returned the final data.
        session.done = true;
        session.phoneNumber = apiResponse.user.id;
        session.sessionToken = apiResponse.user.token;
        session.tokenType = apiResponse.secondary;

        return {
          success: true,
          phoneNumber: session.phoneNumber,
          sessionToken: session.sessionToken,
          tokenType: session.tokenType,
        };
      } catch (err) {
        return {
          success: false,
          error: err.message,
        };
      }
    }
  }

  new UiServer();
})();