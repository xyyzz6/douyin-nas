'use strict';
/**
 * douyin-nas 解码服务（Docker / 飞牛 NAS）
 * =====================================================================================
 *  这个东西是干什么的
 * =====================================================================================
 *  手机上的 APK 原本内嵌了一套 arm64 的 ffmpeg/ffprobe（30MB），在手机本地转码。
 *  问题是：手机 CPU 转 1080p 根本跑不动实时（软编实测 0.37×），只能退到 h264_mediacodec
 *  硬编，而硬编在部分设备/模拟器上又不出帧；再加上 30MB 让 APK 臃肿。
 *
 *  现在把转码这件事整个搬到 NAS 上：
 *
 *      ┌──────────┐   /api/transcode    ┌──────────────────┐   ffmpeg   ┌──────┐
 *      │  APK     │ ──────────────────► │ 本服务（容器内）  │ ─────────► │ NAS  │
 *      │ (瘦客户端)│ ◄────────────────── │ 边转边播 fMP4     │  WebDAV    │ 片库 │
 *      └──────────┘   fragmented MP4    └──────────────────┘            └──────┘
 *
 *  NAS 的 CPU 通常是手机的好几倍，而且**一直插着电**，转码最合适不过。
 *  手机只负责收流和解码，发热和耗电都下去了。
 *
 * =====================================================================================
 *  和主服务（server.js）的关系
 * =====================================================================================
 *  本文件是 server.js 里「转码 + 探测」那部分的**独立部署版**，只干两件事：
 *    · POST/GET /api/transcode  —— 边转边播，输出 fragmented MP4
 *    · GET      /api/probe      —— 时长 + 画面宽高（含竖屏 rotation 摆正）
 *  外加：
 *    · GET /api/caps           —— 能力探测，前端/APK 用它决定「走远端还是本地」
 *    · GET /api/health         —— 容器健康检查
 *    · GET /api/encoders       —— 列出这台机器上可用的 H.264 编码器（排障用）
 *
 *  它**不需要**片库、不需要 WebDAV 浏览 —— 只要给它一个可读的视频地址，它就能转。
 *  地址由调用方通过 `src` 参数直接传进来（绝对 http/https URL），或者用 WebDAV
 *  配置拼接（见 /api/config）。
 *
 * =====================================================================================
 *  ⚠️ 设计上刻意保留的两个「和手机版不一样」的地方
 * =====================================================================================
 *  1. **转码不用 h264_mediacodec**。那个是 Android 专属的硬编器，容器里没有。
 *     这里用 libx264（软编，画质/兼容性最好）；如果宿主有独显并挂了 /dev/dri，
 *     会优先试 h264_qsv / h264_nvenc / h264_vaapi（见 detectHwEncoder）。
 *  2. **限速投递（pace）必须保留**。这是个很容易被忽略但非常致命的点，见下面 PACE_* 注释。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { URL } = require('url');

// ------------------------------------------------------------------ 配置

const PORT = Number(process.env.PORT || 8099);

/**
 * WebDAV 配置。三种给法，优先级从高到低：
 *   1. 环境变量（docker-compose 里传，推荐）
 *   2. data/config.json（容器里挂个卷，可以热改 —— 见 reloadConfig）
 *   3. 请求参数 src= 直接指定绝对地址（不需要任何配置，最灵活）
 */
const ENV = process.env;
let config = {
  url: ENV.DAV_URL || '',
  user: ENV.DAV_USER || '',
  pass: ENV.DAV_PASS || '',
};

const CONFIG_FILE = path.join(__dirname, 'data', 'config.json');

function reloadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (j.url) config.url = j.url;
      if (j.user !== undefined) config.user = j.user;
      if (j.pass !== undefined) config.pass = j.pass;
      console.log('[cfg] 已从 config.json 覆盖：', config.url);
    }
  } catch (e) {
    console.warn('[cfg] config.json 读不了，忽略：', e.message);
  }
}
reloadConfig();

/** 浏览器能直接解的容器。其余的一律走转码（或者重封装） */
const BROWSER_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'ogv'];

