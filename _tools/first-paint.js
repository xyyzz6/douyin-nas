/* 冷启动→首屏可见 的秒级计时（1 秒粒度足够：想看的是「5231 条是不是明显变慢」）。
 * ---------------------------------------------------------------------------
 * ⚠️ 每个循环都要**重新取 socket**：force-stop 之后是新进程，旧 socket 直接
 *    `socket hang up`。这是本工具唯一的坑，其它都直白。
 * 用法：node _tools/first-paint.js [--rounds=2]
 */
const { execFileSync, spawn } = require('child_process');
const http = require('http');
const WebSocket = require('ws');

const DEV = 'emulator-5554';
const args = process.argv.slice(2);
const ROUNDS = Number((args.find((a) => a.startsWith('--rounds=')) || '--rounds=2').split('=')[1]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd) {
  try { return execFileSync('bash', ['-c', cmd], { encoding: 'utf8', maxBuffer: 8 << 20 }); }
  catch (e) { return ''; }
}

/** 重新取 socket → 建转发 → 连 CDP → 求值；任何一步失败返回 null */
async function probe(expr) {
  const sock = sh(`adb -s ${DEV} shell "cat /proc/net/unix | grep webview_devtools_remote" \
    | awk '{print $NF}' | sed 's/^@//' | head -1`).trim();
  if (!sock) return null;
  sh(`adb -s ${DEV} forward tcp:9222 localabstract:${sock} >/dev/null 2>&1`);
  let list;
  try {
    list = await new Promise((res, rej) => {
      const req = http.get('http://127.0.0.1:9222/json', (r) => {
        let b = ''; r.on('data', (c) => { b += c; });
        r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
      });
      req.on('error', rej);
      req.setTimeout(3000, () => { req.destroy(); rej(new Error('timeout')); });
    });
  } catch (e) { return null; }

  const page = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) return null;

  const val = await new Promise((res) => {
    let ws;
    try { ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false }); }
    catch (e) { return res(null); }
    const done = (v) => { try { ws.close(); } catch (_) {} res(v); };
    ws.on('open', () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true },
    })));
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m.id === 1) done(m.result && m.result.result ? m.result.result.value : null);
      } catch (_) { done(null); }
    });
    ws.on('error', () => done(null));
    setTimeout(() => done(null), 4000);
  });
  return val;
}

const READY = `(() => {
  const f = document.querySelector('.feed');
  if (!f) return 'nofeed';
  const n = document.querySelectorAll('.item').length;
  if (!n) return 'noitem';
  if (!document.getElementById('loadingView').hidden) return 'loading';
  return 'ready:' + n;
})()`;

async function main() {
  for (let k = 1; k <= ROUNDS; k++) {
    sh(`adb -s ${DEV} shell "am force-stop com.nas.douyin"`);
    await sleep(1200);
    const t0 = Date.now();
    sh(`adb -s ${DEV} shell "am start -n com.nas.douyin/.MainActivity" >/dev/null 2>&1`);

    let state = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      state = await probe(READY);
      if (state && state.startsWith('ready:')) break;
    }
    const ms = Date.now() - t0;
    console.log(`第 ${k} 轮  冷启动→首屏可见 = ${(ms / 1000).toFixed(1)} s   (${state})`);

    const extra = await probe(`JSON.stringify({
      DOM节点: document.getElementsByTagName('*').length,
      video元素: document.querySelectorAll('video').length,
      JS堆MB: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : null,
    })`);
    console.log(`         ${extra}`);
  }
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
