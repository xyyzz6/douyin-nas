'use strict';
/**
 * NAS 短视频（抖音风格）
 * ------------------------------------------------------------------
 * 纯 Node 原生实现，零依赖。职责：
 *   1. 静态资源服务（含 Range 支持，供演示视频拖动进度）
 *   2. WebDAV 代理：PROPFIND 浏览 / 扫描目录，GET 流式转发（透传 Range，支持拖动）
 *   3. 点赞 / 收藏的本地持久化（data/state.json）
 *   4. 多设备同步的**账号服务端**（/api/auth/*、/api/sync/*）——
 *      多台设备登同一个账号，点赞收藏/坏码流/头像昵称/片源清单自动对齐，
 *      strm 备份包也能存在账号里供新设备一键恢复。见文件里「多设备同步」那一段。
 *
 * 之所以要做代理，是因为浏览器直连 WebDAV 会撞 CORS，
 * 且多数 NAS 的 WebDAV 不支持 CORS 预检。走本机转发可完全绕开。
 *
 * 关于「路径」的约定（很重要）：
 *   下面所有 absPath 都是「相对 WebDAV 服务地址的完整路径」，形如 /video/2024。
 *   它和 PROPFIND 返回的 href 是同一个坐标系，所以浏览器里点到的目录
 *   可以直接拿去扫描，不需要用户再手填路径。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { URL } = require('url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
/* 数据目录默认在代码旁边（`<项目>/data`）。
 * `NAS_DATA_DIR` 可以改到别处 —— 两个实际用途：
 *   · 测试时用临时目录跑，不污染手上的那份配置与账号库；
 *   · 部署时把「代码」和「数据」分开（容器里挂个卷、或者放 NAS 的某个共享目录）。 */
const DATA_DIR = process.env.NAS_DATA_DIR
  ? path.resolve(process.env.NAS_DATA_DIR)
  : path.join(ROOT, 'data');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');   // 视频缩略图缓存（服务端抽帧落盘，避免每次重生成）
const THUMB_SEEK = 60;     // 默认截取时间点（秒）：跳过片头，看正片
const THUMB_VER = 'v1';    // 改截取逻辑/时间点后 +1 即可让全部缓存失效重抽
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 8080);

/* 版本号（2026-09-20 用户要「以后每次打包都更新版本号」）。
 *
 * APK 那边是 build.js 每次打包自动涨、再由 aapt2 打进 manifest，
 * 运行时用 PackageManager 读回来（NasServer.configJsonObj）。
 * PC 版没有那个流程，也没人装它 —— 这里给个**固定值**占位就行，
 * 只为让前端「我的」页那行版本小字**两个后端都能显示**、不空着。
 * ⚠️ 别试图在 PC 版搞自动涨号：它没有「打包」这个动作，涨了也没人看，
 *    反而会和 APK 的版本号混在一起让人以为是同一个东西。 */
const PC_VERSION = 'PC';

/* 我们**认**的视频后缀 —— 只用于路径校验（/api/stream、/api/probe、/api/thumb、
   转码、抽帧都拿它判「这是不是一个视频文件」）。
   ⚠️ 它**不再**决定片库里列什么，那是 BROWSER_EXTS 的事。两个别合并。 */
const ALL_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mkv', 'avi', 'flv', 'wmv', 'ts', 'mpg', 'mpeg', '3gp', 'rmvb'];
/* 片库**只**列这些（2026-09-18 用户要求「播放时直接过滤掉 avi/wmv/mkv」）。
   理由：单机自包含架构（README 第 29 节）下 APK 不带 ffmpeg，
   avi / wmv / mkv / flv / ts / mpg / mpeg / 3gp / rmvb 这些封装系统根本解不了，
   列出来只会让人点进去卡住（以前是标灰）。
   原来这个白名单由设置页的 `playableOnly` 开关控制，现在**固定开启、开关已删**。
   ⚠️ 别退回「可配置」：那等于又把解不了的格式放回首页。 */
const BROWSER_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];

const DEFAULT_CONFIG = {
  url: '',           // WebDAV 服务地址，如 http://192.168.1.100:5005
  user: '',
  pass: '',
  dir: '',           // 「文件夹」页当前所在的远端目录（完整路径，空 = 用地址里带的路径 / 根目录）
  dirs: [],          // 片源文件夹（可以好几个）：首页刷的就是这些文件夹的合集
  /* 🔒 「不重扫」的片源文件夹（2026-09-18 加）。
   *    用户的话：「有些文件夹我添加上去之后，不会再新增文件了，每次都扫描的话太浪费时间了」。
   *    扫一遍大目录要十几分钟（§42 实测 802 秒），把「已经不会再变」的文件夹标上，
   *    常规扫描就**整个跳过它**，直接用上一份片库里属于它的视频。
   *    ⚠️ 只在「上一份片库里确实有它的视频」时才跳过 —— 一次都没扫过就必须扫，
   *    否则用户标完发现这个文件夹空了，只会以为坏了。 */
  skipDirs: [],
  recursive: true,
  /* 扫描深度：**0 = 不限**（一直往下钻）。
     ⚠️ 原来默认是 4、且硬 clamp 到 8。2026-09-18 实测 /dav/示例片源 有 48.4% 的
        视频在第 5 层（5095 个），深度 4 会把它们**全部**漏掉，而且不报错 ——
        这就是用户说的「有些视频藏的比较深扫不出来」。默认值改成「不限」。
     ⚠️ 旧配置里残留的 4 会在扫描时照旧生效（它是个有效值），
        想放开必须让用户自己把深度改成「不限」。所以前端默认值也要一起改。 */
  maxDepth: 0,
  // ⚠️ 这里原来有 `playableOnly: true`（设置页「只列出能直接播的格式」开关）。
  //    2026-09-18 起**片库固定只列 BROWSER_EXTS**，这个开关连同配置项一起删了。
  //    旧 data/config.json 里残留的 `playableOnly` 由 migrateConfig() 丢掉。
  fit: 'contain',    // contain | cover
  nickname: 'NAS 影迷',
  ffmpegPath: '',    // 自定义 ffmpeg 位置（留空 = 自动找 bin/ 和 PATH）
  // NAS 上的 Docker 解码服务（见仓库 decode-server/）。留空 = 本机 ffmpeg（PC 版）/
  // 不转码（APK 版，因为它已经不内嵌 ffmpeg 了）。
  decodeUrl: '',
};

/** PROPFIND 要问的字段 */
const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
  </d:prop>
</d:propfind>`;

/** 跳过的系统/隐藏目录 */
const SKIP_DIR = /^(\.|@|#recycle|#snapshot|__MACOSX|\$RECYCLE\.BIN)/i;

/* ================================ 路径 ================================ */

function encPath(p) {
  return String(p).split('/').map(encodeURIComponent).join('/');
}

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i < 0 ? '' : String(name).slice(i + 1).toLowerCase();
}

/**
 * 归一化成一个干净的绝对路径：统一斜杠、合并重复、消掉 . 和 ..
 * 顺带把路径穿越（../）挡在门外，后面拼 URL 就安全了。
 */
function normAbs(p) {
  let s = String(p == null ? '' : p).trim().replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
}

/**
 * 本机片源前缀判据 —— **容忍被 normAbs 补出来的前导斜杠**（2026-09-21）。
 *
 * 🔴 历史配置里可能存着 `/local:/` 这种脏值（老版本把 `local:/` 送进 normAbs 补出来的）。
 *    脏值一旦存进去，`startsWith('local:')` 判不出来 → `effectiveDir()` 的短路失效 →
 *    又被补成 `/dav/local:` 这个不存在的 WebDAV 路径。
 *    症状：进「文件夹」页先弹一句「之前设的文件夹已经打不开了」。
 *    ⚠️ 手机版 `NasServer.isLocalSrc` 同步放宽了判据，两边要一致。
 */
function isLocalSrcPath(s) {
  return typeof s === 'string' && s.trim().replace(/^\/+/, '').startsWith('local:');
}

/**
 * 片源路径归一 —— 按 `local:` / WebDAV **分流**，别一律 normAbs。
 * 开头先剥前导斜杠是在修历史脏值（`/local:/` → `local:/`）；
 * WebDAV 路径剥完再交给 normAbs，会重新补回一个 `/`。
 */
function normSrcPath(s) {
  let t = String(s == null ? '' : s).trim();
  while (t.startsWith('/')) t = t.slice(1);
  if (!t) return '';
  if (t.startsWith('local:')) return 'local:' + normAbs(t.slice('local:'.length));
  return normAbs(t);
}

const baseNameOf = (p) => {
  const segs = normAbs(p).split('/').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : '';
};

/** 所在文件夹名（用来当「作者」，只要倒数第二段） */
function folderOf(p) {
  const segs = normAbs(p).split('/').filter(Boolean);
  return segs.length > 1 ? segs[segs.length - 2] : '根目录';
}

function parentOf(p) {
  const s = normAbs(p);
  if (s === '/') return null;
  const i = s.lastIndexOf('/');
  return i <= 0 ? '/' : s.slice(0, i);
}

/**
 * 把地址拆成「源」和「地址里带的路径」，兼容 https://域名/remote.php/dav/files/xxx 这种写法。
 *
 * ⚠️ `urlPath` 必须是**去尾斜杠**的形态（`/dav/` → `/dav`，根则是 `''`），
 * 不能用 normAbs() —— normAbs 会把 `/dav/` 归一成 `/dav`（这步是对的），
 * 但**根路径会落成 `'/'` 而不是 `''`**，于是 davUrlAbs() 里那句
 * `p.startsWith(urlPath + '/')` 就成了 `p.startsWith('//')`，永远不成立；
 * 而 `urlPath &&` 那个真值判断也会误判成「有前缀」。
 * 统一用「去尾斜杠、根为空串」这一种形态，跟 Java 侧 DavClient.basePrefix 对齐。
 */
function splitUrl(url) {
  const raw = String(url || '').trim();
  try {
    const u = new URL(raw);
    return { origin: u.origin, urlPath: pathPrefix(u.pathname) };
  } catch (_) {
    return { origin: raw.replace(/\/+$/, ''), urlPath: '' };
  }
}

/** urlPath 的唯一正确形态：`/dav/` → `/dav`；`/`、``、`null` → `''` */
function pathPrefix(p) {
  let s = String(p == null ? '' : p);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/**
 * 拼出远端完整 URL。
 *
 * ⚠️ 这里必须把 `splitUrl().urlPath` 算进去 —— 服务地址可能**挂在子路径**上：
 *    · CloudDrive2 的 WebDAV 在 `http://IP:19798/dav`
 *    · Nextcloud 在 `http://域名/remote.php/dav`
 *    · Alist 在 `http://IP:5244/dav`
 *    只有群晖那种「根目录就是 WebDAV」的场景（`:5005`）urlPath 才恰好是 `/`。
 *
 * 2026-09-18 修的坑：以前这里只取 `origin`，把地址里的路径整个丢了 ——
 * 于是配 `http://IP:19798/dav` 会去打 `http://IP:19798/`，
 * CD2 的管理界面不收 PROPFIND，回 **405**，用户看到的是
 * 「服务端不允许 PROPFIND」这种完全指错方向的提示。
 * ⚠️ 同一天 Java 侧（DavClient）也被查出**反向**的同类 bug：那边是无条件
 * `base + encPath(path)`，而 path 本来就带 `/dav` → 拼成 `/dav/dav/xxx` → 404。
 * 也就是说两边一度错在相反方向、症状还各不相同（一个 405、一个 404）。
 * 现在两边都统一到下面这条幂等规则，并有 _tmp/urlparity.js 做 17 组用例对拍。
 *
 * 坐标系的约定（`effectiveDir` / `hrefToAbsPath` 都遵守它）：
 * **absPath 是「含 urlPath 前缀」的完整路径**。所以这里要做的是
 * 「有前缀就沿用、没前缀才补上」，**绝无脑拼接** —— 否则会拼成
 * `/dav/dav/xxx`（CD2 返回的 href 本来就带 `/dav`）。
 *
 * 空态的处理也很讲究：`/dav` 这个「服务根」本身要原样落成 `origin + '/dav'`，
 * **不能**写成 `'/dav/'` —— CD2 对 `/dav/` 回 301 且 Location 没带主机名，
 * Node 的 fetch 跟着跳就废了。所以这里手写拼接、不用 new URL() 相对解析
 * （相对解析会把 `/dav` 当文件、丢掉最后一段）。
 * server.js 与 Java 的 DavClient.absUrl() 规则必须一致 —— 两边有对拍脚本。
 */
/**
 * 把任意 absPath 归一到「含 urlPath 前缀」的规范形态。
 *
 * 子路径挂载（CD2 的 `/dav`）时 `/`（服务根）和 `/dav`（挂载根）指的是**同一层**，
 * 必须归一 —— 否则列表会把挂载根自己列成一个子文件夹（`cp === p` 拿
 * `/dav` 比 `/` 永远不等），「上一级」还会走进一个面包屑空掉的幽灵根。
 * `davUrlAbs` / `effectiveDir` / `listDir` 都走这里，别再各写一份判据。
 */
function mountAbs(cfg, absPath) {
  const { urlPath } = splitUrl(cfg && cfg.url);
  let p = normAbs(absPath);
  // urlPath 为空（根挂载）→ 不用补；已经是 urlPath 本身、或已经带前缀 → 原样用
  if (urlPath && p !== urlPath && !p.startsWith(urlPath + '/')) {
    p = normAbs(urlPath + p);
  }
  return p;
}

function davUrlAbs(cfg, absPath, isDir) {
  const { origin, urlPath } = splitUrl(cfg.url);
  const p = mountAbs(cfg, absPath);
  // 目录要带尾斜杠，但「urlPath 本身」除外（CD2 的 /dav/ 会 301）
  const needsSlash = isDir && p !== urlPath;
  let out = origin + encPath(p);
  if (needsSlash && !out.endsWith('/')) out += '/';
  return out;
}

/** 把 PROPFIND 返回的 href 换成同坐标系的绝对路径 */
function hrefToAbsPath(href) {
  let p = String(href || '');
  try { p = new URL(p, 'http://dav.local').pathname; } catch (_) { /* 相对路径直接用 */ }
  try { p = decodeURIComponent(p); } catch (_) { /* 编码坏了就保留原样 */ }
  return normAbs(p);
}

/** 面包屑：/video/2024/电影 → [{name:'video',path:'/video'}, ...] */
function crumbsOf(absPath) {
  const out = [];
  let cur = '';
  for (const seg of normAbs(absPath).split('/').filter(Boolean)) {
    cur += '/' + seg;
    out.push({ name: seg, path: cur });
  }
  return out;
}

/**
 * 真正要用的目录：优先用传进来的，其次用配置里记着的，
 * 都没有就用地址里带的路径（比如 /remote.php/dav/files/用户名）。
 * 顺手把「地址带路径但 dir 没带前缀」的情况补全，老配置也能直接跑。
 *
 * 🔴 本机片源（`local:`）在这里**返回空串**（2026-09-20，与 NasServer.effectiveDir 对齐）。
 *    PC 版其实进不来这个分支（normDirs 已经把 `local:` 滤掉了），但两边判据要一致 ——
 *    否则一旦哪天 PC 版也支持本机片源，这里就会把 `local:/` 补成 `/local:/`，
 *    变成一个去 PROPFIND 必然 404 的假路径，和手机版踩过的坑一模一样。
 */
function effectiveDir(override) {
  const pick = override || config.dir;
  if (isLocalSrcPath(pick)) return '';
  // `override || config.dir || urlPath` 里 urlPath 可能是空串（根挂载）——
  // 空串会被 normAbs 兜成 '/'，正确。所以这里不用特判。
  return mountAbs(config, pick || splitUrl(config.url).urlPath);
}

