
module.exports = (api) => {
    // Load the platform logic from the lib folder.
    const PalGatePlatform = require('./lib/palgate.js');
    // Register the platform with Homebridge using the registered alias.
    api.registerPlatform('PalGatePlatform', PalGatePlatform);
  }