/**
 * 在 NAS 上 BFS 统计「视频文件都藏在第几层」。
 *
 * 目的：判断当前 `maxDepth`（默认 4）到底漏掉了多少东西。
 * 用户说「有些视频藏的比较深」，但在改配置之前必须先**量**出来：
 * 到底是深度不够、还是递归没开、还是撞了 800 条 / 45 秒的上限。
 *
 * ⚠️ CD2 的 WebDAV **不支持 Depth: 3**（返回空，不是报错），只能一层层 BFS。
 * ⚠️ 只读，不改任何东西。失败就跳过那条分支。
 *
 * 用法：node _tools/scan-depth-profile.js [起始路径] [最大深度] [请求预算]
 * 例：  node _tools/scan-depth-profile.js '/dav/示例片源' 10 4000
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/* ⚠️ 凭据从 data/config.json 读，**别硬编码进源码**。 */
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const ORIGIN = new URL(cfg.url).origin;
const AUTH = cfg.user + ':' + cfg.pass;
/* 片库白名单（BROWSER_EXTS）—— 只有这些会进片库，所以按它统计才有意义。 */
const OK = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];
const BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>';

const start = process.argv[2] || '/dav/示例片源';
const maxDepth = Number(process.argv[3] || 10);
const budget = Number(process.argv[4] || 4000);

/** 起始路径算第 1 层（跟后端 walk(depth=1) 的语义对齐） */
const START_DEPTH = 1;

function pf(p) {
  /* ⚠️ 中文路径必须自己百分号编码，curl 不会替你做，否则 CD2 返回空。 */
  const enc = p.split('/').map(encodeURIComponent).join('/');
  try {
    const out = execFileSync('curl', [
      '-s', '--max-time', '12', '-u', AUTH, '-X', 'PROPFIND',
      '-H', 'Depth: 1', '-H', 'Content-Type: application/xml',
      '--data-binary', BODY, ORIGIN + enc,
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (!out || !out.includes('multistatus')) return null;
    return out;
  } catch (_) {
    return null;
  }
}

/** 从 PROPFIND 响应里拆出「子目录」和「文件」 */
function parse(xml) {
  const dirs = [];
  const files = [];
  /* 🔴 CD2 返回的 collection 是**成对标签** `<D:collection></D:collection>`，
     不是自闭合的 `<D:collection/>`。第一版只认自闭合写法，结果**所有目录都被
     当成文件**了（表现为「请求 1 个目录、0 个视频」）。两种写法都要认。 */
  const isDir = /<D:collection\s*\/>|<D:collection\s*>\s*<\/D:collection>/;
  const re = /<D:response>([\s\S]*?)<\/D:response>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const blk = m[1];
    const hm = /<D:href>([\s\S]*?)<\/D:href>/.exec(blk);
    if (!hm) continue;
    let href = hm[1];
    try { href = decodeURIComponent(href); } catch (_) { /* 保持原样 */ }
    (isDir.test(blk) ? dirs : files).push(href);
  }
  return { dirs, files };
}

const extOf = (n) => {
  const i = n.lastIndexOf('.');
  return i < 0 ? '' : n.slice(i + 1).toLowerCase();
};

const byDepth = {};          // 深度 → 视频数
const samples = {};          // 深度 → 前几个路径（给用户看「深的是哪些」）
const deepDirs = [];         // 深度 > 4 且含视频的目录
let reqs = 0;

const queue = [{ p: start, d: START_DEPTH }];
const seen = new Set([start.replace(/\/+$/, '')]);
let videos = 0;

while (queue.length && reqs < budget) {
  const { p, d } = queue.shift();
  reqs++;
  const xml = pf(p);
  if (!xml) continue;
  const { dirs, files } = parse(xml);

  for (const f of files) {
    const name = f.split('/').filter(Boolean).pop();
    if (!OK.includes(extOf(name))) continue;
    videos++;
    byDepth[d] = (byDepth[d] || 0) + 1;
    if (!samples[d]) samples[d] = [];
    if (samples[d].length < 3) samples[d].push(f.replace(/^\/dav\//, ''));
    if (d > 4) {
      const dir = f.slice(0, f.lastIndexOf('/'));
      if (!deepDirs.some((x) => x.dir === dir)) deepDirs.push({ dir: dir.replace(/^\/dav\//, ''), depth: d, n: 0 });
      const hit = deepDirs.find((x) => x.dir === dir.replace(/^\/dav\//, ''));
      if (hit) hit.n++;
    }
  }

  if (d < maxDepth) {
    for (const dd of dirs) {
      /* PROPFIND 会把起始目录自己也列出来，跳过 */
      const norm = dd.replace(/\/+$/, '');
      if (norm === p.replace(/\/+$/, '') || seen.has(norm)) continue;
      seen.add(norm);
      queue.push({ p: norm, d: d + 1 });
    }
  }
  if (reqs % 50 === 0) {
    process.stderr.write(`\r  已请求 ${reqs} 个目录，找到 ${videos} 个视频…   `);
  }
}
process.stderr.write('\r' + ' '.repeat(60) + '\r');

console.log(`\n===== ${start}  深度分布（请求 ${reqs} 个目录） =====`);
console.log(`白名单视频总数：${videos}`);
console.log();
console.log('每层有多少个视频：');
const depths = Object.keys(byDepth).map(Number).sort((a, b) => a - b);
for (const d of depths) {
  const bar = '█'.repeat(Math.min(60, byDepth[d]));
  const flag = d > 4 ? '  ← ⚠️ 当前 maxDepth=4 扫不到' : '';
  console.log(`  第 ${String(d).padStart(2)} 层：${String(byDepth[d]).padStart(4)}  ${bar}${flag}`);
}
const beyond = depths.filter((d) => d > 4).reduce((a, d) => a + byDepth[d], 0);
console.log();
console.log(`🔴 深于 4 层的视频：${beyond} 个（占 ${(beyond / (videos || 1) * 100).toFixed(1)}%）`);
console.log();
if (samples[depths[depths.length - 1]]) {
  console.log('最深层的例子：');
  for (const d of depths.slice(-3)) {
    console.log(`  第 ${d} 层：${(samples[d] || []).join('  |  ')}`);
  }
}
if (deepDirs.length) {
  console.log();
  console.log('深于 4 层、且确实含视频的目录：');
  deepDirs.sort((a, b) => b.n - a.n).slice(0, 12)
    .forEach((x) => console.log(`  [${x.depth} 层] ${x.n} 个  ${x.dir}`));
}
console.log();
console.log(`请求预算用完了吗：${reqs >= budget ? '是（可能没扫全！）' : '否（扫全了）'}`);