/**
 * 挂载根目录 —— 这个 WebDAV 地址本身指向的那一层。
 *   子路径挂载（CD2 `:19798/dav`）→ `/dav`
 *   根挂载（群晖 `:5005`）        → `/`
 * 「登录探根」和「浏览兜底」用的必须是同一个概念，别再各写一遍表达式。
 */
function mountRootOf(cfg) {
  return splitUrl(cfg && cfg.url).urlPath || '/';
}

/**
 * 首页要刷的「片源文件夹」列表（可以好几个）。
 * 一个都没配就退回「当前浏览目录」—— 老配置、以及还没挑过文件夹的新用户都不会白屏。
 */
function sourceDirs() {
  const list = (config.dirs || []).map(normAbs).filter(Boolean);
  return list.length ? [...new Set(list)] : [effectiveDir()];
}

/* ============================== HTTP 基础 ============================== */

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function authHeader(cfg) {
  if (!cfg.user && !cfg.pass) return {};
  return { Authorization: 'Basic ' + Buffer.from(`${cfg.user || ''}:${cfg.pass || ''}`).toString('base64') };
}

/** 低层 HTTP 请求，返回 IncomingMessage */
function httpRequest(method, target, { headers = {}, body = null, timeout = 30000, cfg = null } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (e) { return reject(new Error('地址不合法: ' + target)); }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: { 'User-Agent': 'NAS-Douyin/1.0', ...authHeader(cfg || {}), ...headers },
        rejectUnauthorized: false,
      },
      (res) => resolve(res)
    );
    req.on('error', (e) => reject(new Error(`连接失败: ${e.message}`)));
    if (timeout > 0) req.setTimeout(timeout, () => req.destroy(new Error('请求超时（检查 NAS 地址/端口是否可达）')));
    if (body) req.write(body);
    req.end();
  });
}

/** 给一组任务加并发上限（浏览 NAS 时别把对方打挂） */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ========================== WebDAV 目录解析 ========================== */

function pick(blk, tag) {
  const r = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i');
  const m = blk.match(r);
  return m ? m[1].trim() : '';
}

function parseMultiStatus(xml) {
  const out = [];
  const re = /<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const blk = m[1];
    const href = pick(blk, 'href');
    if (!href) continue;
    out.push({
      href: decodeXml(href),
      isDir: /<(?:\w+:)?collection\b/i.test(blk),
      name: decodeXml(pick(blk, 'displayname') || ''),
      size: parseInt(pick(blk, 'getcontentlength') || '0', 10) || 0,
      ct: pick(blk, 'getcontenttype') || '',
      mtime: pick(blk, 'getlastmodified') || '',
    });
  }
  return out;
}

/** 对某个远端目录发 PROPFIND */
async function propfind(cfg, absPath, depth) {
  const target = davUrlAbs(cfg, absPath, true);
  const res = await httpRequest('PROPFIND', target, {
    cfg,
    headers: {
      Depth: String(depth),
      'Content-Type': 'application/xml; charset=utf-8',
      Accept: 'application/xml, text/xml, */*',
    },
    body: PROPFIND_BODY,
  });
  const chunks = [];
  for await (const c of res) chunks.push(c);
  const xml = Buffer.concat(chunks).toString('utf8');
  if (res.statusCode >= 400) {
    const hint =
      res.statusCode === 401 ? '认证失败：用户名或密码不对' :
      res.statusCode === 404 ? '目录不存在，可能被删了或者改名了' :
      res.statusCode === 405 ? '服务端不允许 PROPFIND：确认地址指向的是 WebDAV 共享' : '';
    throw new Error(`WebDAV 返回 ${res.statusCode}${hint ? '（' + hint + '）' : ''}`);
  }
  return parseMultiStatus(xml);
}

/** 列出某个远端目录：子文件夹 + 本层的视频 */
async function listDir(cfg, absPath) {
  /* 🔴 先归一到「含 urlPath 前缀」的坐标系（mountAbs）—— 见它的注释。
   *    不归一的话：① 挂载根会被列成一个叫「dav」的子文件夹（cp === p 永远不等）；
   *    ② 面包屑/上一级按 `/` 算，会走进一个幽灵根。 */
  const p = mountAbs(cfg, absPath);
  const raw = await propfind(cfg, p, 1);
  const exts = BROWSER_EXTS;
  const dirs = [];
  const videos = [];

  for (const it of raw) {
    const cp = hrefToAbsPath(it.href);
    if (!cp || cp === p) continue;             // PROPFIND 会把被请求的目录自己也返回，排掉
    const name = baseNameOf(cp);
    if (!name || SKIP_DIR.test(name)) continue;

    if (it.isDir) {
      dirs.push({ name, path: cp, count: null });   // count 稍后由 /api/counts 补上
    } else {
      const ext = extOf(name);
      if (!exts.includes(ext)) continue;
      videos.push({
        p: cp, name, size: it.size, mtime: it.mtime, ext,
        playable: BROWSER_EXTS.includes(ext),
        folder: folderOf(cp), title: name.replace(/\.[^.]+$/, ''), author: folderOf(cp),
      });
    }
  }

  const cmp = (a, b) => String(a.name).localeCompare(String(b.name), 'zh-Hans-CN', { numeric: true });
  dirs.sort(cmp);
  videos.sort(cmp);

  /* 挂载根就是可浏览树的顶 —— 它**没有**上一级。
   * 不钉住的话 parentOf('/dav') 会给出 '/'，前端「上一级」永远可点，
   * 点下去又落回同一层（甚至幽灵根）。根挂载时 p 就是 '/'，本来就 null。 */
  const mountRoot = mountRootOf(cfg);

  return {
    ok: true,
    path: p,
    name: baseNameOf(p) || '根目录',
    parent: p === mountRoot ? null : parentOf(p),
    crumbs: crumbsOf(p),
    dirs,
    videos,
    videoCount: videos.length,
  };
}

/** 数一数某个目录下有几个视频（只数本层，点目录时用） */
async function countVideos(cfg, absPath) {
  const raw = await propfind(cfg, absPath, 1);
  const exts = BROWSER_EXTS;
  let n = 0;
  for (const it of raw) {
    if (it.isDir) continue;
    const cp = hrefToAbsPath(it.href);
    const name = baseNameOf(cp);
    if (name && exts.includes(extOf(name))) n++;
  }
  return n;
}

/* ============================== 扫描片库 ============================== */

/** 上一次扫描是否因为超时/数量上限被截断（用于前端提示） */
let scanTruncated = false;

async function scanLibrary(cfg, startAbs) {
  const root = normAbs(startAbs);
  const found = [];
  const visited = new Set();
  const t0 = Date.now();
  scanTruncated = false;
  /* 深度：0 = **不限**（一直往下钻）。上限 32 只是防呆，不是业务限制。
     ⚠️ 原来是 `Math.min(8, ...)` —— 实测 /dav/示例片源 有 48.4% 的视频在第 5 层，
     硬 clamp 到 8 会把更深的全丢掉，而且**不报错**（就是用户说的「藏得深扫不出来」）。 */
  const maxDepth = Math.max(0, Math.min(32, Number(cfg.maxDepth) || 0));
  const unlimited = maxDepth === 0;
  const exts = BROWSER_EXTS;
  /* ------------------------------------------------------------------
   * 三道上限（2026-09-18 按用户要求「全部扫出来」重新标定）
   * ------------------------------------------------------------------
   * 原来的值：45 秒 / 800 条 / 深度 8。实测 /dav/示例片源 单一个片源就有上万个视频，
   * 45 秒只够扫出 549 个 —— 而且**超时不报告**（`truncated` 只看条数），
   * 用户以为扫全了。现在：
   *   · MAX_MS    45s → 5min（配合下面的并发，实测 4000 个目录约 3.4 分钟）
   *   · MAX_VIDEOS 800 → 20000（实测 10525 个，800 会砍掉九成）
   *   · 深度      8   → 不限
   * ⚠️ 时间/条数上限是**兜底**不是目标：撞上时必须置 truncated，让前端如实告知。 */
  const MAX_MS = 300000;
  const MAX_VIDEOS = 20000;
  /* 🔴 并发路数。原来是**串行** BFS（一个目录一个 PROPFIND 挨着来），
     CD2 不支持 Depth:3 只能一层层走，于是 4000 个目录要 ~19 分钟。
     实测（_tools/bench-concurrency.js，60 个真实目录）：
       串行 16.9s / 8 并发 3.1s（快 5.5 倍）/ 16 并发 2.7s
     16 路比 8 路只快 12%，对 NAS 压力大一倍 —— **8 是甜点**。 */
  const CONCURRENCY = 8;

  /** 并发跑一批，但最多同时 limit 个（结果顺序与入参一致） */
  async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let i = 0;
    async function worker() {
      while (i < list.length) {
        const idx = i++;
        out[idx] = await fn(list[idx], idx);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
    return out;
  }

  /* 按层 BFS：同一层内的目录**并发**探，层与层之间串行（保证深度语义） */
  let frontier = [root];
  let depth = 1;
  visited.add(root);
  let startErr = null;

  while (frontier.length) {
    if (Date.now() - t0 > MAX_MS || found.length >= MAX_VIDEOS) { scanTruncated = true; break; }

    /* ⚠️ 结果必须带上 dirAbs —— 并发之后循环体里已经拿不到「这批是谁的了」，
       而 PROPFIND 的响应里第一条是**目录自己**，得靠它跳过（否则自己进自己 = 死循环）。 */
    const results = await mapLimit(frontier, CONCURRENCY, async (dirAbs) => {
      try {
        return { dirAbs, items: await propfind(cfg, dirAbs, 1) };
      } catch (e) {
        if (depth === 1) startErr = e;      // 起点目录失败 → 整体失败（跟旧行为一致）
        else console.warn('[scan] 跳过目录', dirAbs, e.message);
        return { dirAbs, items: null };
      }
    });

    const next = [];
    for (const r of results) {
      if (!r.items) continue;
      const self = r.dirAbs.replace(/\/+$/, '');
      for (const it of r.items) {
        const cp = hrefToAbsPath(it.href);
        if (!cp) continue;
        const name = baseNameOf(cp);
        if (!name || SKIP_DIR.test(name)) continue;

        if (it.isDir) {
          const norm = cp.replace(/\/+$/, '');
          if (norm === self) continue;                 // PROPFIND 会把目录自己也列出来
          if (visited.has(norm)) continue;
          visited.add(norm);
          if (found.length < MAX_VIDEOS) next.push(norm);
          continue;
        }

        const ext = extOf(name);
        if (!exts.includes(ext)) continue;
        if (found.length >= MAX_VIDEOS) { scanTruncated = true; continue; }
        found.push({
          p: cp, name, size: it.size, mtime: it.mtime, ext,
          playable: BROWSER_EXTS.includes(ext),
        });
      }
    }

    if (startErr) throw startErr;
    if (!cfg.recursive) break;
    if (!unlimited && depth >= maxDepth) break;
    if (found.length >= MAX_VIDEOS) { scanTruncated = true; break; }
    frontier = next;
    depth++;
  }

  if (scanTruncated) {
    console.warn(`[scan] 撞到上限：${found.length} 个视频 / ${Date.now() - t0}ms（MAX_VIDEOS=${MAX_VIDEOS}, MAX_MS=${MAX_MS}）`);
  }
  found.sort((a, b) => a.p.localeCompare(b.p, 'zh-Hans-CN', { numeric: true }));
  return found;
}

/* ============================== 配置/状态 ============================== */

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function writeJson(file, obj) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 老版本配置里有过「本地磁盘模式」，读进来时把那几个字段丢掉 */
function migrateConfig(raw) {
  const c = { ...DEFAULT_CONFIG, ...(raw || {}) };
  delete c.source;
  delete c.localRoot;
  /* `playableOnly`（设置页「只列出能直接播的格式」开关）2026-09-18 废弃：
     片库现在固定只列 BROWSER_EXTS，没有可配的余地。
     旧 config.json 里那个 `false` 留着会让人以为它还有用，直接丢掉。 */
  delete c.playableOnly;
  if (!c.dir && raw && raw.basePath) c.dir = normAbs(raw.basePath);   // basePath 是旧字段，语义等价
  delete c.basePath;
  c.url = String(c.url || '').trim().replace(/\/+$/, '');
  c.dir = c.dir ? normSrcPath(c.dir) : '';

  // 片源文件夹可以好几个。只有「配置文件里压根没有 dirs 这个字段」的老配置，
  // 才把单个 dir 补成第一项 —— 否则用户主动清空片源后，随便保存一次设置又会把它变回来。
  const legacy = !Array.isArray(c.dirs);
  let dirs = Array.isArray(c.dirs) ? c.dirs : [];
  // （normDirs 里已经滤掉本机片源 local:，见它的注释）
  dirs = normDirs(dirs);
  if (!dirs.length && c.dir && legacy) dirs = [c.dir];
  c.dirs = dirs;
  /* 老配置没有 skipDirs。顺带把「已经不在 dirs 里」的残留项清掉 ——
     文件夹都删了还记着它，只会让人看不懂为什么扫描结果里少了东西。 */
  const sd = Array.isArray(c.skipDirs) ? c.skipDirs : [];
  c.skipDirs = [...new Set(sd.filter((d) => typeof d === 'string' && d.trim()).map(normAbs))]
    .filter((d) => dirs.includes(d));

  /* 0 = 不限深度。上限 32 只是防呆，不是业务限制（实测真实目录最深 5 层）。 */
  c.maxDepth = Math.max(0, Math.min(32, Number(c.maxDepth) || 0));
  // 解码服务地址（NAS 上的 Docker 转码容器）。留空 = 用本机 ffmpeg（PC 版）或不转码（APK 版）。
  // 统一形状：去尾部斜杠 —— 否则 "…:8099" 和 "…:8099/" 会被当成两个不同的值。
  c.decodeUrl = String(c.decodeUrl || '').trim().replace(/\/+$/, '');
  return c;
}

/** 归一化一份「片源文件夹」列表：去空、去重、限个数 */
function normDirs(arr) {
  /* 🔴 「本机片源」（`local:` 开头）在 PC 版上**直接丢掉**（2026-09-20）。
     它是手机本地的一类片源（strm 自动库生成的目录），APK 版靠 java.io.File 扫；
     PC 版没有这个概念 —— 更关键的是 normAbs 会把 `local:/` 补成 `/local:/`，
     于是它变成一个「形状像 WebDAV、去 PROPFIND 必然 404」的哑片源，
     每轮扫描都白撞一次、还可能拖慢整轮。宁可在这里就滤掉。
     （app.js 的 isLocalSrc / NasServer.isLocalSrc 是同一份判据。） */
  return [...new Set((Array.isArray(arr) ? arr : [])
    .filter((d) => typeof d === 'string' && d.trim() && !d.trim().startsWith('local:'))
    .map(normAbs))].slice(0, 30);
}

let config = migrateConfig(readJson(CONFIG_FILE, {}));
let state = { likes: {}, favorites: {}, ...readJson(STATE_FILE, {}) };
let library = { videos: [], scannedAt: 0, source: 'demo' };

let saveStateTimer = null;
function saveStateSoon() {
  clearTimeout(saveStateTimer);
  saveStateTimer = setTimeout(() => { try { writeJson(STATE_FILE, state); } catch (e) { console.warn('保存状态失败', e.message); } }, 300);
}

/* ---------------------- 片库缓存（一天只完整扫一次） ---------------------- */
/**
 * 每次打开 App 都全盘扫一遍 NAS 太浪费：目录多点的话要好几秒，手机流量也白烧。
 * 所以扫完就把结果落盘，24 小时内直接读缓存；过期了也先把旧缓存给前端撑住界面，
 * 再在后台慢慢扫新增内容，扫完通知前端换上（前端靠 ?peek=1 轮询 version）。
 */
const LIB_CACHE_FILE = path.join(DATA_DIR, 'library.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 缓存有效期 = 一天扫一次

let cachedSig = '';    // 磁盘上那份缓存对应的是哪套配置
let scanning = null;   // 正在跑的后台扫描（单飞：同时只允许一个）
let libVersion = 0;    // 片库每更新一次 +1，前端靠它判断要不要重新拉
let libError = '';     // 最近一次后台扫描的失败原因（扫成功就清掉）
let scanAgain = false; // 这轮扫描的结果作废了（扫的中途配置又变了），结束后按新配置再来一轮

/**
 * 这套配置下缓存还算不算数（改地址/账号/片源/递归都要作废）。
 * 密码只取指纹 —— 这个 sig 会被写进 data/library.json，没必要把明文密码再抄一份。
 */
function libSig() {
  const passPrint = config.pass
    ? crypto.createHash('sha1').update(String(config.pass)).digest('hex').slice(0, 12)
    : '';
  return [config.url, config.user, passPrint, (config.dirs || []).join('|'),
    config.recursive ? 1 : 0, config.maxDepth,
    /* 把片库白名单**本身**拼进签名：改白名单（或像 2026-09-18 这样把
       avi/wmv/mkv 滤掉）会**自动作废旧缓存**。
       不这么做的话，旧缓存里那些已经不该出现的 avi/wmv 会被原样读回来，
       用户得等到 TTL 过期才看不见它们。 */
    BROWSER_EXTS.join(',')].join('\u0000');
  /* ⚠️ 签名里**刻意不含** skipDirs（2026-09-18）。
     一旦把它拼进来，勾选/取消「不重扫」就会让整份片库缓存失效 ——
     而跳过的那些目录正是要靠这份缓存才有视频的，等于自己把自己清空了。
     勾选项改变时的正确性由 buildLibrary 按目录维度合并来保证：
       取消勾选 → 那一轮会真扫它，新结果自然覆盖缓存里的旧记录；
       刚勾选   → 上一轮刚扫过，缓存里就是最新的，直接用。 */
}

/** 启动时把上次扫好的片库直接读回来，省掉开机第一扫 */
function loadLibraryCache() {
  const c = readJson(LIB_CACHE_FILE, null);
  if (!c || !Array.isArray(c.videos) || !c.videos.length) return;
  if (c.sig !== libSig()) { console.log('[cache] 配置变过，片库缓存作废'); return; }
  library = {
    videos: c.videos, scannedAt: c.scannedAt || 0, source: c.source || 'webdav',
    dirs: c.dirs || [], dir: (c.dirs || [])[0] || '',
    skipDirs: Array.isArray(config.skipDirs) ? config.skipDirs : [],
    truncated: false, elapsedMs: c.elapsedMs || 0, cached: true,
  };
  cachedSig = c.sig;
  libVersion++;
  console.log(`[cache] 载入片库缓存：${c.videos.length} 个视频，${Math.round((Date.now() - library.scannedAt) / 60000)} 分钟前扫的`);
}

function saveLibraryCache() {
  if (library.source !== 'webdav' || !library.videos.length) return;
  try {
    writeJson(LIB_CACHE_FILE, {
      sig: libSig(), scannedAt: library.scannedAt, source: library.source,
      dirs: library.dirs || [], elapsedMs: library.elapsedMs || 0, videos: library.videos,
    });
  } catch (e) { console.warn('[cache] 写片库缓存失败', e.message); }
}

function clearLibraryCache() {
  cachedSig = '';
  try { fs.unlinkSync(LIB_CACHE_FILE); } catch (_) {}
}

/** 配置变了：内存和磁盘上的片库都作废 */
function resetLibrary() {
  library = { videos: [], scannedAt: 0, source: 'demo' };
  clearLibraryCache();
}

/**
 * 缓存过期时在后台悄悄重扫；前端先拿旧数据把界面撑起来，扫完再换。
 *
 * 单飞：同时只允许一路扫描。已经有了就直接复用那一路 —— 但复用的时候得等一下，
 * 否则「下拉刷新」这种明确要求重扫的请求会立刻拿到旧数据和旧的 version，
 * 前端会以为「扫完了，什么都没变」。等它结束再读一次内存里的片库，就是新结果了。
 */
function kickBackgroundScan(wait) {
  if (scanning) return wait ? scanning.catch(() => {}) : scanning;
  const sig = libSig();
  scanning = (async () => {
    try {
      const next = await buildLibrary();
      /* 🔴 扫的中途配置又变了（用户手快，刚加的文件夹还没扫完又加了一个）：
       * 这份结果已经对不上号，**必须丢掉**，不能提交。
       *
       * 为什么不能「先提交再重扫」：提交会让 libVersion++，前端那套 ?peek=1 轮询
       * 一旦看到版本变化就**取走这份过期数据并停止轮询** —— 后面那轮正确的结果
       * 就再也没人看了，界面会永久停在半路上。
       * （libVersion 只在「扫完并提交」那一刻 +1，所以丢弃本轮 = 什么都不动。） */
      if (sig !== libSig()) {
        console.log('[cache] 扫描期间片源又变了，丢弃本轮结果并按新配置重扫');
        scanAgain = true;
        return;
      }
      library = next;
      cachedSig = sig;
      libError = '';
      libVersion++;
      saveLibraryCache();
      console.log(`[cache] 后台刷新完成：${next.videos.length} 个视频，${next.elapsedMs}ms` +
        (next.errors ? `（${next.errors.length} 个片源读不到）` : ''));
    } catch (e) {
      console.warn('[cache] 后台刷新失败，继续用旧缓存：', e.message);
      /* 扫挂了也得让 libVersion 动一下 —— 前端只在版本变化时才去取结果，
       * 不动它就只会一直空等到 5 分钟超时，用户看到的是「永远在扫」。
       * 原因挂在 payload 的 scanError 上一起带回去，前端拿到后直接弹出来。 */
      libError = e.message;
      libVersion++;
    } finally {
      scanning = null;
      // 刚才那轮被作废了 → 立刻按新配置补一轮（单飞：这里 scanning 已清空，起得来）
      if (scanAgain) { scanAgain = false; kickBackgroundScan(); }
    }
  })();
  return scanning;
}

loadLibraryCache();

/* ============================== 静态资源 ============================== */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.ogv': 'video/ogg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function sendJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

function sendText(res, code, text, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}

/** 本地文件服务，带 Range 支持（视频拖动进度必需） */
function serveStatic(req, res, filePath, { cache = true } = {}) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not Found');
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    const baseHeaders = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache ? 'public, max-age=86400' : 'no-store',
    };

    /** 读流出错（文件被占用/被删/权限）不能让进程挂掉 */
    const pipeSafe = (stream) => {
      stream.on('error', (e) => {
        console.warn('[static] 读取失败', path.basename(filePath), e.code || e.message);
        try { res.destroy(); } catch (_) {}
      });
      res.on('close', () => { try { stream.destroy(); } catch (_) {} });
      stream.pipe(res);
    };

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= st.size) end = st.size - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...baseHeaders, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return pipeSafe(fs.createReadStream(filePath, { start, end }));
    }
    res.writeHead(200, { ...baseHeaders, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    pipeSafe(fs.createReadStream(filePath));
  });
}

