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

    // Pre-parsed token inputs — these never change after construction
    this._tokenBuffer = config.token ? Buffer.from(config.token, 'hex') : null;
    this._phoneNumber = parseInt(config.phoneNumber, 10);
    this._tokenType   = parseInt(config.tokenType, 10);

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
      await this.discoverDevicesWithRetry();
      // Start the poller regardless of discovery outcome — cached accessories are
      // restored on boot even when the API is briefly unreachable, and the poller
      // recovers on its own once connectivity returns.
      this.startStatusPoller();
    });

    this.api.on('shutdown', () => {
      if (this._pollerInterval) clearInterval(this._pollerInterval);
    });
  }

  // Retries discovery with escalating backoff so a transient API outage at boot
  // (e.g. a power cut where the router is still coming up) doesn't permanently
  // leave the plugin without its gates until a manual restart.
  async discoverDevicesWithRetry() {
    const backoffMs = [5000, 15000, 30000, 60000, 60000];
    for (let attempt = 0; attempt <= backoffMs.length; attempt++) {
      try {
        await this.discoverDevices();
        return;
      } catch (err) {
        // A 4xx means the request reached PalGate and was rejected (e.g. bad token) —
        // retrying won't help, so stop immediately rather than hammering the API.
        if (/API call error: 4\d\d/.test(err.message)) {
          this.log.error("Device discovery failed: PalGate rejected the request. Please check your token, phone number, and token type.", err.message);
          return;
        }
        if (attempt === backoffMs.length) {
          this.log.error(`Device discovery failed after ${attempt + 1} attempts. Relying on cached accessories; restart Homebridge once the PalGate API is reachable.`, err.message);
          return;
        }
        const delay = backoffMs[attempt];
        this.log.warn(`Device discovery attempt ${attempt + 1} failed (${err.message}). Retrying in ${delay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  // Called when restoring cached accessories.
  configureAccessory(accessory) {
    this.log.info("Restoring cached gate", accessory.displayName);
    delete accessory.context.customConfigSnapshot; // leftover from removed recreation mechanism
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
      temporalToken = generateToken(this._tokenBuffer, this._phoneNumber, this._tokenType);
    } catch (err) {
      // Config/parsing error — retrying won't help, so log and stop without throwing.
      this.log.error("Failed to generate temporal token. Please check your configuration.", err.message);
      return;
    }
    this.log.debug("Generated temporal token for device discovery");
    const { getDevices } = require('./api.js');

    const response = await getDevices(temporalToken);
    const data = response;
    if (!data.devices || !Array.isArray(data.devices)) {
      throw new Error("Invalid devices response: missing devices array.");
    }
    this.log.debug("Discovered", data.devices.length, "gate(s)");

    const customGates = this.config.customGates || [];

    const discoveredGates = this._buildDiscoveredGates(data.devices, customGates);
    const customOnlyGates = this._buildCustomOnlyGates(customGates, discoveredGates.map(g => g.deviceId));
    if (customOnlyGates.length > 0) {
      this.log.info(`Added ${customOnlyGates.length} custom-only gate(s) that were not discovered from API`);
    }

    this.gates = discoveredGates.concat(customOnlyGates);
    this._registerGateAccessories(this.gates);
    this._pruneStaleAccessories(this.gates);
    this._writeGateMetaCache(discoveredGates);

    const configuredAccessoryInfo = this.accessories.map(acc =>
      `${acc.context.name} [${acc.context.accessoryType}] (ID: ${acc.context.deviceId})`
    ).join(', ');
    if (configuredAccessoryInfo) {
      this.log.success("Configured gate accessory(ies)", configuredAccessoryInfo);
    } else {
      this.log.info("No gate accessories configured");
    }
  }


  _writeGateMetaCache(discoveredGates) {
    try {
      const fs = require('fs');
      const path = require('path');
      const meta = {};
      discoveredGates.forEach(gate => {
        if (!gate.deviceData) return;
        const { outputNum } = splitDeviceId(gate.deviceId);
        const latch = (outputNum === 2 ? gate.deviceData.output2Latch : gate.deviceData.output1Latch) === true;
        meta[gate.deviceId] = { admin: gate.deviceData.admin === true, latch };
      });
      const metaPath = path.join(this.api.user.storagePath(), 'palgate-gate-meta.json');
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      this.log.debug('Wrote gate metadata cache to', metaPath);
    } catch (err) {
      this.log.debug('Could not write gate metadata cache:', err.message);
    }
  }

  _buildDiscoveredGates(devices, customGates) {
    const { detectMultiOutputDevices, generateGateEntries } = require('./utils/helpers.js');
    return devices.flatMap((deviceData) => {
      const deviceId = deviceData.id || deviceData._id;
      const defaultName = deviceData.name1 || deviceData.name || deviceId;
      const outputs = detectMultiOutputDevices(deviceData);
      return generateGateEntries(deviceId, outputs, defaultName, deviceData).map((gateEntry) => {
        const gateDeviceId = gateEntry.deviceId;
        const { outputNum } = splitDeviceId(gateDeviceId);
        const custom = customGates.find(item => item.deviceId === gateDeviceId);

        if (custom) {
          if (custom.hide === true) return null;
          const name = (custom.name && custom.name.trim().length > 0) ? custom.name : gateEntry.name;
          let exposeGarageDoor = custom.garageDoor === true;
          let exposeSwitch = custom.switch === true;
          let exposeLock = custom.lock === true;
          if (!exposeGarageDoor && !exposeSwitch && !exposeLock) {
            ({ exposeGarageDoor, exposeSwitch, exposeLock } = this._resolveDefaultExposeFlags());
          }
          const { exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch } = this._resolveRelayFlags(custom, deviceData, outputNum);
          return { deviceId: gateDeviceId, name, exposeGarageDoor, exposeSwitch, exposeLock, exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, deviceData };
        } else {
          const { exposeGarageDoor, exposeSwitch, exposeLock } = this._resolveDefaultExposeFlags();
          const { exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch } = this._resolveRelayFlags(null, deviceData, outputNum);
          return { deviceId: gateDeviceId, name: gateEntry.name, exposeGarageDoor, exposeSwitch, exposeLock, exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, deviceData };
        }
      });
    }).filter(gate => gate !== null);
  }

  _buildCustomOnlyGates(customGates, discoveredIds) {
    return customGates
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
        return { deviceId: c.deviceId, name, exposeGarageDoor, exposeSwitch, exposeLock, exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch };
      });
  }

  _registerGateAccessories(gates) {
    const types = ['garageDoor', 'switch', 'lock', 'holdOpenLock', 'holdClosedLock', 'holdOpenSwitch', 'holdClosedSwitch'];
    const flagMap = { garageDoor: 'exposeGarageDoor', switch: 'exposeSwitch', lock: 'exposeLock', holdOpenLock: 'exposeHoldOpenLock', holdClosedLock: 'exposeHoldClosedLock', holdOpenSwitch: 'exposeHoldOpenSwitch', holdClosedSwitch: 'exposeHoldClosedSwitch' };
    gates.forEach(gate => {
      types.forEach(type => {
        if (gate[flagMap[type]]) this.createAccessoryForGate(gate, type, gate.deviceData);
      });
    });
  }

  _pruneStaleAccessories(gates) {
    const flagMap = { garageDoor: 'exposeGarageDoor', switch: 'exposeSwitch', lock: 'exposeLock', holdOpenLock: 'exposeHoldOpenLock', holdClosedLock: 'exposeHoldClosedLock', holdOpenSwitch: 'exposeHoldOpenSwitch', holdClosedSwitch: 'exposeHoldClosedSwitch' };
    const keepKeys = new Set(gates.flatMap(gate =>
      Object.entries(flagMap).filter(([, flag]) => gate[flag]).map(([type]) => `${gate.deviceId}|${type}`)
    ));
    const stale = this.accessories.filter(acc => !keepKeys.has(`${acc.context.deviceId}|${acc.context.accessoryType}`));
    stale.forEach(acc => {
      this.api.unregisterPlatformAccessories("homebridge-palgate", "PalGatePlatform", [acc]);
      this.log.info(`Removed accessory ${acc.context.name} (${acc.context.deviceId}) because it was not found in the latest device list or configuration`);
    });
    this.accessories = this.accessories.filter(acc => keepKeys.has(`${acc.context.deviceId}|${acc.context.accessoryType}`));
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
    const triggerMode = this._resolveTriggerMode(deviceId);

    // Resume in-progress cycle from before restart, or snap to CLOSED.
    const now = Date.now();
    const t2Expiry = accessory.context._doorTimerT2Expiry;
    if (t2Expiry && t2Expiry > now) {
      const t1Expiry = accessory.context._doorTimerT1Expiry;
      if (t1Expiry && t1Expiry > now) {
        // Still opening — resume from current position
        accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPENING;
        accessory.context.targetDoorState = this.Characteristic.TargetDoorState.OPEN;
        const t1 = setTimeout(() => {
          accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPEN;
          service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPEN);
          const t2 = setTimeout(() => {
            accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
            accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
            service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
            service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
            accessory.context._doorTimers = null;
            accessory.context._doorTimerT1Expiry = null;
            accessory.context._doorTimerT2Expiry = null;
          }, t2Expiry - Date.now());
          accessory.context._doorTimers = [t2];
        }, t1Expiry - now);
        accessory.context._doorTimers = [t1];
      } else {
        // Already open, waiting to close
        accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPEN;
        accessory.context.targetDoorState = this.Characteristic.TargetDoorState.OPEN;
        const t2 = setTimeout(() => {
          accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
          accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
          service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
          service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
          accessory.context._doorTimers = null;
          accessory.context._doorTimerT1Expiry = null;
          accessory.context._doorTimerT2Expiry = null;
        }, t2Expiry - now);
        accessory.context._doorTimers = [t2];
      }
    } else {
      // Expired or no cycle in progress — snap to CLOSED
      accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
      accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
      accessory.context._doorTimerT1Expiry = null;
      accessory.context._doorTimerT2Expiry = null;
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
      .on('set', async (value, callback) => {
        const wantsOpen = value === this.Characteristic.TargetDoorState.OPEN;
        const shouldTrigger = wantsOpen || triggerMode !== 'stateful';

        if (shouldTrigger) {
          this.log.info("Triggering garage door for", accessory.displayName);
          try {
            await this.openGateForAccessory(accessory);
          } catch (err) {
            return callback(err);
          }

          if (accessory.context._doorTimers) accessory.context._doorTimers.forEach(clearTimeout);
          accessory.context._doorTimers = null;
          accessory.context._doorTimerT1Expiry = null;
          accessory.context._doorTimerT2Expiry = null;

          if (triggerMode === 'momentary') {
            accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
            accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
            callback(null);
            service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
            this.syncPrimaryAccessories(accessory, 0, 0, 0);
          } else {
            accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPENING;
            accessory.context.targetDoorState = this.Characteristic.TargetDoorState.OPEN;
            service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPENING);
            this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, openingDelay + gateCloseDelay);

            const triggerTime = Date.now();
            accessory.context._doorTimerT1Expiry = triggerTime + openingDelay;
            accessory.context._doorTimerT2Expiry = triggerTime + openingDelay + gateCloseDelay;

            const t1 = setTimeout(() => {
              accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPEN;
              service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPEN);
              this.log.info("Garage door fully open for", accessory.displayName);
              const t2 = setTimeout(() => {
                accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
                accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
                service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
                service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
                this.log.info("Garage door closed for", accessory.displayName);
                accessory.context._doorTimers = null;
                accessory.context._doorTimerT1Expiry = null;
                accessory.context._doorTimerT2Expiry = null;
              }, gateCloseDelay);
              accessory.context._doorTimers = [t2];
            }, openingDelay);
            accessory.context._doorTimers = [t1];
            callback(null);
          }
        } else {
          // Stateful close: cancel any in-progress cycle and snap to CLOSED
          if (accessory.context._doorTimers) accessory.context._doorTimers.forEach(clearTimeout);
          accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
          accessory.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
          accessory.context._doorTimers = null;
          accessory.context._doorTimerT1Expiry = null;
          accessory.context._doorTimerT2Expiry = null;
          service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
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
    const triggerMode = this._resolveTriggerMode(deviceId);

    service.getCharacteristic(this.Characteristic.On)
      .on('get', (callback) => {
        callback(null, false);
      })
      .on('set', async (value, callback) => {
        const shouldTrigger = value || triggerMode !== 'stateful';

        if (shouldTrigger) {
          this.log.info("Triggering gate via switch for", accessory.displayName);
          try {
            await this.openGateForAccessory(accessory);
          } catch (err) {
            return callback(err);
          }

          if (triggerMode === 'momentary') {
            if (accessory.context._switchTimer) {
              clearTimeout(accessory.context._switchTimer);
              accessory.context._switchTimer = null;
              accessory.context._switchTimerExpiry = null;
            }
            callback(null);
            service.updateCharacteristic(this.Characteristic.On, false);
            this.syncPrimaryAccessories(accessory, 0, 0, 0);
          } else {
            callback(null);
            this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, cumulativeDelay);
            if (accessory.context._switchTimer) clearTimeout(accessory.context._switchTimer);
            accessory.context._switchTimerExpiry = Date.now() + cumulativeDelay;
            accessory.context._switchTimer = setTimeout(() => {
              service.updateCharacteristic(this.Characteristic.On, false);
              this.log.info("Switch auto-off reset for", accessory.displayName);
              accessory.context._switchTimer = null;
              accessory.context._switchTimerExpiry = null;
            }, cumulativeDelay);
          }
        } else {
          // Stateful + setOn(false): cancel timer and snap to OFF
          if (accessory.context._switchTimer) {
            clearTimeout(accessory.context._switchTimer);
            accessory.context._switchTimer = null;
            accessory.context._switchTimerExpiry = null;
          }
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
    const triggerMode = this._resolveTriggerMode(deviceId);

    // Resume in-progress unlock cycle from before restart, or snap to SECURED.
    const now = Date.now();
    const lockExpiry = accessory.context._lockTimerExpiry;
    if (lockExpiry && lockExpiry > now) {
      accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.UNSECURED;
      accessory.context.lockTargetState = this.Characteristic.LockTargetState.UNSECURED;
      accessory.context._lockTimer = setTimeout(() => {
        accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
        accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
        service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
        service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
        this.log.info("Gate secured (relocked) for", accessory.displayName);
        accessory.context._lockTimer = null;
        accessory.context._lockTimerExpiry = null;
      }, lockExpiry - now);
    } else {
      accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
      accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
      accessory.context._lockTimerExpiry = null;
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
      .on('set', async (value, callback) => {
        const wantsUnlock = value === this.Characteristic.LockTargetState.UNSECURED;
        const shouldTrigger = wantsUnlock || triggerMode !== 'stateful';

        if (shouldTrigger) {
          this.log.info("Unlocking gate for", accessory.displayName);
          try {
            await this.openGateForAccessory(accessory);
          } catch (err) {
            return callback(err);
          }

          if (triggerMode === 'momentary') {
            if (accessory.context._lockTimer) {
              clearTimeout(accessory.context._lockTimer);
              accessory.context._lockTimer = null;
              accessory.context._lockTimerExpiry = null;
            }
            accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
            accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
            service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
            service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
            this.syncPrimaryAccessories(accessory, 0, 0, 0);
            callback(null);
          } else {
            accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.UNSECURED;
            accessory.context.lockTargetState = this.Characteristic.LockTargetState.UNSECURED;
            service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.UNSECURED);
            this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, cumulativeDelay);
            if (accessory.context._lockTimer) clearTimeout(accessory.context._lockTimer);
            accessory.context._lockTimerExpiry = Date.now() + cumulativeDelay;
            accessory.context._lockTimer = setTimeout(() => {
              accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
              accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
              service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
              service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
              this.log.info("Gate secured (relocked) for", accessory.displayName);
              accessory.context._lockTimer = null;
              accessory.context._lockTimerExpiry = null;
            }, cumulativeDelay);
            callback(null);
          }
        } else {
          // Stateful + SECURED request: cancel any in-progress timer, snap to SECURED
          if (accessory.context._lockTimer) {
            clearTimeout(accessory.context._lockTimer);
            accessory.context._lockTimer = null;
            accessory.context._lockTimerExpiry = null;
          }
          accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
          accessory.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
          service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
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
      .on('set', async (value, callback) => {
        if (accessory.context.lockCurrentState === value) {
          return callback(null);
        }
        const isLatching = value === this.Characteristic.LockTargetState.SECURED;
        this.log.info(`${isLatching ? 'Locking (latching)' : 'Unlocking (normal)'} Hold Open for`, accessory.displayName);
        try {
          await this.setRelayMode(accessory, isLatching ? 'hold_open' : 'normal');
        } catch (err) { return callback(err); }
        accessory.context.lockCurrentState = value;
        accessory.context.lockTargetState = value;
        service.updateCharacteristic(this.Characteristic.LockCurrentState, value);
        if (isLatching) {
          this.syncCompanionLock(accessory, 'holdClosedLock', this.Characteristic.LockCurrentState.UNSECURED);
          this.syncCompanionSwitch(accessory, 'holdClosedSwitch', false);
        }
        this.syncCompanionSwitch(accessory, 'holdOpenSwitch', isLatching);
        callback(null);
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
      .on('set', async (value, callback) => {
        if (accessory.context.lockCurrentState === value) {
          return callback(null);
        }
        const isLatching = value === this.Characteristic.LockTargetState.SECURED;
        this.log.info(`${isLatching ? 'Locking (latching)' : 'Unlocking (normal)'} Hold Closed for`, accessory.displayName);
        try {
          await this.setRelayMode(accessory, isLatching ? 'hold_closed' : 'normal');
        } catch (err) { return callback(err); }
        accessory.context.lockCurrentState = value;
        accessory.context.lockTargetState = value;
        service.updateCharacteristic(this.Characteristic.LockCurrentState, value);
        if (isLatching) {
          this.syncCompanionLock(accessory, 'holdOpenLock', this.Characteristic.LockCurrentState.UNSECURED);
          this.syncCompanionSwitch(accessory, 'holdOpenSwitch', false);
        }
        this.syncCompanionSwitch(accessory, 'holdClosedSwitch', isLatching);
        callback(null);
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
      .on('set', async (value, callback) => {
        if (accessory.context.switchState === value) {
          return callback(null);
        }
        this.log.info(`${value ? 'Turning On' : 'Turning Off'} Hold Open Switch for`, accessory.displayName);
        try {
          await this.setRelayMode(accessory, value ? 'hold_open' : 'normal');
        } catch (err) { return callback(err); }
        accessory.context.switchState = value;
        service.updateCharacteristic(this.Characteristic.On, value);
        if (value) {
          this.syncCompanionSwitch(accessory, 'holdClosedSwitch', false);
          this.syncCompanionLock(accessory, 'holdClosedLock', this.Characteristic.LockCurrentState.UNSECURED);
        }
        this.syncCompanionLock(accessory, 'holdOpenLock', value ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED);
        callback(null);
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
      .on('set', async (value, callback) => {
        if (accessory.context.switchState === value) {
          return callback(null);
        }
        this.log.info(`${value ? 'Turning On' : 'Turning Off'} Hold Closed Switch for`, accessory.displayName);
        try {
          await this.setRelayMode(accessory, value ? 'hold_closed' : 'normal');
        } catch (err) { return callback(err); }
        accessory.context.switchState = value;
        service.updateCharacteristic(this.Characteristic.On, value);
        if (value) {
          this.syncCompanionSwitch(accessory, 'holdOpenSwitch', false);
          this.syncCompanionLock(accessory, 'holdOpenLock', this.Characteristic.LockCurrentState.UNSECURED);
        }
        this.syncCompanionLock(accessory, 'holdClosedLock', value ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED);
        callback(null);
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

        // Cancel any in-progress sync animation for this companion so a retrigger
        // mid-cycle doesn't leave a stale timer that later snaps it back to rest.
        if (companion._syncTimers) companion._syncTimers.forEach(clearTimeout);
        companion._syncTimers = [];

        if (type === 'garageDoor') {
          const service = companion.getService(this.Service.GarageDoorOpener);
          if (service) {
            companion.context.currentDoorState = this.Characteristic.CurrentDoorState.OPENING;
            companion.context.targetDoorState = this.Characteristic.TargetDoorState.OPEN;
            service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPENING);
            service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.OPEN);

            const t1 = setTimeout(() => {
              companion.context.currentDoorState = this.Characteristic.CurrentDoorState.OPEN;
              service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.OPEN);
              const t2 = setTimeout(() => {
                companion.context.currentDoorState = this.Characteristic.CurrentDoorState.CLOSED;
                companion.context.targetDoorState = this.Characteristic.TargetDoorState.CLOSED;
                service.updateCharacteristic(this.Characteristic.CurrentDoorState, this.Characteristic.CurrentDoorState.CLOSED);
                service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.CLOSED);
                companion._syncTimers = [];
              }, gateCloseDelay);
              companion._syncTimers = [t2];
            }, openingDelay);
            companion._syncTimers = [t1];
            this.log.debug(`Synced companion garageDoor to OPEN for ${sourceAccessory.displayName}`);
          }
        } else if (type === 'switch') {
          const service = companion.getService(this.Service.Switch);
          if (service) {
            service.updateCharacteristic(this.Characteristic.On, true);
            const t = setTimeout(() => {
              service.updateCharacteristic(this.Characteristic.On, false);
              companion._syncTimers = [];
            }, cumulativeDelay);
            companion._syncTimers = [t];
            this.log.debug(`Synced companion switch to ON for ${sourceAccessory.displayName}`);
          }
        } else if (type === 'lock') {
          const service = companion.getService(this.Service.LockMechanism);
          if (service) {
            companion.context.lockCurrentState = this.Characteristic.LockCurrentState.UNSECURED;
            companion.context.lockTargetState = this.Characteristic.LockTargetState.UNSECURED;
            service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.UNSECURED);
            service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.UNSECURED);
            const t = setTimeout(() => {
              companion.context.lockCurrentState = this.Characteristic.LockCurrentState.SECURED;
              companion.context.lockTargetState = this.Characteristic.LockTargetState.SECURED;
              service.updateCharacteristic(this.Characteristic.LockCurrentState, this.Characteristic.LockCurrentState.SECURED);
              service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.SECURED);
              companion._syncTimers = [];
            }, cumulativeDelay);
            companion._syncTimers = [t];
            this.log.debug(`Synced companion lock to UNSECURED for ${sourceAccessory.displayName}`);
          }
        }
      }
    });
  }

  startStatusPoller() {
    const relayTypes = ['holdOpenLock', 'holdClosedLock', 'holdOpenSwitch', 'holdClosedSwitch'];
    const hasRelayAccessories = () => this.accessories.some(acc => relayTypes.includes(acc.context.accessoryType));

    if (!hasRelayAccessories()) {
      this.log.debug("No relay accessories registered — skipping background state poller");
      return;
    }

    const intervalSecs = this.safeParseInt(this.config.pollInterval, 60, 'pollInterval');
    const intervalMs = Math.max(10, intervalSecs) * 1000;
    this.log.debug(`Starting background state poller (runs every ${intervalMs / 1000}s)`);

    this._pollerInterval = setInterval(async () => {
      if (!hasRelayAccessories()) return;
      this.log.debug("Polling PalGate API for state updates...");
      const { generateToken } = require('./token-gen.js');
      const { getDeviceInfoOnce } = require('./api.js');

      try {
        const temporalToken = generateToken(this._tokenBuffer, this._phoneNumber, this._tokenType);

        // Fetch only the devices that have relay accessories, in parallel
        const relayAccessories = this.accessories.filter(acc => relayTypes.includes(acc.context.accessoryType));
        const uniqueBaseIds = [...new Set(relayAccessories.map(acc => splitDeviceId(acc.context.deviceId).baseId))];
        const deviceMap = new Map();
        await Promise.all(uniqueBaseIds.map(async baseId => {
          try {
            const deviceData = await getDeviceInfoOnce(temporalToken, baseId);
            deviceMap.set(baseId, deviceData);
          } catch (err) {
            this.log.warn(`Poller: failed to fetch device ${baseId}:`, err.message);
          }
        }));

        this.syncLockStates(deviceMap);
      } catch (err) {
        this.log.warn("Background status poll failed:", err.message);
      }
    }, intervalMs);
  }

  syncLockStates(deviceMap) {
    const now = Date.now();

    this.accessories.forEach(accessory => {
      const accessoryType = accessory.context.accessoryType;
      if (accessoryType !== 'holdOpenLock' && accessoryType !== 'holdClosedLock' &&
          accessoryType !== 'holdOpenSwitch' && accessoryType !== 'holdClosedSwitch') return;

      const { baseId, outputNum } = splitDeviceId(accessory.context.deviceId);

      // Skip this device if a relay write was issued recently — avoids overwriting
      // a just-set state before the API has propagated the change.
      const lastWrite = this._lastRelayWriteByDevice && this._lastRelayWriteByDevice.get(baseId);
      if (lastWrite && (now - lastWrite < 15000)) {
        this.log.debug(`Poller: skipping sync for ${baseId} — relay write completed recently.`);
        return;
      }

      const deviceData = deviceMap.get(baseId);
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

  async setRelayMode(accessory, mode) {
    const { baseId, outputNum } = splitDeviceId(accessory.context.deviceId);

    let latch, dsbl;
    if (mode === 'hold_open')        { latch = true;  dsbl = true; }
    else if (mode === 'hold_closed') { latch = false; dsbl = true; }
    else if (mode === 'normal')      { latch = false; dsbl = false; }
    else throw new Error(`Unknown relay mode: ${mode}`);

    const { generateToken } = require('./token-gen.js');
    const { callApi } = require('./api.js');
    const temporalToken = generateToken(this._tokenBuffer, this._phoneNumber, this._tokenType);
    const path = `device/${baseId}/open-gate?outputNum=${outputNum}&output${outputNum}LatchStatus=${latch}&output${outputNum}Disabled=${dsbl}`;
    this.log.debug(`Issuing setRelayMode API request: ${path}`);
    await callApi(path, temporalToken);
    if (!this._lastRelayWriteByDevice) this._lastRelayWriteByDevice = new Map();
    this._lastRelayWriteByDevice.set(baseId, Date.now());
    this.log.success(`Successfully set relay mode to ${mode} for`, accessory.displayName);
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
      if (!isLatchPermitted) return flags;
    }

    if (custom && custom.relayEnabled === false) return flags;

    // Per-gate direction takes precedence over global; default is both enabled.
    const holdOpen   = (custom && custom.relayHoldOpen   !== undefined) ? custom.relayHoldOpen   !== false : this.config.relayHoldOpen   !== false;
    const holdClosed = (custom && custom.relayHoldClosed !== undefined) ? custom.relayHoldClosed !== false : this.config.relayHoldClosed !== false;

    if (custom && (custom.relaySwitch === true || custom.relayLock === true)) {
      flags.exposeHoldOpenSwitch   = custom.relaySwitch === true && holdOpen;
      flags.exposeHoldClosedSwitch = custom.relaySwitch === true && holdClosed;
      flags.exposeHoldOpenLock     = custom.relayLock   === true && holdOpen;
      flags.exposeHoldClosedLock   = custom.relayLock   === true && holdClosed;
    } else if (this.config.enableRelayLocks === true) {
      if (this.config.relayAccessoryType && this.config.relayAccessoryType.toLowerCase() === 'switch') {
        flags.exposeHoldOpenSwitch   = holdOpen;
        flags.exposeHoldClosedSwitch = holdClosed;
      } else {
        flags.exposeHoldOpenLock   = holdOpen;
        flags.exposeHoldClosedLock = holdClosed;
      }
    }
    return flags;
  }

  _resolveTriggerMode(deviceId) {
    const customEntry = (this.config.customGates || []).find(c => c.deviceId === deviceId);
    const mode = (customEntry && customEntry.triggerMode) || this.config.triggerMode || 'stateful';
    return ['stateful', 'stateless', 'momentary'].includes(mode) ? mode : 'stateful';
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

  async openGateForAccessory(accessory) {
    this.log.debug("Opening gate for", accessory.displayName, "...");
    const { openGate } = require('./api.js');
    const { generateToken } = require('./token-gen.js');
    const temporalToken = generateToken(this._tokenBuffer, this._phoneNumber, this._tokenType);
    this.log.debug("Using temporary token for", accessory.displayName);
    await openGate(accessory.context.deviceId, temporalToken);
    this.log.success("Successfully opened gate for", accessory.displayName);
  }
}

module.exports = PalGatePlatform;
