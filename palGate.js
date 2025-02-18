// palGate.js
const { generateToken } = require('./tokenGenerator.js');
const { validateToken, openGate } = require('./palGateAPI.js');

module.exports = (api) => {
  api.registerAccessory('PalGateOpener', PalGateOpener);
};

class PalGateOpener {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    this.deviceId = config['deviceId'];
    this.token = config['token'];
    this.tokenType = config['tokenType'];
    this.phoneNumber = config['phoneNumber'];

    this.accessoryType = (config['accessoryType'] || 'switch').toLowerCase();
    this.name = config.name;

    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    this.log.debug('PalGate Accessory Plugin Loaded');
    this.log.debug("deviceID :", this.deviceId);
    this.log.debug("token :", this.token);
    this.log.debug("phoneNumber :", this.phoneNumber);

    // Verify login details
    try {
      const temporalToken = generateToken(
        Buffer.from(this.token, 'hex'),
        parseInt(this.phoneNumber, 10),
        this.tokenType
      );
      this.log.debug("Generated temp token for validation:", temporalToken);
      validateToken(temporalToken, (err, response) => {
        if (err) {
          this.log.error("Token validation failed:", err);
        } else {
          this.log.debug("Token validated successfully. Response: " + response);
        }
      });
    } catch (error) {
      this.log.error("Error during token validation:", error);
    }

    // Verify accessory type meets supporting types.
    if (this.accessoryType !== 'switch' && this.accessoryType !== 'garagedoor') {
      this.log.warn('Accessory Type is not supported, using it as "switch" instead!');
      this.accessoryType = 'switch';
    }

    // AccessoryInformation service
    this.informationService = new this.api.hap.Service.AccessoryInformation()
      .setCharacteristic(this.api.hap.Characteristic.Manufacturer, "Pal Systems")
      .setCharacteristic(this.api.hap.Characteristic.Model, "PalGate App");

    // Create the appropriate service based on accessory type.
    switch (this.accessoryType) {
      case "switch":
        this.service = new this.api.hap.Service.Switch(this.name);
        this.service.getCharacteristic(this.api.hap.Characteristic.On)
          .on('get', this.getOnHandler.bind(this))
          .on('set', this.setOnHandler.bind(this));
        break;
      case "garagedoor":
        this.service = new this.api.hap.Service.GarageDoorOpener(this.name);
        this.service.getCharacteristic(this.Characteristic.CurrentDoorState)
          .on('get', this.handleCurrentDoorStateGet.bind(this));
        this.service.getCharacteristic(this.Characteristic.TargetDoorState)
          .on('get', this.handleTargetDoorStateGet.bind(this))
          .on('set', this.handleTargetDoorStateSet.bind(this));
        break;
    }
  }

  getServices() {
    return [this.informationService, this.service];
  }

  // GET handler for CurrentDoorState
  handleCurrentDoorStateGet(callback) {
    this.log.debug('Triggered GET Current DoorState');
    const currentValue = this.api.hap.Characteristic.CurrentDoorState.CLOSED;
    callback(null, currentValue);
  }

  // GET handler for TargetDoorState
  handleTargetDoorStateGet(callback) {
    this.log.debug('Triggered GET Target DoorState');
    const targetDoorState = this.api.hap.Characteristic.CurrentDoorState.CLOSED;
    callback(null, targetDoorState);
  }

  // SET handler for TargetDoorState (Garage Door)
  handleTargetDoorStateSet(value, callback) {
    this.log.debug("Checking values before generating token...");
    this.log.debug("Token:", this.token);
    this.log.debug("Phone Number:", this.phoneNumber);

    if (!this.token || typeof this.token !== 'string' || !/^[0-9a-fA-F]{32}$/.test(this.token)) {
      this.log.error("Error: Token is missing or invalid.");
      return callback(new Error("Token is missing or invalid."));
    }
    if (!this.phoneNumber || isNaN(parseInt(this.phoneNumber, 10))) {
      this.log.error("Error: Phone number is missing or invalid.");
      return callback(new Error("Phone number is missing or invalid."));
    }
    if (value == this.api.hap.Characteristic.TargetDoorState.OPEN) {
      try {
        const temporalToken = generateToken(
          Buffer.from(this.token, 'hex'),
          parseInt(this.phoneNumber, 10),
          this.tokenType
        );
        this.log.debug("Generated temp token for opening gate:", temporalToken);
        openGate(this.deviceId, temporalToken, (err, response) => {
          if (err) {
            this.log.error("Error opening gate:", err);
            return callback(err);
          } else {
            this.log.info("Gate opened successfully!");
            this.service.setCharacteristic(
              this.Characteristic.CurrentDoorState,
              this.api.hap.Characteristic.CurrentDoorState.OPEN
            );
            this.log.debug("Response: " + response);
            return callback(null);
          }
        });
      } catch (error) {
        this.log.error("Error generating token for opening gate:", error);
        return callback(error);
      }
    } else if (value == this.api.hap.Characteristic.CurrentDoorState.CLOSED) {
      this.log.debug('Closing gate...');
      this.service.setCharacteristic(this.Characteristic.CurrentDoorState, this.api.hap.Characteristic.CurrentDoorState.CLOSED);
      return callback(null);
    }
  }

  // GET handler for Switch On state
  getOnHandler(callback) {
    this.log.debug('Getting switch state');
    const value = false;
    callback(null, value);
  }

  // SET handler for Switch On state
  setOnHandler(value, callback) {
    this.log.debug("Checking values before generating token...");
    this.log.debug("Token:", this.token);
    this.log.debug("Phone Number:", this.phoneNumber);

    if (!this.token || typeof this.token !== 'string' || !/^[0-9a-fA-F]{32}$/.test(this.token)) {
      this.log.error("Error: Token is missing or invalid.");
      return callback(new Error("Token is missing or invalid."));
    }
    if (!this.phoneNumber || isNaN(parseInt(this.phoneNumber, 10))) {
      this.log.error("Error: Phone number is missing or invalid.");
      return callback(new Error("Phone number is missing or invalid."));
    }
    try {
      const temporalToken = generateToken(
        Buffer.from(this.token, 'hex'),
        parseInt(this.phoneNumber, 10),
        this.tokenType
      );
      this.log.debug("Generated temp token for opening gate:", temporalToken);
      openGate(this.deviceId, temporalToken, (err, response) => {
        if (err) {
          this.log.error("Error opening gate:", err);
          return callback(err);
        } else {
          this.log.info("Gate opened successfully!");
          this.log.debug("Response: " + response);
          return callback(null);
        }
      });
    } catch (error) {
      this.log.error("Error generating token for opening gate:", error);
      return callback(error);
    }
  }
}