const LOG_LEVEL = ENV.LOG_LEVEL || 'info';
const log = (...a) => { if (LOG_LEVEL !== 'quiet') console.log(...a); };

// ------------------------------------------------------------------ 小工具

function sendText(res, code, s) {
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(s);
}

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (res.headersSent) { try { res.end(); } catch (_) {} return; }
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function extOf(p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p || '').split('?')[0]);
  return m ? m[1].toLowerCase() : '';
}

function tailLines(s, n = 6) {
  const l = String(s || '').trim().split(/\r?\n/).filter(Boolean);
  return l.length ? l.slice(-n).join(' ┃ ').slice(0, 1200) : '';
}

function tailLine(s) {
  const l = String(s || '').trim().split(/\r?\n/).filter(Boolean);
  return l.length ? l[l.length - 1].slice(0, 300) : '';
}

/**
 * ⚠️ 代理变量一定要摘掉。
 * 容器里如果继承了 HTTP_PROXY/HTTPS_PROXY（有些 NAS 系统全局设了），
 * ffmpeg 会把访问**内网 NAS** 的请求也丢给代理，代理不认识这个地址 → 404/502。
 * 我们读的是局域网设备，走代理毫无意义。
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

// ------------------------------------------------------------------ ffmpeg / ffprobe 定位

let ffCache = null;

function isFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch (_) { return false; } }

function findTool(name) {
  const envPath = name === 'ffmpeg' ? ENV.FFMPEG_PATH : ENV.FFPROBE_PATH;
  if (isFile(envPath)) return envPath;
  // 容器里通常就在 PATH 上（基础镜像已装）
  for (const d of String(ENV.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const hit = path.join(d, name);
    if (isFile(hit)) return hit;
  }
  // 本地开发（Windows）时退到项目的 bin/。
  // ⚠️ 两个位置都要试：在项目根目录跑 `node decode-server/server.js` 时 __dirname
  //    是 decode-server/，bin/ 在**上一级**。少了 ../ 这一步就会「明明有 ffmpeg 却说没找到」。
  for (const rel of [path.join('..', 'bin', name), path.join('bin', name)]) {
    const local = path.join(__dirname, rel);
    if (isFile(local)) return local;
    const exe = local + '.exe';           // Windows 上带 .exe
    if (isFile(exe)) return exe;
  }
  return '';
}

function ffTools() {
  if (!ffCache) {
    const ffmpeg = findTool('ffmpeg');
    const ffprobe = findTool('ffprobe');
    ffCache = { ffmpeg, ffprobe, ready: !!(ffmpeg && ffprobe) };
    log('[ff] ffmpeg =', ffmpeg || '(没找到)');
    log('[ff] ffprobe =', ffprobe || '(没找到)');
  }
  return ffCache;
}

// ------------------------------------------------------------------ 硬件编码器探测

/**
 * 优先用宿主 GPU 编码（CPU 占用几乎为零），没有就 libx264 软编。
 *
 * ⚠️ 容器里要用硬件编码必须**把设备挂进来**，否则 ffmpeg 编译时带了 nvenc/qsv
 *    也跑不起来（打开设备失败 → 起转立刻退出）：
 *      · Intel 核显 / AMD： docker run --device /dev/dri
 *      · NVIDIA：          --gpus all（且宿主装了 nvidia-container-toolkit）
 *    compose 里这两行默认注释掉了，需要时自己开。
 *
 * 探测结果缓存一次。注意「编译进来」≠「能用」—— 所以真实用哪个仍以
 * 起转能不能出数据为准（见 handleTranscode 里的回退）。
 */