/* ============================== 演示模式 ============================== */

const DEMO_META = [
  { title: '周末在 NAS 里翻出的老片，画质居然还能打 #电影 #回忆', author: '影迷小林' },
  { title: '把家里十年的视频都整理进 NAS 了，治愈感拉满 #存储 #数码', author: '数码阿伟' },
  { title: '深夜刷片时刻 🎬 这个片头我能看一百遍 #电影剪辑', author: '夜猫放映厅' },
  { title: '动画片的色彩真的顶，随手一截都是壁纸 #动画 #壁纸', author: '阿澈' },
  { title: '水母在水里飘的样子太解压了，循环播放一整天 #治愈 #海洋', author: '慢慢' },
  { title: '十分钟看完一朵花开，时间被拍下来的感觉 #延时摄影', author: '植物观察日记' },
];

function demoVideos() {
  const dir = path.join(PUBLIC_DIR, 'samples');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.(mp4|webm|ogv)$/i.test(f)); } catch (_) { files = []; }
  files.sort();
  return files.map((f, i) => {
    const meta = DEMO_META[i % DEMO_META.length];
    const st = fs.statSync(path.join(dir, f));
    return {
      p: 'demo://' + f,
      name: f,
      size: st.size,
      mtime: st.mtime.toISOString(),
      ext: extOf(f),
      playable: true,
      demo: true,
      title: meta.title,
      author: meta.author,
      stream: '/samples/' + encodeURIComponent(f),
    };
  });
}

/* ================================ 路由 ================================ */

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

/* =====================================================================================
 *  多设备同步（账号系统）—— 2026-09-20 用户需求
 * =====================================================================================
 *  一台 NAS 当「同步服务端」，多台设备登同一个账号 → 点赞 / 收藏 / 坏码流名单 /
 *  头像昵称 / 片源与监控清单 自动对齐；strm 备份包也存在账号里，新设备登录后自动恢复
 *  （换机不用再手动导 zip）。
 *
 *  为什么放在 server.js 而不是单开一个服务：用户 NAS 上本来就跑着它（网页版），
 *  多跑一个进程就多一份运维负担。代价是它顺带承担了账号存储。
 *
 *  🔴 安全底线（每条都很便宜，但少一条就出事）：
 *    1. 密码**只存 scrypt 哈希**，不存明文、也不用 md5/sha1（那种一撞库就全裸）；
 *    2. token 用 crypto.randomBytes，且**落盘**（重启不掉线），带过期时间；
 *    3. 每个账号的数据**按用户名分文件**，登录后只碰自己那一份；
 *    4. 用户名过白名单 —— 它会被拼进文件名，不收白名单就等于开了目录穿越。
 *
 *  ⚠️ CORS **只开给 /api/auth/* 与 /api/sync/***（见 sendCorsJson）：
 *     手机 App 的页面跑在 127.0.0.1:8099，连 NAS 是跨域，必须放行；
 *     但**绝不能**顺手给别的接口也加 `*` —— 那些接口没有鉴权，一旦允许任意网页
 *     跨域读，等于把「改配置」的按钮开放给用户浏览器里打开的任何一个网站。
 */

const SYNC_DIR = path.join(DATA_DIR, 'sync');
const SYNC_DB_FILE = path.join(SYNC_DIR, 'accounts.json');
const SYNC_TOKEN_TTL = 180 * 24 * 3600 * 1000;   // token 半年，过期自动失效
const SYNC_BODY_MAX = 8 * 1024 * 1024;           // 同步请求体上限（含头像 base64）
const SYNC_ZIP_MAX = 64 * 1024 * 1024;           // strm 备份包上限
const SYNC_TOMB_KEEP = 60 * 24 * 3600 * 1000;    // 删除墓碑保留 60 天
/* 用户名会被拼进文件名（u-<name>.json）—— 这条白名单是唯一防线，别放宽到允许斜杠 */
const SYNC_NAME_RE = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]{1,32}$/;
/* 注册开关。默认开着（第一次部署总得有个账号），`SYNC_ALLOW_REGISTER=0` 关掉。
 * 什么时候该关：这个服务一旦能从公网/公司网络访问，开着注册就等于把「往你 NAS 写数据」
 * 的入口公开 —— 别人看不到你的数据（账号之间是隔离的），但能占你的盘。
 * 关掉之后已有账号照常登录；要新账号就临时把环境变量去掉重启一次。 */
const SYNC_ALLOW_REGISTER = process.env.SYNC_ALLOW_REGISTER !== '0';

function syncDbLoad() {
  const o = readJson(SYNC_DB_FILE, null);
  return {
    users: (o && o.users) || {},
    tokens: (o && o.tokens) || {},
  };
}
function syncDbSave(db) {
  ensureDir();
  try { fs.mkdirSync(SYNC_DIR, { recursive: true }); } catch (_) {}
  writeJson(SYNC_DB_FILE, db);
}
function syncUserFile(name) { return path.join(SYNC_DIR, 'u-' + name + '.json'); }
function syncZipFile(name) { return path.join(SYNC_DIR, 'u-' + name + '.strm.zip'); }

function syncHash(pass, salt) {
  return crypto.scryptSync(String(pass), String(salt), 32).toString('hex');
}
function syncNewToken() { return crypto.randomBytes(24).toString('hex'); }

/** 空的账号数据（每个字段都跟本机 /api/state、/api/config 里的同名同形） */
function syncEmptyData() {
  return {
    likes: {}, favorites: {}, badStreams: {},
    /* profile：昵称 + 头像（头像前端存的是一段 dataURL，可能几百 KB） */
    profile: {},
    /* sources：片源 / 监控清单 / 间隔（与 strm 备份包里的那份同形） */
    sources: {},
    updatedAt: 0,
  };
}
function syncDataLoad(name) {
  return { ...syncEmptyData(), ...(readJson(syncUserFile(name), null) || {}) };
}
function syncDataSave(name, d) {
  d.updatedAt = Date.now();
  try { fs.mkdirSync(SYNC_DIR, { recursive: true }); } catch (_) {}
  writeJson(syncUserFile(name), d);
}

/** 注册。返回 { token, user } 或 { error } */
function syncRegister(name, pass) {
  if (!SYNC_NAME_RE.test(name)) return { error: '账号名只能用中英文、数字、_ - .（1~32 位）' };
  if (String(pass || '').length < 4) return { error: '密码至少 4 位' };
  const db = syncDbLoad();
  if (db.users[name]) return { error: '这个账号名已经被用了' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[name] = { salt, hash: syncHash(pass, salt), at: Date.now() };
  const token = syncNewToken();
  db.tokens[token] = { user: name, at: Date.now() };
  syncDbSave(db);
  syncDataSave(name, syncEmptyData());     // 先落一份空数据，后面 pull 就不用判 null
  return { token, user: name };
}

function syncLogin(name, pass) {
  const db = syncDbLoad();
  const u = db.users[name];
  /* ⚠️ 不区分「账号不存在」和「密码错」——那等于免费送一个账号枚举接口。
     统一一句话，用户少得到的那点提示不值得暴露这个。 */
  if (!u) return { error: '账号或密码不对' };
  if (syncHash(pass, u.salt) !== u.hash) return { error: '账号或密码不对' };
  const token = syncNewToken();
  db.tokens[token] = { user: name, at: Date.now() };
  syncDbSave(db);
  return { token, user: name };
}

/** 取 Bearer token → { user, token }；无效/过期返回 null */
function syncAuth(req) {
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(String(req.headers.authorization || '').trim());
  if (!m) return null;
  const db = syncDbLoad();
  const rec = db.tokens[m[1]];
  if (!rec) return null;
  if (Date.now() - Number(rec.at || 0) > SYNC_TOKEN_TTL) {
    delete db.tokens[m[1]];
    syncDbSave(db);
    return null;
  }
  return { user: rec.user, token: m[1] };
}

/**
 * 条目归一化：老格式（`true` / `1` / 字符串）和新格式（`{t, del}`）都要认。
 *
 * ⚠️ 老格式给 `t = 0`：它只在两边都没有时间信息时才可能胜出。
 *    要是把老格式当成「刚刚」（t=now），那「本机取消收藏」永远推不过去。
 */
function syncNormEntry(v) {
  if (v && typeof v === 'object') {
    return { t: Number(v.t) || 0, del: !!v.del };
  }
  return { t: 0, del: false };
}

/**
 * 两份 map 合并 —— **按时间戳取新**（改收藏时间越晚的越权威）。
 *
 * 三件事必须一起做到，少一件多设备就会互相打脸：
 *   · 并集：A 设备收的、B 设备收的，合并后两边都有；
 *   · 时间戳定胜负：同一条两边都改过 → 听晚的那次；
 *   · **墓碑要留着**（del:true 且 t>0）：不留的话「取消收藏」在对方那儿会复活 ——
 *     因为它只看到「我这边有、你那边没有」，会以为是我还没同步过去。
 * 平手（t 相等）取本地：本机刚点的那一下更可信。
 */
function syncMergeMap(local, remote) {
  const out = {};
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  for (const k of keys) {
    const a = syncNormEntry((local || {})[k]);
    const b = syncNormEntry((remote || {})[k]);
    const win = b.t > a.t ? b : a;
    if (!win.del) out[k] = { t: win.t || 0 };
    else if (win.t > 0) out[k] = { t: win.t, del: true };
    /* 老格式的「存在」没有 t：并集保留即可，但不能生成墓碑（不知道是删的还是没同步过） */
  }
  return out;
}

/** 清掉过期墓碑（不然合并表只会越长越大） */
function syncPruneTomb(map) {
  const now = Date.now();
  const out = {};
  for (const [k, v] of Object.entries(map || {})) {
    if (v && v.del && now - Number(v.t || 0) > SYNC_TOMB_KEEP) continue;
    out[k] = v;
  }
  return out;
}

/** 🗑️ 这里原来有个 `syncUnionArr(a, b)`（数组并集），2026-09-21 **删掉了**。
 *
 * 它当时是给 sources（片源 / 不重扫 / 监控清单）合并用的，注释写着
 * 「只补不删 —— 谁都不想同步一次就丢掉自己的文件夹」。
 * 但**并集在语义上就表达不了删除**：用户删掉一个监控文件夹，下一次同步
 * 就被账号里那份并回来，症状是「这个文件夹已经不需要监控了但是无法移除」。
 * 现在改成「按时间戳取最后改过的那份」，见 mergeSnapshot 里 sources 那段。
 * ⚠️ 别再加回来。 */

/** 带 CORS 的 JSON 响应（只有 auth / sync 用，见文件头上那条安全说明） */
function sendCorsJson(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Max-Age': '86400',
  });
  res.end(buf);
}

