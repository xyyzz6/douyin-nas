#!/usr/bin/env node
/**
 * make-strm.js —— 一键把 WebDAV 目录树转成 .strm 链接库（douyin-nas 配套）
 * =====================================================================
 * 用途：少打网盘 API（防 115 风控）。strm 库建好后，App 只扫这些小文本，
 *       不再递归列整棵视频目录树。
 *
 * 产物：每个视频文件对应一个 `<原名>.strm`（内容 = 该文件在 WebDAV 上的
 *       绝对路径，如 `/dav/115open/云下载/剧/s01e01.mkv`）。
 *       ⚠️ 故意用「路径」而不是 115 下载直链 —— 直链有时效，路径永远有效，
 *          App 播放时会自动转内部代理（自动带登录凭据）。
 *
 * 用法（在电脑上跑，node >= 18，无第三方依赖）：
 *   node make-strm.js --url=http://127.0.0.1:19798/dav --user=you@x.com --pass=pwd ^
 *        --src=/dav/115open/云下载/剧 --out=D:/strm/剧
 *
 *   · --src  WebDAV 上要转换的目录（递归整棵树）
 *   · --out  strm 输出文件夹（保持原目录结构，自动创建）
 *   · --upload=/dav/115open/云下载/_strm   可选：把生成的 strm 直接 PUT 回网盘
 *     （串行 + 默认 500ms 间隔，--delay 可调；上传几千个小文件建议分批、
 *      挑闲时跑 —— 上传类 API 高频同样可能触发风控）
 *   · --depth=4     可选：递归深度上限（默认不限）
 *   · 手机内嵌 CD2 也能连：数据线连电脑后 `adb reverse tcp:19798 tcp:19798`，
 *     然后 --url=http://127.0.0.1:19798/dav 即可（凭据在 App 设置页能看到）。
 *
 * 输出日志为英文（避免 Windows 控制台中文乱码）。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---------------- args ---------------- */
const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([a-zA-Z]+)(?:=(.*))?$/);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const BASE = (args.url || '').replace(/\/+$/, '');
const USER = args.user || '';
const PASS = args.pass || '';
const SRC = args.src || '';
const OUT = args.out || '';
const UPLOAD = (args.upload || '').replace(/\/+$/, '');
const DELAY = Math.max(0, parseInt(args.delay || '500', 10));
const MAX_DEPTH = parseInt(args.depth || '0', 10) || Infinity; // 0 = unlimited
const CONC = 4;              // PROPFIND concurrency (gentle on the cloud drive)
const SKIP = /^(\.|@|#recycle|#snapshot|__MACOSX|\$RECYCLE\.BIN)/i;
const VIDEO = new Set(['mp4','m4v','mov','webm','ogv','mkv','flv','ts','3gp']);

if (!BASE || !SRC || !OUT) {
  console.error('usage: node make-strm.js --url=... --user=... --pass=... --src=/dav/... --out=D:/strm [--upload=/dav/.../_strm]');
  process.exit(2);
}
/* base path prefix, e.g. /dav —— absolute paths above it get trimmed (same rule as the App) */
const BASE_PREFIX = new URL(BASE).pathname.replace(/\/+$/, '');

/* ---------------- tiny WebDAV client ---------------- */
function request(method, absPath, { body = null, headers = {} } = {}) {
  // absPath: "/dav/xxx/yyy" (already the full dav path, NOT percent-encoded yet)
  const rel = trimPrefix(absPath);
  const url = BASE + encPath(rel);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search,
      method,
      headers: {
        ...headers,
        ...(body ? { 'Content-Type': 'application/xml' } : {}),
        ...(USER ? { Authorization: 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64') } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout ' + method + ' ' + absPath)));
    if (body) req.write(body);
    req.end();
  });
}

