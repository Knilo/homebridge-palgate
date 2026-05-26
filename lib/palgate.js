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

    // Required configuration properties
    const requiredProps = ['token', 'phoneNumber', 'tokenType'];

    // Check for missing properties (allow tokenType === 0)
    const missingProps = requiredProps.filter(prop => {
      if (prop === 'tokenType') {
        return this.config[prop] === undefined || this.config[prop] === null;
      }
      return !this.config[prop];
    });

    if (missingProps.length > 0) {
      this.log.error(`Missing required configuration properties ${missingProps.join(', ')}. Please provide these in your platform config.`);
      return; 
    }

    this.api.on('didFinishLaunching', async () => {
      const isValid = await this.validatePlatformToken();
      if (!isValid) return;
    
      try {
        await this.discoverDevices();
      } catch (err) {
        this.log.error("Error during device discovery.", err.message);
      }
    });
  }

  async validatePlatformToken() {
    try {
      const { generateToken } = require('./token-gen.js');
      const temporalToken = generateToken(
        Buffer.from(this.token, 'hex'),
        parseInt(this.phoneNumber, 10),
        parseInt(this.tokenType, 10)
      );
      this.log.debug("Validating platform token using temporary token", temporalToken);
      const { validateToken } = require('./api.js');
      await validateToken(temporalToken);
      this.log.debug("Platform token successfully validated");
      return true;
    } catch (err) {
      this.log.error("Platform token validation failed. Please check your token, phone number, and token type.", err.message);
      return false;
    }
  }

  // Called when restoring cached accessories.
  configureAccessory(accessory) {
    this.log.info("Restoring cached gate", accessory.displayName);
    // Ensure the service handlers are (re)attached for cached accessories.
    const accessoryType = accessory.context.accessoryType;
    if (accessoryType === 'garageDoor') {
      this.setupGarageDoorHandlers(accessory);
    } else if (accessoryType === 'switch') {
      this.setupSwitchHandlers(accessory);
    } else if (accessoryType === 'lock') {
      this.setupLockHandlers(accessory);
    }
    this.accessories.push(accessory);
  }
  // Discover devices via the PalGate API.
  async discoverDevices() {
    const { generateToken } = require('./token-gen.js');
    let temporalToken;
    try {
      temporalToken = generateToken(
        Buffer.from(this.token, 'hex'),
        parseInt(this.phoneNumber, 10),
        parseInt(this.tokenType, 10)
      );
    } catch (err) {
      this.log.error("Failed to generate temporal token. Please check your configuration.", err.message);
      return;
    }
    this.log.debug("Generated temporal token for device discovery", temporalToken);
    const { getDevices } = require('./api.js');
    try {
      const response = await getDevices(temporalToken);
      const data = response;
      if (!data.devices || !Array.isArray(data.devices)) {
        throw new Error("Invalid devices response: missing devices array.");
      }
      this.log.debug("Discovered", data.devices.length, "gate(s)");

      const customGates = this.config.customGates || [];
      const { detectMultiOutputDevices, generateGateEntries } = require('./utils/helpers.js');

      // Process each discovered device.
      // Use flatMap because one device can produce multiple gate entries (for multi-output devices)
      let gates = data.devices.flatMap((deviceData) => {
        const deviceId = deviceData.id || deviceData._id;
        const defaultName = deviceData.name1 || deviceId;
        
        // Detect if this device has multiple outputs
        const outputs = detectMultiOutputDevices(deviceData);
        
        // Generate gate entries (one per output, or single entry for single-output device)
        const gateEntries = generateGateEntries(deviceId, outputs, defaultName, deviceData);
        
        // Process each gate entry and apply merge logic with customGates
        return gateEntries.map((gateEntry) => {
          const gateDeviceId = gateEntry.deviceId;
          const gateDefaultName = gateEntry.name;
          
          // Check if there's a custom config for this specific gate (deviceId or deviceId:outputNum)
          const custom = customGates.find(item => item.deviceId === gateDeviceId);

          if (custom) {
            // Remove any cached accessories for this gate.
            const cachedAccessories = this.accessories.filter(acc => acc.context.deviceId === gateDeviceId);
            if (cachedAccessories.length > 0) {
              this.api.unregisterPlatformAccessories("homebridge-palgate", "PalGatePlatform", cachedAccessories);
              this.log.info(`Removed cached accessory(ies) for gate ${gateDeviceId} due to updated custom configuration`);
              this.accessories = this.accessories.filter(acc => acc.context.deviceId !== gateDeviceId);
            }
            // If custom config specifies to hide the gate, do not add it.
            if (custom.hide === true) {
              return null;
            }
            // Use custom name if provided; otherwise, use the API name.
            const name = (custom.name && custom.name.trim().length > 0) ? custom.name : gateDefaultName;
            // Determine the accessory types as requested by the custom config.
            let exposeGarageDoor = custom.garageDoor === true;
            let exposeSwitch = custom.switch === true;
            let exposeLock = custom.lock === true;
            if (!exposeGarageDoor && !exposeSwitch && !exposeLock) {
              // Use the default accessoryType from the main config.
              if (this.accessoryType === 'garageDoor') {
                exposeGarageDoor = true;
              } else if (this.accessoryType === 'switch') {
                exposeSwitch = true;
              } else if (this.accessoryType === 'lock') {
                exposeLock = true;
              } else {
                // Fallback to garageDoor if the accessoryType is unknown.
                exposeGarageDoor = true;
              }
            }
            return { deviceId: gateDeviceId, name, exposeGarageDoor, exposeSwitch, exposeLock };
          } else {
            // No custom config: use default settings based on global accessoryType.
            let exposeGarageDoor = false;
            let exposeSwitch = false;
            let exposeLock = false;
            if (this.accessoryType === 'garageDoor') {
              exposeGarageDoor = true;
            } else if (this.accessoryType === 'switch') {
              exposeSwitch = true;
            } else if (this.accessoryType === 'lock') {
              exposeLock = true;
            } else {
              // Fallback to garageDoor if accessoryType is not recognized.
              exposeGarageDoor = true;
            }
            return { deviceId: gateDeviceId, name: gateDefaultName, exposeGarageDoor, exposeSwitch, exposeLock };
          }
        });
      }).filter(gate => gate !== null);

      // This section is added because when discovering devices from the API, if you have multiple gates
      // under the same device the code isn't handling that correctly. So we add any custom gates that are not discovered.
      const discoveredIds = gates.map(g => g.deviceId);
      const customOnly = customGates
        .filter(c => c.deviceId && c.deviceId.trim().length > 0 && !discoveredIds.includes(c.deviceId) && c.hide !== true)
        .map(c => {
          const name = (c.name && c.name.trim().length > 0) ? c.name : c.deviceId;
          let exposeGarageDoor = c.garageDoor === true;
          let exposeSwitch = c.switch === true;
          let exposeLock = c.lock === true;
          if (!exposeGarageDoor && !exposeSwitch && !exposeLock) {
            if (this.accessoryType === 'garageDoor') { exposeGarageDoor = true; }
            else if (this.accessoryType === 'switch') { exposeSwitch = true; }
            else if (this.accessoryType === 'lock') { exposeLock = true; }
            else { exposeGarageDoor = true; }
          }
          return { deviceId: c.deviceId, name, exposeGarageDoor, exposeSwitch, exposeLock };
        });

      if (customOnly.length > 0) {
        this.log.info(`Added ${customOnly.length} custom-only gate(s) that were not discovered from API`);
      }

      gates = gates.concat(customOnly);
      this.gates = gates;
      
      // Create or update accessories for each gate.
      this.gates.forEach(gate => {
        if (gate.exposeGarageDoor) {
          this.createAccessoryForGate(gate, "garageDoor");
        }
        if (gate.exposeSwitch) {
          this.createAccessoryForGate(gate, "switch");
        }
        if (gate.exposeLock) {
          this.createAccessoryForGate(gate, "lock");
        }
      });

      // Remove any cached accessories for device/type combinations that are no longer discovered.
      const keepKeys = this.gates.flatMap(gate => {
        const keys = [];
        if (gate.exposeGarageDoor) {
          keys.push(`${gate.deviceId}|garageDoor`);
        }
        if (gate.exposeSwitch) {
          keys.push(`${gate.deviceId}|switch`);
        }
        if (gate.exposeLock) {
          keys.push(`${gate.deviceId}|lock`);
        }
        return keys;
      });

      this.accessories.forEach(acc => {
        const accKey = `${acc.context.deviceId}|${acc.context.accessoryType}`;
        if (!keepKeys.includes(accKey)) {
          this.api.unregisterPlatformAccessories("homebridge-palgate", "PalGatePlatform", [acc]);
          this.log.info(`Removed accessory ${acc.context.name} (${acc.context.deviceId}) because it was not found in the latest device list or configuration`);
        }
      });
      this.accessories = this.accessories.filter(acc => keepKeys.includes(`${acc.context.deviceId}|${acc.context.accessoryType}`));
      const configuredAccessoryInfo = this.accessories.map(acc =>
        `${acc.context.name} [${acc.context.accessoryType}] (ID: ${acc.context.deviceId})`
      ).join(', ');
      if (configuredAccessoryInfo) {
      this.log.success("Configured gate accessory(ies)", configuredAccessoryInfo);
      } else {
        this.log.info("No gate accessories configured");
      }

    } catch (err) {
      this.log.error("Error retrieving devices. Please check your configuration and ensure your token is valid.", err.message);
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
        let svc;
        if (type === "garageDoor") {
          svc = accessory.getService(this.Service.GarageDoorOpener);
        } else if (type === "lock") {
          svc = accessory.getService(this.Service.LockMechanism);
        } else {
          svc = accessory.getService(this.Service.Switch);
        }
        if (svc) {
          svc.setCharacteristic(this.Characteristic.Name, desiredName);
        }
        this.log.info("Updated accessory name to", desiredName);
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
    } else if (type === "lock") {
      accessory.addService(this.Service.LockMechanism, desiredName);
      this.setupLockHandlers(accessory);
    } else {
      accessory.addService(this.Service.Switch, desiredName);
      this.setupSwitchHandlers(accessory);
    }
    // Add or update the AccessoryInformation service:
    // Ensure the AccessoryInformation service is added.
    let infoService = accessory.getService(this.Service.AccessoryInformation);
    if (!infoService) {
      infoService = accessory.addService(this.Service.AccessoryInformation);
    }

    let packageJson;
    try {
      packageJson = require('../package.json');
    } catch (err) {
      this.log.error("Failed to load package information", err.message);
      return;
    }
    
    infoService
      .setCharacteristic(this.Characteristic.Manufacturer, 'PAL Electronics Systems Ltd.')
      .setCharacteristic(this.Characteristic.Model, type)
      .setCharacteristic(this.Characteristic.SerialNumber, gate.deviceId)
      .setCharacteristic(this.Characteristic.FirmwareRevision, packageJson.version);

    this.api.registerPlatformAccessories("homebridge-palgate", "PalGatePlatform", [accessory]);
    this.log.debug("Registered new gate accessory", desiredName);


    this.accessories.push(accessory);
  }

  setupGarageDoorHandlers(accessory) {
    const service = accessory.getService(this.Service.GarageDoorOpener);

    if (!service) {
      this.log.error("GarageDoorOpener service not found for", accessory.displayName);
      return;
    }

    // Get the configurable gate close delay (in ms) from the config, defaulting to 5000 ms.
    const closeDelay = this.config.gateCloseDelay ? parseInt(this.config.gateCloseDelay, 10) : 5000;

    // Initialize door state if not already set.
    if (accessory.context.currentDoorState === undefined) {
      accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
    }
    if (accessory.context.targetDoorState === undefined) {
      accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
    }

    // Get handlers return the stored state.
    service.getCharacteristic(this.Characteristic.CurrentDoorState)
      .on('get', (callback) => {
        callback(null, accessory.context.currentDoorState);
      });

    service.getCharacteristic(this.Characteristic.TargetDoorState)
      .on('get', (callback) => {
        callback(null, accessory.context.targetDoorState);
      })
      .on('set', (value, callback) => {
        if (value === this.Characteristic.TargetDoorState.OPEN) {
          this.log.info("Triggering garage door for", accessory.displayName);
          this.openGateForAccessory(accessory, (err) => {
            if (err) {
              return callback(err);
            }
            // Update state to open.
            accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPEN;
            accessory.context.targetDoorState = this.Characteristic.TargetDoorState.OPEN;
            service.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPEN);
            // After a delay, simulate the door closing.
            setTimeout(() => {
              accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
              accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
              service.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
              service.setCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
              this.log.info("Garage door closed for", accessory.displayName);
            }, closeDelay);
            callback(null);
          });
        } else {
          // If a closed command is received, immediately update the state.
          accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
          accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
          service.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
          callback(null);
        }
      });
  }

  setupSwitchHandlers(accessory) {
    const service = accessory.getService(this.Service.Switch);

    if (!service) {
      this.log.error("Switch service not found for", accessory.displayName);
      return;
    }

    // For a stateless switch, always return "off".
    service.getCharacteristic(this.Characteristic.On)
      .on('get', (callback) => {
        callback(null, false);
      })
      .on('set', (value, callback) => {
        if (value) {
          this.log.info("Triggering gate via switch for", accessory.displayName);
          // Trigger the action.
          this.openGateForAccessory(accessory, (err) => {
            // Reset the switch to off after the action completes.
            service.setCharacteristic(this.Characteristic.On, false);
            callback(err);
          });
        } else {
          // If turning off, simply confirm.
          callback(null);
        }
      });
  }

  setupLockHandlers(accessory) {
    const service = accessory.getService(this.Service.LockMechanism);

    if (!service) {
      this.log.error("LockMechanism service not found for", accessory.displayName);
      return;
    }

    // Get the configurable gate close delay (in ms) from the config, defaulting to 5000 ms.
    const closeDelay = this.config.gateCloseDelay ? parseInt(this.config.gateCloseDelay, 10) : 5000;

    // Initialize lock state if not already set.
    if (accessory.context.lockCurrentState === undefined) {
      accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
    }
    if (accessory.context.lockTargetState === undefined) {
      accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
    }

    // Get handlers return the stored state.
    service.getCharacteristic(this.Characteristic.LockCurrentState)
      .on('get', (callback) => {
        callback(null, accessory.context.lockCurrentState);
      });

    service.getCharacteristic(this.Characteristic.LockTargetState)
      .on('get', (callback) => {
        callback(null, accessory.context.lockTargetState);
      })
      .on('set', (value, callback) => {
        if (value === this.Characteristic.LockTargetState.UNSECURED) {
          this.log.info("Unlocking gate for", accessory.displayName);
          this.openGateForAccessory(accessory, (err) => {
            if (err) {
              return callback(err);
            }
            // Update state to unlocked (unsecured).
            accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.UNSECURED;
            accessory.context.lockTargetState = this.Characteristic.LockTargetState.UNSECURED;
            service.setCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.UNSECURED);
            
            // After a delay, simulate the lock securing again.
            setTimeout(() => {
              accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
              accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
              service.setCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
              service.setCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
              this.log.info("Gate secured (relocked) for", accessory.displayName);
            }, closeDelay);
            callback(null);
          });
        } else {
          // If a secure (lock) command is received, immediately update the state.
          accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
          accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
          service.setCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
          callback(null);
        }
      });
  }

  openGateForAccessory(accessory, callback) {
    this.log.debug("Opening gate for", accessory.displayName, "...");
    try {
      const { openGate } = require('./api.js');
      const deviceId = accessory.context.deviceId;
      const { generateToken } = require('./token-gen.js');
      const temporalToken = generateToken(
        Buffer.from(this.token, 'hex'),
        parseInt(this.phoneNumber, 10),
        parseInt(this.tokenType, 10)
      );
      this.log.debug("Using temporary token for", accessory.displayName, temporalToken);
      openGate(deviceId, temporalToken)
        .then((response) => {
          this.log.success("Successfully opened gate for", accessory.displayName);
          callback(null);
        })
        .catch((err) => {
          this.log.error("Failed to open gate for", accessory.displayName, err.message);
          callback(err);
        });
    } catch (err) {
      this.log.error("Failed to open gate for", accessory.displayName, err.message);
      callback(err);
    }
  }
}

module.exports = PalGatePlatform;
