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
    this.accessoryType = config.accessoryType || 'garageDoor';

    // Build the list of linked PalGate accounts. Supports multiple accounts via
    // config.accounts, and falls back to the legacy top-level token/phoneNumber/
    // tokenType as a single implicit account (fully backward compatible).
    this.accounts = this._buildAccounts(config);
    this._accountById = new Map(this.accounts.map(a => [a.id, a]));

    if (this.accounts.length === 0) {
      this.log.error(`Missing required configuration properties token, phoneNumber, tokenType. Please provide these in your platform config.`);
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
      if (this._logPollerTimer) clearTimeout(this._logPollerTimer);
      // Cancel any in-flight valve countdowns so pending timers don't keep the process
      // alive (and so a restart releases holds cleanly rather than resuming a lost timer).
      this.accessories.forEach(acc => {
        if (acc.context && (acc.context._valveTimer || acc.context._valveTick)) {
          this._clearValveTimers(acc);
        }
      });
    });
  }

  // Builds the account list from config. Each account carries its own credentials so
  // the plugin can manage gates across multiple linked PalGate accounts. An account is
  // identified by its phone number (tokenType is only the device-link slot).
  _buildAccounts(config) {
    const accounts = [];
    const seen = new Set();

    const add = (src, label, index) => {
      const { token, phoneNumber, tokenType } = src || {};
      const displayLabel = (label && String(label).trim()) || `Account ${index + 1}`;
      if (!token || !phoneNumber || tokenType === undefined || tokenType === null) {
        this.log.error(`Ignoring PalGate account "${displayLabel}": missing token, phoneNumber, or tokenType.`);
        return;
      }
      const id = String(phoneNumber);
      if (seen.has(id)) {
        this.log.warn(`Ignoring duplicate PalGate account "${displayLabel}" for phone number ${id}.`);
        return;
      }
      seen.add(id);
      accounts.push({
        id,
        label: displayLabel,
        tokenBuffer: Buffer.from(token, 'hex'),
        phoneNumber: parseInt(phoneNumber, 10),
        tokenType: parseInt(tokenType, 10),
      });
    };

    if (Array.isArray(config.accounts) && config.accounts.length > 0) {
      config.accounts.forEach((acc, i) => add(acc, acc.label, i));
    } else if (config.token || config.phoneNumber || config.tokenType !== undefined) {
      // Legacy single-account config: top-level credentials become one implicit account.
      add(config, config.label, 0);
    }
    return accounts;
  }

  // Ranks how privileged an account is on a specific gate, so a gate shared across accounts
  // is operated by the account that unlocks the most features. Latch (relay/hold) outranks
  // admin (external-open) because losing latch makes the relay accessories disappear — the
  // more visible breakage — whereas losing admin only skips passive open detection.
  //   both → 3, latch only → 2, admin only → 1, neither → 0.
  _gatePrivilegeScore(deviceData, deviceId) {
    if (!deviceData) return 0;
    const { outputNum } = splitDeviceId(deviceId);
    const admin = deviceData.admin === true;
    const latch = outputNum === 2 ? deviceData.output2Latch === true : deviceData.output1Latch === true;
    if (admin && latch) return 3;
    if (latch) return 2;
    if (admin) return 1;
    return 0;
  }

  // Generates a fresh temporal token for the given account.
  _tokenFor(account) {
    const { generateToken } = require('./token-gen.js');
    return generateToken(account.tokenBuffer, account.phoneNumber, account.tokenType);
  }

  // Resolves the account that owns an accessory (via context.accountId), falling back to
  // the first account for accessories tagged before multi-account support (or custom-only
  // gates). Returns undefined only when no accounts are configured.
  _accountForAccessory(accessory) {
    const id = accessory && accessory.context && accessory.context.accountId;
    return (id !== undefined && this._accountById.get(String(id))) || this.accounts[0];
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
    } else if (accessoryType === 'holdOpenValve') {
      this.setupHoldOpenValveHandlers(accessory);
    } else if (accessoryType === 'holdClosedValve') {
      this.setupHoldClosedValveHandlers(accessory);
    }
    this.accessories.push(accessory);
  }
  // Discover devices across all configured accounts. Each account is queried with its own
  // credentials and its gates are merged into a single accessory set. A gate that appears
  // in more than one account (a physically shared gate) is registered once, operated by the
  // account with the most elevated permissions on it (admin + latch > latch > admin > none),
  // so relay (needs latch) and external-open detection (needs admin) keep working — rather
  // than blindly keeping whichever account happened to be listed first.
  async discoverDevices() {
    const { getDevices } = require('./api.js');

    // Admin status per base device — external-open detection reads the operation log, which
    // is admin-only (unlike relay mode, which needs latch permission). Set from the OWNING
    // account (the token that will actually poll the log), after dedupe below.
    this._deviceAdminById = new Map();

    const customGates = this.config.customGates || [];
    const byId = new Map(); // deviceId -> { gate, score, label }
    let anyAccountSucceeded = false;
    let lastError;

    for (const account of this.accounts) {
      let temporalToken;
      try {
        temporalToken = this._tokenFor(account);
      } catch (err) {
        // Config/parsing error for this account — retrying won't help, so log and skip it.
        this.log.error(`Account "${account.label}": failed to generate temporal token. Please check its configuration.`, err.message);
        continue;
      }

      let data;
      try {
        data = await getDevices(temporalToken);
      } catch (err) {
        lastError = err;
        this.log.warn(`Account "${account.label}": device discovery failed:`, err.message);
        continue;
      }

      if (!data.devices || !Array.isArray(data.devices)) {
        // A single-account setup preserves the original strict behavior (its callers/retry
        // ladder rely on the throw); with multiple accounts, one bad response must not abort
        // the others.
        if (this.accounts.length === 1) {
          throw new Error("Invalid devices response: missing devices array.");
        }
        this.log.warn(`Account "${account.label}": invalid devices response (missing devices array) — skipping.`);
        continue;
      }

      anyAccountSucceeded = true;
      this.log.debug(`Account "${account.label}": discovered ${data.devices.length} gate(s)`);

      this._buildDiscoveredGates(data.devices, customGates, account.id).forEach(gate => {
        const score = this._gatePrivilegeScore(gate.deviceData, gate.deviceId);
        const existing = byId.get(gate.deviceId);
        if (!existing) {
          byId.set(gate.deviceId, { gate, score, label: account.label });
          return;
        }
        if (score > existing.score) {
          this.log.info(`Gate ${gate.deviceId}: account "${account.label}" has higher privileges than "${existing.label}" — it will operate this gate.`);
          byId.set(gate.deviceId, { gate, score, label: account.label });
        } else {
          this.log.info(`Gate ${gate.deviceId} also present in account "${account.label}" — already managed by "${existing.label}".`);
        }
      });
    }

    // If every account failed at the network level, surface the error so the retry ladder
    // in discoverDevicesWithRetry can back off (matches the original single-account behavior).
    if (!anyAccountSucceeded && lastError) throw lastError;

    const discoveredGates = [...byId.values()].map(v => v.gate);
    // Admin flag per base device follows the owning account's token, OR'd across a device's
    // outputs so any admin-owned output enables external-open detection for the base.
    discoveredGates.forEach(gate => {
      const { baseId } = splitDeviceId(gate.deviceId);
      const ownerAdmin = !!(gate.deviceData && gate.deviceData.admin === true);
      this._deviceAdminById.set(baseId, this._deviceAdminById.get(baseId) === true || ownerAdmin);
    });

    const customOnlyGates = this._buildCustomOnlyGates(customGates, [...byId.keys()], this.accounts[0].id);
    if (customOnlyGates.length > 0) {
      this.log.info(`Added ${customOnlyGates.length} custom-only gate(s) that were not discovered from API`);
    }

    this.gates = discoveredGates.concat(customOnlyGates);
    this._registerGateAccessories(this.gates);
    this._pruneStaleAccessories(this.gates);

    const configuredAccessoryInfo = this.accessories.map(acc =>
      `${acc.context.name} [${acc.context.accessoryType}] (ID: ${acc.context.deviceId})`
    ).join(', ');
    if (configuredAccessoryInfo) {
      this.log.success("Configured gate accessory(ies)", configuredAccessoryInfo);
    } else {
      this.log.info("No gate accessories configured");
    }
  }

  _buildDiscoveredGates(devices, customGates, accountId) {
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
          const { exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, exposeHoldOpenValve, exposeHoldClosedValve } = this._resolveRelayFlags(custom, deviceData, outputNum);
          return { deviceId: gateDeviceId, accountId, name, exposeGarageDoor, exposeSwitch, exposeLock, exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, exposeHoldOpenValve, exposeHoldClosedValve, deviceData };
        } else {
          const { exposeGarageDoor, exposeSwitch, exposeLock } = this._resolveDefaultExposeFlags();
          const { exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, exposeHoldOpenValve, exposeHoldClosedValve } = this._resolveRelayFlags(null, deviceData, outputNum);
          return { deviceId: gateDeviceId, accountId, name: gateEntry.name, exposeGarageDoor, exposeSwitch, exposeLock, exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, exposeHoldOpenValve, exposeHoldClosedValve, deviceData };
        }
      });
    }).filter(gate => gate !== null);
  }

  _buildCustomOnlyGates(customGates, discoveredIds, accountId) {
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
        const { exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, exposeHoldOpenValve, exposeHoldClosedValve } = this._resolveRelayFlags(c, null, 1);
        return { deviceId: c.deviceId, accountId, name, exposeGarageDoor, exposeSwitch, exposeLock, exposeHoldOpenLock, exposeHoldClosedLock, exposeHoldOpenSwitch, exposeHoldClosedSwitch, exposeHoldOpenValve, exposeHoldClosedValve };
      });
  }

  _registerGateAccessories(gates) {
    const types = ['garageDoor', 'switch', 'lock', 'holdOpenLock', 'holdClosedLock', 'holdOpenSwitch', 'holdClosedSwitch', 'holdOpenValve', 'holdClosedValve'];
    const flagMap = { garageDoor: 'exposeGarageDoor', switch: 'exposeSwitch', lock: 'exposeLock', holdOpenLock: 'exposeHoldOpenLock', holdClosedLock: 'exposeHoldClosedLock', holdOpenSwitch: 'exposeHoldOpenSwitch', holdClosedSwitch: 'exposeHoldClosedSwitch', holdOpenValve: 'exposeHoldOpenValve', holdClosedValve: 'exposeHoldClosedValve' };
    gates.forEach(gate => {
      types.forEach(type => {
        if (gate[flagMap[type]]) this.createAccessoryForGate(gate, type, gate.deviceData);
      });
    });
  }

  _pruneStaleAccessories(gates) {
    const flagMap = { garageDoor: 'exposeGarageDoor', switch: 'exposeSwitch', lock: 'exposeLock', holdOpenLock: 'exposeHoldOpenLock', holdClosedLock: 'exposeHoldClosedLock', holdOpenSwitch: 'exposeHoldOpenSwitch', holdClosedSwitch: 'exposeHoldClosedSwitch', holdOpenValve: 'exposeHoldOpenValve', holdClosedValve: 'exposeHoldClosedValve' };
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
      if (type === "holdOpenLock" || type === "holdOpenSwitch" || type === "holdOpenValve") return `${desiredName} Hold Open`;
      if (type === "holdClosedLock" || type === "holdClosedSwitch" || type === "holdClosedValve") return `${desiredName} Hold Closed`;
      return desiredName;
    };
    const finalName = getAccessoryName();

    if (accessory) {
      // Keep the owning-account tag current on every discovery, even when the accessory
      // itself is unchanged — so a gate that moves between accounts (or a cached accessory
      // predating multi-account support) is always operated with the right credentials.
      accessory.context.accountId = gate.accountId;
      // Name unchanged — keep the existing accessory as-is so its HomeKit room, scene,
      // and automation placement is preserved.
      if (accessory.displayName === finalName) {
        return;
      }
      // Name changed. HomeKit ignores an in-place displayName change on an
      // already-published accessory, so the only way to surface the new name is to
      // remove and re-add it. That resets this accessory's room/scene/automation
      // placement — the unavoidable HomeKit cost of a rename — but it's scoped strictly
      // to name changes, so every other edit (types, delays, relay settings) keeps its
      // placement. Fall through to recreate below with the same deterministic UUID.
      this.api.unregisterPlatformAccessories("homebridge-palgate", "PalGatePlatform", [accessory]);
      this.accessories = this.accessories.filter(acc => acc.UUID !== uuid);
      this.log.info(`Recreating accessory to apply new name "${finalName}" (was "${accessory.displayName}")`);
    }

    accessory = new this.api.platformAccessory(finalName, uuid);
    accessory.context.deviceId = gate.deviceId;
    accessory.context.accountId = gate.accountId;
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
    } else if (type === "holdOpenValve") {
      accessory.addService(this.Service.Valve, finalName);
      this.setupHoldOpenValveHandlers(accessory, deviceData);
    } else if (type === "holdClosedValve") {
      accessory.addService(this.Service.Valve, finalName);
      this.setupHoldClosedValveHandlers(accessory, deviceData);
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
            // Stateless re-trigger (or stateful open): keep the tile showing open and
            // re-run the open animation. On a rerouted close-tap HomeKit sent
            // target=CLOSED, so acknowledge the write first, then force both target and
            // current back to open — otherwise the tile shows a contradictory "Closing".
            callback(null);
            accessory.context.currentDoorState = this.Characteristic.CurrentDoorState.OPENING;
            accessory.context.targetDoorState = this.Characteristic.TargetDoorState.OPEN;
            service.updateCharacteristic(this.Characteristic.TargetDoorState, this.Characteristic.TargetDoorState.OPEN);
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

    // The switch is a transient trigger — always start OFF after a restart. Timer handles
    // don't survive a restart, so clear their bookkeeping too.
    accessory.context.switchOn = false;
    accessory.context._switchTimer = null;
    accessory.context._switchTimerExpiry = null;

    service.getCharacteristic(this.Characteristic.On)
      .on('get', (callback) => {
        callback(null, accessory.context.switchOn === true);
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
            accessory.context.switchOn = false;
            callback(null);
            service.updateCharacteristic(this.Characteristic.On, false);
            this.syncPrimaryAccessories(accessory, 0, 0, 0);
          } else {
            // Stateful On, or stateless (including a rerouted off-tap): show the switch On
            // for the open window and (re)arm the auto-off timer. Acknowledge the write
            // first, then force On=true so a rerouted off-tap keeps the switch on and
            // re-triggers instead of turning off.
            callback(null);
            accessory.context.switchOn = true;
            service.updateCharacteristic(this.Characteristic.On, true);
            this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, cumulativeDelay);
            if (accessory.context._switchTimer) clearTimeout(accessory.context._switchTimer);
            accessory.context._switchTimerExpiry = Date.now() + cumulativeDelay;
            accessory.context._switchTimer = setTimeout(() => {
              accessory.context.switchOn = false;
              service.updateCharacteristic(this.Characteristic.On, false);
              this.log.info("Switch auto-off reset for", accessory.displayName);
              accessory.context._switchTimer = null;
              accessory.context._switchTimerExpiry = null;
            }, cumulativeDelay);
          }
        } else {
          // Stateful + setOn(false): cancel the auto-off timer and stay OFF (no trigger).
          if (accessory.context._switchTimer) {
            clearTimeout(accessory.context._switchTimer);
            accessory.context._switchTimer = null;
            accessory.context._switchTimerExpiry = null;
          }
          accessory.context.switchOn = false;
          callback(null);
          service.updateCharacteristic(this.Characteristic.On, false);
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
            // Stateless re-trigger (or stateful unlock): keep the tile showing unlocked
            // and restart the relock timer. On a rerouted secure-tap HomeKit sent
            // target=SECURED, so acknowledge the write first, then force both target and
            // current back to unsecured — otherwise the tile shows a contradictory "Locking".
            callback(null);
            accessory.context.lockCurrentState = this.Characteristic.LockCurrentState.UNSECURED;
            accessory.context.lockTargetState = this.Characteristic.LockTargetState.UNSECURED;
            service.updateCharacteristic(this.Characteristic.LockTargetState, this.Characteristic.LockTargetState.UNSECURED);
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
          this.syncCompanionValve(accessory, 'holdClosedValve', false);
        }
        this.syncCompanionSwitch(accessory, 'holdOpenSwitch', isLatching);
        this.syncCompanionValve(accessory, 'holdOpenValve', isLatching);
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
          this.syncCompanionValve(accessory, 'holdOpenValve', false);
        }
        this.syncCompanionSwitch(accessory, 'holdClosedSwitch', isLatching);
        this.syncCompanionValve(accessory, 'holdClosedValve', isLatching);
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
          this.syncCompanionValve(accessory, 'holdClosedValve', false);
        }
        this.syncCompanionLock(accessory, 'holdOpenLock', value ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED);
        this.syncCompanionValve(accessory, 'holdOpenValve', value);
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
          this.syncCompanionValve(accessory, 'holdOpenValve', false);
        }
        this.syncCompanionLock(accessory, 'holdClosedLock', value ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED);
        this.syncCompanionValve(accessory, 'holdClosedValve', value);
        callback(null);
      });
  }

  setupHoldOpenValveHandlers(accessory, deviceData) {
    this._setupValveHandlers(accessory, deviceData, 'hold_open');
  }

  setupHoldClosedValveHandlers(accessory, deviceData) {
    this._setupValveHandlers(accessory, deviceData, 'hold_closed');
  }

  // Valve relay accessory: exposes the Hold Open / Hold Closed relay as a HAP Valve so
  // the Home app can show a live countdown (SetDuration/RemainingDuration) for a timed
  // hold. Active/InUse reflect the latch state; activating starts a countdown that writes
  // normal mode at zero. Restart releases any in-progress hold to normal (a lost timer
  // must not become a permanent silent hold), so we never resume a countdown here.
  _setupValveHandlers(accessory, deviceData, direction) {
    const service = accessory.getService(this.Service.Valve);
    if (!service) {
      this.log.error(`Valve service not found for ${direction === 'hold_open' ? 'Hold Open' : 'Hold Closed'} Valve on`, accessory.displayName);
      return;
    }
    const C = this.Characteristic;

    // A hold that was mid-countdown before restart is released to normal: cancel any
    // persisted latch bookkeeping and start Inactive.
    this._clearValveTimers(accessory);
    let releasedOnRestart = false;
    if (accessory.context.valveActive === true) {
      // We were holding before the restart — return the relay to normal mode so a lost
      // timer can't leave the gate silently held.
      releasedOnRestart = true;
    }
    accessory.context.valveActive = false;

    // Determine the resting SetDuration. First time, seed from the configured default
    // (global valveDefaultDuration, per-gate override, 300s fallback; 0 = indefinite).
    // Once the user sets a duration on the Home app tile it persists here and wins.
    if (accessory.context.valveSetDuration === undefined) {
      accessory.context.valveSetDuration = this._resolveValveDefaultDuration(accessory.context.deviceId);
    }

    // Initial state from device data (only used to decide whether to release on restart —
    // an active-at-startup latch matching our direction means we should re-secure to normal).
    if (releasedOnRestart) {
      // Fire-and-forget: write normal mode so a stale hold is cleared. Errors are logged
      // but must not block accessory setup.
      this.setRelayMode(accessory, 'normal').catch(err =>
        this.log.warn(`Valve: failed to release stale ${direction} hold on startup for ${accessory.displayName}:`, err.message));
    }

    service.updateCharacteristic(C.Active, C.Active.INACTIVE);
    service.updateCharacteristic(C.InUse, C.InUse.NOT_IN_USE);
    service.updateCharacteristic(C.ValveType, C.ValveType.GENERIC_VALVE);
    service.updateCharacteristic(C.RemainingDuration, 0);
    service.updateCharacteristic(C.SetDuration, accessory.context.valveSetDuration);

    service.getCharacteristic(C.Active)
      .on('get', (callback) => {
        callback(null, accessory.context.valveActive ? C.Active.ACTIVE : C.Active.INACTIVE);
      })
      .on('set', async (value, callback) => {
        const wantsActive = value === C.Active.ACTIVE;
        if (wantsActive === (accessory.context.valveActive === true)) {
          return callback(null);
        }
        if (wantsActive) {
          this.log.info(`Activating ${direction === 'hold_open' ? 'Hold Open' : 'Hold Closed'} Valve for`, accessory.displayName);
          try {
            await this.setRelayMode(accessory, direction);
          } catch (err) { return callback(err); }
          accessory.context.valveActive = true;
          service.updateCharacteristic(C.Active, C.Active.ACTIVE);
          service.updateCharacteristic(C.InUse, C.InUse.IN_USE);
          this._startValveCountdown(accessory);
          this._syncValveCompanions(accessory, direction, true);
          callback(null);
        } else {
          this.log.info(`Deactivating ${direction === 'hold_open' ? 'Hold Open' : 'Hold Closed'} Valve for`, accessory.displayName);
          this._clearValveTimers(accessory);
          try {
            await this.setRelayMode(accessory, 'normal');
          } catch (err) { return callback(err); }
          accessory.context.valveActive = false;
          service.updateCharacteristic(C.Active, C.Active.INACTIVE);
          service.updateCharacteristic(C.InUse, C.InUse.NOT_IN_USE);
          service.updateCharacteristic(C.RemainingDuration, 0);
          callback(null);
        }
      });

    service.getCharacteristic(C.InUse)
      .on('get', (callback) => {
        callback(null, accessory.context.valveActive ? C.InUse.IN_USE : C.InUse.NOT_IN_USE);
      });

    service.getCharacteristic(C.SetDuration)
      .on('get', (callback) => {
        callback(null, accessory.context.valveSetDuration || 0);
      })
      .on('set', (value, callback) => {
        // Clamp to HAP's SetDuration range (0–3600s); 0 = indefinite hold.
        accessory.context.valveSetDuration = Math.min(3600, Math.max(0, parseInt(value, 10) || 0));
        callback(null);
      });

    service.getCharacteristic(C.RemainingDuration)
      .on('get', (callback) => {
        callback(null, this._valveRemaining(accessory));
      });
  }

  _valveRemaining(accessory) {
    if (!accessory.context.valveActive || !accessory.context._valveExpiry) return 0;
    const remainingMs = accessory.context._valveExpiry - Date.now();
    return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
  }

  _clearValveTimers(accessory) {
    if (accessory.context._valveTimer) clearTimeout(accessory.context._valveTimer);
    if (accessory.context._valveTick) clearInterval(accessory.context._valveTick);
    // Normalize to null (not undefined) so the timer state is well-defined even on the
    // indefinite-hold path, where no timer is ever scheduled.
    accessory.context._valveTimer = null;
    accessory.context._valveTick = null;
    accessory.context._valveExpiry = null;
  }

  // Starts (or restarts) the countdown from the valve's SetDuration. SetDuration = 0
  // means indefinite — no countdown, the hold stays until manually released. On expiry
  // the relay is written back to normal and the valve goes Inactive.
  _startValveCountdown(accessory) {
    const C = this.Characteristic;
    const service = accessory.getService(this.Service.Valve);
    if (!service) return;
    this._clearValveTimers(accessory);

    const duration = parseInt(accessory.context.valveSetDuration, 10) || 0;
    if (duration <= 0) {
      // Indefinite hold — no countdown; Home app shows no remaining time.
      service.updateCharacteristic(C.RemainingDuration, 0);
      return;
    }

    accessory.context._valveExpiry = Date.now() + duration * 1000;
    service.updateCharacteristic(C.RemainingDuration, duration);

    accessory.context._valveTick = setInterval(() => {
      const remaining = this._valveRemaining(accessory);
      service.updateCharacteristic(C.RemainingDuration, remaining);
      if (remaining <= 0 && accessory.context._valveTick) {
        clearInterval(accessory.context._valveTick);
        accessory.context._valveTick = null;
      }
    }, 1000);

    accessory.context._valveTimer = setTimeout(async () => {
      this._clearValveTimers(accessory);
      this.log.info("Valve hold expired — returning to normal for", accessory.displayName);
      try {
        await this.setRelayMode(accessory, 'normal');
      } catch (err) {
        this.log.warn(`Valve: failed to return ${accessory.displayName} to normal at expiry:`, err.message);
      }
      accessory.context.valveActive = false;
      service.updateCharacteristic(C.Active, C.Active.INACTIVE);
      service.updateCharacteristic(C.InUse, C.InUse.NOT_IN_USE);
      service.updateCharacteristic(C.RemainingDuration, 0);
    }, duration * 1000);
  }

  // Activating one relay direction releases the opposite direction across all its
  // accessory variants (lock/switch/valve), and keeps the same-direction variants in
  // sync — mirrors the lock/switch companion sync rules.
  _syncValveCompanions(accessory, direction, active) {
    if (direction === 'hold_open') {
      // Release the opposite (hold closed) direction.
      this.syncCompanionValve(accessory, 'holdClosedValve', false);
      this.syncCompanionLock(accessory, 'holdClosedLock', this.Characteristic.LockCurrentState.UNSECURED);
      this.syncCompanionSwitch(accessory, 'holdClosedSwitch', false);
      // Keep same-direction variants in sync.
      this.syncCompanionLock(accessory, 'holdOpenLock', active ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED);
      this.syncCompanionSwitch(accessory, 'holdOpenSwitch', active);
    } else {
      this.syncCompanionValve(accessory, 'holdOpenValve', false);
      this.syncCompanionLock(accessory, 'holdOpenLock', this.Characteristic.LockCurrentState.UNSECURED);
      this.syncCompanionSwitch(accessory, 'holdOpenSwitch', false);
      this.syncCompanionLock(accessory, 'holdClosedLock', active ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED);
      this.syncCompanionSwitch(accessory, 'holdClosedSwitch', active);
    }
  }

  // Releases (deactivates) a companion valve of the given type, cancelling its countdown.
  syncCompanionValve(accessory, companionType, active) {
    const baseId = accessory.context.deviceId;
    const companion = this.accessories.find(acc => acc.context.deviceId === baseId && acc.context.accessoryType === companionType);
    if (!companion) return;
    const companionService = companion.getService(this.Service.Valve);
    if (!companionService) return;
    const C = this.Characteristic;
    if ((companion.context.valveActive === true) === active) return;
    this._clearValveTimers(companion);
    companion.context.valveActive = active;
    companionService.updateCharacteristic(C.Active, active ? C.Active.ACTIVE : C.Active.INACTIVE);
    companionService.updateCharacteristic(C.InUse, active ? C.InUse.IN_USE : C.InUse.NOT_IN_USE);
    companionService.updateCharacteristic(C.RemainingDuration, 0);
    this.log.debug(`Synced companion valve ${companionType} to ${active ? 'ACTIVE' : 'INACTIVE'}`);
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

    // Momentary mode passes all-zero delays. Animating a companion through
    // OPENING→OPEN→CLOSED (or on→off) with 0ms timers just produces a visible
    // flicker in the Home app, so leave companions at rest instead.
    if (openingDelay === 0 && gateCloseDelay === 0 && cumulativeDelay === 0) return;

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
            companion.context.switchOn = true;
            service.updateCharacteristic(this.Characteristic.On, true);
            const t = setTimeout(() => {
              companion.context.switchOn = false;
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
    const relayTypes = ['holdOpenLock', 'holdClosedLock', 'holdOpenSwitch', 'holdClosedSwitch', 'holdOpenValve', 'holdClosedValve'];
    const hasRelayAccessories = () => this.accessories.some(acc => relayTypes.includes(acc.context.accessoryType));

    // Feature 1: the external-open log poller runs on its own cadence, independent of
    // whether any relay accessories exist.
    this.startExternalOpenPoller();

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
      const { getDeviceInfoOnce } = require('./api.js');

      try {
        // Fetch only the devices that have relay accessories, each with its owning
        // account's token. A base device maps to exactly one account (dedupe guarantees a
        // single owner per gate), so one token per base device is sufficient.
        const relayAccessories = this.accessories.filter(acc => relayTypes.includes(acc.context.accessoryType));
        const accountByBaseId = new Map();
        relayAccessories.forEach(acc => {
          const { baseId } = splitDeviceId(acc.context.deviceId);
          if (!accountByBaseId.has(baseId)) accountByBaseId.set(baseId, this._accountForAccessory(acc));
        });

        const deviceMap = new Map();
        await Promise.all([...accountByBaseId.entries()].map(async ([baseId, account]) => {
          try {
            const deviceData = await getDeviceInfoOnce(this._tokenFor(account), baseId);
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

    const relayTypes = ['holdOpenLock', 'holdClosedLock', 'holdOpenSwitch', 'holdClosedSwitch', 'holdOpenValve', 'holdClosedValve'];
    this.accessories.forEach(accessory => {
      const accessoryType = accessory.context.accessoryType;
      if (!relayTypes.includes(accessoryType)) return;

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
      const isValve = accessoryType === 'holdOpenValve' || accessoryType === 'holdClosedValve';
      const service = isLock ? accessory.getService(this.Service.LockMechanism)
        : isValve ? accessory.getService(this.Service.Valve)
        : accessory.getService(this.Service.Switch);
      if (!service) return;

      // Extract latch status and disabled status for the specific output
      const latchStatus = outputNum === 2 ? deviceData.output2LatchStatus === true : deviceData.output1LatchStatus === true;
      const isDisabled = outputNum === 2 ? deviceData.output2Disabled === true : deviceData.output1Disabled === true;

      if (isValve) {
        // Does the device latch state say this valve's direction is active?
        const wantActive = accessoryType === 'holdOpenValve'
          ? (latchStatus && isDisabled)
          : (!latchStatus && isDisabled);

        // A running timed hold is not external drift to be corrected — don't revert a
        // countdown mid-flight. (The 15s write cooldown covers the immediately-after-
        // activation window; the active timer extends that guard for the full duration.)
        if (accessory.context.valveActive === true && (accessory.context._valveTimer || accessory.context._valveExpiry)) {
          return;
        }

        const isActive = accessory.context.valveActive === true;
        if (wantActive !== isActive) {
          this.log.info(`Poller: Synced external state update for ${accessory.displayName} -> ${wantActive ? 'ACTIVE' : 'INACTIVE'}`);
          if (!wantActive) this._clearValveTimers(accessory);
          accessory.context.valveActive = wantActive;
          service.updateCharacteristic(this.Characteristic.Active, wantActive ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE);
          service.updateCharacteristic(this.Characteristic.InUse, wantActive ? this.Characteristic.InUse.IN_USE : this.Characteristic.InUse.NOT_IN_USE);
          service.updateCharacteristic(this.Characteristic.RemainingDuration, 0);
        }
      } else if (isLock) {
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

    const { callApi } = require('./api.js');
    const temporalToken = this._tokenFor(this._accountForAccessory(accessory));
    const path = `device/${baseId}/open-gate?outputNum=${outputNum}&output${outputNum}LatchStatus=${latch}&output${outputNum}Disabled=${dsbl}`;
    this.log.debug(`Issuing setRelayMode API request: ${path}`);
    // Interactive path — cap the retry budget so the HomeKit callback isn't held long
    // enough to show "No Response".
    await callApi(path, temporalToken, { retryDelays: [500], timeout: 4000 });
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
    const flags = {
      exposeHoldOpenLock: false, exposeHoldClosedLock: false,
      exposeHoldOpenSwitch: false, exposeHoldClosedSwitch: false,
      exposeHoldOpenValve: false, exposeHoldClosedValve: false,
    };

    if (deviceData) {
      const isLatchPermitted = outputNum === 2 ? deviceData.output2Latch === true : deviceData.output1Latch === true;
      if (!isLatchPermitted) return flags;
    }

    // Explicit per-gate disable always wins.
    if (custom && custom.relayEnabled === false) return flags;

    // Relay is enabled for this gate when it's turned on per-gate (relayEnabled === true,
    // or an explicit per-gate type is chosen) OR globally. This lets a gate opt in even
    // when the global default is off — and opt out when it's on (handled above).
    const perGateType = !!(custom && (custom.relaySwitch === true || custom.relayLock === true || custom.relayValve === true));
    const enabled = (custom && custom.relayEnabled === true) || perGateType || this.config.enableRelayLocks === true;
    if (!enabled) return flags;

    // Per-gate direction takes precedence over global; default is both enabled.
    const holdOpen   = (custom && custom.relayHoldOpen   !== undefined) ? custom.relayHoldOpen   !== false : this.config.relayHoldOpen   !== false;
    const holdClosed = (custom && custom.relayHoldClosed !== undefined) ? custom.relayHoldClosed !== false : this.config.relayHoldClosed !== false;

    // Type: per-gate override if set, otherwise fall back to the global relay accessory type.
    let asSwitch, asLock, asValve;
    if (perGateType) {
      asValve  = custom.relayValve  === true;
      asSwitch = custom.relaySwitch === true;
      asLock   = custom.relayLock   === true;
    } else {
      const globalType = (this.config.relayAccessoryType || 'lock').toLowerCase();
      asValve  = globalType === 'valve';
      asSwitch = globalType === 'switch';
      asLock   = !asValve && !asSwitch;
    }

    flags.exposeHoldOpenValve    = asValve  && holdOpen;
    flags.exposeHoldClosedValve  = asValve  && holdClosed;
    flags.exposeHoldOpenSwitch   = asSwitch && holdOpen;
    flags.exposeHoldClosedSwitch = asSwitch && holdClosed;
    flags.exposeHoldOpenLock     = asLock   && holdOpen;
    flags.exposeHoldClosedLock   = asLock   && holdClosed;
    return flags;
  }

  // Whether external-open detection is enabled for a given gate. Per-gate override
  // takes precedence over the global default (mirrors the relayEnabled precedence).
  _resolveDetectExternalOpens(deviceId) {
    const customEntry = (this.config.customGates || []).find(c => c.deviceId === deviceId);
    if (customEntry && customEntry.detectExternalOpens !== undefined) {
      return customEntry.detectExternalOpens === true;
    }
    return this.config.detectExternalOpens === true;
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

  // Resolves the default Valve hold duration (seconds) for a gate: per-gate override if
  // present, else the global valveDefaultDuration, else 300 (5 min). 0 = indefinite hold.
  // Clamped to HAP's SetDuration ceiling of 3600s (1 hour).
  _resolveValveDefaultDuration(deviceId) {
    const customEntry = (this.config.customGates || []).find(item => item.deviceId === deviceId);
    let seconds = this.safeParseInt(this.config.valveDefaultDuration, 300, 'valveDefaultDuration');
    if (customEntry && customEntry.valveDefaultDuration !== undefined) {
      seconds = this.safeParseInt(customEntry.valveDefaultDuration, seconds, `customGates[${deviceId}].valveDefaultDuration`);
    }
    return Math.min(3600, seconds);
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
    const temporalToken = this._tokenFor(this._accountForAccessory(accessory));
    this.log.debug("Using temporary token for", accessory.displayName);
    // Record this open BEFORE the API call so the log poller can self-dedupe even if the
    // log entry lands before openGate resolves. Keyed by base device + output number.
    this._recordSelfOpen(accessory.context.deviceId);
    await openGate(accessory.context.deviceId, temporalToken);
    this.log.success("Successfully opened gate for", accessory.displayName);
  }

  // Records a plugin-initiated open so the external-open poller can skip the matching log
  // entry (userId === our phoneNumber within ±30s). Keyed "baseId:outputNum".
  // Match tolerance (seconds) for pairing a log entry with a HomeKit-initiated open.
  // Covers clock skew between this host and PalGate's server, and — critically — must be
  // at least the poll interval so a record survives until the poll that reads its entry.
  // Defaults to 30s; scaled up to the poll interval by startExternalOpenPoller.
  _selfOpenWindowSec() {
    return Math.max(30, this._selfOpenWindowConfigured || 0);
  }

  _recordSelfOpen(deviceId) {
    const { baseId, outputNum } = splitDeviceId(deviceId);
    if (!this._selfOpens) this._selfOpens = new Map();
    const key = `${baseId}:${outputNum}`;
    const list = this._selfOpens.get(key) || [];
    const nowSec = Math.floor(Date.now() / 1000);
    list.push(nowSec);
    // Retain for twice the match window so a record can't be pruned before the next poll
    // (which may be up to one poll interval away) plus the match window reads it.
    const retention = 2 * this._selfOpenWindowSec();
    this._selfOpens.set(key, list.filter(t => nowSec - t <= retention));
  }

  // True if a plugin-initiated open for this base device + output was recorded within
  // the match window of the given log-entry timestamp (unix seconds).
  _matchesSelfOpen(baseId, outputNum, entryTimeSec) {
    if (!this._selfOpens) return false;
    const list = this._selfOpens.get(`${baseId}:${outputNum}`);
    if (!list) return false;
    const window = this._selfOpenWindowSec();
    return list.some(t => Math.abs(t - entryTimeSec) <= window);
  }

  // ── Feature 1: external-open detection via the operation log ────────────────
  startExternalOpenPoller() {
    // Only run when at least one admin gate has detection enabled (non-admin gates are
    // filtered out by _detectionBaseIds — the operation log is admin-only).
    const baseIds = this._detectionBaseIds();
    if (baseIds.length === 0) {
      this.log.debug("External-open detection: no eligible (admin + enabled) gates — skipping log poller");
      return;
    }

    const intervalSecs = Math.max(5, this.safeParseInt(this.config.logPollInterval, 15, 'logPollInterval'));
    this._logPollBaseMs = intervalSecs * 1000;
    this._logPollCurrentMs = this._logPollBaseMs;
    // Scale the self-open match/retention window to the poll interval (30s floor) so a
    // longer poll interval can't prune a self-open record before its entry is read.
    this._selfOpenWindowConfigured = intervalSecs;

    // High-water mark per base device, initialized to now so we never replay history.
    this._lastSeenLogTime = new Map();
    const nowSec = Math.floor(Date.now() / 1000);
    baseIds.forEach(id => this._lastSeenLogTime.set(id, nowSec));

    this.log.info(`Starting external-open detection poller (every ${intervalSecs}s) for ${baseIds.length} gate(s)`);
    const schedule = () => {
      this._logPollerTimer = setTimeout(async () => {
        await this._pollExternalOpens();
        schedule();
      }, this._logPollCurrentMs);
    };
    schedule();
  }

  // Base device IDs of gates with detection enabled (deduped — multi-output gates share
  // one base device and thus one log fetch per tick). Non-admin gates are excluded: the
  // operation log is admin-only, so polling them would only ever 401.
  _detectionBaseIds() {
    const ids = new Set();
    this.accessories.forEach(acc => {
      const { baseId } = splitDeviceId(acc.context.deviceId);
      const enabled = this._resolveDetectExternalOpens(baseId) || this._resolveDetectExternalOpens(acc.context.deviceId);
      if (!enabled) return;
      // Admin status unknown (e.g. custom-only gate never seen in discovery) → allow it and
      // let the API be the authority; known-non-admin → skip.
      const admin = this._deviceAdminById ? this._deviceAdminById.get(baseId) : undefined;
      if (admin === false) {
        this.log.debug(`External-open detection: skipping non-admin gate ${baseId} (operation log requires admin)`);
        return;
      }
      ids.add(baseId);
    });
    return [...ids];
  }

  // Resolves the account that owns a base device, via any accessory registered under it.
  // Falls back to the first account (e.g. custom-only gate never seen in discovery).
  _accountForBaseId(baseId) {
    const acc = this.accessories.find(a => splitDeviceId(a.context.deviceId).baseId === baseId);
    return (acc && this._accountForAccessory(acc)) || this.accounts[0];
  }

  async _pollExternalOpens() {
    const baseIds = this._detectionBaseIds();
    if (baseIds.length === 0) return;

    const { getDeviceLogOnce } = require('./api.js');

    let anyFailure = false;
    let rateLimited = false;
    await Promise.all(baseIds.map(async baseId => {
      const account = this._accountForBaseId(baseId);
      let temporalToken;
      try {
        temporalToken = this._tokenFor(account);
      } catch (err) {
        anyFailure = true;
        this.log.warn(`Log poller: failed to generate token for account "${account.label}":`, err.message);
        return;
      }
      try {
        const entries = await getDeviceLogOnce(temporalToken, baseId);
        this._processLogEntries(baseId, entries, account);
      } catch (err) {
        anyFailure = true;
        if (/API call error: 429/.test(err.message)) rateLimited = true;
        this.log.warn(`Log poller: failed to fetch log for ${baseId}:`, err.message);
      }
    }));

    // Backoff on 429/failures, doubling up to 5 min; reset on a fully successful tick.
    if (rateLimited || anyFailure) {
      this._logPollCurrentMs = Math.min(this._logPollCurrentMs * 2, 5 * 60 * 1000);
      this.log.debug(`Log poller: backing off to ${this._logPollCurrentMs / 1000}s`);
    } else {
      this._logPollCurrentMs = this._logPollBaseMs;
    }
  }

  _processLogEntries(baseId, entries, account = this.accounts[0]) {
    if (!Array.isArray(entries) || entries.length === 0) return;
    const highWater = this._lastSeenLogTime.get(baseId) || 0;
    let maxSeen = highWater;

    // Entries are newest-first; process oldest-first so animations fire in order.
    const fresh = entries.filter(e => e && typeof e.time === 'number' && e.time > highWater);
    fresh.sort((a, b) => a.time - b.time);

    for (const entry of fresh) {
      if (entry.time > maxSeen) maxSeen = entry.time;

      // operation is "Output N" — map to the gate's output number.
      const match = typeof entry.operation === 'string' && entry.operation.match(/Output\s+(\d+)/i);
      if (!match) continue;
      const outputNum = parseInt(match[1], 10);

      // Self-dedupe: skip our own HomeKit-initiated opens (the owning account's phone number
      // within ±30s of a trigger the plugin just issued). Opens by that phone number OUTSIDE
      // that window are the owner opening from the PalGate app well after any HomeKit action —
      // those are genuine "not from HomeKit just now" opens and SHOULD be surfaced.
      const entryUserMatchesUs = account && account.phoneNumber !== undefined && String(entry.userId) === String(account.phoneNumber);
      if (entryUserMatchesUs && this._matchesSelfOpen(baseId, outputNum, entry.time)) {
        this.log.debug(`Log poller: skipping self-initiated open for ${baseId}:${outputNum}`);
        continue;
      }

      this._handleExternalOpen(baseId, outputNum, entry);
    }

    this._lastSeenLogTime.set(baseId, maxSeen);
  }

  _handleExternalOpen(baseId, outputNum, entry) {
    // Resolve the accessory deviceId — multi-output gates use "baseId:outputNum", but a
    // single-output gate is registered under the plain baseId.
    const withOutput = `${baseId}:${outputNum}`;
    const targets = this.accessories.filter(acc =>
      acc.context.deviceId === withOutput ||
      (outputNum === 1 && acc.context.deviceId === baseId));
    if (targets.length === 0) return;

    // Only the primary (openable) accessory types animate on an external open; relay
    // accessories track latch state, not opens. Animate one primary and let the existing
    // companion sync fan the animation out to the gate's other primary tiles.
    const primaryTypes = ['garageDoor', 'switch', 'lock'];
    const primary = targets.find(acc => primaryTypes.includes(acc.context.accessoryType));
    if (!primary) return;

    // Attribution for the log line.
    const name = primary.context.name || primary.displayName;
    const who = [entry.firstname, entry.lastname].filter(Boolean).join(' ').trim() || 'someone';
    let how;
    if (entry.type === 100) how = 'app';
    else if (entry.type === 8) how = `dial-in from ${entry.sn}`;
    else how = `type ${entry.type}`;
    this.log.info(`Gate "${name}" opened externally by ${who} (${how})`);

    // Animate through the existing trigger animation WITHOUT calling the open API.
    this._animateExternalOpen(primary);
  }

  // Runs the existing HomeKit-trigger animation for an external open, reusing the same
  // timer bookkeeping as a real tap but skipping the API open call.
  _animateExternalOpen(accessory) {
    const type = accessory.context.accessoryType;
    const deviceId = accessory.context.deviceId;
    const { openingDelay, gateCloseDelay } = this._resolveDelays(deviceId);
    const cumulativeDelay = openingDelay + gateCloseDelay;
    const C = this.Characteristic;

    if (type === 'garageDoor') {
      const service = accessory.getService(this.Service.GarageDoorOpener);
      if (!service) return;
      if (accessory.context._doorTimers) accessory.context._doorTimers.forEach(clearTimeout);
      accessory.context.currentDoorState = C.CurrentDoorState.OPENING;
      accessory.context.targetDoorState = C.TargetDoorState.OPEN;
      service.updateCharacteristic(C.TargetDoorState, C.TargetDoorState.OPEN);
      service.updateCharacteristic(C.CurrentDoorState, C.CurrentDoorState.OPENING);
      this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, cumulativeDelay);
      const triggerTime = Date.now();
      accessory.context._doorTimerT1Expiry = triggerTime + openingDelay;
      accessory.context._doorTimerT2Expiry = triggerTime + openingDelay + gateCloseDelay;
      const t1 = setTimeout(() => {
        accessory.context.currentDoorState = C.CurrentDoorState.OPEN;
        service.updateCharacteristic(C.CurrentDoorState, C.CurrentDoorState.OPEN);
        const t2 = setTimeout(() => {
          accessory.context.currentDoorState = C.CurrentDoorState.CLOSED;
          accessory.context.targetDoorState = C.TargetDoorState.CLOSED;
          service.updateCharacteristic(C.CurrentDoorState, C.CurrentDoorState.CLOSED);
          service.updateCharacteristic(C.TargetDoorState, C.TargetDoorState.CLOSED);
          accessory.context._doorTimers = null;
          accessory.context._doorTimerT1Expiry = null;
          accessory.context._doorTimerT2Expiry = null;
        }, gateCloseDelay);
        accessory.context._doorTimers = [t2];
      }, openingDelay);
      accessory.context._doorTimers = [t1];
    } else if (type === 'switch') {
      const service = accessory.getService(this.Service.Switch);
      if (!service) return;
      if (accessory.context._switchTimer) clearTimeout(accessory.context._switchTimer);
      accessory.context.switchOn = true;
      service.updateCharacteristic(C.On, true);
      this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, cumulativeDelay);
      accessory.context._switchTimerExpiry = Date.now() + cumulativeDelay;
      accessory.context._switchTimer = setTimeout(() => {
        accessory.context.switchOn = false;
        service.updateCharacteristic(C.On, false);
        accessory.context._switchTimer = null;
        accessory.context._switchTimerExpiry = null;
      }, cumulativeDelay);
    } else if (type === 'lock') {
      const service = accessory.getService(this.Service.LockMechanism);
      if (!service) return;
      if (accessory.context._lockTimer) clearTimeout(accessory.context._lockTimer);
      accessory.context.lockCurrentState = C.LockCurrentState.UNSECURED;
      accessory.context.lockTargetState = C.LockTargetState.UNSECURED;
      service.updateCharacteristic(C.LockTargetState, C.LockTargetState.UNSECURED);
      service.updateCharacteristic(C.LockCurrentState, C.LockCurrentState.UNSECURED);
      this.syncPrimaryAccessories(accessory, openingDelay, gateCloseDelay, cumulativeDelay);
      accessory.context._lockTimerExpiry = Date.now() + cumulativeDelay;
      accessory.context._lockTimer = setTimeout(() => {
        accessory.context.lockCurrentState = C.LockCurrentState.SECURED;
        accessory.context.lockTargetState = C.LockTargetState.SECURED;
        service.updateCharacteristic(C.LockCurrentState, C.LockCurrentState.SECURED);
        service.updateCharacteristic(C.LockTargetState, C.LockTargetState.SECURED);
        accessory.context._lockTimer = null;
        accessory.context._lockTimerExpiry = null;
      }, cumulativeDelay);
    }
  }
}

module.exports = PalGatePlatform;
