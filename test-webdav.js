#!/usr/bin/env node
/**
 * 端到端联调脚本（开发自测用）：
 *   1. 起一个「模拟 NAS」的 WebDAV 服务（支持 PROPFIND 深度 1 + GET/Range + Basic 鉴权）
 *   2. 让本项目的 server.js 去连它，验证 目录浏览 / 扫描 / 递归 / 中文路径 / 鉴权 / 拉流 全链路
 *   3. 测试过程需要把配置切到模拟 NAS，所以脚本会**先备份你的真实配置，跑完自动还原**，
 *      不用你再手动备份 data/config.json（早期版本会把它清成演示模式，丢过配置）
 *
 * 用法：先 node server.js，再另开一个终端 node test-webdav.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const DAV_PORT = 8099;
const APP = 'http://127.0.0.1:8080';

/**
 * 跑之前先把用户真实的 config.json 读进内存。
 * 测试中途会反复改配置（指向模拟 NAS、最后清成演示模式），结束时用这份快照还原。
 * 注意：还原必须走 POST /api/config，因为服务端配置是常驻内存的，直接改文件不生效。
 */
const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');
const USER_CFG = (() => { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { return null; } })();

/**
 * 片库缓存同样要备份：测试中途改配置会触发 resetLibrary()，而它会把 data/library.json 删掉。
 * 不补回来的话，用户下次打开 App 得重新扫一遍 NAS —— 而「别每次打开都重扫」正是用户明确要求的。
 */
const LIB_FILE = path.join(__dirname, 'data', 'library.json');
const USER_LIB = (() => { try { return fs.readFileSync(LIB_FILE); } catch (_) { return null; } })();

/**
 * 还原时以「服务端当前配置」为准，文件只用来取密码。
 * 原因：config.json 里可能没有 dirs 这类后加的字段（老配置文件就没有），
 * 而服务端启动时会把它们迁移出来 —— 只照文件还原会把迁移结果弄丢。
 */
let LIVE_CFG = null;
function wantCfg() {
  const live = (LIVE_CFG && LIVE_CFG.config) || {};
  const file = USER_CFG || {};
  const pick = (k, d) => (live[k] !== undefined ? live[k] : (file[k] !== undefined ? file[k] : d));
  return {
    url: pick('url', ''),
    user: pick('user', ''),
    pass: file.pass || '',                       // /api/config 不回传密码，只能从文件里拿
    dir: pick('dir', ''),
    // 片源列表：优先用服务端当前的（它会做老配置迁移），再退到文件，最后退回单个 dir
    dirs: (Array.isArray(live.dirs) && live.dirs.length) ? live.dirs
      : (Array.isArray(file.dirs) && file.dirs.length) ? file.dirs
      : (pick('dir', '') ? [pick('dir', '')] : []),
    recursive: pick('recursive', true) !== false,
    maxDepth: pick('maxDepth', 4),
    playableOnly: pick('playableOnly', true) !== false,
    fit: pick('fit', 'contain'),
    nickname: pick('nickname', 'NAS 影迷'),
    ffmpegPath: pick('ffmpegPath', ''),
  };
}

