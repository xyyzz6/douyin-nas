/**
 * 翻页流畅性的**量化**测量台。
 *
 * 为什么必须重新做一个：
 *   §23 那个 CDP 基准是「注入 15Hz 的 pointermove，看 scrollTop 序列」——
 *   注入频率本身就低于刷新率，压根触发不了「每事件直写 scrollTop」要治的场景，
 *   于是**修复版和旧版跑出一模一样的结果**。那个实验测不出差异，等于没测。
 *
 * 本工具的做法：
 *   ① 在页面里以 **125Hz（8ms）** 注入合成 pointer 事件 —— 高于 60Hz 刷新率，
 *      才能暴露「同一帧里重复做重活」的问题。事件与采样在**同一个时钟**里，
 *      所以「手指在哪 / 画面滚到哪」可以逐帧对齐，能算出真正的**跟手滞后**。
 *   ② 每帧记 `{d: 帧间隔, st: scrollTop, t}`；另用 PerformanceObserver 收 longtask。
 *   ③ 可选 `--css` 注入一段样式做**对照实验**（逐个关掉可疑的 CSS 属性），
 *      这样「到底哪个属性在拖后腿」是量出来的，不是猜的。
 *
 * 用法：
 *   node _tools/perf-swipe.js                        # 基线
 *   node _tools/perf-swipe.js --css '.item{will-change:auto}'   # 关掉 will-change
 *   node _tools/perf-swipe.js --css '' --repeat 3
 *   node _tools/perf-swipe.js --touch                 # 走 CDP 真触摸（Input.dispatchTouchEvent）
 *
 * ⚠️ 前提：`adb forward tcp:9222 localabstract:webview_devtools_remote_<PID>`
 */
const http = require('http');

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

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

/* ---------- 页面里装一次采样器 ---------- */
const HARNESS = `(() => {
  if (window.__perf && window.__perf.ready) return 'exists';
  const P = window.__perf = { ready: true, frames: [], longs: [], expect: [], y0: 0, base: 0, h: 0 };
  let last = performance.now();
  const step = (t) => {
    const c = document.querySelector('.feed');
    P.frames.push({ d: +(t - last).toFixed(2), t: +t.toFixed(1), st: c ? +c.scrollTop.toFixed(1) : -1 });
    last = t;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longs.push(+e.duration.toFixed(1)); })
      .observe({ entryTypes: ['longtask'] });
  } catch (_) {}
  return 'ok';
})()`;

/* ---------- 一次 125Hz 的合成手势 ---------- */
const RUN = `(async (o) => {
  const P = window.__perf;
  const feed = document.querySelector('.feed');
  P.frames.length = 0; P.longs.length = 0; P.expect.length = 0;
  P.y0 = o.y0; P.base = feed.scrollTop; P.h = feed.clientHeight;

  // 先把位置摆正，等视频起播，再开始量 —— 否则每次测的状态都不一样
  feed.scrollTop = o.resetTo;
  await new Promise((r) => setTimeout(r, o.warmup));

  P.frames.length = 0; P.longs.length = 0;
  P.base = feed.scrollTop;

  const mk = (type, y) => new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true,
    pointerId: 1, pointerType: 'touch', isPrimary: true,
    clientX: o.x, clientY: y, buttons: type === 'pointerup' ? 0 : 1, button: 0,
  });
  const stepMs = o.ms / o.n, dy = o.dy;
  feed.dispatchEvent(mk('pointerdown', o.y0));
  let k = 0;
  await new Promise((resolve) => {
    const iv = setInterval(() => {
      k++;
      const y = o.y0 + dy * (k / o.n);
      P.expect.push({ t: +performance.now().toFixed(1), y: +y.toFixed(1) });
      feed.dispatchEvent(mk('pointermove', y));
      if (k >= o.n) { clearInterval(iv); feed.dispatchEvent(mk('pointerup', o.y0 + dy)); resolve(); }
    }, stepMs);
  });
  await new Promise((r) => setTimeout(r, o.settle));
  return JSON.stringify({ h: P.h, base: P.base, y0: P.y0, end: feed.scrollTop, frames: P.frames, longs: P.longs, expect: P.expect });
})`;

