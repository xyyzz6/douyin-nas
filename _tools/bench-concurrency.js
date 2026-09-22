/**
 * 量「并发 PROPFIND」到底能比串行快多少。
 *
 * 背景：放开扫描限制后，/dav/示例片源 单一个片源就有上万个视频、几千个目录。
 * 现在是**串行** Depth-1 BFS（CD2 不支持 Depth:3，只能一层层来），
 * 实测扫完要十几分钟 —— 不解决这个，「一次扫全」根本不可用。
 *
 * 这个脚本在同一批目录上分别跑串行 / 8 并发 / 16 并发，比耗时。
 * ⚠️ 只读，不改任何东西。
 *
 * 用法：node _tools/bench-concurrency.js [目录数]
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'config.json'), 'utf8'));
const ORIGIN = new URL(cfg.url).origin;
const AUTH = cfg.user + ':' + cfg.pass;
const BODY = '<?xml version="1.0" encoding="utf-8"?>'
  + '<D:propfind xmlns:D="DAV:"><D:prop><D:resourcetype/></D:prop></D:propfind>';

const N = Number(process.argv[2] || 60);

const isDirRe = /<D:collection\s*\/>|<D:collection\s*>\s*<\/D:collection>/;

function pf(p) {
  const enc = p.split('/').map(encodeURIComponent).join('/');
  return new Promise((resolve) => {
    execFile('curl', ['-s', '--max-time', '12', '-u', AUTH, '-X', 'PROPFIND',
      '-H', 'Depth: 1', '-H', 'Content-Type: application/xml',
      '--data-binary', BODY, ORIGIN + enc],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, (err, out) => {
      if (err || !out || !out.includes('multistatus')) return resolve(null);
      const dirs = [];
      const re = /<D:response>([\s\S]*?)<\/D:response>/g;
      let m;
      while ((m = re.exec(out)) !== null) {
        const hm = /<D:href>([\s\S]*?)<\/D:href>/.exec(m[1]);
        if (!hm) continue;
        let href = hm[1];
        try { href = decodeURIComponent(href); } catch (_) { /* noop */ }
        if (isDirRe.test(m[1])) dirs.push(href.replace(/\/+$/, ''));
      }
      resolve(dirs);
    });
  });
}

async function runLimit(list, limit) {
  const t0 = Date.now();
  let ok = 0;
  for (let i = 0; i < list.length; i += limit) {
    const batch = list.slice(i, i + limit);
    const rs = await Promise.all(batch.map(pf));
    ok += rs.filter(Boolean).length;
  }
  return { ms: Date.now() - t0, ok };
}

(async () => {
  /* 先串行收集 N 个真实存在的目录（当测试样本） */
  const sample = [];
  let frontier = ['/dav/示例片源'];
  const seen = new Set(['/dav/示例片源']);
  while (sample.length < N && frontier.length) {
    const p = frontier.shift();
    const ds = await pf(p);
    if (!ds) continue;
    for (const d of ds) {
      if (seen.has(d)) continue;
      seen.add(d);
      frontier.push(d);
      if (sample.length < N) sample.push(d);
      else break;
    }
  }
  console.log(`样本：${sample.length} 个真实目录（来自 /dav/示例片源）\n`);

  for (const limit of [1, 8, 16]) {
    const r = await runLimit(sample, limit);
    const name = limit === 1 ? '串行  ' : `${String(limit).padStart(2)} 并发`;
    console.log(`  ${name}：${String(r.ms).padStart(6)} ms   成功 ${r.ok}/${sample.length}`);
  }
  console.log('\n（成功数不一致 = 那次有请求超时，属正常网络抖动）');
})();
