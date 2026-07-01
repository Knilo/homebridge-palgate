'use strict';

const packageJson = require('../package.json');
const { splitDeviceId } = require('./utils/helpers.js');

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
        this.startStatusPoller();
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
      this.log.debug("Validating platform token");
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
    } else if (accessoryType === 'holdOpenLock') {
      this.setupHoldOpenLockHandlers(accessory);
    } else if (accessoryType === 'holdClosedLock') {
      this.setupHoldClosedLockHandlers(accessory);
    } else if (accessoryType === 'holdOpenSwitch') {
      this.setupHoldOpenSwitchHandlers(accessory);
    } else if (accessoryType === 'holdClosedSwitch') {
      this.setupHoldClosedSwitchHandlers(accessory);
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
    this.log.debug("Generated temporal token for device discovery");
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
          
          const { outputNum } = splitDeviceId(gateDeviceId);

          // Check if there's a custom config for this specific gate (deviceId or deviceId:outputNum)
          const custom = customGates.find(item => item.deviceId === gateDeviceId);

          if (custom) {
            // Only remove cached accessories if the custom config has actually changed.
            const configSnapshot = JSON.stringify(custom);
            const cachedAccessories = this.accessories.filter(acc => acc.context.deviceId === gateDeviceId);
            const configChanged = cachedAccessories.some(acc => acc.context.customConfigSnapshot !== configSnapshot);
            if (cachedAccessories.length > 0 && configChanged) {
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
            let exposeGarageDoor = custom.garageDoor === true;
            let exposeSwitch = custom.switch === true;
            let exposeLock = custom.lock === true;
            if (!exposeGarageDoor && !exposeSwitch && !exposeLock) {
              ({ exposeGarageDoor, exposeSwitch, exposeLock } = this._resolveDefaultExposeFlags());
            }
            const { exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch } = this._resolveRelayFlags(custom, deviceData, outputNum);

            return { deviceId: gateDeviceId, name, exposeGarageDoor, exposeSwitch, exposeLock, exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, deviceData, customConfigSnapshot: configSnapshot };
          } else {
            const { exposeGarageDoor, exposeSwitch, exposeLock } = this._resolveDefaultExposeFlags();
            const { exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch } = this._resolveRelayFlags(null, deviceData, outputNum);
            return { deviceId: gateDeviceId, name: gateDefaultName, exposeGarageDoor, exposeSwitch, exposeLock, exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, deviceData };
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
            ({ exposeGarageDoor, exposeSwitch, exposeLock } = this._resolveDefaultExposeFlags());
          }
          const { exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch } = this._resolveRelayFlags(c, null, 1);

          return { deviceId: c.deviceId, name, exposeGarageDoor, exposeSwitch, exposeLock,
            exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch };
        });

      if (customOnly.length > 0) {
        this.log.info(`Added ${customOnly.length} custom-only gate(s) that were not discovered from API`);
      }

      gates = gates.concat(customOnly);
      this.gates = gates;
      
      // Create or update accessories for each gate.
      this.gates.forEach(gate => {
        if (gate.exposeGarageDoor) {
          this.createAccessoryForGate(gate, "garageDoor", gate.deviceData);
        }
        if (gate.exposeSwitch) {
          this.createAccessoryForGate(gate, "switch", gate.deviceData);
        }
        if (gate.exposeLock) {
          this.createAccessoryForGate(gate, "lock", gate.deviceData);
        }
        if (gate.exposeHoldOpenLock) {
          this.createAccessoryForGate(gate, "holdOpenLock", gate.deviceData);
        }
        if (gate.exposeHoldClosedLock) {
          this.createAccessoryForGate(gate, "holdClosedLock", gate.deviceData);
        }
        if (gate.exposeHoldOpenSwitch) {
          this.createAccessoryForGate(gate, "holdOpenSwitch", gate.deviceData);
        }
        if (gate.exposeHoldClosedSwitch) {
          this.createAccessoryForGate(gate, "holdClosedSwitch", gate.deviceData);
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
        if (gate.exposeHoldOpenLock) {
          keys.push(`${gate.deviceId}|holdOpenLock`);
        }
        if (gate.exposeHoldClosedLock) {
          keys.push(`${gate.deviceId}|holdClosedLock`);
        }
        if (gate.exposeHoldOpenSwitch) {
          keys.push(`${gate.deviceId}|holdOpenSwitch`);
        }
        if (gate.exposeHoldClosedSwitch) {
          keys.push(`${gate.deviceId}|holdClosedSwitch`);
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


  createAccessoryForGate(gate, type, deviceData) {
    // Use the instance's UUIDGen instead of the global variable.
    const uuid = this.UUIDGen.generate(gate.deviceId + "_" + type);
    const desiredName = (gate.name && gate.name.trim() !== "") ? gate.name : gate.deviceId;
    let accessory = this.accessories.find(acc => acc.UUID === uuid);
    const getAccessoryName = () => {
      if (type === "holdOpenLock" || type === "holdOpenSwitch") return `${desiredName} Hold Open`;
      if (type === "holdClosedLock" || type === "holdClosedSwitch") return `${desiredName} Hold Closed`;
      return desiredName;
    };
    const finalName = getAccessoryName();

    if (accessory) {
      if (accessory.displayName !== finalName) {
        accessory.displayName = finalName;
        accessory.context.name = finalName;
        let svc;
        if (type === "garageDoor") {
          svc = accessory.getService(this.Service.GarageDoorOpener);
        } else if (type === "lock" || type === "holdOpenLock" || type === "holdClosedLock") {
          svc = accessory.getService(this.Service.LockMechanism);
        } else {
          svc = accessory.getService(this.Service.Switch);
        }
        if (svc) {
          svc.setCharacteristic(this.Characteristic.Name, finalName);
        }
        this.log.info("Updated accessory name to", finalName);
      }
      return;
    }

    accessory = new this.api.platformAccessory(finalName, uuid);
    accessory.context.deviceId = gate.deviceId;
    accessory.context.name = finalName;
    accessory.context.accessoryType = type;
    if (gate.customConfigSnapshot !== undefined) {
      accessory.context.customConfigSnapshot = gate.customConfigSnapshot;
    }

    if (type === "garageDoor") {
      accessory.addService(this.Service.GarageDoorOpener, finalName);
      this.setupGarageDoorHandlers(accessory);
    } else if (type === "lock") {
      accessory.addService(this.Service.LockMechanism, finalName);
      this.setupLockHandlers(accessory);
    } else if (type === "holdOpenLock") {
      accessory.addService(this.Service.LockMechanism, finalName);
      this.setupHoldOpenLockHandlers(accessory, deviceData);
    } else if (type === "holdClosedLock") {
      accessory.addService(this.Service.LockMechanism, finalName);
      this.setupHoldClosedLockHandlers(accessory, deviceData);
    } else if (type === "holdOpenSwitch") {
      accessory.addService(this.Service.Switch, finalName);
      this.setupHoldOpenSwitchHandlers(accessory, deviceData);
    } else if (type === "holdClosedSwitch") {
      accessory.addService(this.Service.Switch, finalName);
      this.setupHoldClosedSwitchHandlers(accessory, deviceData);
    } else {
      accessory.addService(this.Service.Switch, finalName);
      this.setupSwitchHandlers(accessory);
    }
    // Add or update the AccessoryInformation service:
    // Ensure the AccessoryInformation service is added.
    let infoService = accessory.getService(this.Service.AccessoryInformation);
    if (!infoService) {
      infoService = accessory.addService(this.Service.AccessoryInformation);
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

    const deviceId = accessory.context.deviceId;
    const { openingDelay, gateCloseDelay } = this._resolveDelays(deviceId);

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

            // Cancel any in-progress timer chain from a previous trigger
            if (accessory.context._doorTimers) {
              accessory.context._doorTimers.forEach(clearTimeout);
            }

            // Phase 1: Set to OPENING immediately
            accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPENING;
            accessory.context.targetDoorState = this.Characteristic.TargetDoorState.OPEN;
            service.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPENING);

            this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, openingDelay + gateCloseDelay);

            // Phase 2: Transition to fully OPEN after openingDelay
            const t1 = setTimeout(() => {
              accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPEN;
              service.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPEN);
              this.log.info("Garage door fully open for", accessory.displayName);

              // Phase 3: Transition to CLOSED after gateCloseDelay
              const t2 = setTimeout(() => {
                accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
                accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
                service.setCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
                service.setCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
                this.log.info("Garage door closed for", accessory.displayName);
                accessory.context._doorTimers = null;
              }, gateCloseDelay);

              accessory.context._doorTimers = [t2];
            }, openingDelay);

            accessory.context._doorTimers = [t1];
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

    const deviceId = accessory.context.deviceId;
    const { openingDelay, gateCloseDelay } = this._resolveDelays(deviceId);
    const cumulativeDelay = openingDelay + gateCloseDelay;

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
            if (err) {
              return callback(err);
            }
            callback(null);
            this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, cumulativeDelay);

            // Cancel any in-progress auto-off timer from a previous trigger
            if (accessory.context._switchTimer) {
              clearTimeout(accessory.context._switchTimer);
            }
            accessory.context._switchTimer = setTimeout(() => {
              service.setCharacteristic(this.Characteristic.On, false);
              this.log.info("Switch auto-off reset for", accessory.displayName);
              accessory.context._switchTimer = null;
            }, cumulativeDelay);
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

    const deviceId = accessory.context.deviceId;
    const { openingDelay, gateCloseDelay } = this._resolveDelays(deviceId);
    const cumulativeDelay = openingDelay + gateCloseDelay;

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

            this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, cumulativeDelay);

            // Cancel any in-progress relock timer from a previous trigger
            if (accessory.context._lockTimer) {
              clearTimeout(accessory.context._lockTimer);
            }
            accessory.context._lockTimer = setTimeout(() => {
              accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
              accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
              service.setCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
              service.setCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
              this.log.info("Gate secured (relocked) for", accessory.displayName);
              accessory.context._lockTimer = null;
            }, cumulativeDelay);
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

  setupHoldOpenLockHandlers(accessory, deviceData) {
    const service = accessory.getService(this.Service.LockMechanism);
    if (!service) {
      this.log.error("LockMechanism service not found for Hold Open Lock on", accessory.displayName);
      return;
    }

    if (accessory.context.lockCurrentState === undefined) {
      let initialState = this.Characteristic.LockCurrentState.UNSECURED;
      if (deviceData) {
        const deviceId = accessory.context.deviceId;
        const { outputNum } = splitDeviceId(deviceId);
        const latchStatus = outputNum === 2 ? deviceData.output2LatchStatus === true : deviceData.output1LatchStatus === true;
        const isDisabled = outputNum === 2 ? deviceData.output2Disabled === true : deviceData.output1Disabled === true;
        if (latchStatus && isDisabled) {
          initialState = this.Characteristic.LockCurrentState.SECURED;
        }
      }
      accessory.context.lockCurrentState = initialState;
    }
    if (accessory.context.lockTargetState === undefined) {
      accessory.context.lockTargetState = accessory.context.lockCurrentState;
    }

    // Explicitly initialize HomeKit characteristic values on startup
    service.updateCharacteristic(this.Characteristic.LockCurrentState, accessory.context.lockCurrentState);
    service.updateCharacteristic(this.Characteristic.LockTargetState, accessory.context.lockTargetState);

    service.getCharacteristic(this.Characteristic.LockCurrentState)
      .on('get', (callback) => {
        callback(null, accessory.context.lockCurrentState);
      });

    service.getCharacteristic(this.Characteristic.LockTargetState)
      .on('get', (callback) => {
        callback(null, accessory.context.lockTargetState);
      })
      .on('set', (value, callback) => {
        if (accessory.context.lockCurrentState === value) {
          return callback(null); // Prevent duplicate API requests if state already matches
        }
        const isLatching = value === this.Characteristic.LockTargetState.SECURED;
        this.log.info(`${isLatching ? 'Locking (latching)' : 'Unlocking (normal)'} Hold Open for`, accessory.displayName);
        this.setRelayMode(accessory, isLatching ? 'hold_open' : 'normal_from_open', (err) => {
          if (err) return callback(err);
          accessory.context.lockCurrentState = value;
          accessory.context.lockTargetState = value;
          service.updateCharacteristic(this.Characteristic.LockCurrentState, value);

          // If Hold Open is locked (active), ensure Hold Closed is unlocked
          if (isLatching) {
            this.syncCompanionLock(accessory, 'holdClosedLock', this.Characteristic.LockCurrentState.UNSECURED);
            this.syncCompanionSwitch(accessory, 'holdClosedSwitch', false);
          }
          // Sync its own switch counterpart
          this.syncCompanionSwitch(accessory, 'holdOpenSwitch', isLatching);
          callback(null);
        });
      });
  }

  setupHoldClosedLockHandlers(accessory, deviceData) {
    const service = accessory.getService(this.Service.LockMechanism);
    if (!service) {
      this.log.error("LockMechanism service not found for Hold Closed Lock on", accessory.displayName);
      return;
    }

    if (accessory.context.lockCurrentState === undefined) {
      let initialState = this.Characteristic.LockCurrentState.UNSECURED;
      if (deviceData) {
        const deviceId = accessory.context.deviceId;
        const { outputNum } = splitDeviceId(deviceId);
        const latchStatus = outputNum === 2 ? deviceData.output2LatchStatus === true : deviceData.output1LatchStatus === true;
        const isDisabled = outputNum === 2 ? deviceData.output2Disabled === true : deviceData.output1Disabled === true;
        if (!latchStatus && isDisabled) {
          initialState = this.Characteristic.LockCurrentState.SECURED;
        }
      }
      accessory.context.lockCurrentState = initialState;
    }
    if (accessory.context.lockTargetState === undefined) {
      accessory.context.lockTargetState = accessory.context.lockCurrentState;
    }

    // Explicitly initialize HomeKit characteristic values on startup
    service.updateCharacteristic(this.Characteristic.LockCurrentState, accessory.context.lockCurrentState);
    service.updateCharacteristic(this.Characteristic.LockTargetState, accessory.context.lockTargetState);

    service.getCharacteristic(this.Characteristic.LockCurrentState)
      .on('get', (callback) => {
        callback(null, accessory.context.lockCurrentState);
      });

    service.getCharacteristic(this.Characteristic.LockTargetState)
      .on('get', (callback) => {
        callback(null, accessory.context.lockTargetState);
      })
      .on('set', (value, callback) => {
        if (accessory.context.lockCurrentState === value) {
          return callback(null); // Prevent duplicate API requests if state already matches
        }
        const isLatching = value === this.Characteristic.LockTargetState.SECURED;
        this.log.info(`${isLatching ? 'Locking (latching)' : 'Unlocking (normal)'} Hold Closed for`, accessory.displayName);
        this.setRelayMode(accessory, isLatching ? 'hold_closed' : 'normal_from_closed', (err) => {
          if (err) return callback(err);
          accessory.context.lockCurrentState = value;
          accessory.context.lockTargetState = value;
          service.updateCharacteristic(this.Characteristic.LockCurrentState, value);

          // If Hold Closed is locked (active), ensure Hold Open is unlocked
          if (isLatching) {
            this.syncCompanionLock(accessory, 'holdOpenLock', this.Characteristic.LockCurrentState.UNSECURED);
            this.syncCompanionSwitch(accessory, 'holdOpenSwitch', false);
          }
          // Sync its own switch counterpart
          this.syncCompanionSwitch(accessory, 'holdClosedSwitch', isLatching);
          callback(null);
        });
      });
  }

  setupHoldOpenSwitchHandlers(accessory, deviceData) {
    const service = accessory.getService(this.Service.Switch);
    if (!service) {
      this.log.error("Switch service not found for Hold Open Switch on", accessory.displayName);
      return;
    }

    if (accessory.context.switchState === undefined) {
      let initialState = false;
      if (deviceData) {
        const deviceId = accessory.context.deviceId;
        const { outputNum } = splitDeviceId(deviceId);
        const latchStatus = outputNum === 2 ? deviceData.output2LatchStatus === true : deviceData.output1LatchStatus === true;
        const isDisabled = outputNum === 2 ? deviceData.output2Disabled === true : deviceData.output1Disabled === true;
        if (latchStatus && isDisabled) {
          initialState = true;
        }
      }
      accessory.context.switchState = initialState;
    }

    service.updateCharacteristic(this.Characteristic.On, accessory.context.switchState);

    service.getCharacteristic(this.Characteristic.On)
      .on('get', (callback) => {
        callback(null, accessory.context.switchState);
      })
      .on('set', (value, callback) => {
        if (accessory.context.switchState === value) {
          return callback(null);
        }
        this.log.info(`${value ? 'Turning On' : 'Turning Off'} Hold Open Switch for`, accessory.displayName);
        this.setRelayMode(accessory, value ? 'hold_open' : 'normal_from_open', (err) => {
          if (err) return callback(err);
          accessory.context.switchState = value;
          service.updateCharacteristic(this.Characteristic.On, value);

          if (value) {
            this.syncCompanionSwitch(accessory, 'holdClosedSwitch', false);
            this.syncCompanionLock(accessory, 'holdClosedLock', this.Characteristic.LockCurrentState.UNSECURED);
          }
          // Sync its own lock counterpart
          this.syncCompanionLock(accessory, 'holdOpenLock', value ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED);
          callback(null);
        });
      });
  }

  setupHoldClosedSwitchHandlers(accessory, deviceData) {
    const service = accessory.getService(this.Service.Switch);
    if (!service) {
      this.log.error("Switch service not found for Hold Closed Switch on", accessory.displayName);
      return;
    }

    if (accessory.context.switchState === undefined) {
      let initialState = false;
      if (deviceData) {
        const deviceId = accessory.context.deviceId;
        const { outputNum } = splitDeviceId(deviceId);
        const latchStatus = outputNum === 2 ? deviceData.output2LatchStatus === true : deviceData.output1LatchStatus === true;
        const isDisabled = outputNum === 2 ? deviceData.output2Disabled === true : deviceData.output1Disabled === true;
        if (!latchStatus && isDisabled) {
          initialState = true;
        }
      }
      accessory.context.switchState = initialState;
    }

    service.updateCharacteristic(this.Characteristic.On, accessory.context.switchState);

    service.getCharacteristic(this.Characteristic.On)
      .on('get', (callback) => {
        callback(null, accessory.context.switchState);
      })
      .on('set', (value, callback) => {
        if (accessory.context.switchState === value) {
          return callback(null);
        }
        this.log.info(`${value ? 'Turning On' : 'Turning Off'} Hold Closed Switch for`, accessory.displayName);
        this.setRelayMode(accessory, value ? 'hold_closed' : 'normal_from_closed', (err) => {
          if (err) return callback(err);
          accessory.context.switchState = value;
          service.updateCharacteristic(this.Characteristic.On, value);

          if (value) {
            this.syncCompanionSwitch(accessory, 'holdOpenSwitch', false);
            this.syncCompanionLock(accessory, 'holdOpenLock', this.Characteristic.LockCurrentState.UNSECURED);
          }
          // Sync its own lock counterpart
          this.syncCompanionLock(accessory, 'holdClosedLock', value ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED);
          callback(null);
        });
      });
  }

  syncCompanionLock(accessory, companionType, targetValue) {
    const baseId = accessory.context.deviceId;
    const companion = this.accessories.find(acc => acc.context.deviceId === baseId && acc.context.accessoryType === companionType);
    if (companion) {
      const companionService = companion.getService(this.Service.LockMechanism);
      if (companionService && companion.context.lockCurrentState !== targetValue) {
        companion.context.lockCurrentState = targetValue;
        companion.context.lockTargetState = targetValue;
        companionService.updateCharacteristic(this.Characteristic.LockCurrentState, targetValue);
        companionService.updateCharacteristic(this.Characteristic.LockTargetState, targetValue);
        this.log.debug(`Synced companion lock ${companionType} to target value ${targetValue}`);
      }
    }
  }

  syncCompanionSwitch(accessory, companionType, targetValue) {
    const baseId = accessory.context.deviceId;
    const companion = this.accessories.find(acc => acc.context.deviceId === baseId && acc.context.accessoryType === companionType);
    if (companion) {
      const companionService = companion.getService(this.Service.Switch);
      if (companionService && companion.context.switchState !== targetValue) {
        companion.context.switchState = targetValue;
        companionService.updateCharacteristic(this.Characteristic.On, targetValue);
        this.log.debug(`Synced companion switch ${companionType} to target value ${targetValue}`);
      }
    }
  }

  syncPrimaryAccessories(sourceAccessory, openingDelay, gateCloseDelay, cumulativeDelay) {
    const baseId = sourceAccessory.context.deviceId;
    this.accessories.forEach(companion => {
      if (companion.context.deviceId === baseId && companion.UUID !== sourceAccessory.UUID) {
        const type = companion.context.accessoryType;

        if (type === 'garageDoor') {
          const service = companion.getService(this.Service.GarageDoorOpener);
          if (service) {
            companion.context.currentDoorState = this.Characteristic.CurrentDoorState.OPENING;
            companion.context.targetDoorState = this.Characteristic.TargetDoorState.OPEN;
            service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPENING);
            service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.OPEN);

            setTimeout(() => {
              companion.context.currentDoorState = this.Characteristic.CurrentDoorState.OPEN;
              service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPEN);
              setTimeout(() => {
                companion.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
                companion.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
                service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
                service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
              }, gateCloseDelay);
            }, openingDelay);
            this.log.debug(`Synced companion garageDoor to OPEN for ${sourceAccessory.displayName}`);
          }
        } else if (type === 'switch') {
          const service = companion.getService(this.Service.Switch);
          if (service) {
            service.updateCharacteristic(this.Characteristic.On, true);
            setTimeout(() => {
              service.updateCharacteristic(this.Characteristic.On, false);
            }, cumulativeDelay);
            this.log.debug(`Synced companion switch to ON for ${sourceAccessory.displayName}`);
          }
        } else if (type === 'lock') {
          const service = companion.getService(this.Service.LockMechanism);
          if (service) {
            companion.context.lockCurrentState = this.Characteristic.LockCurrentState.UNSECURED;
            companion.context.lockTargetState = this.Characteristic.LockTargetState.UNSECURED;
            service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.UNSECURED);
            service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.UNSECURED);
            setTimeout(() => {
              companion.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
              companion.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
              service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
              service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
            }, cumulativeDelay);
            this.log.debug(`Synced companion lock to UNSECURED for ${sourceAccessory.displayName}`);
          }
        }
      }
    });
  }

  startStatusPoller() {
    const intervalSecs = this.safeParseInt(this.config.pollInterval, 60, 'pollInterval');
    const intervalMs = Math.max(10, intervalSecs) * 1000;
    this.log.debug(`Starting background state poller (runs every ${intervalMs / 1000}s)`);

    setInterval(async () => {
      this.log.debug("Polling PalGate API for state updates...");
      const { generateToken } = require('./token-gen.js');
      const { getDevices } = require('./api.js');

      try {
        const temporalToken = generateToken(
          Buffer.from(this.token, 'hex'),
          parseInt(this.phoneNumber, 10),
          parseInt(this.tokenType, 10)
        );
        const data = await getDevices(temporalToken);
        if (data && Array.isArray(data.devices)) {
          this.syncLockStates(data.devices);
        }
      } catch (err) {
        this.log.warn("Background status poll failed:", err.message);
      }
    }, intervalMs);
  }

  syncLockStates(devicesList) {
    if (this.lastRelayWrite && (Date.now() - this.lastRelayWrite < 15000)) {
      this.log.debug("Skipping background poller lock states sync: relay write in progress or completed recently.");
      return;
    }

    this.accessories.forEach(accessory => {
      const accessoryType = accessory.context.accessoryType;
      if (accessoryType !== 'holdOpenLock' && accessoryType !== 'holdClosedLock' &&
          accessoryType !== 'holdOpenSwitch' && accessoryType !== 'holdClosedSwitch') return;

      const { baseId, outputNum } = splitDeviceId(accessory.context.deviceId);
      const deviceData = devicesList.find(d => (d.id || d._id) === baseId);
      if (!deviceData) return;

      const isLock = accessoryType === 'holdOpenLock' || accessoryType === 'holdClosedLock';
      const service = isLock ? accessory.getService(this.Service.LockMechanism) : accessory.getService(this.Service.Switch);
      if (!service) return;

      // Extract latch status and disabled status for the specific output
      const latchStatus = outputNum === 2 ? deviceData.output2LatchStatus === true : deviceData.output1LatchStatus === true;
      const isDisabled = outputNum === 2 ? deviceData.output2Disabled === true : deviceData.output1Disabled === true;

      if (isLock) {
        let targetState = this.Characteristic.LockCurrentState.UNSECURED;

        if (accessoryType === 'holdOpenLock') {
          // Hold Open is SECURED/Locked if latchStatus is true AND it is disabled (latch override is active)
          if (latchStatus && isDisabled) {
            targetState = this.Characteristic.LockCurrentState.SECURED;
          }
        } else if (accessoryType === 'holdClosedLock') {
          // Hold Closed is SECURED/Locked if latchStatus is false AND it is disabled (hold closed override is active)
          if (!latchStatus && isDisabled) {
            targetState = this.Characteristic.LockCurrentState.SECURED;
          }
        }

        if (accessory.context.lockCurrentState !== targetState) {
          this.log.info(`Poller: Synced external state update for ${accessory.displayName} -> ${targetState === this.Characteristic.LockCurrentState.SECURED ? 'LOCKED' : 'UNLOCKED'}`);
          accessory.context.lockCurrentState = targetState;
          accessory.context.lockTargetState = targetState;
          service.updateCharacteristic(this.Characteristic.LockCurrentState, targetState);
          service.updateCharacteristic(this.Characteristic.LockTargetState, targetState);
        }
      } else {
        let targetState = false;

        if (accessoryType === 'holdOpenSwitch') {
          if (latchStatus && isDisabled) {
            targetState = true;
          }
        } else if (accessoryType === 'holdClosedSwitch') {
          if (!latchStatus && isDisabled) {
            targetState = true;
          }
        }

        if (accessory.context.switchState !== targetState) {
          this.log.info(`Poller: Synced external state update for ${accessory.displayName} -> ${targetState ? 'ON' : 'OFF'}`);
          accessory.context.switchState = targetState;
          service.updateCharacteristic(this.Characteristic.On, targetState);
        }
      }
    });
  }

  setRelayMode(accessory, mode, callback) {
    const { baseId, outputNum } = splitDeviceId(accessory.context.deviceId);

    let latch = false;
    let dsbl = false;

    if (mode === 'hold_open') {
      latch = true;
      dsbl = true;
    } else if (mode === 'hold_closed') {
      latch = false;
      dsbl = true;
    } else if (mode === 'normal_from_open') {
      latch = true;
      dsbl = false;
    } else if (mode === 'normal_from_closed') {
      latch = false;
      dsbl = false;
    } else {
      this.log.error(`Unknown relay mode: ${mode}`);
      return callback(new Error(`Unknown relay mode: ${mode}`));
    }

    const { generateToken } = require('./token-gen.js');
    const { callApi } = require('./api.js');

    try {
      const temporalToken = generateToken(
        Buffer.from(this.token, 'hex'),
        parseInt(this.phoneNumber, 10),
        parseInt(this.tokenType, 10)
      );

      const path = `device/${baseId}/open-gate?outputNum=${outputNum}&output${outputNum}LatchStatus=${latch}&output${outputNum}Disabled=${dsbl}`;
      this.log.debug(`Issuing setRelayMode API request: ${path}`);
      callApi(path, temporalToken)
        .then(() => {
          this.lastRelayWrite = Date.now();
          this.log.success(`Successfully set relay mode to ${mode} for`, accessory.displayName);
          callback(null);
        })
        .catch((err) => {
          this.log.error(`Failed to set relay mode for ${accessory.displayName}:`, err.message);
          callback(err);
        });
    } catch (err) {
      this.log.error(`Error generating token for setRelayMode on ${accessory.displayName}:`, err.message);
      callback(err);
    }
  }

  _resolveDefaultExposeFlags() {
    return {
      exposeGarageDoor: this.accessoryType === 'garageDoor' || !['switch', 'lock'].includes(this.accessoryType),
      exposeSwitch: this.accessoryType === 'switch',
      exposeLock: this.accessoryType === 'lock',
    };
  }

  _resolveRelayFlags(custom, deviceData, outputNum) {
    const flags = { exposeHoldOpenLock: false, exposeHoldClosedLock: false, exposeHoldOpenSwitch: false, exposeHoldClosedSwitch: false };

    if (deviceData) {
      const isLatchPermitted = outputNum === 2 ? deviceData.output2Latch === true : deviceData.output1Latch === true;
      if (!isLatchPermitted && deviceData.admin !== true) return flags;
    }

    if (custom && (custom.relaySwitch === true || custom.relayLock === true)) {
      flags.exposeHoldOpenSwitch = custom.relaySwitch === true;
      flags.exposeHoldClosedSwitch = custom.relaySwitch === true;
      flags.exposeHoldOpenLock = custom.relayLock === true;
      flags.exposeHoldClosedLock = custom.relayLock === true;
    } else if (this.config.enableRelayLocks === true) {
      if (this.config.relayAccessoryType && this.config.relayAccessoryType.toLowerCase() === 'switch') {
        flags.exposeHoldOpenSwitch = true;
        flags.exposeHoldClosedSwitch = true;
      } else {
        flags.exposeHoldOpenLock = true;
        flags.exposeHoldClosedLock = true;
      }
    }
    return flags;
  }

  _resolveDelays(deviceId) {
    const customEntry = (this.config.customGates || []).find(item => item.deviceId === deviceId);
    let openingDelay = this.safeParseInt(this.config.gateOpeningDelay, 1000, 'gateOpeningDelay');
    let gateCloseDelay = this.safeParseInt(this.config.gateCloseDelay, 5000, 'gateCloseDelay');
    if (customEntry) {
      if (customEntry.gateOpeningDelay !== undefined) {
        openingDelay = this.safeParseInt(customEntry.gateOpeningDelay, openingDelay, `customGates[${deviceId}].gateOpeningDelay`);
      }
      if (customEntry.gateCloseDelay !== undefined) {
        gateCloseDelay = this.safeParseInt(customEntry.gateCloseDelay, gateCloseDelay, `customGates[${deviceId}].gateCloseDelay`);
      }
    }
    return { openingDelay, gateCloseDelay };
  }

  safeParseInt(value, defaultValue, fieldName) {
    if (value === undefined || value === null) return defaultValue;
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      this.log.warn(`Config: "${fieldName}" has invalid value (${JSON.stringify(value)}), using default ${defaultValue}`);
      return defaultValue;
    }
    return parsed;
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
      this.log.debug("Using temporary token for", accessory.displayName);
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
