/**
 * 解码服务自测 —— 直接打 HTTP，把流写进内存/文件，报告字节数与首字节时间。
 *
 * 为什么要单独写这个而不是用 curl：
 *   curl 在 Windows 的 Git Bash 里 `-o /tmp/x` 的路径会被 MSYS 转换，
 *   而且 `-m` 超时会把已收数据也丢掉，看到的字节数不可信。
 *   这个脚本在同一进程里收流，数字是准的。
 *
 * 用法：
 *   node decode-server/selftest.js <源地址> [mode] [最长时间ms]
 *   例：node decode-server/selftest.js http://127.0.0.1:8123/samples/05_bbb10s.mp4 copy
 */
'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');

const BASE = process.env.DECODE_URL || 'http://127.0.0.1:8099';
const src = process.argv[2];
const mode = process.argv[3] || 'auto';
const maxMs = Number(process.argv[4] || 45000);

if (!src) {
  console.error('用法: node decode-server/selftest.js <源地址> [mode] [最长时间ms]');
  process.exit(2);
}

function get(urlStr, onRes, onErr) {
  const lib = urlStr.startsWith('https') ? https : http;
  return lib.get(urlStr, { timeout: 30000 }, onRes).on('error', onErr);
}

function probe() {
  return new Promise((resolve) => {
    const u = BASE + '/api/probe?src=' + encodeURIComponent(src);
    get(u, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve(d));
    }, (e) => resolve('ERR ' + e.message));
  });
}

function stream() {
  return new Promise((resolve) => {
    const u = BASE + `/api/transcode?src=${encodeURIComponent(src)}&mode=${mode}`;
    let bytes = 0, firstAt = 0, chunks = 0, status = 0, headers = {};
    const t0 = Date.now();
    const out = process.env.SAVE_TO ? fs.createWriteStream(process.env.SAVE_TO) : null;

    const req = get(u, (r) => {
      status = r.statusCode;
      headers = r.headers;
      r.on('data', (c) => {
        if (!firstAt) firstAt = Date.now() - t0;
        bytes += c.length;
        chunks++;
        if (out) out.write(c);
      });
      r.on('end', () => {
        if (out) out.end();
        resolve({ status, headers, bytes, chunks, firstAt, total: Date.now() - t0 });
      });
      r.on('error', () => resolve({ status, headers, bytes, chunks, firstAt, total: Date.now() - t0 }));
    }, (e) => resolve({ error: e.message, bytes, chunks, firstAt, total: Date.now() - t0 }));

    // 到点就主动断开 —— 转码流是「转完才结束」的，直播式长连接
    const timer = setTimeout(() => {
      try { req.destroy(); } catch (_) {}
      if (out) out.end();
      resolve({ status, headers, bytes, chunks, firstAt, total: Date.now() - t0, cut: true });
    }, maxMs);
    req.on('close', () => clearTimeout(timer));
  });
}

(async () => {
  console.log('源   :', src);
  console.log('模式 :', mode);
  console.log('--- /api/probe ---');
  console.log(await probe());
  console.log('--- /api/transcode ---');
  const r = await stream();
  const mb = (r.bytes / 1048576).toFixed(2);
  console.log('HTTP     :', r.status);
  console.log('X-Transcode:', r.headers && (r.headers['x-transcode'] || '-'),
              '  编码器:', r.headers && (r.headers['x-transcode-encoder'] || '-'));
  console.log('首字节   :', (r.firstAt / 1000).toFixed(2) + 's');
  console.log('收到     :', r.bytes, 'B  (' + mb + ' MB)  分块', r.chunks);
  console.log('耗时     :', (r.total / 1000).toFixed(2) + 's' + (r.cut ? '  [到点主动断开]' : '  [流自然结束]'));
  if (r.bytes > 512 * 1024) console.log('判定     : ✅ 转码流有实质数据');
  else console.log('判定     : ❌ 数据太少（' + r.bytes + 'B），有问题');
})();