/** 读**二进制**请求体（strm 备份包）。readBody 只收 JSON 且有 1MB 上限，这里不能用。 */
function readBodyRaw(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > maxBytes) { dead = true; req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(dead ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}

/** 把本机 state/config 的形状，折成一份「可同步快照」 */
function syncSnapshotFromBody(body) {
  const b = body || {};
  const snap = {};
  for (const k of ['likes', 'favorites', 'badStreams']) {
    if (b[k] && typeof b[k] === 'object') snap[k] = b[k];
  }
  if (b.profile && typeof b.profile === 'object' && Object.keys(b.profile).length) {
    snap.profile = {};
    if (typeof b.profile.nickname === 'string') snap.profile.nickname = b.profile.nickname.slice(0, 40);
    /* 头像是一段 dataURL。超过 1.5MB 的直接不收（客户端已经压过一轮，再大就是异常数据） */
    if (typeof b.profile.avatar === 'string' && b.profile.avatar.length <= 1.5e6) {
      snap.profile.avatar = b.profile.avatar;
    }
    /* 🔴 昵称/头像也得带时间戳，否则「谁后同步谁赢」：
       设备 A 先改名，设备 B 后同步时带着**自己的旧名字**上来，就把 A 改的盖回去了
       （2026-09-20 实测到：B 改的名字被 A 的一次普通同步冲掉）。
       前端只在**确实改过**时才带 nickname/avatar，所以这里 t 缺省 0 = 「不参与竞争」。 */
    snap.profile.t = Number(b.profile.t) || 0;
  }
  if (b.sources && typeof b.sources === 'object') {
    const s = b.sources;
    snap.sources = {};
    for (const k of ['dirs', 'skipDirs', 'strmJobs']) {
      if (Array.isArray(s[k])) snap.sources[k] = s[k].map((x) => String(x)).slice(0, 500);
    }
    if (typeof s.strmIntervalH === 'number') {
      snap.sources.strmIntervalH = Math.max(0, Math.min(168, s.strmIntervalH));
    }
    // .strm 体积阈值（2026-09-22）：跟 strmIntervalH 同一套白名单/夹取写法
    if (typeof s.strmMinSizeMB === 'number') {
      snap.sources.strmMinSizeMB = Math.max(0, Math.min(102400, Math.floor(s.strmMinSizeMB)));
    }
  }
  return snap;
}

/** /api/auth/* 与 /api/sync/* 的全部实现 */
async function handleSync(req, res, u) {
  const p = u.pathname;
  if (req.method === 'OPTIONS') return sendCorsJson(res, 204, {});

  /* ------------------------------ 注册 / 登录 ------------------------------ */
  if (p === '/api/auth/register' || p === '/api/auth/login') {
    if (req.method !== 'POST') return sendCorsJson(res, 405, { ok: false, error: 'method' });
    const body = await readBody(req);
    const name = String(body.user || '').trim();
    const pass = String(body.pass || '');
    if (!name || !pass) return sendCorsJson(res, 400, { ok: false, error: '账号和密码都要填' });
    const isReg = p.endsWith('register');
    if (isReg && !SYNC_ALLOW_REGISTER) {
      return sendCorsJson(res, 200, {
        ok: false,
        error: '这台服务器没有开放注册（已有账号可以直接登录）',
      });
    }
    const r = isReg ? syncRegister(name, pass) : syncLogin(name, pass);
    if (r.error) return sendCorsJson(res, 200, { ok: false, error: r.error });
    console.log(`[sync] ${p.endsWith('register') ? '注册' : '登录'}：${r.user}`);
    return sendCorsJson(res, 200, { ok: true, token: r.token, user: r.user });
  }

  const auth = syncAuth(req);
  if (!auth) return sendCorsJson(res, 401, { ok: false, error: '未登录或登录已过期' });

  if (p === '/api/auth/me') {
    return sendCorsJson(res, 200, { ok: true, user: auth.user });
  }
  if (p === '/api/auth/logout') {
    const db = syncDbLoad();
    delete db.tokens[auth.token];
    syncDbSave(db);
    return sendCorsJson(res, 200, { ok: true });
  }
  /* 改密码：顺手把该账号的所有 token 作废（别的地方还挂着旧 token 是最常见的疏漏） */
  if (p === '/api/auth/pass') {
    if (req.method !== 'POST') return sendCorsJson(res, 405, { ok: false, error: 'method' });
    const body = await readBody(req);
    const db = syncDbLoad();
    const u0 = db.users[auth.user];
    if (!u0 || syncHash(String(body.old || ''), u0.salt) !== u0.hash) {
      return sendCorsJson(res, 200, { ok: false, error: '原密码不对' });
    }
    const np = String(body.pass || '');
    if (np.length < 4) return sendCorsJson(res, 200, { ok: false, error: '新密码至少 4 位' });
    u0.salt = crypto.randomBytes(16).toString('hex');
    u0.hash = syncHash(np, u0.salt);
    for (const [t, rec] of Object.entries(db.tokens)) if (rec.user === auth.user) delete db.tokens[t];
    syncDbSave(db);
    return sendCorsJson(res, 200, { ok: true });
  }

  /* ------------------------------ 拉取 ------------------------------ */
  if (p === '/api/sync/pull' && req.method === 'GET') {
    const d = syncDataLoad(auth.user);
    let zip = null;
    try {
      const st = fs.statSync(syncZipFile(auth.user));
      if (st.isFile()) zip = { has: true, bytes: st.size, at: Math.round(st.mtimeMs) };
    } catch (_) {}
    return sendCorsJson(res, 200, { ok: true, user: auth.user, data: d, strm: zip });
  }

  /* ------------------------------ 推送（合并） ------------------------------ */
  if (p === '/api/sync/push' && req.method === 'POST') {
    const buf = await readBodyRaw(req, SYNC_BODY_MAX);
    if (!buf) return sendCorsJson(res, 413, { ok: false, error: '同步内容太大' });
    let body = {};
    try { body = JSON.parse(buf.toString('utf8') || '{}'); } catch (_) {
      return sendCorsJson(res, 400, { ok: false, error: 'JSON 解析失败' });
    }
    const inc = syncSnapshotFromBody(body);
    const cur = syncDataLoad(auth.user);
    const out = { ...cur };

    for (const k of ['likes', 'favorites', 'badStreams']) {
      out[k] = syncPruneTomb(syncMergeMap(cur[k], inc[k]));
    }
    /* 昵称/头像按时间戳取新（和点赞收藏同一套规矩）：
       前端只在改过时才带 t，所以「没改过的设备同步」不会把别人改的盖回去。 */
    if (inc.profile && Object.keys(inc.profile).length) {
      const curT = Number((cur.profile || {}).t) || 0;
      const incT = Number(inc.profile.t) || 0;
      if (incT >= curT) out.profile = { ...(cur.profile || {}), ...inc.profile };
    }
    if (inc.sources) {
      const cs = cur.sources || {};
      const ns = { ...cs };
      /* 🔴 数组按**时间戳**取新的那份，不是并集（2026-09-21 修，与 sync-server.js 一致）。
         旧版 union 表达不了删除 → 「监控文件夹删了又被加回来」。
         详见 sync-server.js 里那段注释。 */
      for (const k of ['dirs', 'skipDirs', 'strmJobs']) {
        const t = Number(inc.sources[k + 'T']) || 0;
        const ct = Number(cs[k + 'T']) || 0;
        if (Array.isArray(inc.sources[k]) && t > ct) {
          ns[k] = inc.sources[k].map(String).slice(0, 500);
          ns[k + 'T'] = t;
        }
      }
      if (typeof inc.sources.strmIntervalH === 'number') {
        const t = Number(inc.sources.strmIntervalHT) || 0;
        const ct = Number(cs.strmIntervalHT) || 0;
        if (t > ct) {
          ns.strmIntervalH = Math.max(0, Math.min(168, inc.sources.strmIntervalH));
          ns.strmIntervalHT = t;
        }
      }
      // .strm 体积阈值（2026-09-22）：同上，按时间戳取新的那份
      if (typeof inc.sources.strmMinSizeMB === 'number') {
        const t = Number(inc.sources.strmMinSizeMBT) || 0;
        const ct = Number(cs.strmMinSizeMBT) || 0;
        if (t > ct) {
          ns.strmMinSizeMB = Math.max(0, Math.min(102400, Math.floor(inc.sources.strmMinSizeMB)));
          ns.strmMinSizeMBT = t;
        }
      }
      out.sources = ns;
    }
    syncDataSave(auth.user, out);
    /* 顺带把 strm 包信息一起回 —— 前端就不必为「远端有没有备份包」多跑一次 pull
       （换新机登录那条路要判断它，见 syncMaybePullStrm）。 */
    let zstat = null;
    try {
      const st = fs.statSync(syncZipFile(auth.user));
      if (st.isFile()) zstat = { has: true, bytes: st.size, at: Math.round(st.mtimeMs) };
    } catch (_) {}
    return sendCorsJson(res, 200, { ok: true, user: auth.user, data: out, strm: zstat });
  }

  /* ------------------------------ strm 备份包 ------------------------------ */
  if (p === '/api/sync/strm') {
    const f = syncZipFile(auth.user);
    if (req.method === 'GET') {
      try {
        const st = fs.statSync(f);
        if (!st.isFile() || !st.size) return sendCorsJson(res, 404, { ok: false, error: '账号里还没有 strm 备份' });
        res.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': st.size,
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'Content-Length',
        });
        return fs.createReadStream(f).pipe(res);
      } catch (_) {
        return sendCorsJson(res, 404, { ok: false, error: '账号里还没有 strm 备份' });
      }
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const buf = await readBodyRaw(req, SYNC_ZIP_MAX);
      if (!buf) return sendCorsJson(res, 413, { ok: false, error: '备份包太大' });
      /* 解包逻辑在 App 那侧（Java），server.js 不解析它 —— 这里只当一段不透明字节存着。
         但仍然校验一下 zip 魔数：存一个明显不是 zip 的东西进来，等新设备下载时才报错，
         那时候人已经在另一台设备上了，排查成本高得多。 */
      if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        return sendCorsJson(res, 400, { ok: false, error: '这不是一个 zip 备份包' });
      }
      try { fs.mkdirSync(SYNC_DIR, { recursive: true }); } catch (_) {}
      const tmp = f + '.part';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, f);
      console.log(`[sync] ${auth.user} 上传 strm 备份：${(buf.length / 1024 / 1024).toFixed(2)} MB`);
      return sendCorsJson(res, 200, { ok: true, bytes: buf.length });
    }
  }

  return sendCorsJson(res, 404, { ok: false, error: 'not found' });
}

/** 从「临时凭据 + 已保存配置」里凑出一份可用配置 */
function credOf(body) {
  const b = body || {};
  const cfg = { ...config };
  if (typeof b.url === 'string' && b.url.trim()) cfg.url = b.url.trim().replace(/\/+$/, '');
  if (typeof b.user === 'string') cfg.user = b.user;
  if (typeof b.pass === 'string' && b.pass.length) cfg.pass = b.pass;
  return cfg;
}