let hwEncCache = null;
function detectHwEncoder() {
  if (hwEncCache !== null) return hwEncCache;
  hwEncCache = '';
  const tools = ffTools();
  if (!tools.ready) return hwEncCache;
  try {
    const out = execFileSync(tools.ffmpeg, ['-hide_banner', '-encoders'], {
      encoding: 'utf8', env: childEnv(), timeout: 15000,
    });
    // 顺序 = 优先级。NVENC 画质/速度综合最好，其次 QSV，再次 VAAPI。
    if (/\bh264_nvenc\b/.test(out)) hwEncCache = 'nvenc';
    else if (/\bh264_qsv\b/.test(out)) hwEncCache = 'qsv';
    else if (/\bh264_vaapi\b/.test(out)) hwEncCache = 'vaapi';
    else if (/\bh264_v4l2m2m\b/.test(out)) hwEncCache = 'v4l2m2m';
    else if (/\blibx264\b/.test(out)) hwEncCache = 'libx264';
    else hwEncCache = '';        // 连 libx264 都没有（不太可能，基础镜像都带）
  } catch (_) { /* 探测失败就当没有，后面一律软编 */ }
  return hwEncCache;
}

/**
 * 返回 `-c:v ...` 那一段参数。
 * @param {boolean} forceSoft 强制软编（硬编起转失败后的回退）
 */
function pickVideoEncoder(forceSoft) {
  const hw = forceSoft ? 'libx264' : (detectHwEncoder() || 'libx264');
  switch (hw) {
    case 'nvenc':
      return { hw, args: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq',
        '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p'] };
    case 'qsv':
      return { hw, args: ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '23',
        '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'nv12'] };
    case 'vaapi':
      // vaapi 必须先上传到显存，所以要多一个 hwupload。这里用最简单可靠的软件上传路径。
      return { hw, args: ['-c:v', 'h264_vaapi', '-qp', '23',
        '-maxrate', '8M', '-bufsize', '16M'] };
    case 'v4l2m2m':
      return { hw, args: ['-c:v', 'h264_v4l2m2m', '-b:v', '4M'] };
    default:
      // 软编。veryfast 在 NAS 这种 CPU 上性价比最高；
      // maxrate 封顶是因为最终是手机走 Wi-Fi 收流，带宽是稀缺资源。
      return { hw: 'libx264', args: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
        '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p'] };
  }
}

// ------------------------------------------------------------------ 源地址解析

/**
 * 把请求解析成一个 ffmpeg 能直接读的绝对 URL。
 *
 * 两种模式：
 *   · `src=` 调用方直接给绝对地址（APK / 主服务转发时用这个 —— 省一次配置）
 *   · 没给就按 WebDAV 配置拼：{origin}{归一化路径}，并把 Basic 认证塞进 header
 *
 * ⚠️ 踩过的坑：不能拿 config.url 当字符串直接拼。
 *   用户填的可能是 `http://host:5005/`（带尾斜杠）也可能是
 *   `http://host:5005/dav/files/me`（带路径），直接拼会得到
 *   `http://host:5005/dav/files/me/片名.mp4` 这种**路径重复**的地址，
 *   服务器回 401/404 而不是报参数错 —— 很难查。
 *   正确做法和主服务 server.js 的 davUrlAbs 一致：
 *   取 origin（丢掉配置里的路径），再把归一化后的片子路径拼上去。
 *
 * ⚠️ 另一个坑：每段都要 encodeURIComponent，但**斜杠要留着**。
 *   整段 encodeURIComponent 会把 / 也转成 %2F，WebDAV 直接把整串当文件名 → 404。
 *   也要先 decodeURIComponent 一次再编码 —— 否则前端已经编过的路径会被二次编码
 *   （%E4%BA%91 变成 %25E4%25BA%91）。
 */
function encPath(p) {
  return String(p).split('/').map((s) => encodeURIComponent(s)).join('/');
}

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

function decodeSafe(rel) {
  try { return decodeURIComponent(rel); } catch (_) { return rel; }
}

