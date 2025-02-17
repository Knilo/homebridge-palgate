#!/usr/bin/env node
/**
 * palGateCli.js
 *
 * A helper CLI tool to interact with the PalGate API endpoints.
 *
 * Commands:
 *   validate: Validate a token.
 *   open: Open the gate.
 *   devices: List devices.
 *   token: Generate (and display) a temporary token.
 *   link: Run the device linking flow (QR code only).
 *   config: Run the linking flow, then retrieve devices, and output all configuration info and save it as palGateCli.config.
 *
 * If certain required options are missing as flags, the CLI will attempt to load them
 * from a configuration file (palGateCli.config). If that file is missing or incomplete,
 * an error is thrown.
 *
 * Usage examples:
 *   node palGateCli.js validate --token <token> --phoneNumber <phoneNumber> --tokenType <1|2>
 *   node palGateCli.js open --deviceId <deviceId> --token <token> --phoneNumber <phoneNumber> --tokenType <1|2>
 *   node palGateCli.js devices --token <token> --phoneNumber <phoneNumber> --tokenType <1|2>
 *   node palGateCli.js token --token <token> --phoneNumber <phoneNumber> --tokenType <1|2>
 *   node palGateCli.js link
 *   node palGateCli.js config
 */

const { generateToken } = require('./tokenGenerator.js');
const { validateToken, openGate, getDevices, callApi } = require('./palGateApi.js');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api1.pal-es.com/v1/bt/';

// The configuration file path.
const configFilePath = path.join(process.cwd(), 'palGateCli.config');

// Helper function to print usage instructions.
function printUsage() {
  console.log("Usage:");
  console.log("  node palGateCli.js validate --token <token> --phoneNumber <phoneNumber> --tokenType <0|1|2>");
  console.log("  node palGateCli.js open --deviceId <deviceId> --token <token> --phoneNumber <phoneNumber> --tokenType <0|1|2>");
  console.log("  node palGateCli.js devices --token <token> --phoneNumber <phoneNumber> --tokenType <0|1|2>");
  console.log("  node palGateCli.js token --token <token> --phoneNumber <phoneNumber> --tokenType <0|1|2>");
  console.log("  node palGateCli.js link");
  console.log("  node palGateCli.js config");
  console.log("");
  console.log("Example (Config):");
  console.log("  node palGateCli.js config");
}

// Load configuration from file if it exists.
let fileConfig = {};
if (fs.existsSync(configFilePath)) {
  try {
    fileConfig = JSON.parse(fs.readFileSync(configFilePath, 'utf8'));
  } catch (e) {
    console.error("Error parsing configuration file:", e);
    process.exit(1);
  }
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

// Merge values from the configuration file into options if they are missing.
function requireOptions(keys) {
  for (const key of keys) {
    if (!options[key]) {
      if (fileConfig[key]) {
        options[key] = fileConfig[key];
      } else {
        console.error(`Missing required parameter: --${key} and no configuration found in ${configFilePath}`);
        printUsage();
        process.exit(1);
      }
    }
  }
}

// Generate a temporary token using the provided credentials.
function getTemporalToken() {
  return generateToken(
    Buffer.from(options.token, 'hex'),
    parseInt(options.phoneNumber, 10),
    parseInt(options.tokenType, 10)
  );
}

/**
 * startDeviceLinking:
 *  - Generates a unique ID.
 *  - Displays a QR code for the user to scan with the PalGate app.
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
  requireOptions(['token', 'phoneNumber', 'tokenType']);
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
  requireOptions(['deviceId', 'token', 'phoneNumber', 'tokenType']);
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
  requireOptions(['token', 'phoneNumber', 'tokenType']);
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
  requireOptions(['token', 'phoneNumber', 'tokenType']);
  const temporalToken = getTemporalToken();
  console.log("Generated token:", temporalToken);
} else if (command === 'link') {
  // Just perform linking and show linking data.
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
  // Run the linking flow, then retrieve devices, and output a JSON configuration object.
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
          tokenType: linkingData.tokenType,
          deviceIds: deviceIds
        };
        console.log("\nConfiguration:");
        console.log(JSON.stringify(configObj, null, 2));
        // Save the configuration object to a file.
        try {
          fs.writeFileSync(configFilePath, JSON.stringify(configObj, null, 2));
          console.log(`Configuration saved to ${configFilePath}`);
        } catch (writeError) {
          console.error("Error saving configuration file:", writeError);
        }
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