async function handleApi(req, res, u) {
  const q = u.searchParams;

  /* ------------------------------ 配置 ------------------------------ */
  if (u.pathname === '/api/config') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        config: { ...config, pass: '', versionName: PC_VERSION, versionCode: 0 },
        hasPass: !!config.pass,
        mode: config.url ? 'webdav' : 'demo',
        dir: effectiveDir(),
        ffmpeg: { ...ffTools(), ready: !!(ffTools().ffmpeg) },
        // 探时长靠 ffprobe，所以能力位跟 ffmpeg 一致（APK 版用系统解码器，恒为 true）
        probe: !!(ffTools().ffprobe || ffTools().ffmpeg),
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      let next = { ...config };
      for (const k of ['url', 'user', 'recursive', 'maxDepth', 'fit', 'nickname', 'ffmpegPath', 'decodeUrl']) {
        if (k in body) next[k] = body[k];
      }
      // （`playableOnly` 已废弃，migrateConfig 里统一丢掉 —— 见那边注释）
      // 解码服务地址：去掉尾部斜杠统一形状（不然 "…:8099" 和 "…:8099/" 会被当成两个值）。
      // 空串是合法值 —— 表示「不用远端转码」，这时 PC 版回落本地 ffmpeg、APK 版不转码。
      if (typeof next.decodeUrl === 'string') next.decodeUrl = next.decodeUrl.trim().replace(/\/+$/, '');
      if (typeof body.dir === 'string') next.dir = body.dir.trim() ? normSrcPath(body.dir) : '';
      // 片源文件夹可以整组替换；不传就保持原样（设置页只管地址账号，别把片源冲掉）
      if (Array.isArray(body.dirs)) next.dirs = normDirs(body.dirs);
      if (Array.isArray(body.skipDirs)) {
        next.skipDirs = [...new Set(body.skipDirs
          .filter((d) => typeof d === 'string' && d.trim()).map(normAbs))]
          .filter((d) => (next.dirs || []).includes(d));
      }
      if (typeof body.pass === 'string' && body.pass.length) next.pass = body.pass;
      if (body.clearPass) next.pass = '';
      const before = config;
      next = migrateConfig(next);
      config = next;
      writeJson(CONFIG_FILE, config);
      ffCache = null;                     // 路径可能改了，重新探测
      // 只有连接信息真的变了才作废缓存：
      // 单纯点一下「浏览 NAS 目录」不该把已经刷好的列表清空
      const sig = (c) => [c.url, c.user, c.pass, c.dir, (c.dirs || []).join('|')].join('\u0000');
      if (sig(before) !== sig(config)) resetLibrary();
      return sendJson(res, 200, {
        ok: true,
        config: { ...config, pass: '' },
        hasPass: !!config.pass,
        mode: config.url ? 'webdav' : 'demo',
        dir: effectiveDir(),
      });
    }
  }

  /* ------------------------ 浏览远端目录（逐层点进去） ------------------------ */
  if (u.pathname === '/api/browse' && (req.method === 'GET' || req.method === 'POST')) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const cfg = credOf(body);
    if (!cfg.url) return sendJson(res, 200, { ok: false, error: '还没填 WebDAV 服务地址' });

    const raw = (req.method === 'POST' ? (body.path || '') : (q.get('path') || ''));
    const target = raw ? normAbs(raw) : effectiveDir();
    try {
      const info = await listDir(cfg, target);
      return sendJson(res, 200, info);
    } catch (e) {
      /* 空路径的语义是「用配置里那个目录」。而那个目录可能已经在 NAS 上没了
       * （被删 / 改名 / 换了服务器）—— 2026-09-18 的真实场景。
       * 这时人会掉进一个**出不来的死循环**：列表报 404，页面给的「回到根目录」
       * 按钮也是空路径，一点又回到同一个 404，于是永远挑不了文件夹。
       * 自愈：退到挂载根目录再列一次，能列出来就照常返回，另附 healed 标记
       * 让前端提醒人重挑。（与 buildLibrary 的 staleRoots 兜底同一套思路，
       * 两个后端别分叉。） */
      if (!raw) {
        const root = mountRootOf(cfg);
        if (root !== target) {
          try {
            const info = await listDir(cfg, root);
            info.healed = true;
            info.stalePath = target;
            info.staleMsg = '之前设的文件夹已经打不开了，已回到根目录，重新挑一个吧。';
            console.warn('[browse] 配置目录失效，已回退根目录', target, '→', root);
            return sendJson(res, 200, info);
          } catch (e2) {
            console.warn('[browse] 根目录兜底也失败', e2.message);
          }
        }
      }
      return sendJson(res, 200, {
        ok: false,
        path: target,
        crumbs: crumbsOf(target),
        error: e.message,
      });
    }
  }

  /* -------------------- 数一数每个子文件夹里有多少视频 -------------------- */
  // 单独一个接口：列表先渲染出来，数量随后异步补，不拖慢浏览
  if (u.pathname === '/api/counts' && (req.method === 'GET' || req.method === 'POST')) {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const cfg = credOf(body);
    let paths = req.method === 'POST' ? (body.paths || []) : (q.get('paths') || '').split(',').filter(Boolean);
    if (!Array.isArray(paths)) paths = [];
    paths = paths.slice(0, 24).map(normAbs);
    if (!cfg.url || !paths.length) return sendJson(res, 200, { ok: true, counts: {} });

    const nums = await mapLimit(paths, 4, (p) =>
      countVideos(cfg, p).then((n) => [p, n]).catch(() => [p, null])
    );
    const counts = {};
    for (const [p, n] of nums) counts[p] = n;
    return sendJson(res, 200, { ok: true, counts });
  }

  /* ------------------------------ 测试连接 ------------------------------ */
  if (u.pathname === '/api/test' && req.method === 'POST') {
    const body = await readBody(req);
    const cfg = credOf(body);
    if (!cfg.url) return sendJson(res, 200, { ok: false, error: '请先填写服务地址，例如 http://192.168.1.100:5005' });
    /* 登录（两步流程第 1 步）会显式传 dir=''，意思是「只验账号密码，别拿配置里
     * 那个可能已失效的旧目录去试」。所以这里判的是 `dir in body` 而不是 truthy ——
     * 空串以前会被当成「没传」→ 回落 effectiveDir() → 拿已删的旧挂载去 PROPFIND
     * → 404 → 明明账号密码对，却报登录失败。（与 Java 版 handleTest 判据一致。） */
    /* 空 dir → 探服务根：优先用地址里那段路径（CD2 的 `/dav`），地址没带路径才是 `/`。
     * 用 mountRootOf 而不是就地写一遍表达式 —— 「登录探根」和「浏览兜底」必须是
     * 同一个概念，两处各写一份迟早会分叉。（与 Java 版 urlPath() 一致） */
    const rootDir = mountRootOf(cfg);
    const target = ('dir' in body)
      ? (body.dir ? normAbs(body.dir) : rootDir)
      : effectiveDir();
    try {
      const raw = await propfind(cfg, target, 1);
      // WebDAV 的 PROPFIND 会把「被请求的目录自身」也返回，统计时要排掉
      const items = raw
        .map((i) => ({ ...i, rel: hrefToAbsPath(i.href) }))
        .filter((i) => i.rel !== normAbs(target));
      const dirs = items.filter((i) => i.isDir).length;
      const files = items.filter((i) => !i.isDir).length;
      /* 这里**故意**用 ALL_EXTS 而不是 BROWSER_EXTS：这是登录后那句
         「这个目录下有 N 个子文件夹、M 个视频」的**原始盘点**，说的是磁盘上真有什么。
         片库只列能播的（BROWSER_EXTS），所以这两个数字**本来就会不一样**，不是 bug。
         （与 Java 版 handleTest 里的 isVideoExt 一致，别单边改成 isBrowserExt。） */
      const vids = items.filter((i) => !i.isDir && ALL_EXTS.includes(extOf(i.rel))).length;
      const names = items.map((i) => baseNameOf(i.rel)).filter(Boolean).slice(0, 8);
      return sendJson(res, 200, { ok: true, path: target, dirs, files, vids, entries: names });
    } catch (e) {
      return sendJson(res, 200, { ok: false, error: e.message });
    }
  }

  /* ------------------------------ 演示素材 ------------------------------ */
  /* ------------------------ 探测编码/时长（转码用） ------------------------ */
  if (u.pathname === '/api/probe' && req.method === 'GET') {
    const abs = normAbs(q.get('p') || '');
    if (!abs || !ALL_EXTS.includes(extOf(abs))) return sendJson(res, 200, { ok: false, error: '路径不对' });
    if (!config.url) return sendJson(res, 200, { ok: false, error: '未配置 WebDAV' });
    const r = await probeFile(abs, q.get('fresh') === '1');
    return sendJson(res, 200, r);
  }

  if (u.pathname === '/api/demo') {
    return sendJson(res, 200, { videos: demoVideos(), scannedAt: Date.now(), source: 'demo' });
  }

  /* ---------------- 解码服务能力（设置页「测试解码服务」按钮） ----------------
   * 前端不自己去连那个地址，是因为解码服务和本机服务**不同源**，会被 CORS 挡掉；
   * 由这里代连一次，前端只问本机。字段和 decode-server 的 /api/caps 对齐。
   * ⚠️ Java 版（android/src/com/nas/douyin/NasServer.java 的 handleCaps）要实现同样一份，
   *    两边字段口径必须一致 —— 详见仓库 README 里「两套后端」那一节。
   */
  if (u.pathname === '/api/caps' && req.method === 'GET') {
    const base = String(config.decodeUrl || '').trim().replace(/\/+$/, '');
    if (!base) {
      return sendJson(res, 200, {
        ok: false, configured: false, canTranscode: false,
        error: '没有配置解码服务地址',
        message: '留空表示不做转码，只能播 mp4 / mov / webm',
      });
    }
    const out = { ok: false, configured: true, url: base, canTranscode: false };
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      let r;
      try {
        r = await fetch(base + '/api/caps', { signal: ctrl.signal });
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        out.error = '解码服务返回 HTTP ' + r.status;
        return sendJson(res, 200, out);
      }
      const caps = await r.json().catch(() => null);
      if (!caps) {
        out.error = '解码服务返回的不是 JSON';
        return sendJson(res, 200, out);
      }
      const mine = caps.service === 'douyin-nas-decode';
      out.service = caps.service || '';
      out.canTranscode = !!caps.canTranscode;
      if (caps.encoder) out.encoder = caps.encoder;
      if (caps.hardware != null) out.hardware = !!caps.hardware;
      if (caps.version) out.version = caps.version;
      if (caps.paceRate) out.paceRate = caps.paceRate;
      out.ok = mine && out.canTranscode;
      if (!mine) {
        out.error = '这个地址上的服务不是 douyin-nas-decode（service='
          + (caps.service || '缺字段') + '），是不是端口填错了？';
      } else if (!out.canTranscode) {
        out.error = '解码服务在跑，但它没有可用的 ffmpeg（canTranscode=false）';
      }
      return sendJson(res, 200, out);
    } catch (e) {
      out.error = '连不上 ' + base + '：' + (e && e.message ? e.message : e);
      return sendJson(res, 200, out);
    }
  }

  /* -------------------- 片源文件夹（首页刷哪几个目录） -------------------- */
  if (u.pathname === '/api/sources' && req.method === 'POST') {
    const body = await readBody(req);
    if (!config.url) return sendJson(res, 200, { ok: false, error: '还没填 WebDAV 服务地址' });
    if (Array.isArray(body.dirs)) config.dirs = normDirs(body.dirs);
    if (typeof body.recursive === 'boolean') config.recursive = body.recursive;
    /* 🔒「不重扫」的文件夹。只保留**仍在片源里**的项，并顺手去重。 */
    if (Array.isArray(body.skipDirs)) {
      const cur = normDirs(config.dirs);
      config.skipDirs = [...new Set(body.skipDirs
        .filter((d) => typeof d === 'string' && d.trim())
        .map(normAbs))].filter((d) => cur.includes(d));
    }
    if (config.dirs.length) config.dir = config.dirs[0];
    writeJson(CONFIG_FILE, config);

    /* 🔴 立刻回话，扫描丢后台 —— 这是 2026-09-18「添加/移除文件夹反应太慢」的修复。
     *
     * 以前这里是 `await buildLibrary(config.dirs)`：同步扫完才回。
     * 加一个 498 个视频的文件夹要 12~40 秒，界面全程卡在「正在扫描片源…」的转圈上 ——
     * 用户点一下「＋ 加入」等半分钟没动静，只能以为坏了。
     *
     * 但项目里**早就有一套**「先给旧数据撑住界面、后台慢慢扫、扫完通知前端换」的机制：
     * kickBackgroundScan + GET /api/library?peek=1 + 前端 watchLibraryRefresh()。
     * 缓存过期那条路一直在用它，只有这里没接上。现在接上。
     *
     * 所以：配置写盘 → 起后台扫描 → 马上回「配置已生效、片库还在扫」（pendingScan:true）。
     * 前端拿到后立刻更新片源栏，再靠 peek 轮询等结果，扫完自动换上并提示。
     *
     * ⚠️ 这里**刻意不动内存里的 library**：让它保持旧数据撑着界面（stale-while-revalidate），
     *    别让首页在扫描期间闪成「一条都没有」。旧的 cachedSig 与新配置对不上，
     *    自然就不算「可用缓存」，不会脏读。
     * ⚠️ 也别 clearLibraryCache()：扫挂了还得靠旧缓存兜底，而且磁盘那份带的是旧 sig，
     *    启动时 loadLibraryCache 自己会判掉。 */
    if (!config.dirs.length) {
      // 片源被清空：没什么可扫的，直接把片库清干净。
      // 这一路必须**同步**给结果，否则旧的视频会一直挂在首页上。
      library = { videos: [], scannedAt: Date.now(), source: 'webdav', dirs: [], dir: '' };
      cachedSig = libSig();
      libError = '';
      libVersion++;
      clearLibraryCache();
      return sendJson(res, 200, { ok: true, config: { ...config, pass: '' }, ...libPayload() });
    }

    kickBackgroundScan();
    return sendJson(res, 200, {
      ...libPayload(),
      ok: true,
      config: { ...config, pass: '' },
      /* dirs/dir 放在 libPayload() 之后：它展开的是**旧片库**的 dirs，
       * 而片源栏（renderSrcList / hasSrc）读的是这里。顺序反了就会显示上一套片源。 */
      dirs: config.dirs,
      dir: config.dirs[0],
      /* 只在**确实有一轮扫描在跑**时才说 pending —— 万一它已经结束了（配置其实没变，
       * 复用的那轮扫描刚好提交完），前端就该照常 applyLibrary，而不是傻等一个
       * 永远不会来的 peek 通知。 */
      pendingScan: !!scanning,
    });
  }

  /* ------------------------------ 视频列表 ------------------------------ */
  if (u.pathname === '/api/library') {
    const refresh = q.get('refresh') === '1';
    const peek = q.get('peek') === '1';
    const dir = q.get('dir') || '';
    const rec = q.get('recursive');
    if (rec === '0' || rec === '1') config.recursive = rec === '1';

    if (dir) {
      // 「只刷这个文件夹」= 把片源换成它一个并记住，下次打开还是它
      config.dirs = [normAbs(dir)];
      config.dir = normAbs(dir);
      writeJson(CONFIG_FILE, config);
      resetLibrary();
    }

    /* 前端轮询用：只回报「片库有没有变」，后台扫完就让它自己换上新内容 */
    if (peek) {
      const v = Number(q.get('v') || -1);
      const changed = v !== libVersion;
      return sendJson(res, 200, {
        ok: true, version: libVersion, changed,
        count: library.videos.length, scanning: !!scanning,
        ...(changed ? libPayload() : {}),
      });
    }

    const sig = libSig();
    const usable = library.videos.length > 0 && cachedSig === sig;
    const fresh = usable && Date.now() - (library.scannedAt || 0) < CACHE_TTL_MS;

    try {
      if (refresh) {
        /* 🔴 2026-09-18：深扫（不限深度）实测 **13 分钟**（549 → 5496 个视频）。
         *    以前这里会 `await` 一路扫描，HTTP 请求挂十几分钟才回，看着跟死机一样。
         *    改成和 Java 版（NasServer.handleLibrary）一致：
         *    **立刻回话 + 后台扫**，前端靠 ?peek=1 轮询扫完自动换上。
         *
         *    ⚠️ 顺带修掉一个老 bug：以前只有 `scanning` 为真时才等，
         *    否则走到 `cachedSig !== libSig()` —— 配置没变时这个判断**恒为 false**，
         *    于是 PC 版点「重新扫描」**根本没扫**，直接把旧缓存还回去了。
         *
         *    kickBackgroundScan() 自带单飞（已在跑就复用那一路），不用自己判 scanning。
         *    ⚠️ 手上这份是旧片库：带 `pendingScan`，前端就不会拿它去 applyLibrary。 */
        kickBackgroundScan();
        return sendJson(res, 200, {
          ...libPayload(),
          cached: true,
          stale: true,
          scanning: !!scanning,
          pendingScan: !!scanning,
        });
      } else if (!usable) {
        // 没缓存 / 配置变了：老老实实扫一遍
        library = await buildLibrary();
        cachedSig = libSig();
        libError = '';
        libVersion++;
        saveLibraryCache();
      } else if (!fresh) {
        // 缓存过期：先把旧列表还给前端（秒开），新增内容后台慢慢扫，扫完让前端自己换
        kickBackgroundScan();
      }
    } catch (e) {
      // 扫描失败（NAS 掉线 / 端口不对 / 密码错）时返回结构化错误，
      // 让前端能给出人话提示，而不是把 500 纯文本塞进 JSON.parse 里炸掉
      return sendJson(res, 200, {
        videos: [], scannedAt: Date.now(), source: config.url ? 'webdav' : 'demo',
        demo: !config.url, configReady: !!config.url, error: e.message,
      });
    }
    return sendJson(res, 200, libPayload());
  }

  /* --------------------------- 点赞 / 收藏 --------------------------- */
  if (u.pathname === '/api/state') {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        likes: state.likes || {},
        favorites: state.favorites || {},
        badStreams: state.badStreams || {},
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const { type, id, on } = body || {};
      if (!id) return sendJson(res, 400, { ok: false, error: 'missing id' });
      if (type !== 'like' && type !== 'favorite' && type !== 'badstream') {
        return sendJson(res, 400, { ok: false, error: 'unknown type' });
      }
      // 坏码流名单：前端检测出某片解码持续丢帧就登记，所有设备之后直接走重编码
      if (type === 'badstream') {
        if (!state.badStreams) state.badStreams = {};
        if (on === false) delete state.badStreams[id];
        else state.badStreams[id] = { t: Date.now() };
        saveStateSoon();
        return sendJson(res, 200, { ok: true, state: { badStreams: state.badStreams } });
      }
      const bag = type === 'like' ? 'likes' : 'favorites';
      if (!state[bag]) state[bag] = {};
      if (on === false) delete state[bag][id];
      else state[bag][id] = { t: Date.now() };
      saveStateSoon();
      return sendJson(res, 200, {
        ok: true,
        state: { likes: state.likes || {}, favorites: state.favorites || {} },
      });
    }
  }

  /* 整体写回三份名单（多设备同步专用，见 public/js/app.js 里 syncApply 的注释）。
     语义是**整体替换**，不是合并 —— 调用方手里已经是合并后的权威结果。
     Java 版 NasServer.handleStateBulk 是同一套接口，两边别单边改。 */
  if (u.pathname === '/api/state/bulk' && req.method === 'POST') {
    const body = await readBody(req);
    let n = 0;
    for (const k of ['likes', 'favorites', 'badStreams']) {
      const v = body && body[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) { state[k] = v; n++; }
    }
    if (!n) return sendJson(res, 400, { ok: false, error: '三个名单一个都没带' });
    saveStateSoon();
    return sendJson(res, 200, { ok: true, n });
  }

  return sendJson(res, 404, { ok: false, error: 'not found' });
}