function resolveSource(u) {
  const src = u.searchParams.get('src');
  if (src) {
    const s = String(src).trim();
    if (!/^https?:\/\//i.test(s)) throw new Error('src 必须是 http/https 绝对地址');
    return { url: s, headers: null, kind: 'src' };
  }
  const rel = u.searchParams.get('p');
  if (!rel) throw new Error('缺少参数：p（视频路径）或 src（绝对地址）');
  if (!config.url) throw new Error('未配置 WebDAV。给容器传 DAV_URL/DAV_USER/DAV_PASS 环境变量，或用 src= 直接指定地址');

  let origin;
  try { origin = new URL(String(config.url).trim()).origin; }
  catch (_) { throw new Error('WebDAV 地址不合法：' + config.url); }

  const url = origin + encPath(normAbs(decodeSafe(rel)));

  const headers = [];
  if (config.user || config.pass) {
    headers.push('Authorization: Basic ' + Buffer.from(config.user + ':' + config.pass).toString('base64'));
  }
  headers.push('User-Agent: douyin-nas-decode');
  return { url, headers: headers.join('\r\n') + '\r\n', kind: 'dav' };
}

// ------------------------------------------------------------------ /api/probe

const probeCache = new Map();
const PROBE_TTL = Number(ENV.PROBE_TTL_MS || 6 * 60 * 60 * 1000);   // 远端文件不会变，6 小时够了

/**
 * ffprobe 读「时长 + 编码 + 画面宽高」。
 *
 * ⚠️ 为什么一定要回 width/height，而不是只回时长：
 *   前端要把加载转圈对准**视频画面矩形**（`.vbox`），而转码流的
 *   `video.videoWidth` 在 WebView 里**恒为 0** —— 我们为了首字节快，
 *   输出的是 fragmented MP4（moov 空的、分辨率写在 moof 里），
 *   WebView 能解码但从不回填 videoWidth。所以尺寸只能由这里代答。
 *
 * ⚠️ 竖屏片（手机拍的）会把宽高旋转 90° 存：ffprobe 报的是**存储**尺寸，
 *   显示时要交换。前端算宽高比用的是显示后的值，所以这里先摆正。
 */
function probeSource(source, fresh) {
  const tools = ffTools();
  if (!tools.ready) return Promise.resolve({ ok: false, error: '容器里没有 ffmpeg / ffprobe' });

  const key = source.url;
  const hit = probeCache.get(key);
  if (!fresh && hit && (Date.now() - hit.at) < PROBE_TTL) return Promise.resolve(hit.value);

  return new Promise((resolve) => {
    const args = ['-hide_banner', '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams',
      // 少建连、少乱 seek：探测慢了用户就盯着黑屏等
      '-multiple_requests', '1', '-short_seek_size', '1000000',
      '-analyzeduration', '1000000', '-probesize', '1000000'];
    if (extOf(source.url) === 'avi') args.push('-use_odml', '0');
    if (source.headers) args.push('-headers', source.headers);
    args.push(source.url);

    let p;
    try { p = spawn(tools.ffprobe, args, { windowsHide: true, env: childEnv() }); }
    catch (e) { return resolve({ ok: false, error: e.message }); }

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
        probeCache.set(key, { at: Date.now(), value: r });
        resolve(r);
      } catch (_) { resolve({ ok: false, error: 'ffprobe 输出解析不了' }); }
    });
  });
}

/** 视频已是 H.264、音频已是 AAC/MP3 → 只换封装，不重编码（几乎不吃 CPU） */
function canRemux(info) {
  if (!info || !info.ok) return false;
  if (info.vcodec !== 'h264') return false;
  return !info.acodec || info.acodec === 'aac' || info.acodec === 'mp3';
}

// ------------------------------------------------------------------ /api/transcode

/**
 * 同一时刻每个源只允许一路 ffmpeg。
 * 拖进度条 = 新起一路；旧的那路如果还占着云盘挂载的连接，两条一起啃同一个
 * 大文件会把挂载点拖崩（实测：并发时新流 0 字节直接断）。新请求来了先掐旧的。
 */
const transJobs = new Map();

