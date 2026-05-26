const { generateToken } = require('../lib/token-gen.js');
const { callApi } = require('../lib/api.js');

const token = "f7c527568a80706e2dba682a39925780";
const phoneNumber = "972586317450";
const tokenType = 1;
const deviceId = "4G600216305";

const temporalToken = generateToken(
  Buffer.from(token, 'hex'),
  parseInt(phoneNumber, 10),
  parseInt(tokenType, 10)
);

async function run() {
  try {
    const res = await callApi(`device/${deviceId}/`, temporalToken);
    console.log("Current Device Details:");
    console.log(JSON.stringify(res.device, null, 2));
  } catch (err) {
    console.log("Error getting status:", err.message);
  }
}

run();
