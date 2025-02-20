'use strict';

let Service, Characteristic, UUIDGen;

module.exports = (api) => {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;
  UUIDGen = api.hap.uuid;
  api.registerPlatform('PalGateOpener', PalGatePlatform);
};

class PalGatePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = [];

    // Global platform configuration (shared among all devices)
    this.token = config.token;
    this.phoneNumber = config.phoneNumber;
    this.tokenType = config.tokenType; // Expected to be a number: 0, 1, or 2.
    this.accessoryType = config.accessoryType || 'garageDoor'; // default to "garageDoor"

    if (!this.token || !this.phoneNumber || (this.tokenType === undefined)) {
      this.log.error("PalGatePlatform: Missing required configuration. Please provide token, phoneNumber, and tokenType in your platform config.");
    }

    // Validate global token on startup.
    const { generateToken } = require('./tokenGenerator.js');
    const temporalToken = generateToken(
      Buffer.from(this.token, 'hex'),
      parseInt(this.phoneNumber, 10),
      parseInt(this.tokenType, 10)
    );
    this.log.debug("Validating platform credentials with temporal token:", temporalToken);
    const { validateToken } = require('./palGateApi.js');
    validateToken(temporalToken, (err, response) => {
      if (err) {
        this.log.error("Platform token validation failed:", err.message);
      } else {
        this.log.info("Platform token validated successfully.");
      }
    });

    // Listen for Homebridge finishing launch, then discover devices.
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  // Called for each accessory loaded from cache.
  configureAccessory(accessory) {
    this.log.info("Restoring cached accessory:", accessory.displayName);
    this.accessories.push(accessory);
  }

  // Discover devices via the PalGate API.
  // Inside your PalGatePlatform class

discoverDevices() {
  const { generateToken } = require('./tokenGenerator.js');
  const temporalToken = generateToken(
    Buffer.from(this.token, 'hex'),
    parseInt(this.phoneNumber, 10),
    parseInt(this.tokenType, 10)
  );
  this.log.debug("Generated temporal token for device discovery:", temporalToken);
  const { getDevices } = require('./palGateApi.js');
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
      this.log.info("Discovered", data.devices.length, "device(s).");

      // Get custom gate settings from platform config (optional).
      const customGates = this.config.customGates || [];
      
      // Build a gate array: for each device, extract deviceId, name, and which types to expose.
      this.gates = data.devices.map((deviceData, idx) => {
        const deviceId = deviceData.id || deviceData._id;
        // Look for custom settings for this device.
        const custom = customGates.find(item => item.deviceId === deviceId);
        // Use the custom name if provided; otherwise, default to the deviceId.
        const name = (custom && custom.name && custom.name.trim().length > 0) ? custom.name : deviceId;
        // Determine accessory types to expose:
        let exposeGarageDoor, exposeSwitch;
        if (custom) {
          exposeGarageDoor = custom.garageDoor === true;
          exposeSwitch = custom.switch === true;
        } else {
          // If no custom config, use the platform's default.
          exposeGarageDoor = (this.accessoryType === "garageDoor");
          exposeSwitch = (this.accessoryType === "switch");
        }
        // If the custom config specifies hide, skip this gate.
        if (custom && custom.hide === true) {
          return null;
        }
        return { deviceId, name, exposeGarageDoor, exposeSwitch };
      }).filter(gate => gate !== null);

      this.log.info("Final gate configuration:", JSON.stringify(this.gates, null, 2));

      // For each gate, create accessories for each exposed type.
      this.gates.forEach(gate => {
        if (gate.exposeGarageDoor) {
          this.createAccessoryForGate(gate, "garageDoor");
        }
        if (gate.exposeSwitch) {
          this.createAccessoryForGate(gate, "switch");
        }
      });
    } catch (parseError) {
      this.log.error("Error parsing devices response:", parseError.message);
    }
  });
}

createAccessoryForGate(gate, type) {
  // Use a stable UUID combining deviceId and type.
  const uuid = UUIDGen.generate(gate.deviceId + "_" + type);
  
  // Determine the desired name:
  // If a custom name is provided, use it; otherwise, use the deviceId as the default.
  const desiredName = (gate.name && gate.name.trim() !== "") ? gate.name : gate.deviceId;
  
  // Check if an accessory with this UUID already exists.
  let accessory = this.accessories.find(acc => acc.UUID === uuid);
  if (accessory) {
    // Update the accessory's name if it differs from desiredName.
    if (accessory.displayName !== desiredName) {
      accessory.displayName = desiredName;
      accessory.context.name = desiredName;
      // Attempt to update the primary service's name (if possible).
      const svc = accessory.getService(type === "garageDoor" ? Service.GarageDoorOpener : Service.Switch);
      if (svc) {
        svc.setCharacteristic(Characteristic.Name, desiredName);
      }
      this.log.info("Updated cached accessory name to:", desiredName);
    }
    return;
  }
  
  // If accessory does not exist, create a new one.
  accessory = new this.api.platformAccessory(desiredName, uuid);
  accessory.context.deviceId = gate.deviceId;
  accessory.context.name = desiredName;
  accessory.context.accessoryType = type;
  
  // Add the appropriate service based on the accessory type.
  if (type === "garageDoor") {
    accessory.addService(Service.GarageDoorOpener, desiredName);
    this.setupGarageDoorHandlers(accessory);
  } else {
    accessory.addService(Service.Switch, desiredName);
    this.setupSwitchHandlers(accessory);
  }
  
  this.api.registerPlatformAccessories("homebridge-palgate-opener", "PalGateOpener", [accessory]);
  this.log.info("Added new accessory:", desiredName);
  this.accessories.push(accessory);
}
  // Setup handlers for a garage door accessory.
  setupGarageDoorHandlers(accessory) {
    const service = accessory.getService(Service.GarageDoorOpener);
    // GET current state: for simplicity, assume CLOSED.
    service.getCharacteristic(Characteristic.CurrentDoorState)
      .on('get', (callback) => {
        callback(null, Characteristic.CurrentDoorState.CLOSED);
      });
    // GET target state: assume CLOSED.
    service.getCharacteristic(Characteristic.TargetDoorState)
      .on('get', (callback) => {
        callback(null, Characteristic.CurrentDoorState.CLOSED);
      })
      .on('set', (value, callback) => {
        this.log.info("Setting Garage Door state for", accessory.displayName, "to", value);
        if (value === Characteristic.TargetDoorState.OPEN) {
          this.openGateForAccessory(accessory, (err) => {
            if (err) {
              callback(err);
            } else {
              // Update current state to OPEN.
              service.setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.OPEN);
              callback(null);
            }
          });
        } else {
          // For CLOSED, simply update the state.
          service.setCharacteristic(Characteristic.CurrentDoorState, Characteristic.CurrentDoorState.CLOSED);
          callback(null);
        }
      });
  }

  // Setup handlers for a switch accessory.
  setupSwitchHandlers(accessory) {
    const service = accessory.getService(Service.Switch);
    service.getCharacteristic(Characteristic.On)
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
              service.setCharacteristic(Characteristic.On, true);
              callback(null);
            }
          });
        } else {
          service.setCharacteristic(Characteristic.On, false);
          callback(null);
        }
      });
  }

  // Helper method to open the gate for a given accessory.
  openGateForAccessory(accessory, callback) {
    const { openGate } = require('./palGateApi.js');
    const deviceId = accessory.context.deviceId;
    const { generateToken } = require('./tokenGenerator.js');
    // Use the platform's global credentials to generate a temporary token.
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