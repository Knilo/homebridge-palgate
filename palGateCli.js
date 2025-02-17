#!/usr/bin/env node
/**
 * palGateCli.js
 *
 * A helper CLI tool to use the PalGate API endpoints outside of the plugin.
 *
 * Commands:
 *   validate: Validate a token.
 *   open: Open the gate.
 *   devices: List devices.
 *   token: Generate (and display) a temporal token.
 *   link: Run the device linking flow (QR code only).
 *   config: Run the linking flow and then retrieve devices; output all configuration info.
 *
 * Usage examples:
 *   node palGateCli.js validate --token <token> --phone <phoneNumber> --tokenType <1|2>
 *   node palGateCli.js open --deviceId <deviceId> --token <token> --phone <phoneNumber> --tokenType <1|2>
 *   node palGateCli.js devices --token <token> --phone <phoneNumber> --tokenType <1|2>
 *   node palGateCli.js token --token <token> --phone <phoneNumber> --tokenType <1|2>
 *   node palGateCli.js link
 *   node palGateCli.js config
 *
 * IMPORTANT: Ensure that your generateToken function (in token_generator.js) supports token type 2.
 */

const { generateToken } = require('./tokenGenerator.js');
const { validateToken, openGate, getDevices, callApi } = require('./palGateApi.js');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode-terminal');

const BASE_URL = 'https://api1.pal-es.com/v1/bt/';

// Helper function to print usage instructions.
function printUsage() {
  console.log("Usage:");
  console.log("  node palGateCli.js validate --token <token> --phone <phoneNumber> --tokenType <1|2>");
  console.log("  node palGateCli.js open --deviceId <deviceId> --token <token> --phone <phoneNumber> --tokenType <1|2>");
  console.log("  node palGateCli.js devices --token <token> --phone <phoneNumber> --tokenType <1|2>");
  console.log("  node palGateCli.js token --token <token> --phone <phoneNumber> --tokenType <1|2>");
  console.log("  node palGateCli.js link");
  console.log("  node palGateCli.js config");
  console.log("");
  console.log("Example (Config):");
  console.log("  node palGateCli.js config");
}

const args = process.argv.slice(2);
if (args.length === 0) {
  printUsage();
  process.exit(1);
}

const command = args[0];
const options = {};

// Simple argument parser: flags start with '--'
for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].substring(2);
    if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
      options[key] = args[i + 1];
      i++;
    } else {
      options[key] = true;
    }
  }
}

// Ensure required parameters are provided.
function requireOptions(keys) {
  for (const key of keys) {
    if (!options[key]) {
      console.error(`Missing required parameter: --${key}`);
      printUsage();
      process.exit(1);
    }
  }
}

// Generate a temporary token using the provided credentials.
function getTemporalToken() {
  return generateToken(
    Buffer.from(options.token, 'hex'),
    parseInt(options.phone, 10),
    parseInt(options.tokenType, 10)
  );
}

/**
 * startDeviceLinking:
 *  - Generates a unique ID.
 *  - Displays a QR code so the user can scan it with the PalGate app.
 *  - Calls the linking endpoint.
 *  - Returns linking data: { phoneNumber, sessionToken, tokenType }.
 */
function startDeviceLinking(callback) {
  const uniqueId = uuidv4();
  const qrData = JSON.stringify({ id: uniqueId });
  console.log("Please scan this QR code with your PalGate app to link your device:");
  qrcode.generate(qrData, { small: true });
  console.log("Waiting for device linking response...");

  const endpoint = `${BASE_URL}un/secondary/init/${uniqueId}`;
  // For linking, no token is required—pass an empty token.
  callApi(endpoint, '', (err, response) => {
    if (err) {
      return callback(err);
    }
    try {
      const data = JSON.parse(response);
      // Expected response structure:
      // { user: { id: "<phone_number>", token: "<session token>" }, secondary: <tokenType> }
      if (!data.user || !data.secondary) {
        return callback(new Error("Invalid linking response: missing fields."));
      }
      const phoneNumber = data.user.id;
      const sessionToken = data.user.token;
      const tokenType = data.secondary;
      return callback(null, { phoneNumber, sessionToken, tokenType });
    } catch (parseError) {
      return callback(parseError);
    }
  });
}

