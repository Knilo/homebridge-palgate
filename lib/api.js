const axios = require('axios');
const https = require('https');

const BASE_URL = 'https://api1.pal-es.com/v1/bt/';

// Create HTTP agents with keep-alive enabled
const httpsAgent = new https.Agent({ keepAlive: true });

// Create an axios instance with a base URL and default headers
const apiClient = axios.create({
    baseURL: BASE_URL,
    httpsAgent,
    headers: {
        'Accept': '*/*',
        'Accept-Language': 'en-us',
        'Content-Type': 'application/json'
    }
});

// Makes an API call to a given endpoint using the provided token.
async function callApi(endpoint, tokenHeader) {
    try {
        const response = await apiClient.get(endpoint, {
            headers: { 'x-bt-token': tokenHeader }
        });
        return response.data;
    } catch (error) {
        if (error.response) {
            const errorData = typeof error.response.data === 'object'
              ? JSON.stringify(error.response.data, null, 2)
              : error.response.data;
            throw new Error(`API call error: ${error.response.status} - ${errorData}`);
          } else {
            throw new Error(`API call failed: ${error.message}`);
          }
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
async function openGate(deviceId, temporalToken) {
    // If deviceId contains a trailing ":<number>", treat that as outputNum
    let outputNum = 1;
    if (typeof deviceId === 'string' && deviceId.includes(':')) {
        const parts = deviceId.split(':');
        const possibleOutput = parts.pop();
        const baseId = parts.join(':');
        if (/^\d+$/.test(possibleOutput)) {
            const parsedOutput = parseInt(possibleOutput, 10);
            // Validate that outputNum is a positive integer
            if (parsedOutput > 0) {
                deviceId = baseId;
                outputNum = parsedOutput;
            }
        }
    }
    const endpoint = `device/${deviceId}/open-gate?outputNum=${outputNum}`;
    return await callApi(endpoint, temporalToken);
}

// Gets devices associated with the user
async function getDevices(tokenHeader) {
    const endpoint = 'devices/';
    return await callApi(endpoint, tokenHeader);
}

// Retrieves information about a specific device.
async function getDeviceInfo(tokenHeader, deviceId) {
    const endpoint = `device/${deviceId}/`;
    return await callApi(endpoint, tokenHeader);
}

module.exports = {
    callApi,
    validateToken,
    openGate,
    getDevices,
    getDeviceInfo
};