/* ---------------- 模拟 NAS 的文件树 ---------------- */
const TREE = {
  '/': { dir: true, children: ['video/'] },
  '/video/': { dir: true, children: ['电影/', '剧集/', 'a_root.mp4', 'b_root.mov', 'c_unsupported.mkv', 'readme.txt'] },
  '/video/电影/': { dir: true, children: ['流浪地球片段.mp4', '星际穿越 trailer.m4v'] },
  '/video/剧集/': { dir: true, children: ['第一季/'] },
  '/video/剧集/第一季/': { dir: true, children: ['S01E01.mp4', 'S01E02.mp4'] },
};
const FILES = {
  '/video/a_root.mp4': 800000,
  '/video/b_root.mov': 500000,
  '/video/c_unsupported.mkv': 900000,
  '/video/readme.txt': 100,
  '/video/电影/流浪地球片段.mp4': 1200000,
  '/video/电影/星际穿越 trailer.m4v': 600000,
  '/video/剧集/第一季/S01E01.mp4': 700000,
  '/video/剧集/第一季/S01E02.mp4': 710000,
};
const CT = { mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska', txt: 'text/plain' };
const AUTH = 'Basic ' + Buffer.from('nasuser:naspass').toString('base64');

const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function propfindBody(p) {
  const node = TREE[p];
  const rows = [];
  rows.push(`<D:response><D:href>${esc(enc(p))}</D:href><D:propstat><D:prop>
    <D:displayname>${esc(decodeURIComponent(p.split('/').filter(Boolean).pop() || 'root'))}</D:displayname>
    <D:resourcetype><D:collection/></D:resourcetype></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
  for (const c of node.children) {
    const full = p + c;
    if (TREE[full]) {
      rows.push(`<D:response><D:href>${esc(enc(full))}</D:href><D:propstat><D:prop>
        <D:displayname>${esc(decodeURIComponent(c.replace(/\/$/, '')))}</D:displayname>
        <D:resourcetype><D:collection/></D:resourcetype></D:prop>
        <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    } else {
      const size = FILES[full];
      const ext = (full.split('.').pop() || '').toLowerCase();
      rows.push(`<D:response><D:href>${esc(enc(full))}</D:href><D:propstat><D:prop>
        <D:displayname>${esc(c)}</D:displayname>
        <D:resourcetype/>
        <D:getcontentlength>${size}</D:getcontentlength>
        <D:getcontenttype>${CT[ext] || 'application/octet-stream'}</D:getcontenttype>
        <D:getlastmodified>Wed, 16 Sep 2026 08:00:00 GMT</D:getlastmodified></D:prop>
        <D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">\n${rows.join('\n')}\n</D:multistatus>`;
}

function startMockDav() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      // 鉴权：密码错就直接 401，用来验证代理有没有把 Basic 头传下去
      if (req.headers.authorization !== AUTH) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="NAS"' });
        return res.end('Unauthorized');
      }
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.length > 1 && !p.endsWith('/') && TREE[p + '/']) p += '/';

      if (req.method === 'PROPFIND') {
        if (TREE[p]) {
          const xml = propfindBody(p);
          res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml) });
          return res.end(xml);
        }
        res.writeHead(404); return res.end('not found');
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        const size = FILES[p];
        if (!size) { res.writeHead(404); return res.end('not found'); }
        const range = req.headers.range;
        const head = { 'Content-Type': CT[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m[1] ? +m[1] : 0;
          const end = m[2] ? +m[2] : size - 1;
          res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
          return res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(end - start + 1, 7));
        }
        res.writeHead(200, { ...head, 'Content-Length': size });
        return res.end(req.method === 'HEAD' ? undefined : Buffer.alloc(size, 7));
      }
      res.writeHead(405); res.end();
    });
    srv.listen(DAV_PORT, '127.0.0.1', () => resolve(srv));
  });
}

/* ---------------- 测试 ---------------- */
const post = async (path, body) => {
  const r = await fetch(APP + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};
const get = async (path, headers) => {
  const r = await fetch(APP + path, { headers });
  let data = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) data = await r.json();
  else data = await r.arrayBuffer();
  return { status: r.status, headers: r.headers, data };
};

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label); }
  else { fail++; console.log('  ❌ ' + label + (extra ? '  →  ' + JSON.stringify(extra) : '')); }
};

