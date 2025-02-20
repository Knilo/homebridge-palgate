const { XMLHttpRequest } = require("xmlhttprequest");
const BASE_URL = 'https://api1.pal-es.com/v1/bt/';

function callApi(endpoint, tokenHeader, callback) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', endpoint);
  xhr.setRequestHeader('x-bt-token', tokenHeader);
  xhr.setRequestHeader("Accept", "*/*");
  xhr.setRequestHeader("Accept-Language", "en-us");
  xhr.setRequestHeader("Content-Type", "application/json");
  xhr.setRequestHeader("User-Agent", "okhttp/4.9.3");

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      callback(null, xhr.responseText);
    } else {
      callback(new Error(`API call error: ${xhr.status} - ${xhr.responseText}`));
    }
  };

  xhr.onerror = () => {
    callback(new Error("API call failed!"));
  };

  xhr.send();
}

function validateToken(temporalToken, callback) {
  const ts = Math.floor(Date.now() / 1000);
  const tsDiff = 0;
  const endpoint = `${BASE_URL}user/check-token?ts=${ts}&ts_diff=${tsDiff}`;
  callApi(endpoint, temporalToken, callback);
}

function openGate(deviceId, temporalToken, callback) {
  const endpoint = `${BASE_URL}device/${deviceId}/open-gate?outputNum=1`;
  callApi(endpoint, temporalToken, callback);
}

/**
 * Get the list of devices by calling the devices endpoint.
 *
 * @param {string} tokenHeader - The token to be sent in the x-bt-token header.
 * @param {function} callback - Callback function(err, response).
 */
function getDevices(tokenHeader, callback) {
    const endpoint = `${BASE_URL}devices/`;
    callApi(endpoint, tokenHeader, callback);
  }
  
function getDeviceInfo(tokenHeader, deviceId, callback) {
    const endpoint = `${BASE_URL}device/${deviceId}/`;
    callApi(endpoint, tokenHeader, callback);
  }

  module.exports = {
    callApi,
    validateToken,
    openGate,
    getDevices,
    getDeviceInfo
  };