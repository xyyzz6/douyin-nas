'use strict';
/**
 * 启动图标绘制（零依赖，纯 Node / 只用自带 API）。
 *
 * 设计目标（2026-09-23 视觉升级）：
 *   旧版是「近黑圆角块 + 一个平涂三角 + 中间一道青红渐变带」——
 *   平、扁、无层次，那道过渡带还是灰的（青红直接插值会经过浑浊的中间色）。
 *   新版要做出**材质感**，靠四层叠出来：
 *     1. 底：斜向冷色渐变 + 顶部内侧高光（拟玻璃/金属的受光面）
 *     2. 品牌光晕：青（左上）与红（右下）两团径向辉光，压在底上做出「背光」
 *     3. 播放三角：不是平涂，而是**逐像素按位置取色**的青→红对角渐变，
 *        并在右半边叠一层暗部（模拟立体棱面），左侧留一道窄高光棱
 *     4. 收边：整枚描一圈极淡的内描边 + 底部内侧暗角，把轮廓「拎」出来
 *   另加一道斜向光扫（sheen），是「高端感」最省力的来源。
 *
 * ⚠️ 全部在**超采样画布**上按浮点算，最后 4×4 盒式降采样抗锯齿。
 *    画布内的坐标一律用 S（超采样边长）归一化后再乘，别直接用像素值 ——
 *    否则换 48px 输出时比例全错。
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

// ------------------------------------------------------------------ 小工具

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const mix = (a, b, t) => a + (b - a) * t;
const lerp3 = (A, B, t) => [mix(A[0], B[0], t), mix(A[1], B[1], t), mix(A[2], B[2], t)];
/** 平滑阶跃：t 在 [e0,e1] 之间做 S 形过渡 */
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-6));
  return t * t * (3 - 2 * t);
};

/** 圆角矩形：返回点到边的**带符号距离**（<0 在内部） */
function sdRoundRect(x, y, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(x - cx) - hx;
  const dy = Math.abs(y - cy) - hy;
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - r;
}

/**
 * 三角的带符号距离（近似，够用于柔化边缘）。
 * 用「到三条边的距离取最大」的经典做法。
 */
function sdTriangle(px, py, a, b, c) {
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
  const dot = (u, v) => u[0] * v[0] + u[1] * v[1];
  const edges = [[a, b], [b, c], [c, a]];
  let d = -Infinity;
  for (const [p, q] of edges) {
    const e = sub(q, p);
    const w = sub([px, py], p);
    const len2 = dot(e, e) || 1e-6;
    const t = clamp01(dot(w, e) / len2);
    const proj = [p[0] + e[0] * t, p[1] + e[1] * t];
    const dist = Math.hypot(px - proj[0], py - proj[1]);
    // 判断在内侧还是外侧
    const n = [-e[1], e[0]];
    const s = Math.sign(dot(w, n)) || 1;
    d = Math.max(d, s > 0 ? -dist : dist);
  }
  return d;
}

