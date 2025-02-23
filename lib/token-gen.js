const { BLOCK_SIZE, TOKEN_SIZE, TIMESTAMP_OFFSET, T_C_KEY, TokenType } = require('./utils/constants.js');
const { aesEncryptDecrypt } = require('./utils/aes.js');
const { packUint64BE, bytesToHex } = require('./utils/helpers.js');

function generateToken(sessionToken, phoneNumber, tokenType, timestampMs = null, timestampOffset = TIMESTAMP_OFFSET) {
  if (sessionToken.length !== BLOCK_SIZE) {
    throw new Error('Invalid session token');
  }
  if (timestampMs === null) {
    timestampMs = Math.floor(Date.now() / 1000);
  }

  const step2Key = _step1(sessionToken, phoneNumber);
  const step2Result = _step2(step2Key, timestampMs, timestampOffset);

  const result = new Uint8Array(TOKEN_SIZE);
  if (tokenType === TokenType.SMS) {
    result[0] = 0x01;
  } else if (tokenType === TokenType.PRIMARY) {
    result[0] = 0x11;
  } else if (tokenType === TokenType.SECONDARY) {
    result[0] = 0x21;
  } else {
    throw new Error(`unknown token type: ${tokenType}`);
  }

  // Pack the phone number and take bytes 2 to 7.
  const phonePacked = packUint64BE(phoneNumber);
  result.set(phonePacked.slice(2, 8), 1);

  result.set(step2Result, 7);

  return bytesToHex(result).toUpperCase();
}

function _step1(sessionToken, phoneNumber) {
  const key = new Uint8Array(T_C_KEY); // Copy T_C_KEY
  const phonePacked = packUint64BE(phoneNumber);
  // Replace key[6..11] with phonePacked[2..7]
  for (let i = 0; i < 6; i++) {
    key[6 + i] = phonePacked[2 + i];
  }
  return aesEncryptDecrypt(sessionToken, key, true);
}

function _step2(resultFromStep1, timestampMs, timestampOffset) {
  const nextState = new Uint8Array(BLOCK_SIZE);
  // Set nextState[1..2] to the little-endian representation of 0xa0a.
  const val16 = 0xa0a;
  nextState[1] = val16 & 0xff;
  nextState[2] = (val16 >> 8) & 0xff;
  // Set nextState[10..13] to the big-endian representation of (timestampMs + timestampOffset).
  const val32 = timestampMs + timestampOffset;
  nextState[10] = (val32 >> 24) & 0xff;
  nextState[11] = (val32 >> 16) & 0xff;
  nextState[12] = (val32 >> 8) & 0xff;
  nextState[13] = val32 & 0xff;
  return aesEncryptDecrypt(nextState, resultFromStep1, false);
}

module.exports = { generateToken };