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

async function testEndpoint(name, path) {
  try {
    console.log(`Testing ${name}: ${path}...`);
    const res = await callApi(path, temporalToken);
    console.log(`Success: ${name} ->`, JSON.stringify(res));
  } catch (err) {
    console.log(`Failed: ${name} ->`, err.message);
  }
}

async function run() {
  // Test HOLD OPEN
  console.log("Setting HOLD OPEN...");
  await testEndpoint("Hold Open", `device/${deviceId}/open-gate?outputNum=1&output1LatchStatus=true&output1Disabled=true`);
  
  // Wait 3 seconds, then check status
  await new Promise(r => setTimeout(r, 3000));
  
  const statusRes = await callApi(`device/${deviceId}/`, temporalToken);
  console.log("Device Latch Status after Hold Open:", statusRes.device.output1LatchStatus, "(Expected: true)");
  console.log("Device Disabled Status after Hold Open:", statusRes.device.output1Disabled, "(Expected: true)");
  
  // Test reset back to NORMAL
  console.log("\nSetting back to NORMAL...");
  await testEndpoint("Normal Mode", `device/${deviceId}/open-gate?outputNum=1&output1LatchStatus=false&output1Disabled=false`);
  
  // Wait 3 seconds, check status again
  await new Promise(r => setTimeout(r, 3000));
  
  const statusRes2 = await callApi(`device/${deviceId}/`, temporalToken);
  console.log("Device Latch Status after Normal:", statusRes2.device.output1LatchStatus, "(Expected: false)");
  console.log("Device Disabled Status after Normal:", statusRes2.device.output1Disabled, "(Expected: false)");
}

run();
