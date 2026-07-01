function galoisMul2(value) {
    return (value & 0x80) ? (((value << 1) ^ 0x1b) & 0xff) : ((value << 1) & 0xff);
  }
  
  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  
  function packUint64BE(num) {
    const result = new Uint8Array(8);
    let big = BigInt(num);
    for (let i = 7; i >= 0; i--) {
      result[i] = Number(big & 0xffn);
      big >>= 8n;
    }
    return result;
  }
  
  /**
   * Detects multiple outputs from device data.
   * Returns array of detected outputs with their numbers and names.
   * Returns empty array for single-output devices.
   * 
   * @param {Object} deviceData - Device data from API
   * @returns {Array} Array of { outputNum, name } objects, or empty array for single-output
   */
  function detectMultiOutputDevices(deviceData) {
    // Count total output fields to determine if this is truly a multi-output device.
    // We must base this on field presence, not enabled count, so that a device with
    // output1 enabled and output2 disabled consistently gets the deviceId:outputNum
    // format — preventing accessory orphaning when the second output is later enabled.
    let totalOutputs = 0;
    while (deviceData[`output${totalOutputs + 1}`] !== undefined) {
      totalOutputs++;
    }

    // Truly single-output device — caller uses plain deviceId
    if (totalOutputs <= 1) {
      return [];
    }

    // Multi-output device: return only currently-enabled outputs, but always with
    // the deviceId:outputNum naming convention regardless of how many are enabled.
    const outputs = [];
    for (let outputNum = 1; outputNum <= totalOutputs; outputNum++) {
      if (deviceData[`output${outputNum}`] === true && deviceData[`output${outputNum}Disabled`] !== true) {
        outputs.push({ outputNum, name: deviceData[`name${outputNum}`] || null });
      }
    }
    return outputs;
  }

  /**
   * Generates gate entries for a device.
   * For single-output devices (empty outputs array), returns single entry with deviceId.
   * For multi-output devices, returns multiple entries with deviceId:outputNum format.
   * 
   * @param {string} deviceId - Base device ID
   * @param {Array} outputs - Array of { outputNum, name } from detectMultiOutputDevices
   * @param {string} defaultName - Default name (usually name1 or deviceId)
   * @param {Object} deviceData - Device data from API (for accessing nameN fields)
   * @returns {Array} Array of gate entry objects with deviceId and name
   */
  function generateGateEntries(deviceId, outputs, defaultName, deviceData) {
    // Single-output device (no outputs detected)
    if (outputs.length === 0) {
      return [{ deviceId, name: defaultName }];
    }
    
    // Multi-output device - generate entry for each output
    return outputs.map(({ outputNum, name }) => {
      const gateDeviceId = `${deviceId}:${outputNum}`;
      // Use nameN if available, otherwise generate "Device Name - Output N"
      const gateName = name || (defaultName ? `${defaultName} - Output ${outputNum}` : `Output ${outputNum}`);
      return { deviceId: gateDeviceId, name: gateName };
    });
  }

  module.exports = {
    galoisMul2,
    bytesToHex,
    packUint64BE,
    detectMultiOutputDevices,
    generateGateEntries
  };