#!/usr/bin/env node
/**
 * palGateCli.js
 *
 * A CLI tool to interact with the PalGate API endpoints outside of the plugin.
 *
 * Commands:
 *   validate: Validate a token.
 *   open: Open the gate.
 *   devices: List devices.
 *   token: Generate (and display) a temporary token.
 *   link: Run the device linking flow (QR code only).
 *   config: Run the linking flow, retrieve devices, and output configuration info.
 *           If the --auto flag is provided, the new accessory configuration will be appended
 *           to the Homebridge config file at ~/.homebridge/config.json and the linking data will be saved
 *           locally in palGateCLI.config.
 *
 * Options:
 *   -v, --verbose  Enable verbose logging.
 *
 * Example usage:
 *   node palGateCli.js config --auto -v
 */

const { generateToken } = require('../lib/token-gen.js');
const { validateToken, openGate, getDevices, getDeviceInfo, callApi } = require('../lib/api.js');
const { v4: uuidv4 } = require('uuid');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE_URL = 'https://api1.pal-es.com/v1/bt/';
// Path for the Homebridge configuration file.
const homebridgeConfigPath = path.join(os.homedir(), '.homebridge', 'config.json');
// Local configuration defaults file.
const localConfigPath = path.join(os.homedir(), '.palgate-cli.json');

function printUsage() {
  console.log("Usage:");
  console.log("  node palGateCli.js validate --token <token> --phoneNumber <phoneNumber> --tokenType <1|2> [--verbose]");
  console.log("  node palGateCli.js open --deviceId <deviceId> --tokenNumber <token> --phone <phoneNumber> --tokenType <1|2> [--verbose]");
  console.log("  node palGateCli.js devices --token <token> --phoneNumber <phoneNumber> --tokenType <1|2> [--verbose]");
  console.log("  node palGateCli.js token --token <token> --phoneNumber <phoneNumber> --tokenType <1|2> [--verbose]");
  console.log("  node palGateCli.js link [-v]");
  console.log("  node palGateCli.js config [--auto] [-v]");
  console.log("");
  console.log("Example (Full Setup):");
  console.log("  node palGateCli.js config --auto");
}

// Load local defaults from palGateCLI.config if available.
let fileConfig = {};
if (fs.existsSync(localConfigPath)) {
  try {
    const fileContent = fs.readFileSync(localConfigPath, 'utf8').trim();
    if (fileContent) {
      fileConfig = JSON.parse(fileContent);
    } else {
      console.warn("Local configuration file exists but is empty. Using default configuration.");
      fileConfig = {};
    }
  } catch (e) {
    console.warn("Local configuration file exists but is not valid JSON. Ignoring local config.");
    fileConfig = {};
  }
}

const args = process.argv.slice(2);
if (args.length === 0) {
  printUsage();
  process.exit(1);
}

// Define aliases for short and long flags.
const aliases = {
  t: "token",
  token: "token",
  p: "phoneNumber",
  phoneNumber: "phoneNumber",
  d: "deviceId",
  deviceid: "deviceId",
  T: "tokenType",
  tokenType: "tokenType",
  v: "verbose",
  verbose: "verbose",
  a: "auto",
  auto: "auto"
};

const command = args[0];
const options = {};

// Simple argument parser: flags start with '--' and support -v/--verbose.
for (let i = 1; i < args.length; i++) {
  let arg = args[i];
  if (arg.startsWith('--')) {
    arg = arg.substring(2);
  } else if (arg.startsWith('-')) {
    arg = arg.substring(1);
  } else {
    continue;
  }
  // Convert the flag to lowercase and get the canonical name
  const key = aliases[arg.toLowerCase()] || arg;
  // If the next argument exists and doesn't start with '-', treat it as the value.
  if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
    options[key] = args[i + 1];
    i++; // Skip the next argument since we've consumed it.
  } else {
    options[key] = true;
  }
}

const verbose = options.verbose || false;
function debugLog(...args) {
  if (verbose) {
    console.log("[DEBUG]", ...args);
  }
}

// For commands that require parameters, try to fill missing ones from local config.
function requireOptions(keys) {
  for (const key of keys) {
    if (!options[key]) {
      if (fileConfig[key]) {
        options[key] = fileConfig[key];
        debugLog(`Loaded ${key} from local config file.`);
      } else {
        console.error(`Missing required parameter: --${key} and no configuration found in ${localConfigPath}`);
        printUsage();
        process.exit(1);
      }
    }
  }
}

// Generate a temporary token using provided credentials.
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
 *  - Displays a QR code (printed normally) for the user to scan with the PalGate app.
 *  - Calls the linking endpoint.
 *  - Returns linking data: { phoneNumber, sessionToken, tokenType }.
 */