/* ---------- 统计 ---------- */
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const r1 = (x) => Math.round(x * 10) / 10;

function report(label, d, h) {
  const f = d.frames.filter((x) => x.d > 0);
  const ds = f.map((x) => x.d);
  const drop = ds.filter((x) => x > 16.7).length;
  const dbl = ds.filter((x) => x > 33).length;

  // 跟手滞后：把「手指位置」按时间插值成「画面应该在哪」，再和真实 scrollTop 比
  const ex = d.expect;
  const t0 = ex.length ? ex[0].t : 0, t1 = ex.length ? ex[ex.length - 1].t : 0;
  const lags = [];
  if (ex.length > 1) {
    for (const fr of f) {
      if (fr.t < t0 || fr.t > t1) continue;
      let i = 0;
      while (i < ex.length - 1 && ex[i + 1].t < fr.t) i++;
      const a = ex[i], b = ex[Math.min(i + 1, ex.length - 1)];
      const u = b.t === a.t ? 0 : (fr.t - a.t) / (b.t - a.t);
      const y = a.y + (b.y - a.y) * u;
      // app.js: pager.applied = base - (clientY - pager.y0)
      const want = Math.max(0, d.base - (y - d.y0));
      lags.push(Math.abs(want - fr.st));
    }
  }
  const longs = d.longs;
  console.log(`\n【${label}】`);
  console.log(`  帧数 ${ds.length}  帧间隔 p50=${r1(pct(ds, 0.5))} p90=${r1(pct(ds, 0.9))} p99=${r1(pct(ds, 0.99))} max=${r1(Math.max(...ds, 0))} ms`);
  console.log(`  掉帧(>16.7ms) ${drop} 次 (${r1((drop / (ds.length || 1)) * 100)}%)   重掉(>33ms) ${dbl} 次`);
  console.log(`  longtask ${longs.length} 次，合计 ${r1(longs.reduce((s, x) => s + x, 0))} ms，最长 ${r1(Math.max(...longs, 0))} ms`);
  console.log(`  跟手滞后 |期望-实际| 平均 ${r1(mean(lags))}px  p90 ${r1(pct(lags, 0.9))}px  max ${r1(Math.max(...lags, 0))}px`);
  console.log(`  滚动 ${d.base} → ${d.end}（屏高 ${d.h}）`);
  return { ds, drop, dbl, longs, lags };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, dv) => { const i = args.indexOf(k); return i < 0 ? dv : args[i + 1]; };
  const css = args.includes('--css') ? args[args.indexOf('--css') + 1] : null;
  const repeat = Number(opt('--repeat', 1));
  const touch = args.includes('--touch');
  const label = opt('--label', css === null ? '基线（未改任何东西）' : `对照：${css || '(清空注入)'}`);

  const c = await connect();
  await c.evaluate(HARNESS);
  if (css !== null) {
    await c.evaluate(`(() => { let s = document.getElementById('perf-css');
      if (!s) { s = document.createElement('style'); s.id = 'perf-css'; document.head.appendChild(s); }
      s.textContent = ${JSON.stringify(css)}; return 'ok'; })()`);
  } else {
    await c.evaluate(`(() => { const s = document.getElementById('perf-css'); if (s) s.remove(); return 'ok'; })()`);
  }

  const o = { x: 180, y0: 560, dy: -520, n: 66, ms: 520, settle: 1100, warmup: 1400, resetTo: 0 };
  for (let r = 1; r <= repeat; r++) {
    const raw = await c.evaluate(`${RUN}(${JSON.stringify(o)})`, true);
    report(repeat > 1 ? `${label}  #${r}` : label, JSON.parse(raw), o);
  }
  c.close();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
