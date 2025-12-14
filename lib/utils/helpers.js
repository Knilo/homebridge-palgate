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
    const outputs = [];
    
    // Check for output1, output2, etc. fields
    // Keep checking until we find no more output fields
    let outputNum = 1;
    
    while (true) {
      const outputKey = `output${outputNum}`;
      const outputDisabledKey = `output${outputNum}Disabled`;
      
      // If this output field doesn't exist, we're done
      if (deviceData[outputKey] === undefined) {
        // If we haven't found any output fields at all, this is a single-output device
        if (outputNum === 1) {
          break;
        }
        // Otherwise, we've checked all outputs
        break;
      }
      
      // Check if this output is enabled (true and not disabled)
      if (deviceData[outputKey] === true && deviceData[outputDisabledKey] !== true) {
        const nameKey = `name${outputNum}`;
        const name = deviceData[nameKey] || null;
        outputs.push({ outputNum, name });
      }
      
      outputNum++;
    }
    
    // Only return outputs if we found more than one enabled output
    // If only one output (or none), return empty array (single-gate device)
    return outputs.length > 1 ? outputs : [];
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