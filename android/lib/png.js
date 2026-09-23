'use strict';
/**
 * 极简 PNG 编码（零依赖，只用 Node 自带 zlib）。
 *
 * ⚠️ 图标绘制已迁到 `lib/icon.js`（2026-09-23 视觉升级）。
 *    这里保留 `icon()` 只是**向后兼容的转发**，真正的画法在 icon.js ——
 *    改图标请改 icon.js，别在这里改。
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const name = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}

/** rgba: Buffer，长度 w*h*4（8 位直通 alpha） */
function encode(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                       // filter type: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 画启动图标。
 *
 * ⚠️ **转发**到 `lib/icon.js` —— 真正的画法（分层材质、双色符号、光扫）都在那边。
 *    保留这个函数只是为了不破坏旧的 `require('./lib/png.js').icon(size)` 调用。
 * @param {number} size 输出边长（px）
 * @param {object} [opt] 透传给 icon.js 的可调参数
 */
function icon(size, opt) {
  return require('./icon.js').icon(size, opt);
}

module.exports = { encode, icon };