async function startDeviceLinking() {
  const uniqueId = uuidv4();
  const qrData = JSON.stringify({ id: uniqueId });
  console.log("Please scan this QR code with your PalGate app to link your device:");
  qrcode.generate(qrData, { small: true });
  console.log("Waiting for device linking response...");

  const endpoint = `${BASE_URL}un/secondary/init/${uniqueId}`;
  const timeout = 60 * 1000; // 60 seconds timeout
  const startTime = Date.now();

  async function pollForLinking() {
    try {
      const response = await callApi(endpoint, '');
      if (response.user && response.secondary) {
        return {
          phoneNumber: response.user.id,
          sessionToken: response.user.token,
          tokenType: response.secondary
        };
      } else {
        if (Date.now() - startTime > timeout) {
          throw new Error("Device linking timed out.");
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
        return pollForLinking();
      }
    } catch (err) {
      if (Date.now() - startTime > timeout) {
        throw new Error("Device linking timed out.");
      }
      await new Promise(resolve => setTimeout(resolve, 3000));
      return pollForLinking();
    }
  }

  return pollForLinking();
}

(async () => {
  switch (command) {
    case 'validate': {
      requireOptions(['token', 'phoneNumber', 'tokenType']);
      const temporalToken = getTemporalToken();
      debugLog("Generated temporal token for validation:", temporalToken);
      try {
        const response = await validateToken(temporalToken);
        console.log("Token validated successfully");
        console.log(JSON.stringify({ response: response }, null, 2));
      } catch (err) {
        console.error("Token validation failed:", err.message);
      }
      break;
    }
    case 'open': {
      requireOptions(['deviceId', 'token', 'phoneNumber', 'tokenType']);
      debugLog("Device ID is:", options.deviceId);
      const temporalToken = getTemporalToken();
      debugLog("Generated temporal token for opening gate:", temporalToken);
      try {
        const response = await openGate(options.deviceId, temporalToken);
        console.log("Gate opened successfully");
        console.log(JSON.stringify({ response: response }, null, 2));
      } catch (err) {
        console.error("Error opening gate:", err.message);
      }
      break;
    }
    case 'devices': {
      requireOptions(['token', 'phoneNumber', 'tokenType']);
      const temporalToken = getTemporalToken();
      debugLog("Generated temporal token for getting devices:", temporalToken);
      try {
        const response = await getDevices(temporalToken);
        console.log("Devices retrieved successfully");
        console.log(JSON.stringify({ response: response }, null, 2));
      } catch (err) {
        console.error("Error getting devices:", err.message);
      }
      break;
    }
    case 'info': {
      requireOptions(['deviceId', 'token', 'phoneNumber', 'tokenType']);
      debugLog("Device ID is:", options.deviceId);
      const temporalToken = getTemporalToken();
      debugLog("Generated temporal token for getting device info:", temporalToken);
      try {
        const response = await getDeviceInfo(temporalToken, options.deviceId);
        console.log("Device info retrieved successfully");
        console.log(JSON.stringify({ response: response }, null, 2));
      } catch (err) {
        console.error("Error getting device info:", err.message);
      }
      break;
    }
    case 'token': {
      requireOptions(['token', 'phoneNumber', 'tokenType']);
      const temporalToken = getTemporalToken();
      console.log("Generated temporal token");
      console.log(JSON.stringify({ token: temporalToken }, null, 2));
      break;
    }
    case 'link': {
      try {
        const linkingData = await startDeviceLinking();
        debugLog("Device linking successful!");
        debugLog("Phone Number:", linkingData.phoneNumber);
        debugLog("Session Token:", linkingData.sessionToken);
        debugLog("Token Type:", linkingData.tokenType);
        const configObj = {
          phoneNumber: linkingData.phoneNumber,
          token: linkingData.sessionToken,
          tokenType: parseInt(linkingData.tokenType, 10)
        };
        console.log("Configuration generated");
        console.log(JSON.stringify({ config: configObj }, null, 2));
        fs.writeFileSync(localConfigPath, JSON.stringify(configObj, null, 2), 'utf8');
        console.log("Local configuration saved to " + localConfigPath);
      } catch (err) {
        console.error("Device linking failed:", err.message);
        process.exit(1);
      }
      break;
    }
    case 'config': {
      try {
        const linkingData = await startDeviceLinking();
        debugLog("Device linking successful!");
        debugLog("Phone Number:", linkingData.phoneNumber);
        debugLog("Session Token:", linkingData.sessionToken);
        debugLog("Token Type:", linkingData.tokenType);
        const configObj = {
          phoneNumber: linkingData.phoneNumber,
          token: linkingData.sessionToken,
          tokenType: parseInt(linkingData.tokenType, 10)
        };
        console.log("Configuration generated");
        console.log(JSON.stringify({ config: configObj }, null, 2));
        fs.writeFileSync(localConfigPath, JSON.stringify(configObj, null, 2), 'utf8');
        console.log("Local configuration saved to " + localConfigPath);
    
        if (options["auto"]) {
          if (!fs.existsSync(homebridgeConfigPath)) {
            console.error(`Homebridge config not found at ${homebridgeConfigPath}. Please ensure Homebridge is installed and configured.`);
            process.exit(1);
          }
          let hbConfig = JSON.parse(fs.readFileSync(homebridgeConfigPath, 'utf8'));
          if (!Array.isArray(hbConfig.platforms)) {
            hbConfig.platforms = [];
          }
          const platformConfig = {
            "name": "PalGate Platform",
            "platform": "PalGatePlatform",
            "token": linkingData.sessionToken,
            "phoneNumber": linkingData.phoneNumber,
            "tokenType": parseInt(linkingData.tokenType, 10),
            "accessoryType": "garageDoor",
            "gateCloseDelay": 5000
          };
          hbConfig.platforms.push(platformConfig);
          fs.writeFileSync(homebridgeConfigPath, JSON.stringify(hbConfig, null, 2), 'utf8');
          console.log("Homebridge configuration updated and saved to " + homebridgeConfigPath);
          console.log("New Platform Added:");
          console.log(JSON.stringify(platformConfig, null, 2));
          console.log("Note: You will need to restart Homebridge for the platform to initialise");
        }
      } catch (err) {
        console.error("Device linking failed:", err.message);
        process.exit(1);
      }
      break;
    }
    default: {
      console.error("Unknown command:", command);
      printUsage();
      process.exit(1);
    }
  }
})();