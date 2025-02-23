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
  
  module.exports = {
    galoisMul2,
    bytesToHex,
    packUint64BE
  };