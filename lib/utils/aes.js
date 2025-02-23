const { S_BOX, INVERSE_S_BOX, RCON, BLOCK_SIZE, KEY_SIZE } = require('./constants');
const { galoisMul2 } = require('./helpers');

function aesEncryptDecrypt(stateBytes, keyBytes, isEncrypt) {
  if (stateBytes.length !== BLOCK_SIZE || keyBytes.length !== KEY_SIZE) {
    throw new Error("State and/or key are not 16 bytes");
  }
  const state = new Uint8Array(stateBytes);
  const key = new Uint8Array(keyBytes);
  _aesEncDec(state, key, isEncrypt);
  return state;
}

function _aesEncDec(state, key, encrypt) {
  if (encrypt) {
    for (let rnd = 0; rnd < 10; rnd++) {
      key[0] = (S_BOX[key[13]] ^ key[0] ^ RCON[rnd]) & 0xff;
      key[1] = (S_BOX[key[14]] ^ key[1]) & 0xff;
      key[2] = (S_BOX[key[15]] ^ key[2]) & 0xff;
      key[3] = (S_BOX[key[12]] ^ key[3]) & 0xff;
      for (let i = 4; i < KEY_SIZE; i++) {
        key[i] = (key[i] ^ key[i - 4]) & 0xff;
      }
    }
    for (let i = 0; i < BLOCK_SIZE; i++) {
      state[i] = (state[i] ^ key[i]) & 0xff;
    }
  }
  for (let rnd = 0; rnd < 10; rnd++) {
    if (encrypt) {
      for (let i = KEY_SIZE - 1; i > 3; i--) {
        key[i] = (key[i] ^ key[i - 4]) & 0xff;
      }
      key[0] = (S_BOX[key[13]] ^ key[0] ^ RCON[9 - rnd]) & 0xff;
      key[1] = (S_BOX[key[14]] ^ key[1]) & 0xff;
      key[2] = (S_BOX[key[15]] ^ key[2]) & 0xff;
      key[3] = (S_BOX[key[12]] ^ key[3]) & 0xff;
    } else {
      for (let i = 0; i < BLOCK_SIZE; i++) {
        state[i] = S_BOX[state[i] ^ key[i]];
      }
      let buf1 = state[1];
      state[1] = state[5];
      state[5] = state[9];
      state[9] = state[13];
      state[13] = buf1;
      let tmp1 = state[2];
      let tmp2 = state[6];
      state[2] = state[10];
      state[6] = state[14];
      state[10] = tmp1;
      state[14] = tmp2;
      let tmp = state[15];
      state[15] = state[11];
      state[11] = state[7];
      state[7] = state[3];
      state[3] = tmp;
    }
    if ((rnd > 0 && encrypt) || (!encrypt && rnd < 9)) {
      for (let i = 0; i < 4; i++) {
        let base = i * 4;
        if (encrypt) {
          const buf1 = galoisMul2(galoisMul2(state[base] ^ state[base + 2]));
          const buf2 = galoisMul2(galoisMul2(state[base + 1] ^ state[base + 3]));
          state[base] = (state[base] ^ buf1) & 0xff;
          state[base + 1] = (state[base + 1] ^ buf2) & 0xff;
          state[base + 2] = (state[base + 2] ^ buf1) & 0xff;
          state[base + 3] = (state[base + 3] ^ buf2) & 0xff;
        }
        const mix = state[base] ^ state[base + 1] ^ state[base + 2] ^ state[base + 3];
        const first = state[base];
        let buf3 = galoisMul2(state[base] ^ state[base + 1]);
        state[base] = (state[base] ^ buf3 ^ mix) & 0xff;
        buf3 = galoisMul2(state[base + 1] ^ state[base + 2]);
        state[base + 1] = (state[base + 1] ^ buf3 ^ mix) & 0xff;
        buf3 = galoisMul2(state[base + 2] ^ state[base + 3]);
        state[base + 2] = (state[base + 2] ^ buf3 ^ mix) & 0xff;
        buf3 = galoisMul2(state[base + 3] ^ first);
        state[base + 3] = (state[base + 3] ^ buf3 ^ mix) & 0xff;
      }
    }
    if (encrypt) {
      let buf1 = state[13];
      state[13] = state[9];
      state[9] = state[5];
      state[5] = state[1];
      state[1] = buf1;
      let tmp1 = state[10];
      let tmp2 = state[14];
      state[10] = state[2];
      state[14] = state[6];
      state[2] = tmp1;
      state[6] = tmp2;
      let tmp = state[3];
      state[3] = state[7];
      state[7] = state[11];
      state[11] = state[15];
      state[15] = tmp;
      for (let i = 0; i < BLOCK_SIZE; i++) {
        state[i] = (INVERSE_S_BOX[state[i]] ^ key[i]) & 0xff;
      }
    } else {
      key[0] = (S_BOX[key[13]] ^ key[0] ^ RCON[rnd]) & 0xff;
      key[1] = (S_BOX[key[14]] ^ key[1]) & 0xff;
      key[2] = (S_BOX[key[15]] ^ key[2]) & 0xff;
      key[3] = (S_BOX[key[12]] ^ key[3]) & 0xff;
      for (let i = 4; i < KEY_SIZE; i++) {
        key[i] = (key[i] ^ key[i - 4]) & 0xff;
      }
    }
  }
  if (!encrypt) {
    for (let i = 0; i < BLOCK_SIZE; i++) {
      state[i] = (state[i] ^ key[i]) & 0xff;
    }
  }
}

module.exports = {
  aesEncryptDecrypt
};