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
        this.log.info("Configured gates: " + addedGateInfo);

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
    service.getCharacteristic(this.Characteristic.On)
      .on('get', (callback) => {
        callback(null, false);
      })
      .on('set', (value, callback) => {
        const state = value ? "open" : "closed";
        this.log.info("Setting Switch state for", accessory.displayName, "to", state);
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
    openGate(deviceId, temporalToken, (err, response) => {
      if (err) {
        this.log.error("Error opening:", accessory.displayName, ":", err.message);
        return callback(err);
      }
      this.log.info("Successfully opened:", accessory.displayName);
      callback(null);
    });
  }
}

module.exports = PalGatePlatform;