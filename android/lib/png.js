'use strict';
/**
 * 极简 PNG 编码 + 启动图标绘制（零依赖，只用 Node 自带 zlib）。
 *
 * 画完再按 4×4 盒式降采样做抗锯齿，所以只要写「点是否在图形内」的朴素判断就够了。
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

const mix = (a, b, t) => a + (b - a) * t;

/** 圆角矩形：返回点是否落在里面 */
function inRoundRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x;
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 三角形的重心法判定 */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * 画启动图标：近黑圆角底 + 青/红对半的播放三角（抖音那套配色）。
 * @param {number} size 输出边长（px）
 */
function icon(size) {
  const SS = 4;                    // 超采样倍率
  const S = size * SS;
  const out = Buffer.alloc(size * size * 4);
  const hi = Buffer.alloc(S * S * 4);

  const inset = S * 0.055;
  const radius = S * 0.235;
  const bx0 = inset, by0 = inset, bx1 = S - inset, by1 = S - inset;

  // 播放三角
  const tx0 = S * 0.375, tx1 = S * 0.735;
  const ty0 = S * 0.295, ty1 = S * 0.705;
  const apexY = (ty0 + ty1) / 2;
  const mid = (tx0 + tx1) / 2;
  const blend = (tx1 - tx0) * 0.12;   // 青红之间的过渡带

  const CYAN = [0x25, 0xf4, 0xee];
  const RED  = [0xfe, 0x2c, 0x55];

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p = (y * S + x) * 4;
      if (!inRoundRect(x + 0.5, y + 0.5, bx0, by0, bx1, by1, radius)) continue;

      // 底色：左上略亮的近黑，向右下压暗
      const g = (x / S + y / S) / 2;
      let r = mix(0x1c, 0x08, g), gg = mix(0x1c, 0x08, g), b = mix(0x24, 0x0c, g);

      if (inTriangle(x + 0.5, y + 0.5, tx0, ty0, tx0, ty1, tx1, apexY)) {
        const t = Math.max(0, Math.min(1, (x - (mid - blend)) / (2 * blend)));
        r = mix(CYAN[0], RED[0], t);
        gg = mix(CYAN[1], RED[1], t);
        b = mix(CYAN[2], RED[2], t);
      }

      hi[p] = r; hi[p + 1] = gg; hi[p + 2] = b; hi[p + 3] = 255;
    }
  }

  // 盒式降采样：按 alpha 加权，避免边缘发暗
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const p = ((y * SS + dy) * S + (x * SS + dx)) * 4;
          const a = hi[p + 3] / 255;
          ar += hi[p] * a; ag += hi[p + 1] * a; ab += hi[p + 2] * a; aa += a;
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      if (aa > 0) {
        out[o] = Math.round(ar / aa);
        out[o + 1] = Math.round(ag / aa);
        out[o + 2] = Math.round(ab / aa);
      }
      out[o + 3] = Math.round((aa / n) * 255);
    }
  }
  return encode(size, size, out);
}

module.exports = { encode, icon };