async function handleTranscode(req, res, u) {
  const tools = ffTools();
  if (!tools.ready) {
    return sendJson(res, 501, {
      ok: false,
      error: '容器里没有 ffmpeg。基础镜像应当自带；如果你换了镜像，' +
             '把 ffmpeg/ffprobe 放进 PATH，或用 FFMPEG_PATH/FFPROBE_PATH 指定。',
    });
  }

  let source;
  try { source = resolveSource(u); }
  catch (e) { return sendText(res, 400, e.message); }

  const start = Math.max(0, Number(u.searchParams.get('t') || 0) || 0);
  const mode = u.searchParams.get('mode') || 'auto';        // auto | copy | encode
  // 探测一个几 GB 的远程文件要几秒。只有 auto 才需要它来判断
  // 「能重封装还是必须重编码」；调用方对已知要重编码的片会明确传 mode=encode，
  // 这时直接跳过，快进少等一大截。
  const info = mode === 'auto' ? await probeSource(source, false) : { ok: false };
  const copy = mode === 'copy' || (mode === 'auto' && canRemux(info));

  const args = ['-hide_banner', '-loglevel', 'error',
    // 云盘挂载 / WebDAV 偶尔中途断一下或回 5xx：默认行为是 ffmpeg 直接退出
    // → 整条流断掉 → 前端报「播放错误」。让它自己重连，瞬时抖动就翻不起浪。
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-reconnect_on_network_error', '1', '-reconnect_on_http_error', '5xx',
    '-rw_timeout', '20000000',
    // ↓ 这两条是「开画慢」的关键，实测能把首字节压掉一半以上：
    //   multiple_requests：复用同一条 TCP 连接。不开的话每 seek 一次就重连一次，
    //     而 NAS 建连一次要好几秒。
    //   short_seek_size：跨度过小时宁可顺序多读一点，也别断开重连去 seek。
    //     局域网多读 1MB 只要几十毫秒，比重新建连便宜得多。
    '-multiple_requests', '1',
    '-short_seek_size', '1000000'];
  if (extOf(source.url) === 'avi') args.push('-use_odml', '0');
  // ⚠️ -ss 放在 -i **前面**才是「快速定位」（按关键帧跳过前面数据）；
  //    放后面是解码后丢弃，慢得多。
  if (start > 0) args.push('-ss', start.toFixed(3));
  if (source.headers) args.push('-headers', source.headers);
  args.push('-i', source.url);

  let encoder = 'copy';
  if (copy) {
    args.push('-c', 'copy');
  } else {
    const pick = pickVideoEncoder(false);
    encoder = pick.hw;
    args.push(...pick.args);
    // 音轨统一 AAC。有些片子音轨是 AC3/DTS/WMA，浏览器解不了。
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }
  // 输出：fragmented MP4 直接吐 stdout，不落盘、不等整段转完。
  //   frag_keyframe  每个关键帧起一个新分片 → 播放器能边收边解
  //   empty_moov     moov 开头就写（且允许后补）—— 不加这个播放器会一直等到文件结束
  //   frag_duration  除「遇关键帧」外再兜一条「每 1 秒至少切一片」，
  //                  保证快进后第一个分片尽快落地（首字节省 1~2 秒）
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '1000000', '-f', 'mp4', 'pipe:1');

  const jobKey = source.url;
  const prev = transJobs.get(jobKey);
  if (prev) { try { prev.kill(); } catch (_) {} }

  // 先试硬编（如果探测到了），起转失败就退回软编。
  // 「起转失败」的判据不是进程退出码，而是**多久没吐出媒体数据** ——
  // 硬编坏掉时的典型症状是进程活着、退出码 0、但一个字节都不出。
  const attempts = copy ? [null] : (encoder === 'libx264' ? ['libx264'] : [encoder, 'libx264']);
  let lastErr = '';

  for (let i = 0; i < attempts.length; i++) {
    const useArgs = buildArgs(args, attempts[i], copy);
    const r = await tryStream(req, res, useArgs, jobKey, {
      encoder: attempts[i] || 'copy',
      copy,
      start,
      firstByteTimeout: attempts[i] === 'libx264' ? 25000 : 15000,
    });
    if (r.ok) return r.res;
    lastErr = r.error || lastErr;
    if (r.clientGone) return null;                 // 客户端断了就别再试了
    if (i + 1 < attempts.length) {
      log('[transcode] ' + attempts[i] + ' 起转失败，回退 ' + attempts[i + 1] + '：' + lastErr);
    }
  }
  return sendJson(res, 502, { ok: false, error: '转码起流失败：' + (lastErr || '未知原因') });
}

