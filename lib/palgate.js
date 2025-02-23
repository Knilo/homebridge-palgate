'use strict';

let Service, Characteristic, UUIDGen;

// Require additional modules for the linking endpoint.
const qrcode = require('qrcode');               // For generating QR code Data URIs.
const { v4: uuidv4 } = require('uuid');          // For generating unique IDs.
const { callApi } = require('./api.js');           // Reuse the callApi function.
const BASE_URL = 'https://api1.pal-es.com/v1/bt/';

/**
 * startDeviceLinking:
 *   - Generates a unique ID and creates a JSON string for the QR code.
 *   - Calls the PalGate linking endpoint.
 *   - Returns (via callback) an object containing:
 *       { qrData, linkingData }
 *   where linkingData includes phoneNumber, sessionToken, and tokenType.
 */
function startDeviceLinking(callback) {
  const uniqueId = uuidv4();
  const qrData = JSON.stringify({ id: uniqueId });
  const endpoint = `${BASE_URL}un/secondary/init/${uniqueId}`;
  callApi(endpoint, '', (err, response) => {
    if (err) {
      return callback(err);
    }
    try {
      const data = JSON.parse(response);
      if (!data.user || !data.secondary) {
        return callback(new Error("Invalid linking response: missing fields."));
      }
      const linkingData = {
        phoneNumber: data.user.id,
        sessionToken: data.user.token,
        tokenType: parseInt(data.secondary, 10)
      };
      return callback(null, { qrData, linkingData });
    } catch (e) {
      return callback(e);
    }
  });
}

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;
  api.registerPlatform('PalGatePlatform', PalGatePlatform);
};

class PalGatePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.UUIDGen = api.hap.uuid;
    this.accessories = [];

    // Global platform configuration (shared among all devices)
    this.name = config.name || 'PalGate Platform';
    this.token = config.token;
    this.phoneNumber = config.phoneNumber;
    this.tokenType = config.tokenType;
    this.accessoryType = config.accessoryType || 'garageDoor';

    if (!this.token || !this.phoneNumber || (this.tokenType === undefined)) {
      this.log.error("PalGatePlatform: Missing required configuration. Please provide token, phoneNumber, and tokenType in your platform config.");
    }

    // Validate global token on startup.
    const { generateToken } = require('./token-gen.js');
    const temporalToken = generateToken(
      Buffer.from(this.token, 'hex'),
      parseInt(this.phoneNumber, 10),
      parseInt(this.tokenType, 10)
    );
    this.log.debug("Validating platform credentials with temporal token:", temporalToken);
    const { validateToken } = require('./api.js');
    validateToken(temporalToken, (err, response) => {
      if (err) {
        this.log.error("Platform token validation failed:", err.message);
      } else {
        this.log.debug("Platform token validated successfully.");
      }
    });

    // Discover devices after Homebridge has finished launching.
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  // Called when restoring cached accessories.
  configureAccessory(accessory) {
    this.log.info("Restoring cached gate:", accessory.displayName);
    this.accessories.push(accessory);
  }

  // Discover devices via the PalGate API.
  discoverDevices() {
    const { generateToken } = require('./token-gen.js');
    const temporalToken = generateToken(
      Buffer.from(this.token, 'hex'),
      parseInt(this.phoneNumber, 10),
      parseInt(this.tokenType, 10)
    );
    this.log.debug("Generated temporal token for device discovery:", temporalToken);
    const { getDevices } = require('./api.js');
    getDevices(temporalToken, (err, response) => {
      if (err) {
        this.log.error("Error retrieving devices:", err.message);
        return;
      }
      try {
        const data = JSON.parse(response);
        if (!data.devices || !Array.isArray(data.devices)) {
          throw new Error("Invalid devices response: missing devices array.");
        }
        this.log.debug("Discovered", data.devices.length, "gate(s).");

        // Retrieve custom settings from the config.
        const customGates = this.config.customGates || [];

        // Map devices to a configuration object.
        this.gates = data.devices.map((deviceData) => {
          const deviceId = deviceData.id || deviceData._id;
          const deviceName = deviceData.name1;
          if (!deviceName) {
            deviceName = deviceId;
          }
          this.log.debug("Initial gate configuration:", JSON.stringify(this.gates, null, 2));
          const custom = customGates.find(item => item.deviceId === deviceId);

          if (custom) {
            // Remove any pre‑existing accessory for this device.
            const toRemove = this.accessories.filter(acc => acc.context.deviceId === deviceId);
            if (toRemove.length > 0) {
              this.api.unregisterPlatformAccessories("homebridge-palgate", "PalGatePlatform", toRemove);
              this.log.info(`Removed ${toRemove.length} accessory(ies) for device ${deviceId} due to custom configuration.`);
              this.accessories = this.accessories.filter(acc => acc.context.deviceId !== deviceId);
            }
          }
          // If custom settings request hiding, skip this device.
          if (custom && custom.hide === true) {
            return null;
          }
          const name = (custom && custom.name && custom.name.trim().length > 0) ? custom.name : deviceName;
          console.log(name);
          let exposeGarageDoor, exposeSwitch;
          if (custom) {
            exposeGarageDoor = custom.garageDoor === true;
            exposeSwitch = custom.switch === true;
          } else {
            exposeGarageDoor = (this.accessoryType === "garageDoor");
            exposeSwitch = (this.accessoryType === "switch");
          }
          return { deviceId, name, exposeGarageDoor, exposeSwitch };
        }).filter(gate => gate !== null);

        this.log.debug("Gate configurations:", JSON.stringify(this.gates, null, 2));

        // Create accessories for each gate.
        this.gates.forEach(gate => {
          if (gate.exposeGarageDoor) {
            this.createAccessoryForGate(gate, "garageDoor");
          }
          if (gate.exposeSwitch) {
            this.createAccessoryForGate(gate, "switch");
          }
        });
        // Log the names of all added gates.
        const addedGateNames = this.gates.map(g => g.name).join(', ');
        this.log.info("Configured gates: " + addedGateNames);

      } catch (parseError) {
        this.log.error("Error parsing devices response:", parseError.message);
      }
    });
  }

  createAccessoryForGate(gate, type) {
    // Use the instance's UUIDGen instead of the global variable.
    const uuid = this.UUIDGen.generate(gate.deviceId + "_" + type);
    const desiredName = (gate.name && gate.name.trim() !== "") ? gate.name : gate.deviceId;
    let accessory = this.accessories.find(acc => acc.UUID === uuid);
    if (accessory) {
      if (accessory.displayName !== desiredName) {
        accessory.displayName = desiredName;
        accessory.context.name = desiredName;
        const svc = accessory.getService(type === "garageDoor" ? this.Service.GarageDoorOpener : this.Service.Switch);
        if (svc) {
          svc.setCharacteristic(this.Characteristic.Name, desiredName);
        }
        this.log.info("Updated accessory name to:", desiredName);
      }
      return;
    }

    accessory = new this.api.platformAccessory(desiredName, uuid);
    accessory.context.deviceId = gate.deviceId;
    accessory.context.name = desiredName;
    accessory.context.accessoryType = type;

    if (type === "garageDoor") {
      accessory.addService(this.Service.GarageDoorOpener, desiredName);
      this.setupGarageDoorHandlers(accessory);
    } else {
      accessory.addService(this.Service.Switch, desiredName);
      this.setupSwitchHandlers(accessory);
    }
    this.api.registerPlatformAccessories("homebridge-palgate", "PalGatePlatform", [accessory]);
    this.log.info("Added new gate:", desiredName);
    this.accessories.push(accessory);
  }

  setupGarageDoorHandlers(accessory) {
    const service = accessory.getService(this.Service.GarageDoorOpener);
    service.getCharacteristic(this.Characteristic.CurrentDoorState)
      .on('get', (callback) => {
        callback(null, this.Characteristic.CurrentDoorState.CLOSED);
      });
    service.getCharacteristic(this.Characteristic.TargetDoorState)
      .on('get', (callback) => {
        callback(null, this.Characteristic.CurrentDoorState.CLOSED);
      })
      .on('set', (value, callback) => {
        this.log.info("Setting Garage Door state for", accessory.displayName, "to", value);
        if (value === this.Characteristic.TargetDoorState.OPEN) {
          this.openGateForAccessory(accessory, (err) => {
            if (err) {
              callback(err);
            } else {
              service.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPEN);
              callback(null);
            }
          });
        } else {
          service.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
          callback(null);
        }
      });
  }

  setupSwitchHandlers(accessory) {
    const service = accessory.getService(this.Service.Switch);
    service.getCharacteristic(this.Characteristic.On)
      .on('get', (callback) => {
        callback(null, false);
      })
      .on('set', (value, callback) => {
        this.log.info("Setting Switch state for", accessory.displayName, "to", value);
        if (value) {
          this.openGateForAccessory(accessory, (err) => {
            if (err) {
              callback(err);
            } else {
              service.setCharacteristic(this.Characteristic.On, true);
              callback(null);
            }
          });
        } else {
          service.setCharacteristic(this.Characteristic.On, false);
          callback(null);
        }
      });
  }

  openGateForAccessory(accessory, callback) {
    const { openGate } = require('./api.js');
    const deviceId = accessory.context.deviceId;
    const { generateToken } = require('./token-gen.js');
    const temporalToken = generateToken(
      Buffer.from(this.token, 'hex'),
      parseInt(this.phoneNumber, 10),
      parseInt(this.tokenType, 10)
    );
    this.log.debug("Using temporal token for device", deviceId, ":", temporalToken);
    openGate(deviceId, temporalToken, (err, response) => {
      if (err) {
        this.log.error("Error opening gate for device", deviceId, ":", err.message);
        return callback(err);
      }
      this.log.info("Gate opened successfully for device", deviceId);
      callback(null);
    });
  }
}

module.exports = PalGatePlatform;