/**
 * 用 **真实输入**（CDP Input.dispatchTouchEvent）测滑动流畅性。
 *
 * 为什么要重做：`perf-swipe.js` 注入的是**合成 PointerEvent**，实测在本 App 里
 * 根本推不动原生 scroll-snap（scrollTop 纹丝不动），量出来的「跟手滞后」是假数据。
 * 本工具走 CDP 输入通道 → Chromium 当成真手指 → 合成器线程正常滚动，
 * 量到的帧间隔 / longtask 才是用户真实体感。
 *
 * 用法：
 *   node _tools/perf-real.js                 # 基线
 *   node _tools/perf-real.js --repeat 3
 *   node _tools/perf-real.js --css '.tb-icon{backdrop-filter:none}'   # CSS 对照
 *
 * ⚠️ 前提：adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>
 */
const http = require('http');

const getJson = (url) => new Promise((res, rej) => {
  http.get(url, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const targets = await getJson('http://127.0.0.1:9222/json');
  const page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1:8099/.test(t.url));
  if (!page) throw new Error('找不到 App 的 WebView 页面');
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map();
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    }
  });
  await new Promise((r) => ws.on('open', r));
  const evaluate = async (expr, awaitPromise) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result && r.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const HARNESS = `(() => {
  const P = window.__pr = window.__pr || { frames: [], longs: [], st0: 0, st1: 0, h: 0 };
  if (P.installed) return 'exists';
  P.installed = true;
  let last = performance.now();
  const step = (t) => {
    const c = document.querySelector('.feed');
    P.frames.push(+(t - last).toFixed(2));
    last = t;
    if (c) P.st = c.scrollTop;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longs.push(+e.duration.toFixed(1)); })
      .observe({ entryTypes: ['longtask'] });
  } catch (_) {}
  return 'ok';
})()`;

const RESET = `(() => { const P = window.__pr; P.frames.length = 0; P.longs.length = 0;
  const c = document.querySelector('.feed'); P.base = c ? c.scrollTop : -1; P.h = c ? c.clientHeight : 0; return 'ok'; })()`;
const READ = `(() => { const P = window.__pr; const c = document.querySelector('.feed');
  return JSON.stringify({ frames: P.frames, longs: P.longs, base: P.base, end: c ? c.scrollTop : -1, h: P.h }); })()`;

/**
 * 一次真实触摸上滑（看下一条）。
 *
 * 🔴 `Input.dispatchTouchEvent` 在本 WebView 上**推不动**原生 scroll-snap
 *    （实测 scrollTop 纹丝不动），而 `Input.synthesizeScrollGesture` 可以
 *    （实测一次正好 +616px = 一屏）。所以这里走后者，`gestureSourceType:'touch'`。
 */
async function touchSwipe(c, { x, y, dist }) {
  await c.send('Input.synthesizeScrollGesture', {
    x, y, xDistance: 0, yDistance: dist, speed: 900, gestureSourceType: 'touch',
  });
}

const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r1 = (x) => Math.round(x * 10) / 10;

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, dv) => { const i = args.indexOf(k); return i < 0 ? dv : args[i + 1]; };
  const css = args.includes('--css') ? args[args.indexOf('--css') + 1] : null;
  const repeat = Number(opt('--repeat', 1));
  const profile = args.includes('--profile');
  const label = opt('--label', css === null ? '基线' : `对照：${css}`);

  const c = await connect();
  await c.evaluate(HARNESS);
  if (profile) { await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 300 }); }
  if (css !== null) {
    await c.evaluate(`(() => { let s = document.getElementById('perf-css');
      if (!s) { s = document.createElement('style'); s.id = 'perf-css'; document.head.appendChild(s); }
      s.textContent = ${JSON.stringify(css)}; return 'ok'; })()`);
  } else {
    await c.evaluate(`(() => { const s = document.getElementById('perf-css'); if (s) s.remove(); return 'ok'; })()`);
  }

  for (let r = 1; r <= repeat; r++) {
    /* 定位到一个**固定的中段**再测（预热在采样窗口之外）。
       🔴 两个坑：
       1) 页面滚动是「平滑 + 吸附」的：直接写 scrollTop 会被当成长距离平滑滚动，
          读回的是动画中途的值 → 必须 `behavior:'instant'`。
       2) 从 scrollTop=0 起步时 `Input.synthesizeScrollGesture` 推不动（实测 Δ0，
          疑似被 overscroll-behavior-y:contain 吃掉第一个手势）；中段就正常。
          所以固定在 30 屏处测，别从 0 起。 */
    await c.evaluate(`(() => { const c = document.querySelector('.feed');
      c.scrollTo({ top: 616 * 30, behavior: 'instant' }); return Math.round(c.scrollTop); })()`);
    await sleep(1600);
    await c.evaluate(RESET);
    // 视口是 360×616 CSS px（dpr 3）—— 坐标必须落在这范围内，越界等于没摸到
    const g = { x: 180, y: 320, dist: -616 };
    if (profile) await c.send('Profiler.start');
    await touchSwipe(c, g);
    await sleep(1200);
    if (profile) {
      const { profile: prof } = await c.send('Profiler.stop');
      const byId = new Map(prof.nodes.map((n) => [n.id, n]));
      const self = new Map(); let total = 0;
      for (let i = 0; i < prof.samples.length; i++) {
        const dt = prof.timeDeltas[i] || 0; total += dt;
        self.set(prof.samples[i], (self.get(prof.samples[i]) || 0) + dt);
      }
      const agg = new Map();
      for (const [nid, us] of self) {
        const n = byId.get(nid); if (!n) continue; const cf = n.callFrame || {};
        const key = `${cf.functionName || '(anon)'}  @${(cf.url || '').replace(/^.*\//, '')}:${(cf.lineNumber || 0) + 1}`;
        agg.set(key, (agg.get(key) || 0) + us);
      }
      console.log(`  ── CPU self time 合计 ${(total / 1000).toFixed(0)}ms ──`);
      for (const [k, us] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)) {
        console.log(`    ${(us / 1000).toFixed(1).padStart(7)}ms  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
      }
    }
    const raw = JSON.parse(await c.evaluate(READ));
    const ds = raw.frames.filter((x) => x > 0);
    const drop = ds.filter((x) => x > 16.7).length;
    const dbl = ds.filter((x) => x > 33).length;
    const moved = Math.round(raw.end - raw.base);
    console.log(`\n【${label}${repeat > 1 ? '  #' + r : ''}】`);
    console.log(`  帧数 ${ds.length}  间隔 p50=${r1(pct(ds, 0.5))} p90=${r1(pct(ds, 0.9))} p99=${r1(pct(ds, 0.99))} max=${r1(Math.max(...ds, 0))} ms  (均值 ${r1(mean(ds))})`);
    console.log(`  掉帧(>16.7ms) ${drop} 次 (${r1((drop / (ds.length || 1)) * 100)}%)   重掉(>33ms) ${dbl} 次`);
    console.log(`  longtask ${raw.longs.length} 次，合计 ${r1(raw.longs.reduce((s, x) => s + x, 0))}ms，最长 ${r1(Math.max(...raw.longs, 0))}ms`);
    console.log(`  实际滚动 ${Math.round(raw.base)} → ${Math.round(raw.end)}（Δ${moved}px，屏高 ${raw.h}）`);
  }
  c.close();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