/**
 * 把编码器参数替换成指定编码器。
 * 做法：从参数里剥掉已有的 `-c:v ...` 段（含它后面紧跟的编码参数），
 * 再在 `-c:a` 之前插入新的。比「重建整个数组」简单，也不容易漏参数。
 */
function buildArgs(baseArgs, wantEncoder, copy) {
  if (copy || !wantEncoder) return baseArgs.slice();
  const pick = pickVideoEncoder(wantEncoder === 'libx264');
  const out = [];
  let skipping = false;
  // 需要剥掉的那些「只对特定编码器有意义」的参数
  const ENC_ONLY = new Set(['-preset', '-tune', '-rc', '-cq', '-crf', '-global_quality',
    '-qp', '-qp_i', '-qp_p', '-pix_fmt', '-b:v', '-maxrate', '-bufsize', '-profile:v']);
  for (let i = 0; i < baseArgs.length; i++) {
    const s = baseArgs[i];
    if ('-c:v' === s) { skipping = true; i++; continue; }
    if (skipping) {
      if (ENC_ONLY.has(s)) { i++; continue; }
      skipping = false;
    }
    if ('-c:a' === s) {
      out.push(...pick.args);
    }
    out.push(s);
  }
  return out;
}

/** 起一次 ffmpeg。出数据 → 把流接管下来；一个字节没出 → 返回失败（可回退重试） */
function tryStream(req, res, args, jobKey, opt) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(ffTools().ffmpeg, args, { windowsHide: true, env: childEnv() });
    } catch (e) {
      return resolve({ ok: false, error: 'ffmpeg 起不来：' + e.message });
    }

    transJobs.set(jobKey, proc);
    let err = '';
    let started = false;
    let settled = false;
    let clientGone = false;

    const cleanup = () => {
      if (transJobs.get(jobKey) === proc) transJobs.delete(jobKey);
    };
    const kill = () => { try { proc.kill('SIGKILL'); } catch (_) {} };

    // 客户端断开（换 seek / 退出播放）→ 立刻收掉 ffmpeg。
    // 不这么做的话拖几次进度条就会攒一堆 ffmpeg 把 NAS 拖卡。
    const onClose = () => { clientGone = true; kill(); };
    res.on('close', onClose);

    proc.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ ok: false, error: 'ffmpeg 进程错误：' + e.message, clientGone });
    });

    proc.on('close', (code) => {
      cleanup();
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: (tailLines(err) || ('ffmpeg 退出码 ' + code)), clientGone });
    });

    proc.stderr.on('data', (d) => { err += d; if (err.length > 4000) err = err.slice(-2000); });

    // 首字节超时：硬编坏掉时就是「一直不出数据」，靠这个兜住
    const timer = setTimeout(() => {
      if (settled || started) return;
      settled = true;
      kill();
      cleanup();
      resolve({ ok: false, error: '起转 ' + (opt.firstByteTimeout / 1000) + 's 没出数据：' + tailLines(err, 3), clientGone });
    }, opt.firstByteTimeout);

    proc.stdout.on('data', (chunk) => {
      // ⚠️ 这里**不能**再用 settled 当闸门！
      //   settled 的语义是「这次尝试已经有结论了（成功或失败并 resolve 过了）」，
      //   而首块数据一来我们就 resolve({ok:true}) 把 settled 置真 ——
      //   于是后续每一块都会被 `if (settled) return` 挡掉，
      //   表现就是「HTTP 200、Content-Type 对、但响应体只有 28 字节然后永远卡住」。
      //   实测踩过：一个 992KB 的重封装流只收到 1 块 28B 就停了，查了很久。
      //   正确做法是：首块之后照样继续投递，只是不再 resolve、不再写头。
      if (!started) {
        started = true;
        clearTimeout(timer);
        settled = true;
        if (req.method === 'HEAD') { kill(); return resolve({ ok: true, res: null }); }
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          'X-Transcode': opt.copy ? 'remux' : 'encode',
          'X-Transcode-Encoder': opt.encoder,
          'X-Transcode-Start': String(opt.start || 0),
        });
        log('[transcode] 起流 ' + (opt.copy ? '重封装' : '重编码/' + opt.encoder) +
            ' t=' + (opt.start || 0));
        resolve({ ok: true, res: null });
      }
      paceWrite(res, proc, chunk);
    });
  });
}