/** 点在多边形内（射线法）—— 给三角填色用，比 SDF 快且边界处理更简单 */
function inTriangle(px, py, a, b, c) {
  const d1 = (px - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (py - b[1]);
  const d2 = (px - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (py - c[1]);
  const d3 = (px - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (py - a[1]);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

// ------------------------------------------------------------ 品牌色（与 CSS 令牌一致）

const CYAN = [0x25, 0xf4, 0xee];   // var(--cyan)
const RED  = [0xfe, 0x2c, 0x55];   // var(--brand)

/**
 * 画启动图标。
 * @param {number} size 输出边长（px）
 * @param {object} [opt] 可调参数（调试/换风格用）
 */
function icon(size, opt) {
  const o = Object.assign({
    supersample: 4,
    inset: 0.035,        // 圆角块相对画布的内缩
    radius: 0.245,       // 圆角半径
    sheen: 0.55,         // 光扫强度 0..1
    glow: 0.62,          // 品牌辉光强度
    bevel: 0.55,         // 三角立体棱面强度
  }, opt || {});

  const SS = o.supersample;
  const S = size * SS;
  const hi = Buffer.alloc(S * S * 4);
  const out = Buffer.alloc(size * size * 4);

  // 圆角块范围
  const inset = S * o.inset;
  const x0 = inset, y0 = inset, x1 = S - inset, y1 = S - inset;
  const radius = S * o.radius;

  // 播放三角（略微右移，视觉重心居中 —— 三角形本身重心偏左）
  const tx0 = S * 0.372, tx1 = S * 0.742;
  const ty0 = S * 0.283, ty1 = S * 0.717;
  const apex = (ty0 + ty1) / 2;
  const A = [tx0, ty0], B = [tx0, ty1], C = [tx1, apex];

  // 边缘柔化：**很窄**，让圆角保持「硬边」的 App 图标感
  const edgeSoft = SS * 0.55;
  // 描边是「离散的一圈」而不是一片弥散的白雾
  const strokeW = S * 0.0068;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const p = (y * S + x) * 4;
      const fx = x + 0.5, fy = y + 0.5;

      // ---- 圆角块（含抗锯齿 alpha）
      const d = sdRoundRect(fx, fy, x0, y0, x1, y1, radius);
      const cov = 1 - smoothstep(-edgeSoft, edgeSoft, d);
      if (cov <= 0) continue;

      const nx = (fx - x0) / (x1 - x0);   // 0..1 归一化
      const ny = (fy - y0) / (y1 - y0);

      // ---- 1) 底色：斜向冷色渐变（左上稍亮 → 右下近黑，带一点点蓝）
      const t = clamp01((nx * 0.55 + ny * 0.45));
      let col = lerp3([0x1b, 0x1d, 0x27], [0x06, 0x06, 0x0a], t * t);

      // ---- 2) 品牌辉光：做成**沿对角线的整体渐染**（青左上 → 红右下），
      //         而不是两团独立的圆斑 —— 后者会在四角留下看得见的「晕圈」。
      //         用沿对角轴的投影做权重，保证过渡平滑、无可见边界。
      const diag = clamp01((nx * 0.82 + ny * 0.62) / 1.44);   // 0=左上角 1=右下角
      // 青：从左上起、到中段前衰减
      const gc = Math.pow(clamp01(1 - diag / 0.62), 2.2) * 0.60 * o.glow;
      col = lerp3(col, CYAN, gc);
      // 红：从中段起、往右下增强
      const gr = Math.pow(clamp01((diag - 0.34) / 0.60), 1.9) * 0.50 * o.glow;
      col = lerp3(col, RED, gr);
      // 中段补一点点亮度，避免青红交界处发灰
      const midLift = Math.exp(-Math.pow((diag - 0.47) / 0.16, 2)) * 0.16 * o.glow;
      col = lerp3(col, [0xd8, 0x9a, 0xc0], midLift);

      // ---- 2b) 三角背后的**环境光**：让符号「离开」背景，产生悬浮感。
      //          用圆角三角的近似（外扩的椭圆）做一圈柔和辉光。
      const ez = Math.hypot((fx - S * 0.56) / (S * 0.30), (fy - S * 0.50) / (S * 0.34));
      const amb = Math.pow(clamp01(1 - ez), 2.4) * 0.20;
      col = lerp3(col, [0xff, 0xff, 0xff], amb);

      // ---- 3) 顶部内侧高光（受光面）—— 只在圆角块边缘附近生效
      const rimIn = smoothstep(S * 0.055, 0, d);        // d<0 内部，越靠边越接近 1
      const topBias = smoothstep(0.62, 0.0, ny);        // 越靠上越亮
      col = lerp3(col, [0xff, 0xff, 0xff], rimIn * topBias * 0.13);

      // ---- 4) 斜向光扫（sheen）：一条从左上来、往右下淡出的窄带
      const sp = (nx * 0.74 + ny * 0.26);
      const band = Math.exp(-Math.pow((sp - 0.26) / 0.115, 2));
      col = lerp3(col, [0xff, 0xff, 0xff],
        band * (1 - smoothstep(0.30, 0.62, sp)) * 0.20 * o.sheen);

      // ---- 5) 播放三角
      if (inTriangle(fx, fy, A, B, C)) {
        // 配色策略（2026-09-23 定稿）：
        //   抖音那种「青 / 红」双色标志，**不是**把两色渐变糊在一起 ——
        //   渐变的中点必然掉饱和度（RGB 直插得灰紫、线性光插值又发白），
        //   怎么做都脏。真正干净的做法是**两块纯色 + 一道很窄的对角接缝**，
        //   让青和红各自保持 100% 纯度，只在交界处做 1~2px 的过渡。
        const u = clamp01((fx - tx0) / (tx1 - tx0));   // 0=左边 1=尖
        // 接缝做成**轻微斜向**（跟图标整体的光向一致），纯竖直会显得机械。
        // 斜率小一点即可：竖直的 0.475，上边略微右偏、下边略微左偏。
        const slant = (ny - 0.5) * 0.075;
        const seam = 0.475 + slant;
        const seamW = 0.055;                           // 接缝宽度（窄！）
        const w = smoothstep(seam - seamW, seam + seamW, u);

        let tri = lerp3(CYAN, RED, w);

        // 接缝处补一道极淡的高光，模拟「两块玻璃拼接」的折射线
        const seamLine = Math.exp(-Math.pow((u - seam) / (seamW * 0.5), 2));
        tri = lerp3(tri, [0xff, 0xff, 0xff], seamLine * 0.26);

        // 立体棱面：上缘压暗、左缘提亮 → 有厚度感
        const vshade = smoothstep(0.50, 0.03, ny) * smoothstep(0.09, 0.28, nx);
        const leftLit = smoothstep(0.22, 0.012, u);
        tri = lerp3(tri, [0, 0, 0], vshade * 0.20 * o.bevel);          // 上缘暗面
        tri = lerp3(tri, [0xff, 0xff, 0xff], leftLit * 0.22 * o.bevel); // 左缘高光

        col = tri;
      }

      // ---- 6) 内侧描边（细亮边）+ 底部暗角
      const ring = Math.exp(-Math.pow((d + strokeW) / (S * 0.0072), 2));
      col = lerp3(col, [0xff, 0xff, 0xff], ring * 0.34);

      const botVig = smoothstep(0.66, 1.0, ny) * 0.20;
      col = lerp3(col, [0, 0, 0], botVig);

      hi[p] = col[0]; hi[p + 1] = col[1]; hi[p + 2] = col[2];
      hi[p + 3] = 255 * cov;
    }
  }

  // ---- 盒式降采样（按 alpha 加权，避免边缘发暗）
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let ar = 0, ag = 0, ab = 0, aa = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const p = ((y * SS + dy) * S + (x * SS + dx)) * 4;
          const a = hi[p + 3] / 255;
          if (a > 0) { ar += hi[p] * a; ag += hi[p + 1] * a; ab += hi[p + 2] * a; }
          aa += a;
        }
      }
      const n = SS * SS;
      const oo = (y * size + x) * 4;
      if (aa > 0) {
        out[oo] = Math.round(ar / aa);
        out[oo + 1] = Math.round(ag / aa);
        out[oo + 2] = Math.round(ab / aa);
      }
      out[oo + 3] = Math.round((aa / n) * 255);
    }
  }
  return encode(size, size, out);
}

module.exports = { encode, icon, sdRoundRect, inTriangle, mix, lerp3, clamp01, smoothstep };