function trimPrefix(absPath) {
  let p = absPath.startsWith('/') ? absPath : '/' + absPath;
  if (BASE_PREFIX && (p === BASE_PREFIX || p.startsWith(BASE_PREFIX + '/'))) {
    p = p.slice(BASE_PREFIX.length) || '/';
  }
  return p;
}
function encPath(p) {
  if (!p || p === '/') return '/';
  const dir = p.endsWith('/');
  let s = '';
  for (const seg of p.split('/')) {
    if (!seg) continue;
    s += '/' + encodeURIComponent(seg);
  }
  return s + (dir ? '/' : '');
}
const baseName = (p) => { const n = p.replace(/\/+$/, ''); const i = n.lastIndexOf('/'); return i < 0 ? n : n.slice(i + 1); };
const extOf = (p) => { const n = baseName(p); const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i + 1).toLowerCase(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- PROPFIND one level ---------------- */
const PROP_BODY = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>';

function decodeHref(href) {
  // href may be "/dav/a%20b/c.mp4" or "http://host/dav/..." —— keep only the path part
  let p = href;
  try { if (/^https?:\/\//i.test(p)) p = new URL(p).pathname; } catch (_) {}
  try { p = decodeURIComponent(p); } catch (_) {}
  return p;
}

async function propfind(dirAbs) {
  const r = await request('PROPFIND', dirAbs, { body: PROP_BODY, headers: { Depth: '1' } });
  if (r.status >= 400) throw new Error('PROPFIND ' + r.status + ' ' + dirAbs);
  const xml = r.body.toString('utf8');
  const out = [];
  // split into <response> blocks (namespace prefix tolerant: d:/D:/none)
  const blocks = xml.split(/<\/[\w]*:?response>/i);
  const selfPath = dirAbs.replace(/\/+$/, '');
  for (const blk of blocks) {
    const hm = blk.match(/<[\w]*:?href[^>]*>([^<]+)<\//i);
    if (!hm) continue;
    const abs = decodeHref(hm[1]).replace(/\/+$/, '');
    if (!abs) continue;
    if (abs === selfPath) continue;                    // the directory itself
    const isDir = /<[\w]*:?collection\s*\/?\s*>/i.test(blk);
    const sm = blk.match(/<[\w]*:?getcontentlength[^>]*>(\d+)</i);
    out.push({ abs: abs + (isDir ? '/' : ''), isDir, size: sm ? +sm[1] : 0 });
  }
  return out;
}

/* ---------------- BFS walk ---------------- */
async function walk(root) {
  const videos = [];
  let frontier = [root.replace(/\/+$/, '')];
  let depth = 1;
  let scanned = 0;
  while (frontier.length) {
    const batches = [];
    for (let i = 0; i < frontier.length; i += CONC) {
      batches.push(frontier.slice(i, i + CONC));
    }
    const next = [];
    for (const b of batches) {
      const results = await Promise.all(b.map(async (d) => {
        try { return { dir: d, items: await propfind(d) }; }
        catch (e) { console.error('  [skip] ' + d + ' :: ' + e.message); return { dir: d, items: [] }; }
      }));
      for (const { items } of results) {
        scanned++;
        for (const it of items) {
          const name = baseName(it.abs);
          if (!name || SKIP.test(name)) continue;
          if (it.isDir) { next.push(it.abs); continue; }
          if (VIDEO.has(extOf(name))) videos.push({ abs: it.abs, size: it.size });
        }
      }
    }
    if (depth >= MAX_DEPTH) break;
    frontier = next;
    depth++;
    console.log('  [scan] depth ' + depth + ': ' + frontier.length + ' dirs, ' + videos.length + ' videos so far');
  }
  console.log('[scan] done: ' + scanned + ' dirs, ' + videos.length + ' videos');
  return videos;
}

/* ---------------- write .strm files ---------------- */
function relUnder(abs, root) {
  let r = abs.slice(root.replace(/\/+$/, '').length);
  return r.startsWith('/') ? r.slice(1) : r;
}

function writeStrm(videos, root, outDir) {
  let n = 0;
  for (const v of videos) {
    const rel = relUnder(v.abs, root);            // 剧/s01/e01.mkv
    const target = path.join(outDir, rel + '.strm'); // 剧/s01/e01.mkv.strm
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // BOM: Windows 记事本/PowerShell 5.1 才会按 UTF-8 正确显示中文路径
    // （douyin-nas 的 resolveStrm 会剥掉 BOM，Emby/Jellyfin 也容忍）
    fs.writeFileSync(target, '\uFEFF' + v.abs + '\n', 'utf8');
    n++;
  }
  console.log('[write] ' + n + ' strm files -> ' + outDir);
  return n;
}

/* ---------------- optional: PUT back to the drive ---------------- */
async function uploadStrm(videos, root, uploadDir) {
  const mkcolCache = new Set();
  async function ensureDir(dirAbs) {
    if (mkcolCache.has(dirAbs)) return;
    const parts = trimPrefix(dirAbs).split('/').filter(Boolean);
    let cur = '';
    for (const seg of parts) {
      cur += '/' + seg;
      const abs = (BASE_PREFIX + cur);
      if (mkcolCache.has(abs)) continue;
      const r = await request('MKCOL', abs);
      if (r.status >= 400 && r.status !== 405 && r.status !== 301) {
        // 405 = already exists on most servers —— fine
      }
      mkcolCache.add(abs);
    }
    mkcolCache.add(dirAbs);
  }
  let ok = 0, fail = 0;
  for (const v of videos) {
    const rel = relUnder(v.abs, root);
    const dest = uploadDir + '/' + rel + '.strm';
    try {
      await ensureDir(dest.slice(0, dest.lastIndexOf('/')));
      const r = await request('PUT', dest, { body: Buffer.from('\uFEFF' + v.abs + '\n', 'utf8'), headers: { 'Content-Type': 'text/plain' } });
      if (r.status >= 200 && r.status < 300) { ok++; process.stdout.write('\r[upload] ' + (ok + fail) + '/' + videos.length); }
      else { fail++; console.error('\n  [put ' + r.status + '] ' + dest); }
    } catch (e) { fail++; console.error('\n  [err] ' + dest + ' :: ' + e.message); }
    if (DELAY) await sleep(DELAY);
  }
  console.log('\n[upload] ok=' + ok + ' fail=' + fail + ' -> ' + uploadDir);
}

/* ---------------- main ---------------- */
(async () => {
  // sanity: the source must exist
  const probe = await request('PROPFIND', SRC, { body: PROP_BODY, headers: { Depth: '0' } });
  if (probe.status >= 400) {
    console.error('[fatal] source not reachable: HTTP ' + probe.status + ' ' + SRC);
    process.exit(1);
  }
  const root = SRC.replace(/\/+$/, '');
  const videos = await walk(root);
  if (!videos.length) { console.log('[done] nothing to do'); return; }

  fs.mkdirSync(OUT, { recursive: true });
  writeStrm(videos, root, OUT);

  if (typeof UPLOAD === 'string' && UPLOAD) {
    console.log('[upload] target: ' + UPLOAD + ' (delay ' + DELAY + 'ms between PUTs)');
    await uploadStrm(videos, root, UPLOAD);
  } else {
    console.log('[hint] add "' + OUT + '" as a source folder in douyin-nas (via a WebDAV the app can reach),');
    console.log('       or re-run with --upload=/dav/<folder> to push the strm files back to the drive.');
  }
  console.log('[done]');
})().catch((e) => { console.error('[fatal] ' + e.message); process.exit(1); });