// ------------------------------------------------------------------ 限速投递

/**
 * ⚠️ 这段看着可以删，其实**不能删**。原因：
 *
 * 转码速度（NAS 上软编 1080p 大约 2~4MB/s、硬编更快）通常**远快于**播放速度
 * （1080p 约 1MB/s）。不限速的话服务端几秒就把几十秒的内容灌进网络管道和播放器缓冲：
 *   · 局域网 / Wi-Fi 被撑爆（NAS 还要同时从源盘读数据，双向挤同一条链路）
 *   · 一快进，管道里堵着的「旧位置」数据得先排空才轮到新画面 → 用户看到卡死
 *
 * 所以按略高于播放速率的节奏匀速投递：起播先快灌一段把缓冲填满，之后限速。
 * 注意限速只是「上限」，稳态下实际发多少由客户端消费决定（背压），
 * 所以它限制的是**积压量**而不是画质。留 4MB/s 是为了长按 2 倍速也不断粮。
 */
const PACE_RATE = Number(ENV.PACE_RATE || 4 * 1024 * 1024);     // ≈ 32Mbps
const PACE_BURST = Number(ENV.PACE_BURST || 4 * 1024 * 1024);   // 起播/每次快进后先灌这么多

/** 每个响应一套限速状态（用 WeakMap 挂，避免跨请求串台） */
const paceState = new WeakMap();

function paceWrite(res, proc, chunk) {
  let st = paceState.get(res);
  if (!st) {
    st = { sent: 0, t0: Date.now(), queue: [], draining: false };
    paceState.set(res, st);
  }
  if (st.queue.length > 4096) return;        // 客户端八成已经没了，别把内存喂爆
  st.queue.push(chunk);
  if (!st.draining) { st.draining = true; paceDrain(res, proc); }
}

function paceDrain(res, proc) {
  const st = paceState.get(res);
  if (!st) return;
  if (res.writableEnded || res.destroyed || !st.queue.length) {
    if (res.writableEnded || res.destroyed) st.queue.length = 0;
    st.draining = false;
    return;
  }
  const chunk = st.queue[0];
  const allowed = PACE_BURST + PACE_RATE * ((Date.now() - st.t0) / 1000);
  if (st.sent + chunk.length > allowed) {
    // 超前了：让 ffmpeg 先别产出，等预算攒够再发
    const wait = Math.max(20, Math.min(400, ((st.sent + chunk.length - allowed) / PACE_RATE) * 1000));
    try { proc.stdout.pause(); } catch (_) {}
    setTimeout(() => {
      try { proc.stdout.resume(); } catch (_) {}
      paceDrain(res, proc);
    }, wait);
    return;
  }
  st.queue.shift();
  st.sent += chunk.length;
  if (!res.write(chunk)) {
    // 客户端消费慢（正常背压）：等 drain 再继续
    try { proc.stdout.pause(); } catch (_) {}
    res.once('drain', () => {
      try { proc.stdout.resume(); } catch (_) {}
      paceDrain(res, proc);
    });
    return;
  }
  if (st.queue.length) setTimeout(() => paceDrain(res, proc), 0);
  else st.draining = false;
}

// ------------------------------------------------------------------ 能力探测 / 健康检查

function caps() {
  const tools = ffTools();
  const hw = tools.ready ? (detectHwEncoder() || 'libx264') : '';
  return {
    ok: true,
    service: 'douyin-nas-decode',
    version: ENV.APP_VERSION || '1.0.0',
    ffmpeg: tools.ready,
    ffmpegPath: tools.ffmpeg || '',
    ffprobePath: tools.ffprobe || '',
    encoder: hw,
    hardware: !!(hw && hw !== 'libx264'),
    // 前端据此知道「这台服务能不能真转码」。和手机版 /api/state 的 ffmpeg 字段同义。
    canTranscode: tools.ready,
    paceRate: PACE_RATE,
    webdav: !!config.url,
    uptime: Math.round(process.uptime()),
  };
}