if (command === 'validate') {
  requireOptions(['token', 'phone', 'tokenType']);
  const temporalToken = getTemporalToken();
  console.log("Generated temporal token for validation:", temporalToken);
  validateToken(temporalToken, (err, response) => {
    if (err) {
      console.error("Token validation failed:", err);
    } else {
      console.log("Token validated successfully. Response:", response);
    }
  });
} else if (command === 'open') {
  requireOptions(['deviceId', 'token', 'phone', 'tokenType']);
  const temporalToken = getTemporalToken();
  console.log("Generated temporal token for opening gate:", temporalToken);
  openGate(options.deviceId, temporalToken, (err, response) => {
    if (err) {
      console.error("Error opening gate:", err);
    } else {
      console.log("Gate opened successfully. Response:", response);
    }
  });
} else if (command === 'devices') {
  requireOptions(['token', 'phone', 'tokenType']);
  const temporalToken = getTemporalToken();
  console.log("Generated temporal token for getting devices:", temporalToken);
  getDevices(temporalToken, (err, response) => {
    if (err) {
      console.error("Error getting devices:", err);
    } else {
      console.log("Devices retrieved successfully. Response:", response);
    }
  });
} else if (command === 'token') {
  requireOptions(['token', 'phone', 'tokenType']);
  const temporalToken = getTemporalToken();
  console.log("Generated token:", temporalToken);
} else if (command === 'link') {
  // Perform linking and show linking data.
  startDeviceLinking((err, linkingData) => {
    if (err) {
      console.error("Device linking failed:", err);
      process.exit(1);
    } else {
      console.log("\nDevice linking successful!");
      console.log(`Phone Number: ${linkingData.phoneNumber}`);
      console.log(`Session Token: ${linkingData.sessionToken}`);
      console.log(`Token Type: ${linkingData.tokenType}`);
    }
  });
} else if (command === 'config') {
  // Run linking flow, then get devices, and output a JSON configuration object.
  startDeviceLinking((err, linkingData) => {
    if (err) {
      console.error("Device linking failed:", err);
      process.exit(1);
    }
    console.log("\nDevice linking successful!");
    console.log(`Phone Number: ${linkingData.phoneNumber}`);
    console.log(`Session Token: ${linkingData.sessionToken}`);
    console.log(`Token Type: ${linkingData.tokenType}`);
    // Generate a temporary token from the linking data.
    const temporalToken = generateToken(
      Buffer.from(linkingData.sessionToken, 'hex'),
      parseInt(linkingData.phoneNumber, 10),
      parseInt(linkingData.tokenType)
    );
    console.log("\nGenerated temporal token for retrieving devices:", temporalToken);
    // Now retrieve devices.
    getDevices(temporalToken, (err, response) => {
      if (err) {
        console.error("Error retrieving devices:", err);
        process.exit(1);
      }
      try {
        const data = JSON.parse(response);
        if (!data.devices || !Array.isArray(data.devices)) {
          throw new Error("Invalid devices response: missing 'devices' array.");
        }
        const deviceIds = data.devices.map(device => device.id || device._id);
        // Build a configuration object.
        const configObj = {
          phoneNumber: linkingData.phoneNumber,
          token: linkingData.sessionToken,
          tokenType: parseInt(linkingData.tokenType),
          deviceIds: deviceIds
        };
        console.log("\nConfiguration:");
        console.log(JSON.stringify(configObj, null, 2));
      } catch (parseError) {
        console.error("Error parsing devices response:", parseError);
        process.exit(1);
      }
    });
  });
} else {
  console.error("Unknown command:", command);
  printUsage();
  process.exit(1);
}