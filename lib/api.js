const axios = require('axios');
const https = require('https');
const { splitDeviceId } = require('./utils/helpers.js');
const { BASE_URL } = require('./utils/constants.js');

// Create HTTP agents with keep-alive enabled
const httpsAgent = new https.Agent({ keepAlive: true });

// Create an axios instance with a base URL and default headers
const apiClient = axios.create({
    baseURL: BASE_URL,
    httpsAgent,
    timeout: 10000,
    headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-us',
        'Content-Type': 'application/json'
    }
});

const RETRY_DELAYS = [500, 1000, 2000];

function isRetryable(error) {
    if (!error.response) return true; // network/timeout error
    return error.response.status >= 500; // server error, not 4xx auth failures
}

// Makes an API call to a given endpoint using the provided token.
// Retries on network/5xx errors — suitable for gate operations and device listing.
// Pass { retryDelays, timeout } to cap the retry budget for interactive calls, where a
// long blocking retry would stall the HomeKit callback and show the accessory as
// "No Response".
async function callApi(endpoint, tokenHeader, { retryDelays = RETRY_DELAYS, timeout } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
        try {
            const response = await apiClient.get(endpoint, {
                headers: { 'x-bt-token': tokenHeader },
                ...(timeout !== undefined ? { timeout } : {})
            });
            return response.data;
        } catch (error) {
            lastError = error;
            if (!isRetryable(error) || attempt === retryDelays.length) break;
            await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        }
    }
    if (lastError.response) {
        const errorData = typeof lastError.response.data === 'object'
            ? JSON.stringify(lastError.response.data, null, 2)
            : lastError.response.data;
        throw new Error(`API call error: ${lastError.response.status} - ${errorData}`);
    }
    throw new Error(`API call failed: ${lastError.message}`);
}

// Single-shot API call with no retries and a shorter timeout.
// Use this for polling endpoints where the caller controls the retry cadence,
// to avoid piling up concurrent requests that trigger rate limits.
async function callApiOnce(endpoint, tokenHeader, timeout = 8000) {
    try {
        const response = await apiClient.get(endpoint, {
            headers: { 'x-bt-token': tokenHeader },
            timeout
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            const errorData = typeof error.response.data === 'object'
                ? JSON.stringify(error.response.data, null, 2)
                : error.response.data;
            throw new Error(`API call error: ${error.response.status} - ${errorData}`);
        }
        throw new Error(`API call failed: ${error.message}`);
    }
}


// Validate the provided token by calling the check-token endpoint.
async function validateToken(temporalToken) {
    const ts = Math.floor(Date.now() / 1000);
    const tsDiff = 0;
    const endpoint = `user/check-token?ts=${ts}&ts_diff=${tsDiff}`;
    return await callApi(endpoint, temporalToken);
}

// Opens the gate for a specific device.
// Interactive path: cap to one quick retry so a flaky connection resolves in well under
// HomeKit's ~10s tolerance (~8.5s worst case) rather than blocking for tens of seconds.
async function openGate(deviceId, temporalToken, openBy) {
    const { baseId, outputNum } = splitDeviceId(deviceId);
    let endpoint = `device/${baseId}/open-gate?outputNum=${outputNum}`;
    if (openBy !== undefined) endpoint += `&openBy=${encodeURIComponent(openBy)}`;
    return await callApi(endpoint, temporalToken, { retryDelays: [500], timeout: 4000 });
}

// Gets devices associated with the user
async function getDevices(tokenHeader) {
    const endpoint = 'devices/';
    return await callApi(endpoint, tokenHeader);
}

// The device/{id}/ endpoint wraps its payload ({ err, msg, status, device: {...} })
// unlike devices/ which returns flat device objects. Unwrap so callers can read
// outputNLatchStatus etc. directly — reading them off the wrapper silently yields
// undefined, which made the relay state poller treat latched gates as normal.
function unwrapDevice(response) {
    return (response && typeof response === 'object' && response.device) ? response.device : response;
}

// Retrieves information about a specific device.
async function getDeviceInfo(tokenHeader, deviceId) {
    const endpoint = `device/${deviceId}/`;
    return unwrapDevice(await callApi(endpoint, tokenHeader));
}

// Single-shot variant for use in pollers — avoids retry pile-up across poll intervals.
async function getDeviceInfoOnce(tokenHeader, deviceId) {
    const endpoint = `device/${deviceId}/`;
    return unwrapDevice(await callApiOnce(endpoint, tokenHeader));
}

module.exports = {
    callApi,
    callApiOnce,
    validateToken,
    openGate,
    getDevices,
    getDeviceInfo,
    getDeviceInfoOnce
};