/** 给扫描出来的视频补上「所属文件夹 / 标题 / 作者名」 */
function decorate(v) {
  const folder = folderOf(v.p);
  const base = v.name.replace(/\.[^.]+$/, '');
  return {
    ...v,
    folder,
    author: folder.length > 12 ? folder.slice(0, 12) : folder,
    title: base,
  };
}

/**
 * 上一份片库里**属于某个目录**的视频（供「不重扫」的文件夹直接复用）。
 * ⚠️ 判前缀必须带 `/`：`/dav/示例片源2` 不能被当成 `/dav/示例片源` 的子项。
 */
function cachedVideosOfDir(dir) {
  const d = normAbs(dir);
  const list = (library && Array.isArray(library.videos)) ? library.videos : [];
  return list.filter((v) => v.p === d || String(v.p).startsWith(d + '/'));
}

/**
 * 认证/限流类错误判定（与 Java 版 NasServer.isAuthOrLimitError 同一套判据）。
 *
 * 为什么必须认出来并**立刻放弃整轮**：WebDAV 侧的登录限流是「越撞越久」的 ——
 * 密码不对时每失败一次就把锁定时间续上，接着试下一个目录、再回退根目录撞一遍，
 * 几秒就能把锁打满，连管理页都进不去，而且越重启越锁。
 *
 * 判据：DavClient 抛的是 `Error("WebDAV " + code + ...)`。
 * 403 也一起算（云盘类 WebDAV 会把「token 过期」报成 403）。
 */
function isAuthOrLimitError(msg) {
  if (!msg) return false;
  const s = String(msg);
  return s.includes('WebDAV 401') || s.includes('WebDAV 403') || s.includes('WebDAV 429');
}

/**
 * 当前 WebDAV 配置是否指向**本机 CD2 引擎**（127.0.0.1/localhost/::1 + 19798）。
 *
 * PC 版一般连的是别的机器，但用户完全可能在同一台电脑上跑 CD2 再让本服务去连
 * —— 那时 401 的归因和 Java 版一样分成两种（见 buildLibrary 的 authFailed 分支）。
 * 端口与 Java 版 MainActivity.CD2_PORT 保持一致。 */
function isLocalCd2Dav() {
  try {
    const u = new URL(config.url);
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
    return local && Number(u.port || 80) === 19798;
  } catch (_) {
    return false;
  }
}

/**
 * 扫出首页那份片库。
 * 片源可以有好几个文件夹，这里逐个扫完合并；某一个读不到（被删/改名/掉线）只记一笔，
 * 不能让整个片库跟着挂掉 —— 否则用户多加了三个文件夹，坏一个就全黑。
 */
async function buildLibrary(dirsOverride) {
  if (!config.url) {
    return { videos: demoVideos(), scannedAt: Date.now(), source: 'demo' };
  }
  const roots = (Array.isArray(dirsOverride) && dirsOverride.length
    ? normDirs(dirsOverride)
    : sourceDirs()).map(normAbs);
  const t0 = Date.now();
  const seen = new Set();
  const videos = [];
  const errors = [];
  let truncated = false;
  let staleRoots = false;
  /* 认证/限流类错误一出现就置位 → 立刻放弃整轮扫描（与 Java 版 doScan 的 authFailed 对齐） */
  let authFailed = false;

  const skip = new Set((config.skipDirs || []).map(normAbs));
  for (const root of roots) {
    /* 🔒 「不重扫」的文件夹：跳过这次扫描，直接把上一份片库里属于它的视频搬过来。
     *    ⚠️ 只在**缓存里确实有它的视频**时才跳过 —— 一次都没扫过（新装的、缓存被清了）
     *    就必须照常扫一遍，否则用户标完发现这个文件夹一条都没有，只会以为坏了。
     *    想强制重扫它有现成入口：片源栏那个「只刷它」。 */
    if (skip.has(root)) {
      const old = cachedVideosOfDir(root);
      if (old.length) {
        for (const v of old) {
          if (seen.has(v.p)) continue;
          seen.add(v.p);
          videos.push(v);
        }
        console.log(`[scan] 跳过「不重扫」的 ${root}，复用上次 ${old.length} 个视频`);
        continue;
      }
      console.log(`[scan] ${root} 标了「不重扫」但片库里没有它 —— 首次照扫一次`);
    }
    try {
      const list = await scanLibrary(config, root);
      if (scanTruncated) truncated = true;
      for (const v of list) {
        if (seen.has(v.p)) continue;      // 片源互相包含（比如同时加了父目录和子目录）时去重
        seen.add(v.p);
        videos.push(decorate(v));
      }
    } catch (e) {
      console.warn('[scan] 片源读不到，跳过', root, e.message);
      errors.push({ dir: root, error: e.message });
      /* 🔴 认证/限流类错误**立刻放弃整轮**（与 Java 版 doScan 的 authFailed 对齐）：
       * 接着试下一个目录、甚至回退根目录再撞一遍，只会把登录锁越锁越久。
       * 2026-09-20 补齐 —— 此前只有 Java 版有这个判定，PC 版会白撞一次根目录，
       * 还把原始「WebDAV 401」甩给用户。 */
      if (isAuthOrLimitError(e.message)) { authFailed = true; break; }
    }
  }
  /* 配置里的目录**全部**读不到 —— 多半是那些文件夹在 NAS 上已经没了（被删/改名），
   * 而人又删不掉那条旧配置，于是每次扫描都整体失败、App 永久卡死。
   * 这里自愈：退到根目录再试一次，能扫到就照常返回，只是额外提醒人去重挑文件夹。
   * （与 Java 版 doScan 的行为保持一致，两个后端别分叉。）
   * ⚠️ authFailed 时不兜底：那是密码/限流问题，换路径再试一次纯属白撞。 */
  let rootProbed = false;
  if (!videos.length && errors.length && !authFailed) {
    try {
      const list = await scanLibrary(config, '/');
      rootProbed = true;                    // 根目录探过了（成不成功都算探过）
      if (list.length) {
        if (scanTruncated) truncated = true;
        for (const v of list) {
          if (seen.has(v.p)) continue;
          seen.add(v.p);
          videos.push(decorate(v));
        }
        staleRoots = true;
        console.warn('[scan] 配置目录全部失效，已回退根目录兜底，扫到', list.length, '个');
      }
    } catch (e2) {
      console.warn('[scan] 根目录兜底也失败', e2.message);
    }
  }
  /* 仍然一条都没有 —— 这时**别把原始 404 直接甩给用户**。
   * 他要的不是「WebDAV 返回 404」，而是「我该怎么办」。
   * 判据：配置目录读不到 && 根目录探过（说明是路径问题，不是连不上/没权限）。 */
  if (!videos.length && errors.length) {
    if (authFailed) {
      /* 认证/限流：别把「WebDAV 429」原文甩给用户，说清「哪儿出的问题 + 去哪儿改」。
       * 🔴 2026-09-20 与 Java 版对齐：连本机内置引擎时，401 十有八九是
       *    **引擎里还没登录 CD2 账号**（WebDAV 凭据 = CD2 账号），此时密码是对的，
       *    让人重填密码只会打转 —— 要指去第 1 步「打开 CloudDrive2 管理」。 */
      const e = new Error(isLocalCd2Dav()
        ? '内置网盘的 WebDAV 拒绝了这个账号 —— 最常见的原因是内置引擎里还没登录 CD2 账号'
          + '（或登录已过期）。先回「我的 → 数据源设置」第 1 步点「打开 CloudDrive2 管理」，'
          + '在管理页登录你的 CD2 账号并挂载网盘，再用同一组账号密码登录。'
        : 'WebDAV 账号或密码不对（或短时间内重试太多被暂时限流）。'
          + '去「我的 → 数据源设置」重新填密码并登录。');
      e.auth = true;
      if (isLocalCd2Dav()) e.engineLogin = true;
      e.cause = errors[0].error;
      throw e;
    }
    if (rootProbed) {
      const e = new Error('片源文件夹已经打不开了（可能被删或改名）。'
        + '去「设置」重新登录，再挑一个文件夹。');
      e.stale = true;
      e.cause = errors[0].error;
      throw e;
    }
    throw new Error(errors[0].error);
  }

  videos.sort((a, b) => a.p.localeCompare(b.p, 'zh-Hans-CN', { numeric: true }));
  return {
    videos, scannedAt: Date.now(), source: 'webdav',
    /* 🔴 dirs/dir 必须是**用户配置的片源**，不是「本轮实际扫了什么」（roots）——
       两者只在正常情况下才相等：片源为空时 roots 是兜底的根目录，配置目录在 NAS 上
       全失效时（staleRoots）roots 会退成 ['/']。这个字段会被前端 applyLibrary 同步进
       S.config.dirs，回错了就表现成「重启几次后根目录自己出现在片源里」。
       （Java 版 NasServer.doScan 是同一处修复，两边判据别单边改。） */
    dirs: config.dirs, dir: config.dirs[0] || '',
    truncated, elapsedMs: Date.now() - t0,
    errors: errors.length ? errors : undefined,
    staleRoots: staleRoots || undefined,
    staleMsg: staleRoots
      ? '之前设的文件夹已经打不开了（可能被删或改名），已临时从根目录开始扫。去「设置」重新登录并挑一个文件夹。'
      : undefined,
  };
}

/** 给前端的片库响应：附上缓存年龄，界面好显示「上次扫描时间 / 下次自动更新」 */function libPayload() {
  return {
    ...library,
    /* 🔴 dirs/dir 一律以**配置**为准，别信 library 里那份（2026-09-20）。
       library.dirs 是「那一轮扫描的目标」：片源为空时它是兜底的根目录、配置目录在 NAS 上
       全失效时会退成 ['/']，而且会被原样写进磁盘缓存、下次启动 loadLibraryCache 又读回来。
       前端 applyLibrary 会把这个字段同步进 S.config.dirs —— 回错了就表现成
       「重启几次后根目录自己出现在片源里」。
       与 Java 版 NasServer.putLiveSrc() 是同一处修复，两边判据别单边改。 */
    dirs: config.dirs,
    dir: config.dirs[0] || '',
    demo: library.source === 'demo',
    configReady: !!config.url,
    cached: !!library.cached,
    ageMs: library.scannedAt ? Date.now() - library.scannedAt : 0,
    ttlMs: CACHE_TTL_MS,
    scanning: !!scanning,
    version: libVersion,
    /* 后台扫描失败的原因。刻意**不叫 error** —— error 是「这份响应本身失败」的意思，
     * 而这里片库可能是好好的旧数据、只是重扫没成功。混用会让前端在
     * applySources 里误报「扫描失败」，也会让 loadLibrary 走错分支。
     * 前端只在 peek 轮询那条路上读它（见 watchLibraryRefresh）。 */
    ...(libError ? { scanError: libError } : {}),
  };
}

/* ==================== ffmpeg：转码播放浏览器放不了的封装 ==================== */
/**
 * 浏览器的 <video> 只会解 mp4 / mov / webm 这几种封装。
 * avi、wmv、flv、mkv、rmvb、ts 一律放不了 —— 这不是码率问题，是浏览器天生没有对应的解封装器，
 * 换播放器内核也没用（除非装插件）。所以只能由服务端转一道。
 *
 * 这里做的是「边转边播」：ffmpeg 直接把 fragmented MP4 吐到 stdout，我们原样转给浏览器，
 * 不落盘、不等整段转完，点开就能看。能 -c copy 的就只换封装（几乎不吃 CPU）。
 */

const FF_EXE = process.platform === 'win32' ? '.exe' : '';
let ffCache = null;

function isFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } }

/** 依次找：设置里填的路径 → 环境变量 → 项目 bin/ → PATH */
function findTool(name) {
  const custom = String(config.ffmpegPath || '').trim();
  if (custom) {
    if (isFile(custom)) return path.join(path.dirname(custom), name + FF_EXE);
    const inDir = path.join(custom, name + FF_EXE);
    if (isFile(inDir)) return inDir;
  }
  const envPath = name === 'ffmpeg' ? process.env.FFMPEG_PATH : process.env.FFPROBE_PATH;
  if (isFile(envPath)) return envPath;
  const local = path.join(ROOT, 'bin', name + FF_EXE);
  if (isFile(local)) return local;
  for (const d of String(process.env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const hit = path.join(d, name + FF_EXE);
    if (isFile(hit)) return hit;
  }
  return '';
}

function ffTools() {
  if (!ffCache) {
    const ffmpeg = findTool('ffmpeg');
    const ffprobe = findTool('ffprobe');
    ffCache = { ffmpeg, ffprobe, ready: !!(ffmpeg && ffprobe) };
  }
  return ffCache;
}

// 硬件 H.264 编码器探测：软编 libx264 吃满 CPU（快进时最明显），
// 有独立显卡（NVIDIA/Intel 核显/AMD）就用硬件编码芯片，CPU 几乎为零。
// 探测结果缓存一次；即使 ffmpeg 编译进了 nvenc，机器上没有对应 GPU 时，
// 起转会立刻失败 —— 所以实际用哪个，仍以「跑得起来」为准（见 pickVideoEncoder）。
let hwEncCache = null;
function detectHwEncoder() {
  if (hwEncCache) return hwEncCache;
  const tools = ffTools();
  hwEncCache = null;
  if (!tools.ready) return null;
  try {
    const out = execFileSync(tools.ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8', env: childEnv() });
    // 按优先级：独显 NVENC > Intel 核显 QSV > AMD AMF。都得是「能编码」的（V 标记），
    // 有的 ffmpeg 编译进来但实际不可用（带 D 表示可解码但可能不能编码）。
    if (/h264_nvenc\b/.test(out)) return (hwEncCache = 'nvenc');
    if (/h264_qsv\b/.test(out)) return (hwEncCache = 'qsv');
    if (/h264_amf\b/.test(out)) return (hwEncCache = 'amf');
  } catch (_) { /* 探测失败就当没有 */ }
  return null;
}

// 按「能跑起来」选编码器：硬编优先，起转失败（无此 GPU 等）自动退回软编。
// 返回一个数组，是加到 ffmpeg 命令里的 `-c:v ...` 那一段。
let hwWorking = undefined;   // undefined=没试过 / true=硬编可用 / false=硬编坏了，以后别试
function pickVideoEncoder() {
  if (hwWorking === false) return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p'];
  const hw = detectHwEncoder();
  if (hw === 'nvenc') return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p'];
  if (hw === 'qsv')   return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'nv12'];
  if (hw === 'amf')   return ['-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '23', '-qp_p', '23', '-maxrate', '8M', '-bufsize', '16M'];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p'];
}

/** WebDAV 的 Basic 鉴权头：让 ffmpeg 自己去读远端，不必经我们二次转发 */
function davHeaders() {
  const h = [];
  if (config.user || config.pass) {
    h.push('Authorization: Basic ' + Buffer.from(config.user + ':' + config.pass).toString('base64'));
  }
  h.push('User-Agent: douyin-nas');
  return h.join('\r\n') + '\r\n';
}

function tailLine(s) {
  const l = String(s || '').trim().split(/\r?\n/).filter(Boolean);
  return l.length ? l[l.length - 1].slice(0, 300) : '';
}

/** 转码排障用：stderr 末尾多留几行，光看最后一行经常定位不了 */
function tailLines(s, n = 6) {
  const l = String(s || '').trim().split(/\r?\n/).filter(Boolean);
  return l.length ? l.slice(-n).join(' ┃ ').slice(0, 1200) : '';
}

/**
 * ffmpeg/ffprobe 子进程的环境变量。
 * ------------------------------------------------------------------
 * 坑：Node 启动时如果继承了 HTTP_PROXY / HTTPS_PROXY（公司终端、某些安全软件、
 * 或我们自己跑的代理会往里塞），ffmpeg 会「很听话」地把访问 NAS 的请求也丢给那个代理，
 * 代理不认识这个内网地址 → 直接吐 404 / 502。
 * 我们只是要读家里的 NAS，走代理没有任何意义，所以给子进程把代理相关变量全部摘掉。
 * NAS 地址本身可以通过 NO_PROXY 兜底，双保险。
 */
function childEnv() {
  const env = { ...process.env };
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
    delete env[k];
  }
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return env;
}

