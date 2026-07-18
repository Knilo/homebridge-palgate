'use strict';

const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');

/**
 * Minimal mock of the Homebridge plugin API surface that PalGatePlatform uses:
 * hap.Service / hap.Characteristic / hap.uuid, platformAccessory, the
 * didFinishLaunching/shutdown events, and (un)registerPlatformAccessories with
 * call recording so tests can assert the accessory lifecycle.
 */

class MockCharacteristic {
  constructor(type) {
    this.type = type;
    this.value = undefined;
    this.updates = [];
    this.handlers = {};
    this.props = null;
  }
  on(event, handler) { this.handlers[event] = handler; return this; }
  onSet(handler) { this.handlers.set = handler; return this; }
  onGet(handler) { this.handlers.get = handler; return this; }
  updateValue(value) { this.value = value; this.updates.push(value); return this; }
  setProps(props) { this.props = props; return this; }
  // Test helper: simulate HomeKit writing a value (hap 'set' callback style)
  async triggerSet(value) {
    const handler = this.handlers.set;
    if (!handler) throw new Error(`no set handler on ${this.type}`);
    return new Promise((resolve, reject) => {
      const result = handler(value, (err) => err ? reject(err) : resolve());
      // support onSet(async v => {}) style too
      if (result && typeof result.then === 'function') result.then(resolve, reject);
    });
  }
}

class MockService {
  constructor(serviceType, displayName) {
    this.serviceType = serviceType;
    this.displayName = displayName;
    this.characteristics = new Map();
  }
  getCharacteristic(type) {
    if (!this.characteristics.has(type)) this.characteristics.set(type, new MockCharacteristic(type));
    return this.characteristics.get(type);
  }
  setCharacteristic(type, value) { this.getCharacteristic(type).updateValue(value); return this; }
  updateCharacteristic(type, value) { this.getCharacteristic(type).updateValue(value); return this; }
}

class MockPlatformAccessory {
  constructor(displayName, uuid) {
    this.displayName = displayName;
    this.UUID = uuid;
    this.context = {};
    this.services = [];
  }
  addService(serviceType, name) {
    const service = new MockService(serviceType, name);
    this.services.push(service);
    return service;
  }
  getService(serviceType) {
    return this.services.find(s => s.serviceType === serviceType);
  }
}

// Service/Characteristic "types" only need identity — the platform passes them
// around and compares them, it never constructs them directly.
const SERVICE_TYPES = ['GarageDoorOpener', 'LockMechanism', 'Switch', 'AccessoryInformation'];
const CHARACTERISTIC_TYPES = [
  'CurrentDoorState', 'TargetDoorState', 'LockCurrentState', 'LockTargetState', 'On',
  'Manufacturer', 'Model', 'SerialNumber', 'FirmwareRevision', 'Name',
];

// Real hap enum values the platform logic depends on
const CHARACTERISTIC_ENUMS = {
  CurrentDoorState: { OPEN: 0, CLOSED: 1, OPENING: 2, CLOSING: 3, STOPPED: 4 },
  TargetDoorState: { OPEN: 0, CLOSED: 1 },
  LockCurrentState: { UNSECURED: 0, SECURED: 1, JAMMED: 2, UNKNOWN: 3 },
  LockTargetState: { UNSECURED: 0, SECURED: 1 },
};

function makeHap() {
  const Service = {};
  for (const t of SERVICE_TYPES) Service[t] = t;
  const Characteristic = {};
  for (const t of CHARACTERISTIC_TYPES) {
    // Unique identity object per type (usable as a Map key), carrying enum values.
    Characteristic[t] = Object.assign({ toString: () => t }, CHARACTERISTIC_ENUMS[t]);
  }
  return {
    Service,
    Characteristic,
    uuid: { generate: s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 36) },
  };
}

function createMockHomebridgeApi() {
  const emitter = new EventEmitter();
  const registered = [];
  const unregistered = [];
  const api = {
    hap: makeHap(),
    platformAccessory: MockPlatformAccessory,
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    registerPlatformAccessories(_plugin, _platform, accessories) { registered.push(...accessories); },
    unregisterPlatformAccessories(_plugin, _platform, accessories) { unregistered.push(...accessories); },
    updatePlatformAccessories() {},
    registered,
    unregistered,
    // Fire didFinishLaunching and wait for the platform's async handler to finish.
    async launch() {
      const handlers = emitter.listeners('didFinishLaunching');
      for (const h of handlers) await h();
    },
  };
  return api;
}

function createMockLog() {
  const entries = [];
  const push = level => (...args) => entries.push({ level, message: args.join(' ') });
  return {
    entries,
    info: push('info'), warn: push('warn'), error: push('error'),
    debug: push('debug'), success: push('success'), log: push('log'),
    has(level, pattern) { return entries.some(e => e.level === level && pattern.test(e.message)); },
  };
}

module.exports = { createMockHomebridgeApi, createMockLog, MockPlatformAccessory };
