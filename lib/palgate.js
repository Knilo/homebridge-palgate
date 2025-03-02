'use strict';

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
    validateToken(temporalToken)
      .then((response) => {
        this.log.debug("Platform token validated successfully.");
      })
      .catch((err) => {
        this.log.error("Platform token validation failed:", err.message);
      });

    // Discover devices after Homebridge has finished launching.
    this.api.on('didFinishLaunching', () => {
      this.discoverDevices();
    });
  }

  // Called when restoring cached accessories.
  configureAccessory(accessory) {
    this.log.info("Restoring cached gate:", accessory.displayName);
    // Ensure the service handlers are (re)attached for cached accessories.
    const accessoryType = accessory.context.accessoryType;
    if (accessoryType === 'garageDoor') {
      this.setupGarageDoorHandlers(accessory);
    } else if (accessoryType === 'switch') {
      this.setupSwitchHandlers(accessory);
    }
    this.accessories.push(accessory);
  }
  // Discover devices via the PalGate API.
  async discoverDevices() {
    const { generateToken } = require('./token-gen.js');
    const temporalToken = generateToken(
      Buffer.from(this.token, 'hex'),
      parseInt(this.phoneNumber, 10),
      parseInt(this.tokenType, 10)
    );
    this.log.debug("Generated temporal token for device discovery:", temporalToken);
    const { getDevices } = require('./api.js');
    try {
      const response = await getDevices(temporalToken);
      const data = response;
      if (!data.devices || !Array.isArray(data.devices)) {
        throw new Error("Invalid devices response: missing devices array.");
      }
      this.log.debug("Discovered", data.devices.length, "gate(s).");

      const customGates = this.config.customGates || [];

      // Process each discovered device.
      this.gates = data.devices.map((deviceData) => {
        const deviceId = deviceData.id || deviceData._id;
        const defaultName = deviceData.name1 || deviceId;
        const custom = customGates.find(item => item.deviceId === deviceId);

        if (custom) {
          // Remove any cached accessories for this device.
          const cachedAccessories = this.accessories.filter(acc => acc.context.deviceId === deviceId);
          if (cachedAccessories.length > 0) {
            this.api.unregisterPlatformAccessories("homebridge-palgate", "PalGatePlatform", cachedAccessories);
            this.log.info(`Removed cached accessory(ies) for device ${deviceId} due to updated custom configuration.`);
            this.accessories = this.accessories.filter(acc => acc.context.deviceId !== deviceId);
          }
          // If custom config specifies to hide the gate, do not add it.
          if (custom.hide === true) {
            return null;
          }
          // Use custom name if provided; otherwise, use the API name.
          const name = (custom.name && custom.name.trim().length > 0) ? custom.name : defaultName;
          // Determine the accessory types as requested by the custom config.
          const exposeGarageDoor = custom.garageDoor === true;
          const exposeSwitch = custom.switch === true;
          return { deviceId, name, exposeGarageDoor, exposeSwitch };
        } else {
          // No custom config: use default settings (garageDoor with API name).
          return { deviceId, name: defaultName, exposeGarageDoor: true, exposeSwitch: false };
        }
      }).filter(gate => gate !== null);

      // Create or update accessories for each gate.
      this.gates.forEach(gate => {
        if (gate.exposeGarageDoor) {
          this.createAccessoryForGate(gate, "garageDoor");
        }
        if (gate.exposeSwitch) {
          this.createAccessoryForGate(gate, "switch");
        }
      });

      // Remove any cached accessories for devices that are no longer discovered.
      const discoveredIds = this.gates.map(g => g.deviceId);
      this.accessories.forEach(acc => {
        if (!discoveredIds.includes(acc.context.deviceId)) {
          this.api.unregisterPlatformAccessories("homebridge-palgate", "PalGatePlatform", [acc]);
          this.log.info(`Removed accessory for device ${acc.context.deviceId} as it is no longer discovered.`);
        }
      });
      this.accessories = this.accessories.filter(acc => discoveredIds.includes(acc.context.deviceId));
      const addedGateInfo = this.gates.map(g => `${g.name} (ID: ${g.deviceId})`).join(', ');
      if (addedGateInfo) {
        this.log.success("Configured gates: " + addedGateInfo);
      } else {
        this.log.info("No gates configured.");
      }

    } catch (err) {
      this.log.error("Error retrieving devices:", err.message);
    }

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
        callback(null, this.Characteristic.TargetDoorState.CLOSED);
      })
      .on('set', (value, callback) => {
        const state = (value === this.Characteristic.TargetDoorState.OPEN) ? "open" : "closed";
        this.log.info("Setting Garage Door state for", accessory.displayName, "to", state);
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
  
    // Initialize state if not already defined.
    if (accessory.context.switchState === undefined) {
      accessory.context.switchState = false;
    }
    if (accessory.context.isOpening === undefined) {
      accessory.context.isOpening = false;
    }
  
    service.getCharacteristic(this.Characteristic.On)
      .on('get', (callback) => {
        callback(null, accessory.context.switchState);
      })
      .on('set', (value, callback) => {
        // If an open operation is already in progress and the command is to open, ignore duplicate command.
        if (value && accessory.context.isOpening) {
          return callback(null);
        }
        // If the requested value matches the current state, ignore duplicate command.
        if (value === accessory.context.switchState) {
          return callback(null);
        }
  
        const desiredState = value ? "open" : "closed";
        this.log.info("Setting Switch state for", accessory.displayName, "to", desiredState);
  
        if (value) {
          accessory.context.isOpening = true;
          // Optimistically update state so that subsequent get calls report "open."
          accessory.context.switchState = true;
          service.setCharacteristic(this.Characteristic.On, true);
          this.openGateForAccessory(accessory, (err) => {
            accessory.context.isOpening = false;
            if (err) {
              // Revert state if there was an error.
              accessory.context.switchState = false;
              service.setCharacteristic(this.Characteristic.On, false);
              return callback(err);
            }
            this.log.debug("Switch set to on for", accessory.displayName);
            callback(null);
          });
        } else {
          // For turning off, update state immediately.
          accessory.context.switchState = false;
          service.setCharacteristic(this.Characteristic.On, false);
          callback(null);
        }
      });
  }

  openGateForAccessory(accessory, callback) {
    this.log.debug("Opening ", accessory.displayName);
    const { openGate } = require('./api.js');
    const deviceId = accessory.context.deviceId;
    const { generateToken } = require('./token-gen.js');
    const temporalToken = generateToken(
      Buffer.from(this.token, 'hex'),
      parseInt(this.phoneNumber, 10),
      parseInt(this.tokenType, 10)
    );
    this.log.debug("Using temporal token for ", accessory.displayName, ":", temporalToken);
    openGate(deviceId, temporalToken)
      .then((response) => {
        this.log.success("Successfully opened:", accessory.displayName);
        callback(null);
      })
      .catch((err) => {
        this.log.error("Error opening:", accessory.displayName, ":", err.message);
        callback(err);
      });
  }
}

module.exports = PalGatePlatform;