const probeCache = new Map();

/** ffprobe 读时长/编码/画面尺寸。结果缓存 —— 远端文件每探一次都是一次真实下载。
 *
 * ⚠️ 缓存里**必须**带上 width/height，不能只存时长：
 * 前端要把加载转圈对准视频画面矩形（`.vbox`，见 app.js 的 fitVideoBox），
 * 而转码流的 `video.videoWidth` 在 WebView 里**恒为 0** —— 我们把流转封成
 * `-movflags frag_keyframe+empty_moov+default_base_moof` 的 fragmented MP4
 * （为了首字节快），这种流的 moov 是空的、分辨率写在 moof 里，
 * WebView 能解码但从不回填 videoWidth。所以尺寸只能由这里代答。 */
function probeFile(abs, fresh) {
  const tools = ffTools();
  if (!tools.ready) return Promise.resolve({ ok: false, error: '没找到 ffmpeg / ffprobe' });
  if (!fresh && probeCache.has(abs)) return Promise.resolve(probeCache.get(abs));
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
      // 同样是为了少建连、少乱 seek：探测阶段慢，用户就会盯着黑屏等
      '-multiple_requests', '1', '-short_seek_size', '1000000',
      '-analyzeduration', '1000000', '-probesize', '1000000'];
    if (extOf(abs) === 'avi') args.push('-use_odml', '0');
    args.push('-headers', davHeaders(), davUrlAbs(config, abs, false));
    let p;
    try { p = spawn(tools.ffprobe, args, { windowsHide: true, env: childEnv() }); } catch (e) { return resolve({ ok: false, error: e.message }); }
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} }, 30000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000); });
    p.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve({ ok: false, error: tailLine(err) || ('ffprobe 退出码 ' + code) });
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((x) => x.codec_type === 'video') || {};
        const a = (j.streams || []).find((x) => x.codec_type === 'audio') || {};
        /* 竖屏手机拍的片会把宽高旋转 90° 存：ffprobe 报的是**存储**尺寸，
         * 显示时要交换。前端 fitVideoBox 用的是显示后的宽高比，所以这里先摆正。 */
        let w = v.width || 0, h = v.height || 0;
        const rot = Math.abs(Number((v.side_data_list && v.side_data_list[0] && v.side_data_list[0].rotation) || 0)) % 180;
        if (rot === 90 && w && h) { const t = w; w = h; h = t; }
        const r = {
          ok: true,
          duration: Number((j.format && j.format.duration) || v.duration || 0) || 0,
          vcodec: v.codec_name || '',
          acodec: a.codec_name || '',
          width: w,
          height: h,
          container: (j.format && j.format.format_name) || '',
        };
        probeCache.set(abs, r);          // ⚠️ 原来只读不写，等于每探一次都重新下载
        resolve(r);
      } catch (_) { resolve({ ok: false, error: 'ffprobe 的输出解析不了' }); }
    });
  });
}

/** 视频已是 H.264、音频已是 AAC/MP3 时只换封装，不重编码 */
function canRemux(info) {
  if (!info || !info.ok) return false;
  if (info.vcodec !== 'h264') return false;
  return !info.acodec || info.acodec === 'aac' || info.acodec === 'mp3';
}

/** 同一时刻每个文件只允许一路 ffmpeg：abs -> 子进程。
 *  拖进度条 = 新起一路 ffmpeg；旧的那路如果还占着云盘挂载的连接，
 *  两条一起啃同一个 6GB 文件会把挂载点拖崩（实测：并发时新流 0 字节直接断）。
 *  新请求来了先掐掉旧的，连接立刻腾出来。 */
const transJobs = new Map();

/** 转码/转封装成 fragmented MP4 流 */
/**
 * 把一路转码请求转发给 NAS 上的 Docker 解码服务，并把响应体原样流回来。
 *
 * 什么时候走这里：设置页填了「解码服务器地址」就优先走远端。
 * 为什么要有这条路：PC 版自己有 ffmpeg（下面那段就是），但**手机 APK 版没有** ——
 *   2026-09-18 把 APK 里 30MB 的内嵌 ffmpeg 删了，转码统一交给 NAS。
 *   两端共用同一个解码服务，行为才能一致（同一套编码器选择、同一个限速参数）。
 *
 * ⚠️ 不要把 config.url / DAV 凭据带过去：解码服务**自己**配了 WebDAV
 *    （见 decode-server/docker-compose.yml 的 DAV_URL/DAV_USER/DAV_PASS）。
 *    只发相对路径 p，让它自己去拼 —— 少一次凭据转发，也避免路径被拼两次。
 */
async function forwardTranscode(req, res, u, rel, base) {
  const qs = new URLSearchParams();
  qs.set('p', rel);
  // t/mode/h/q 是调参；src 是「绝对地址」旁路（不走 WebDAV 配置，主要给自测用）——
  // 漏了 src 的话，用绝对地址自测会变成「远端拼不出路径」而报错。
  for (const k of ['t', 'mode', 'h', 'q', 'src']) {
    const v = u.searchParams.get(k);
    if (v) qs.set(k, v);
  }
  const target = base.replace(/\/+$/, '') + '/api/transcode?' + qs.toString();

  const ctrl = new AbortController();
  const onClose = () => ctrl.abort();
  res.on('close', onClose);
  try {
    const r = await fetch(target, { signal: ctrl.signal });
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      console.log('[transcode] 远端失败', r.status, rel, detail.slice(0, 200));
      // ⚠️ 摘监听要用 off(name, fn)，**不能**用 on(name, null) ——
      //    Node 会抛 'The "listener" argument must be of type function. Received null'，
      //    而且是在这个 try 里抛、被下面的 catch 接走，表现成
      //    「转发解码服务失败: The "listener" argument ...」—— 一个假的转发失败，
      //    真正的错误（远端 4xx）反而被盖掉了。实测踩到过。
      res.off('close', onClose);
      return sendJson(res, r.status >= 400 ? r.status : 502, {
        ok: false,
        error: '解码服务返回 ' + r.status + (detail ? '：' + detail.slice(0, 200) : ''),
      });
    }
    const out = {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
    };
    // 先把远端的 X-Transcode* 抄过来。远端没带 X-Transcode 时才写兜底 "1"
    // （前端的转码分支靠它认流，缺了整个 seek 逻辑就走错分支）。
    //
    // ⚠️ 兜底**不能**先写进 out 再让远端覆盖 —— Node 的 writeHead 遇到同名头会把
    //    值用 ", " 拼起来，于是响应里出现 `X-Transcode: 1, remux`。
    //    实测踩到过：前端拿 "1, remux" 去比较 `=== 'remux'` 永远不成立。
    for (const h of ['x-transcode', 'x-transcode-encoder', 'x-transcode-start', 'x-transcode-hardware']) {
      const v = r.headers.get(h);
      if (v) out[h.replace(/^x-/, 'X-')] = v;
    }
    if (!out['X-Transcode']) out['X-Transcode'] = '1';
    res.writeHead(200, out);
    console.log('[transcode] 转发远端 =', target);
    for await (const chunk of r.body) {
      if (!res.write(chunk)) await new Promise((ok) => res.once('drain', ok));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: '转发解码服务失败: ' + (e && e.message ? e.message : e) });
    } else {
      try { res.end(); } catch (_) {}
    }
  } finally {
    // ⚠️ 同样必须用 off(name, fn)，不能用 on(name, null)（会抛 TypeError）。
    //    这里如果写错，正常成功的转发也会在 finally 里抛 —— 而响应已经发出去了，
    //    于是变成一个「看起来成功、日志里却有异常」的诡异状态，极难排查。
    res.off('close', onClose);
  }
}

async function handleTranscode(req, res, u) {
  const rel = u.searchParams.get('p');
  if (!rel) return sendText(res, 400, 'missing p');

  // 配了解码服务就优先走它 —— 手机 / PC 用同一套转码实现，行为一致。
  // 连不上就**回落到本地 ffmpeg**（PC 上一般有），而不是直接报错：
  // 用户填的地址可能是随手填错的，不该因此把本来能用的 PC 版弄瘫。
  const remote = String(config.decodeUrl || '').trim().replace(/\/+$/, '');
  if (remote) return await forwardTranscode(req, res, u, rel, remote);

  const tools = ffTools();
  if (!tools.ready) {
    return sendJson(res, 501, {
      ok: false,
      error: '这台机器上没有 ffmpeg，所以转不了码。'
        + '要么在设置页填上 NAS 上解码服务的地址（http://NAS的IP:8099），'
        + '要么把 ffmpeg 放进 douyin-nas/bin/。',
    });
  }
  if (!config.url) return sendText(res, 400, '未配置 WebDAV');
  const abs = normAbs(rel);
  if (!ALL_EXTS.includes(extOf(abs))) return sendText(res, 403, 'not a video');

  const start = Math.max(0, Number(u.searchParams.get('t') || 0) || 0);
  const mode = u.searchParams.get('mode') || 'auto';     // auto | copy | encode
  // 探测一个几 GB 的远程文件要 3~4 秒（实测冷启动首字节 6.9s vs 缓存后 3.1s）。
  // 只有 auto 才需要它来判断「能重封装还是必须重编码」；前端对已知要重编码的片
  // （坏码流 / 用户快进）会明确传 mode=encode，这时直接跳过，快进少等一大截。
  const info = mode === 'auto' ? await probeFile(abs) : { ok: false };
  const copy = mode === 'copy' || (mode === 'auto' && canRemux(info));

  const args = ['-hide_banner', '-loglevel', 'error',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    // 云盘挂载（115 / 各类 WebDAV）偶尔会中途断一下或回个 5xx：
    // 默认行为是 ffmpeg 直接退出 → 整条流断掉 → 前端报「播放错误」。
    // 让它自己重连，这种瞬时抖动就翻不起浪。
    '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '5xx',
    '-rw_timeout', '20000000',
    // ↓ 这两条是「开画慢」的关键，实测能把首字节压掉一半以上
    //   multiple_requests：让 ffmpeg 复用同一条 TCP 连接。
    //     不开的话它每 seek 一次就重连一次，而 NAS / 云盘挂载建连一次要好几秒。
    //   short_seek_size：跨度过小时宁可顺序多读一点，也别断开重连去 seek。
    //     局域网下多读 1MB 只要几十毫秒，比重新建连便宜得多。
    '-multiple_requests', '1',
    '-short_seek_size', '1000000'];
  // AVI 的 OpenDML 超级索引压在文件末尾，ffmpeg 默认会跑去读它，
  // 在云盘挂载上等于绕一大圈（实测多花 3~5 秒）。关掉后靠顺序扫描就能正常解，
  // 首字节从 8s 降到 4s 左右。注意：这是 AVI 专属参数，喂给别的封装会让 ffmpeg 直接报错退出。
  if (extOf(abs) === 'avi') args.push('-use_odml', '0');
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-headers', davHeaders(), '-i', davUrlAbs(config, abs, false));
  if (copy) {
    args.push('-c', 'copy');
  } else {
    // maxrate/bufsize：CRF 在打斗 / 噪点这类高动态片段会把码率顶得很高（这条链路上
    // 最终是手机走 Wi-Fi 来收，带宽是稀缺资源），封顶 8Mbps 当安全阀。
    // 编码器用 pickVideoEncoder()：优先硬件编码（NVENC/QSV/AMF），
    // 否则 libx264 软编。硬编几乎不吃 CPU（软编快进时会吃满所有核）。
    const enc = pickVideoEncoder();
    console.log('[transcode] 编码器 =', enc[1], '|', path.basename(abs), 't=' + start);
    args.push(...enc,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }
  // frag_duration：除了「遇关键帧」，再兜一条「每 1 秒至少切一片」，
  // 保证快进后第一个分片尽快落地（首字节实测能省 1~2 秒）。
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1');

  // 同一文件上一路还在跑就先掐掉，别让它继续占着云盘连接
  const prev = transJobs.get(abs);
  if (prev) { try { prev.kill(); } catch (_) {} }

  let p = null;
  let err = '';
  let started = false;
  const kill = () => { try { p && p.kill(); } catch (_) {} };
  res.on('close', kill);

  // 转码速度（实测 5MB/s）远快于播放速度（1080p 约 1MB/s）。不限速的话，
  // 服务端几秒就把几十秒的内容灌进网络管道和播放器缓冲，后果有两个：
  //   · 局域网 / Wi-Fi 被撑爆（PC 还要同时从 NAS 拉数据，双向挤同一条无线）
  //   · 一快进，管道里堵着的「旧位置」数据得先排空才轮到新画面 → 用户看到的就是卡死
  // 所以按略高于播放速率的节奏匀速投递：起播先快灌一小段把缓冲填满，之后限速。
  // 注意：限速只是「上限」，稳态下实际发多少由客户端消费决定（背压），
  // 所以它限制的是积压量而不是画质。留 4MB/s 是为了长按 2 倍速也不断粮。
  const PACE_RATE = 4 * 1024 * 1024;       // ≈ 32Mbps
  const PACE_BURST = 4 * 1024 * 1024;      // 起播 / 每次快进后先灌 4MB，别让人干等
  let sent = 0;
  let paceStart = 0;
  const queue = [];
  let draining = false;

  function paceDrain() {
    if (res.writableEnded || res.destroyed || !queue.length) {
      if (res.writableEnded || res.destroyed) queue.length = 0;
      draining = false; return;
    }
    const chunk = queue[0];
    const allowed = PACE_BURST + PACE_RATE * ((Date.now() - paceStart) / 1000);
    if (sent + chunk.length > allowed) {
      // 超前了：让 ffmpeg 先别产出，等预算攒够再发
      const wait = Math.max(20, Math.min(400, ((sent + chunk.length - allowed) / PACE_RATE) * 1000));
      try { p && p.stdout.pause(); } catch (_) {}
      setTimeout(() => { try { p && p.stdout.resume(); } catch (_) {} paceDrain(); }, wait);
      return;
    }
    queue.shift();
    sent += chunk.length;
    if (!res.write(chunk)) {
      // 客户端消费慢（正常背压）：等 drain 再继续
      try { p && p.stdout.pause(); } catch (_) {}
      res.once('drain', () => { try { p && p.stdout.resume(); } catch (_) {} paceDrain(); });
      return;
    }
    if (queue.length) setTimeout(paceDrain, 0);
    else draining = false;
  }

  function paceWrite(chunk) {
    if (queue.length > 4096) return;        // 客户端八成已经没了，别把内存喂爆
    queue.push(chunk);
    if (!draining) { draining = true; paceDrain(); }
  }

  /** 起一次转码。首块数据写出 → resolve(true)（留在后台继续流）；一个字节没出就挂 → resolve(false)（可重试） */
  function attempt(n) {
    return new Promise((done) => {
      err = '';
      let proc;
      try { proc = spawn(tools.ffmpeg, args, { windowsHide: true, env: childEnv() }); } catch (e) {
        err = 'ffmpeg 起不来：' + e.message;
        return done(false);
      }
      p = proc;
      transJobs.set(abs, proc);
      proc.on('close', () => { if (transJobs.get(abs) === proc) transJobs.delete(abs); });

      proc.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000); });
      proc.stdout.on('data', (chunk) => {
        if (!started) {
          started = true;
          res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'X-Transcode': copy ? 'remux' : 'encode',
          });
          paceStart = Date.now();              // 限速从这里开始计时
          sent = 0;
          done(true);                          // 首块已出 → 这一路活了，剩下的交给后台流
        }
        paceWrite(chunk);
      });
      proc.on('error', (e) => {
        if (!started) { err += ' ' + e.message; done(false); }
        else try { res.end(); } catch (_) {}
      });
      proc.on('close', (code) => {
        if (started) { try { res.end(); } catch (_) {} return; }
        // 客户端已经走了（拖进度条 / 切集 / 关页面）→ ffmpeg 是被我们 kill 掉的（退出码 null），
        // 这不是「起转失败」，别记噪音日志误导排障，也不该再重试
        if (res.writableEnded || res.destroyed) return done(false);
        // 硬编起不来（ffmpeg 编进了 nvenc 但这台机器没有对应 GPU，或驱动不认）：
        // 标记硬编不可用，让后续请求直接走软编，别每次快进都先撞一次墙
        if (/nvenc|h264_qsv|h264_amf|hevc_nvenc|No capable devices|cannot load nvcuda/i.test(err)) {
          if (hwWorking !== false) {
            hwWorking = false;
            console.log('[transcode] 硬件编码不可用，回退 libx264 软编：', tailLine(err));
          }
        }
        console.log('[transcode]', path.basename(abs), '第' + n + '次起转失败，退出码', code, tailLines(err));
        done(false);
      });
    });
  }

  // 云盘挂载（115 等）偶尔抽风：ffmpeg 一个包都没读到就退出（实测退出码 69 / no packets）。
  // 这种失败是瞬时的 —— 隔一秒再起一路就好，最多试 3 次，别一次抖动就让前端报「播放错误」。
  for (let n = 1; n <= 3 && !started && !res.writableEnded && !res.destroyed; n++) {
    if (n > 1) await new Promise((r) => setTimeout(r, 1000));
    await attempt(n);
    // 硬编在上一轮被判为不可用 → 重建命令行换成软编，再试一次
    if (!started && hwWorking === false && args.some((a) => /nvenc|qsv|amf/.test(a))) {
      const idx = args.findIndex((a) => a === '-c:v');
      if (idx >= 0) args.splice(idx, args.length);
      if (copy) args.push('-c', 'copy');
      else args.push(...pickVideoEncoder(), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:a', 'aac', '-b:a', '160k', '-ac', '2');
      args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1');
    }
  }
  if (!started) {
    return sendJson(res, 502, { ok: false, error: '转码起不来（NAS 读取抖动，已自动重试 3 次）：' + tailLine(err) });
  }
}

