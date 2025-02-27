// api-test.js
//
// Usage:
//   node api-test.js new   // for the new promise/async version (default)
//   node api-test.js old   // for the old callback version

const { performance } = require('perf_hooks');
const process = require('process');

// Get API mode from the command line arguments ("old" or "new").
const apiMode = process.argv[2] || 'new';

// Import the API module (assumes all four functions are exported).
const { validateToken, openGate, getDevices, getDeviceInfo } = require('../api.js');

// A helper function to wrap a callback-based function in a promise.
function promisify(fn) {
  return (...args) =>
    new Promise((resolve, reject) => {
      fn(...args, (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      });
    });
}

// Depending on the mode, use either the original functions (new) or a promisified version (old).
let validateTokenAsync, getDevicesAsync, getDeviceInfoAsync, openGateAsync;
if (apiMode === 'old') {
  console.log("Running in OLD (callback-based) mode.");
  validateTokenAsync = promisify(validateToken);
  getDevicesAsync = promisify(getDevices);
  getDeviceInfoAsync = promisify(getDeviceInfo);
  openGateAsync = promisify(openGate);
} else {
  console.log("Running in NEW (promise/async) mode.");
  validateTokenAsync = validateToken;
  getDevicesAsync = getDevices;
  getDeviceInfoAsync = getDeviceInfo;
  openGateAsync = openGate;
}

// Replace these with valid test values for your API.
const token = '';
const deviceId = '';
const phoneNumber = '';
const tokenType = 1;

const { generateToken } = require('../token-gen.js');
const temporalToken = generateToken(
  Buffer.from(token, 'hex'),
  parseInt(phoneNumber, 10),
  parseInt(tokenType, 10)
);
console.log(temporalToken);
// A helper function to measure the latency of an API call.
async function measureApiCall(name, apiCall) {
  const start = performance.now();
  try {
    const result = await apiCall();
    const end = performance.now();
    console.log(`${name} succeeded in ${(end - start).toFixed(2)} ms`);
    return result;
  } catch (error) {
    const end = performance.now();
    console.error(`${name} failed in ${(end - start).toFixed(2)} ms: ${error.message}`);
    return null;
  }
}

// Run the tests sequentially.
(async () => {
  console.log('Starting API latency tests...');

  // Test validateToken.
  await measureApiCall('validateToken', async () => await validateTokenAsync(temporalToken));

  // Test getDevices.
  const devicesResponse = await measureApiCall('getDevices', async () => await getDevicesAsync(temporalToken));

  // Test getDeviceInfo and openGate if a deviceId is provided.
  if (deviceId) {
    await measureApiCall('getDeviceInfo', async () => await getDeviceInfoAsync(temporalToken, deviceId));
    await measureApiCall('openGate', async () => await openGateAsync(deviceId, temporalToken));
  } else {
    console.log('Device ID not provided. Skipping getDeviceInfo and openGate tests.');
  }
})();