(async () => {
  const srv = await startMockDav();
  const DAV = 'http://127.0.0.1:' + DAV_PORT;
  console.log('\n模拟 NAS 已启动：' + DAV + '（账号 nasuser / naspass）\n');

  // 先把当前（真实的）配置留一份，一会儿原样还回去
  try { LIVE_CFG = (await get('/api/config')).data; } catch (_) {}
  const KEEP = wantCfg();
  console.log('已备份当前配置：' + (KEEP.url || '（没连 NAS，演示模式）') +
    ' · 片源 ' + KEEP.dirs.length + ' 个\n');

  console.log('【1】测试连接（错误的密码应该失败）');
  const bad = await post('/api/test', { url: DAV, dir: '/video', user: 'nasuser', pass: 'wrong' });
  ok(bad.ok === false, '错误密码被正确拒绝', bad);
  ok(/401/.test(bad.error || ''), '错误提示里包含 401：' + (bad.error || ''));

  const good = await post('/api/test', { url: DAV, dir: '/video', user: 'nasuser', pass: 'naspass' });
  ok(good.ok === true, '正确密码连接成功', good);
  ok(good.dirs === 2, '该目录识别出 2 个子文件夹，实际 ' + good.dirs);
  ok(good.vids === 3, '该目录识别出 3 个视频，实际 ' + good.vids);

  console.log('\n【2】保存配置');
  await post('/api/config', { url: DAV, dir: '/video', user: 'nasuser', pass: 'naspass', recursive: true, maxDepth: 4, playableOnly: true });
  const cfg = await get('/api/config');
  ok(cfg.data.mode === 'webdav', '数据源是 webdav');
  ok(cfg.data.config.dir === '/video', '记住了当前目录 /video');

  console.log('\n【3】浏览 NAS 目录（手动选要刷哪层）');
  const root = await get('/api/browse');
  ok(root.data.ok === true, '根目录能列出来');
  ok(root.data.path === '/video', '落在配置里的 /video，实际 ' + root.data.path);
  ok((root.data.dirs || []).length === 2, '看到 2 个子文件夹，实际 ' + (root.data.dirs || []).length);
  ok(root.data.dirs.some((d) => d.name === '电影'), '子文件夹里有「电影」');
  // 默认「仅保留浏览器能播的格式」，.mkv / .txt 都要挡掉，本层只剩 mp4 + mov
  ok((root.data.videos || []).length === 2, '本层 2 个能播的视频（.mkv/.txt 已过滤），实际 ' + (root.data.videos || []).length);
  ok(root.data.videos.every((v) => v.p.startsWith('/video/')), '视频用的是「相对服务地址的绝对路径」');
  ok(root.data.crumbs.length === 1 && root.data.crumbs[0].name === 'video', '面包屑：' + root.data.crumbs.map((c) => c.name).join(' / '));

  const sub = await get('/api/browse?path=' + encodeURIComponent('/video/电影'));
  ok(sub.data.ok === true, '能点进 /video/电影');
  ok(sub.data.crumbs.length === 2, '面包屑变成两级：' + sub.data.crumbs.map((c) => c.name).join(' / '));
  ok(sub.data.crumbs[0].path === '/video', '面包屑第一级可跳回 /video');
  ok(sub.data.parent === '/video', '「上一级」指向 /video，实际 ' + sub.data.parent);
  ok(sub.data.videos.length === 2, '电影目录里 2 个视频，实际 ' + sub.data.videos.length);
  ok(sub.data.videos.some((v) => v.name === '星际穿越 trailer.m4v'), '带空格的英文名能正确解析');

  const deep = await get('/api/browse?path=' + encodeURIComponent('/video/剧集/第一季'));
  ok(deep.data.ok === true && deep.data.videos.length === 2, '能点到三级目录 /video/剧集/第一季');

  const nope = await get('/api/browse?path=' + encodeURIComponent('/video/不存在'));
  ok(nope.data.ok === false, '不存在的目录返回 ok:false');
  ok(/404/.test(nope.data.error || ''), '错误提示里包含 404：' + (nope.data.error || ''));

  console.log('\n【4】顺手数一下每个子文件夹里有多少视频');
  const cnt = await post('/api/counts', { paths: ['/video/电影', '/video/剧集', '/video/不存在'] });
  ok(cnt.ok === true, '/api/counts 正常返回', cnt);
  ok(cnt.counts['/video/电影'] === 2, '/video/电影 数到 2 个，实际 ' + cnt.counts['/video/电影']);
  ok(cnt.counts['/video/剧集'] === 0, '/video/剧集 本层没有视频（只有子文件夹）');
  ok(cnt.counts['/video/不存在'] === null, '读不到的目录返回 null，界面显示「子文件夹」而不是报错');

  console.log('\n【5】点「刷」某个目录 → 只扫这一层');
  const libMovie = await get('/api/library?dir=' + encodeURIComponent('/video/电影') + '&recursive=1');
  const vm = libMovie.data.videos || [];
  ok(vm.length === 2, '只扫「电影」得到 2 个视频，实际 ' + vm.length);
  ok(vm.every((v) => v.p.startsWith('/video/电影/')), '视频路径都在这个目录下');
  ok(vm.every((v) => v.author === '电影'), '作者名取自所在文件夹');

  const libAll = await get('/api/library?dir=' + encodeURIComponent('/video') + '&recursive=1');
  const va = libAll.data.videos || [];
  ok(va.length === 6, '扫整个 /video 递归得到 6 个视频，实际 ' + va.length);
  ok(va.some((v) => v.p === '/video/剧集/第一季/S01E01.mp4'), '递归进入了三级子目录');
  ok(va.some((v) => v.p.includes('流浪地球片段')), '中文文件名解析正确');
  ok(!va.some((v) => v.name.endsWith('.mkv')), '不支持的格式(.mkv)被过滤');
  ok(!va.some((v) => v.name.endsWith('.txt')), '非视频文件(.txt)被过滤');

  const libFlat = await get('/api/library?dir=' + encodeURIComponent('/video') + '&recursive=0');
  ok((libFlat.data.videos || []).length === 2, '关掉「含子文件夹」后只剩本层 2 个，实际 ' + (libFlat.data.videos || []).length);

  console.log('\n【5.5】多个片源文件夹（首页刷的是它们的合集）');
  const two = await post('/api/sources', { dirs: ['/video/电影', '/video/剧集'], recursive: true });
  ok(two.ok === true, '/api/sources 能设置一组片源', two.error);
  ok((two.dirs || []).length === 2, '片源记住了 2 个文件夹，实际 ' + (two.dirs || []).length);
  const tv = two.videos || [];
  ok(tv.length === 4, '两个片源合并后 4 个视频（电影 2 + 剧集递归 2），实际 ' + tv.length);
  ok(tv.filter((v) => v.p.startsWith('/video/电影/')).length === 2, '电影那 2 个都在');
  ok(tv.some((v) => v.p === '/video/剧集/第一季/S01E01.mp4'), '剧集递归到了子目录');

  const dup = await post('/api/sources', { dirs: ['/video', '/video/电影'], recursive: true });
  ok((dup.videos || []).length === 6, '父目录 + 子目录同时加进来会去重，仍是 6 个，实际 ' + (dup.videos || []).length);

  // 再取一次片库：不该重新扫（scannedAt 不变），这就是「不要每次打开都重扫」的那条性质
  const again = await get('/api/library');
  ok(again.data.scannedAt === dup.scannedAt, '紧接着再取片库没有重新扫描（scannedAt 未变）',
    'dup=' + dup.scannedAt + ' again=' + again.data.scannedAt);
  ok(again.data.ttlMs === 86400000, '缓存有效期是一天');
  ok((again.data.dirs || []).length === 2, '响应里带上了片源列表');

  const peekSame = await get('/api/library?peek=1&v=' + again.data.version);
  ok(peekSame.data.changed === false, '片库没变时 peek 只说「没变」（省流量）');
  const peekDiff = await get('/api/library?peek=1&v=-1');
  ok(peekDiff.data.changed === true && Array.isArray(peekDiff.data.videos), '版本对不上时 peek 会把整份列表带回来');

  // 一个片源坏掉不该拖垮整个片库
  const partly = await post('/api/sources', { dirs: ['/video/电影', '/video/不存在'], recursive: true });
  ok((partly.videos || []).length === 2, '坏掉的片源被跳过，好的那个照常出 2 个视频，实际 ' + (partly.videos || []).length);

  const live = await post('/api/sources', { dirs: ['/video'], recursive: true });
  ok((live.videos || []).length === 6, '恢复成单个 /video 片源，6 个视频，实际 ' + (live.videos || []).length);

  console.log('\n【6】拉流代理（拖动进度条依赖 Range）');
  const full = await get('/api/stream?p=' + encodeURIComponent('/video/电影/流浪地球片段.mp4'), { Range: 'bytes=100-599' });
  ok(full.status === 206, '代理返回 206 Partial Content，实际 ' + full.status);
  ok(full.headers.get('content-range') === 'bytes 100-599/1200000', 'Content-Range 正确：' + full.headers.get('content-range'));
  ok(full.data.byteLength === 500, '实际收到 500 字节，实际 ' + full.data.byteLength);
  ok(full.headers.get('accept-ranges') === 'bytes', '声明了 Accept-Ranges: bytes');

  const noRange = await get('/api/stream?p=' + encodeURIComponent('/video/a_root.mp4'), {});
  ok(noRange.status === 200, '不带 Range 时返回 200');

  const notFound = await get('/api/stream?p=' + encodeURIComponent('/video/不存在.mp4'), {});
  ok(notFound.status >= 400, '不存在的文件返回错误码 ' + notFound.status);

  // normAbs 会把 .. 消解掉，所以拼出来的永远是 NAS 上的路径，出不了沙箱
  const traversal = await get('/api/stream?p=' + encodeURIComponent('/video/../../etc/passwd.mp4'), {});
  ok(traversal.status >= 400, '带 .. 的路径被归一化后拒绝（' + traversal.status + '）');

  const notVideo = await get('/api/stream?p=' + encodeURIComponent('/video/readme.txt'), {});
  ok(notVideo.status === 403, '非视频后缀一律 403，实际 ' + notVideo.status);

  console.log('\n【7】点赞 / 收藏 持久化');
  const id = va[0].p;
  await post('/api/state', { type: 'like', id, on: true });
  const stLike = await get('/api/state');
  ok(!!stLike.data.likes[id], '点赞已保存');
  await post('/api/state', { type: 'like', id, on: false });
  ok(!(await get('/api/state')).data.likes[id], '取消点赞生效');

  await post('/api/state', { type: 'favorite', id, on: true });
  const st = await get('/api/state');
  ok(!!st.data.favorites[id], '收藏已保存');
  ok(!('comments' in st.data), '评论字段已移除（现在只有 likes / favorites）');
  await post('/api/state', { type: 'favorite', id, on: false });
  ok(!(await get('/api/state')).data.favorites[id], '取消收藏生效');
  const badType = await post('/api/state', { type: 'comment', id, text: 'x' });
  ok(badType.ok === false, '未知操作类型被拒绝（comment 已不再支持）');

  console.log('\n【8】还原配置');
  // 先确认「清空配置能回到演示模式」这条逻辑本身是对的
  await post('/api/config', { url: '', dir: '', dirs: [], user: '', clearPass: true });
  const back = await get('/api/library?refresh=1');
  ok(back.data.source === 'demo', '清空配置后回到演示模式，演示视频 ' + back.data.videos.length + ' 个');

  // 再把用户自己的 NAS 配置还回去（脚本开头备份的）
  if (KEEP.url) {
    const r = await post('/api/config', KEEP);
    const now = await get('/api/config');
    const wantDirs = KEEP.dirs.join('|');
    const gotDirs = ((now.data.config && now.data.config.dirs) || []).join('|');
    const okBack = r.ok !== false
      && now.data.config && now.data.config.url === KEEP.url
      && !!now.data.hasPass === !!KEEP.pass;
    ok(okBack, '已还原测试前的 NAS 配置：' + KEEP.url);
    ok(gotDirs === wantDirs, '片源文件夹也还原了（' + (gotDirs || '空') + '）');
    if (!okBack) console.log('      ⚠️  自动还原失败，请手动检查 data/config.json');

    // 片库缓存：resetLibrary() 把 data/library.json 删了，先原样写回（万一后面预热失败，文件还是好的）
    if (USER_LIB) { try { fs.writeFileSync(LIB_FILE, USER_LIB); } catch (_) {} }
    // 但内存里的片库已被作废，还得打一次接口让它重扫并重新落盘 ——
    // 否则用户下一次打开 App 会多扫一遍 NAS
    try {
      await get('/api/library');
      const libNow = (() => { try { return JSON.parse(fs.readFileSync(LIB_FILE, 'utf8')); } catch (_) { return null; } })();
      const n = (libNow && libNow.videos && libNow.videos.length) || 0;
      if (n) ok(true, '片库缓存已重建（' + n + ' 个视频，下次打开直接读缓存，不重扫）');
      else console.log('  （片库缓存没能重建：NAS 大概连不上，服务端会再扫一次）');
    } catch (e) {
      console.log('  （片库缓存预热跳过：' + e.message + '）');
    }
  } else {
    console.log('  （跑之前没有配置过 NAS，保持演示模式）');
  }

  srv.close();
  console.log(`\n结果：通过 ${pass} 项，失败 ${fail} 项\n`);
  process.exit(fail ? 1 : 0);
})();