function ffmpegVersion() {
  const tools = ffTools();
  if (!tools.ready) return '';
  try {
    const out = execFileSync(tools.ffmpeg, ['-hide_banner', '-version'], {
      encoding: 'utf8', env: childEnv(), timeout: 10000,
    });
    return (out.split('\n')[0] || '').trim();
  } catch (_) { return ''; }
}

function listEncoders() {
  const tools = ffTools();
  if (!tools.ready) return [];
  try {
    const out = execFileSync(tools.ffmpeg, ['-hide_banner', '-encoders'], {
      encoding: 'utf8', env: childEnv(), timeout: 15000,
    });
    return out.split('\n')
      .map((l) => l.trim())
      .filter((l) => /^V/.test(l))
      .map((l) => {
        const m = /^V\S*\s+(\S+)\s+(.*)$/.exec(l);
        return m ? { name: m[1], desc: m[2].slice(0, 80) } : null;
      })
      .filter(Boolean);
  } catch (_) { return []; }
}

// ------------------------------------------------------------------ 路由

const server = http.createServer(async (req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); }
  catch (_) { return sendText(res, 400, 'bad url'); }

  // 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const p = u.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      return sendJson(res, 200, {
        ok: true,
        service: 'douyin-nas-decode',
        hint: '这是解码服务，没有界面。接口：/api/caps /api/probe /api/transcode /api/health /api/encoders',
      });
    }
    if (p === '/api/health' || p === '/healthz') {
      const c = caps();
      return sendJson(res, c.ffmpeg ? 200 : 503, c);
    }
    if (p === '/api/caps') return sendJson(res, 200, caps());
    if (p === '/api/version') {
      const c = caps();
      return sendJson(res, 200, { ...c, ffmpegVersion: ffmpegVersion() });
    }
    if (p === '/api/encoders') return sendJson(res, 200, { ok: true, encoders: listEncoders() });

    if (p === '/api/probe') {
      let source;
      try { source = resolveSource(u); }
      catch (e) { return sendText(res, 400, e.message); }
      const fresh = u.searchParams.get('fresh') === '1';
      const r = await probeSource(source, fresh);
      if (!r.ok) return sendJson(res, 502, r);
      return sendJson(res, 200, r);
    }

    if (p === '/api/transcode') {
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'GET only');
      const r = await handleTranscode(req, res, u);
      if (r === null) return;                 // 流已经接管，或者客户端断了
      return r;
    }

    sendText(res, 404, 'no such api: ' + p);
  } catch (e) {
    log('[err]', e && e.stack || e);
    sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
  }
});

// 关掉默认的请求超时 —— 转码流是长连接，默认 2 分钟会被莫名掐断
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

server.listen(PORT, '0.0.0.0', () => {
  const c = caps();
  log('====================================================');
  log(' douyin-nas 解码服务已启动');
  log('   端口     : ' + PORT);
  log('   ffmpeg   : ' + (c.ffmpeg ? '✓ ' + c.ffmpegPath : '✗ 没找到（转码不可用）'));
  log('   编码器   : ' + (c.encoder || '（不可用）') + (c.hardware ? '  [硬件]' : '  [软件]'));
  log('   WebDAV   : ' + (c.webdav ? config.url : '（未配置，可用 src= 直接传地址）'));
  log('   限速     : ' + (PACE_RATE / 1048576).toFixed(1) + ' MB/s（突发 ' + (PACE_BURST / 1048576).toFixed(1) + ' MB）');
  log('====================================================');
});

// 优雅退出：容器 stop 时把在跑的 ffmpeg 都收掉，别留孤儿进程
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('[' + sig + '] 正在退出，收掉 ' + transJobs.size + ' 路转码…');
    for (const [, proc] of transJobs) { try { proc.kill('SIGKILL'); } catch (_) {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