/** 视频流代理：透传 Range，实现秒开与随意拖动 */
async function handleStream(req, res, u) {
  const rel = u.searchParams.get('p');
  if (!rel) return sendText(res, 400, 'missing p');
  if (rel.startsWith('demo://')) {
    return serveStatic(req, res, path.join(PUBLIC_DIR, 'samples', rel.slice(7)), { cache: true });
  }
  if (!config.url) return sendText(res, 400, '未配置 WebDAV');

  // normAbs 会把 ../ 消掉，顺便挡住路径穿越
  const abs = normAbs(rel);
  if (!ALL_EXTS.includes(extOf(abs))) return sendText(res, 403, 'not a video');

  let upstream;
  const target = davUrlAbs(config, abs, false);
  try {
    upstream = await httpRequest('GET', target, {
      cfg: config,
      timeout: 0,
      headers: {
        ...(req.headers.range ? { Range: req.headers.range } : {}),
        ...(req.headers['if-none-match'] ? { 'If-None-Match': req.headers['if-none-match'] } : {}),
      },
    });
  } catch (e) {
    return sendText(res, 502, '拉流失败: ' + e.message);
  }

  if (upstream.statusCode >= 400) {
    upstream.resume();
    return sendText(res, upstream.statusCode === 401 ? 401 : 502, `上游返回 ${upstream.statusCode}（可能是权限或路径问题）`);
  }

  const headers = {
    'Content-Type': upstream.headers['content-type'] || MIME[path.extname(abs).toLowerCase()] || 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  };
  for (const h of ['content-length', 'content-range', 'etag', 'last-modified']) {
    if (upstream.headers[h]) headers[h] = upstream.headers[h];
  }
  res.writeHead(upstream.statusCode, headers);
  if (req.method === 'HEAD') { upstream.resume(); return res.end(); }
  upstream.pipe(res);
  upstream.on('error', () => { try { res.destroy(); } catch (_) {} });
  req.on('close', () => { try { upstream.destroy(); } catch (_) {} });
}

/* ==================== 缩略图：ffmpeg 抽帧 + 落盘缓存 ==================== */
/**
 * 网格缩略图原来每次都让浏览器现拉流、现 seek 到第 60 秒，慢又重复。
 * 这里服务端抽一次帧存进 data/thumbs/，之后直接读图，命中即秒出。
 * 缓存文件名按「路径 + 版本」哈希；视频文件换了不会自动失效——要刷新就删 thumbs/ 目录。
 */
const thumbLocks = new Map();   // 同名缓存并发生成时串行化，避免多个 ffmpeg 抢写同一个文件

function thumbKey(rel) {
  return crypto.createHash('sha1').update(THUMB_VER + ':' + rel).digest('hex') + '.jpg';
}

/** 本机文件的时长（演示样例用；远端文件走 probeFile） */
function probeLocal(file) {
  const tools = ffTools();
  if (!tools.ready) return Promise.resolve(0);
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-v', 'quiet', '-print_format', 'json', '-show_format', file];
    let p;
    try { p = spawn(tools.ffprobe, args, { windowsHide: true, env: childEnv() }); } catch (_) { return resolve(0); }
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('error', () => resolve(0));
    p.on('close', (code) => {
      if (code !== 0) return resolve(0);
      try { resolve(Number(JSON.parse(out).format.duration) || 0); } catch (_) { resolve(0); }
    });
  });
}

async function handleThumb(req, res, u) {
  const rel = u.searchParams.get('p');
  if (!rel) return sendText(res, 400, 'missing p');  if (rel.startsWith('demo://')) {
    const file = path.join(PUBLIC_DIR, 'samples', rel.slice('demo://'.length));
    return await extractThumb(req, res, 'local:' + file, null, 'local:' + file);
  }
  if (!config.url) return sendText(res, 400, '未配置 WebDAV');
  const abs = normAbs(rel);
  if (!ALL_EXTS.includes(extOf(abs))) return sendText(res, 403, 'not a video');
  // 直连远端文件抽帧（和转码一样让 ffmpeg 自己读 WebDAV）
  return await extractThumb(req, res, davUrlAbs(config, abs, false), abs, rel);
}

/**
 * @param inputUrl  ffmpeg 输入（local: 开头 = 本机文件，否则远端 WebDAV URL）
 * @param absForProbe  WebDAV 绝对路径，用于 ffprobe 探时长（本机文件传 null）
 * @param key  缓存键（本地文件传 'local:<path>'，远端传 rel）
 */
async function extractThumb(req, res, inputUrl, absForProbe, key) {
  const out = path.join(THUMBS_DIR, thumbKey(key));
  // res 为 null = 后台补齐调用，只要落盘，不回 HTTP
  if (isFile(out)) return res ? serveStatic(req, res, out, { cache: true }) : undefined;

  // 同一文件正在生成时，排队等结果，不要重复起 ffmpeg
  if (thumbLocks.has(out)) {
    await thumbLocks.get(out).catch(() => {});
    if (isFile(out)) return res ? serveStatic(req, res, out, { cache: true }) : undefined;
    if (res) sendText(res, 502, '缩略图生成失败');
    return undefined;
  }

  const tools = ffTools();
  if (!tools.ready) {
    if (res) sendText(res, 501, '没找到 ffmpeg，无法生成缩略图');
    return undefined;
  }

  // 先探时长：比截取点短的片子退到 1/4 处，别停在片尾（短片硬 seek 到 60s 会越界抽不出帧）
  const isLocal = inputUrl.startsWith('local:');
  const probe = absForProbe
    ? probeFile(absForProbe).then((info) => info && info.ok ? (info.duration || 0) : 0).catch(() => 0)
    : (isLocal ? probeLocal(inputUrl.slice('local:'.length)) : Promise.resolve(0));

  const job = probe.then((dur) => new Promise((resolve) => {
    const t = dur >= THUMB_SEEK ? THUMB_SEEK : (dur > 1 ? Math.max(1, dur * 0.25) : 0);
    // 临时文件也要带 .jpg 后缀：ffmpeg 靠扩展名推断输出格式，用 .tmp 会报 "Invalid argument"
    const tmp = out.replace(/\.jpg$/, '.part.jpg');
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (isLocal) {
      // 本地文件：上面那套 -reconnect / -rw_timeout 是 HTTP 协议专属参数，喂给本地输入会报 "Option not found"
      args.push('-ss', String(t), '-i', inputUrl.slice('local:'.length));
    } else {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-rw_timeout', '20000000',
        '-multiple_requests', '1', '-short_seek_size', '1000000');
      if (extOf(key) === 'avi') args.push('-use_odml', '0');
      args.push('-ss', String(t), '-headers', davHeaders(), '-i', inputUrl);
    }
    args.push('-an', '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', tmp);

    let p;
    try { p = spawn(tools.ffmpeg, args, { windowsHide: true, env: childEnv() }); }
    catch (e) { return resolve({ ok: false, error: 'ffmpeg 起不来：' + e.message }); }

    let err = '';
    p.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code !== 0 || !isFile(tmp)) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        console.log('[thumb]', path.basename(out), '失败', code, tailLine(err));
        return resolve({ ok: false, error: tailLine(err) || ('ffmpeg 退出码 ' + code) });
      }
      try { fs.renameSync(tmp, out); } catch (_) { try { fs.copyFileSync(tmp, out); fs.unlinkSync(tmp); } catch (_) {} }
      resolve({ ok: true });
    });
  }));

  const locked = job.then((r) => r, () => ({ ok: false, error: '抽取中断' }));
  thumbLocks.set(out, locked.finally(() => thumbLocks.delete(out)));

  const r = await locked;
  if (r.ok && isFile(out)) return res ? serveStatic(req, res, out, { cache: true }) : undefined;
  if (res) sendText(res, 502, '缩略图生成失败：' + (r.error || ''));
  return undefined;
}

/** 缓存里有多少张、占多大 —— 前端「我的」页要显示「图是存下来的」 */
function thumbStatsRaw() {
  let n = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(THUMBS_DIR)) {
      if (!f.endsWith('.jpg')) continue;
      try { const s = fs.statSync(path.join(THUMBS_DIR, f)); if (s.isFile()) { n++; bytes += s.size; } } catch (_) {}
    }
  } catch (_) {}
  return { cached: n, bytes };
}

function handleThumbStats(res) {
  return sendJson(res, 200, { ok: true, ...thumbStatsRaw(), dir: THUMBS_DIR });
}

/**
 * 把一批视频排进抽帧队列（后台慢慢抽，不阻塞请求）。
 * 和 APK 版的 /api/thumb/backfill 保持同一套协议：{ items: [relPath...] }。
 * 已经缓存过、或正在生成的直接跳过。
 */
async function handleThumbBackfill(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const items = body && Array.isArray(body.items) ? body.items : [];
  const known = new Set(((library && library.videos) || []).map((v) => v.p));
  let queued = 0, skipped = 0;
  for (const rel of items) {
    // 只处理当前片源里真实存在的（收藏了但文件被删的排了也抽不出来）
    if (typeof rel !== 'string' || !rel || !known.has(rel)) { skipped++; continue; }
    const abs = normAbs(rel);
    if (!ALL_EXTS.includes(extOf(abs))) { skipped++; continue; }
    const out = path.join(THUMBS_DIR, thumbKey(rel));
    if (isFile(out) || thumbLocks.has(out)) { skipped++; continue; }
    // 不 await：排上去就回，前端不用等
    extractThumb({ headers: {} }, null, davUrlAbs(config, abs, false), abs, rel)
      .catch(() => {});
    queued++;
  }
  const st = thumbStatsRaw();
  return sendJson(res, 200, { ok: true, queued, skipped, cached: st.cached, bytes: st.bytes });
}

/* =============================== 主服务 =============================== */

/** 防目录穿越 */
function sanitize(p) {
  const clean = path.normalize('/' + String(p).replace(/\\/g, '/')).replace(/^[/\\]+/, '');
  if (clean.includes('..')) return null;
  return clean;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (u.pathname.startsWith('/api/')) {
      /* 多设备同步（账号系统）：独立一条链，因为它要 CORS 预检、要二进制 body、
         还有自己一套 Bearer 鉴权 —— 混进 handleApi 会把那三个特例撒得到处都是。
         ⚠️ 必须排在下面那串具体路由**之前**（前缀匹配 /api/sync/ 与 /api/auth/）。 */
      if (u.pathname.startsWith('/api/auth/') || u.pathname.startsWith('/api/sync/')) {
        return await handleSync(req, res, u);
      }
      if (u.pathname === '/api/stream') return await handleStream(req, res, u);
      if (u.pathname === '/api/transcode') return await handleTranscode(req, res, u);
      if (u.pathname === '/api/thumb') return await handleThumb(req, res, u);
      if (u.pathname === '/api/thumb/stats') return handleThumbStats(res);
      if (u.pathname === '/api/thumb/backfill') return await handleThumbBackfill(req, res);
      return await handleApi(req, res, u);
    }
    if (u.pathname.startsWith('/samples/')) {
      const name = sanitize(u.pathname.slice('/samples/'.length));
      if (!name) return sendText(res, 400, 'bad path');
      return serveStatic(req, res, path.join(PUBLIC_DIR, 'samples', name), { cache: true });
    }
    // 静态资源
    let p = decodeURIComponent(u.pathname);
    if (p === '/' || !path.extname(p)) p = '/index.html';
    const file = sanitize(p);
    if (!file) return sendText(res, 400, 'bad path');
    return serveStatic(req, res, path.join(PUBLIC_DIR, file), { cache: false });
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) sendText(res, 500, '服务器错误: ' + e.message);
    else try { res.end(); } catch (_) {}
  }
});

ensureDir();

/** 兜底：任何未捕获异常都不应该让整个服务退出 */
process.on('uncaughtException', (e) => console.error('[uncaught]', e && e.message));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e && (e.message || e)));

const lan = os.networkInterfaces();
const ips = Object.values(lan).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);

server.listen(PORT, () => {
  console.log('\n  🎬  NAS 短视频（抖音风格）已启动\n');
  console.log(`  本机访问：  http://localhost:${PORT}`);
  ips.forEach((ip) => console.log(`  手机访问：  http://${ip}:${PORT}   （同一 WiFi 下）`));
  const src = config.url
    ? `WebDAV  ${config.url}${config.dir ? '  当前位置 ' + config.dir : ''}`
    : '未配置（当前为演示模式）';
  console.log(`\n  数据源：${src}`);
  const dirs = sourceDirs();
  console.log(`  片源：${dirs.length} 个文件夹`);
  dirs.forEach((d) => console.log(`    · ${d}`));
  console.log(`  片库缓存：${library.videos.length} 个视频，` +
    (library.scannedAt ? `${Math.round((Date.now() - library.scannedAt) / 60000)} 分钟前扫的` : '还没扫过') +
    `（超过 ${CACHE_TTL_MS / 3600000} 小时才重扫）`);
  console.log('  加/删片源：底部「文件夹」页里点 ＋ 加入，不用改配置\n');
});
