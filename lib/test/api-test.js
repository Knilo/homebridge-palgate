// api-test.js
//
// Usage:
//   node api-test.js new   // for the new promise/async version (default)
//   node api-test.js old   // for the original callback-based version

const { performance } = require('perf_hooks');
const process = require('process');

// Determine API mode from command-line argument ("old" or "new")
const apiMode = process.argv[2] || 'new';
console.log(`Running in ${apiMode.toUpperCase()} mode.`);

// Import the API functions
const { validateToken, openGate, getDevices, getDeviceInfo } = require('../api.js');

// Replace these with valid test values for your environment
// Replace these with valid test values for your API.
const sessionToken = '';
const deviceId = '';
const phoneNumber = '';
const tokenType = 1;

const { generateToken } = require('../token-gen.js');
const token = generateToken(
  Buffer.from(sessionToken, 'hex'),
  parseInt(phoneNumber, 10),
  parseInt(tokenType, 10)
);
console.log(token);

if (apiMode === 'old') {
  // Callback-based (old) mode.
  console.log('Starting API latency tests (old mode)...');

  // Helper to measure API call using native callbacks
  function measureApiCallOld(name, fn, next) {
    console.log(`\nStarting ${name}...`);
    const start = performance.now();
    fn((err, result) => {
      const end = performance.now();
      if (err) {
        console.error(`${name} failed in ${(end - start).toFixed(2)} ms: ${err.message}`);
      } else {
        console.log(`${name} succeeded in ${(end - start).toFixed(2)} ms`);
        console.log(`${name} result: ${result ? result.toString().substring(0, 200) : "No result"}`);
      }
      if (typeof next === 'function') {
        next();
      }
    });
  }

  // Chain the API calls sequentially.
  measureApiCallOld('validateToken', cb => {
    validateToken(token, cb);
  }, () => {
    measureApiCallOld('getDevices', cb => {
      getDevices(token, cb);
    }, () => {
      if (deviceId) {
        measureApiCallOld('getDeviceInfo', cb => {
          getDeviceInfo(token, deviceId, cb);
        }, () => {
          measureApiCallOld('openGate', cb => {
            openGate(deviceId, token, cb);
          }, () => {
            console.log('All tests done (old mode).');
          });
        });
      } else {
        console.log('Device ID not provided. Skipping getDeviceInfo and openGate tests.');
      }
    });
  });
  
} else {
  // Promise/async-based (new) mode.
  (async () => {
    console.log('Starting API latency tests (new mode)...');

    // Helper to measure API call latency using async/await.
    async function measureApiCall(name, apiCall) {
      console.log(`\nStarting ${name}...`);
      const start = performance.now();
      try {
        const result = await apiCall();
        const end = performance.now();
        console.log(`${name} succeeded in ${(end - start).toFixed(2)} ms`);
        console.log(`${name} result:`, result ? JSON.stringify(result) : "No result");
      } catch (error) {
        const end = performance.now();
        console.error(`${name} failed in ${(end - start).toFixed(2)} ms: ${error.message}`);
      }
    }

    await measureApiCall('validateToken', async () => await validateToken(token));
    await measureApiCall('getDevices', async () => await getDevices(token));
    if (deviceId) {
      await measureApiCall('getDeviceInfo', async () => await getDeviceInfo(token, deviceId));
      await measureApiCall('openGate', async () => await openGate(deviceId, token));
    } else {
      console.log('Device ID not provided. Skipping getDeviceInfo and openGate tests.');
    }
    console.log('All tests done (new mode).');
  })();
}