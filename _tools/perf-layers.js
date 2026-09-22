/**
 * 结构性指标测量：合成层数量 + 布局/样式重算成本。
 *
 * 为什么不看帧率：这台模拟器**空转**就只有 p50=20ms / p90=36.6ms（≈50fps），
 * 绝对帧率测的是模拟器不是 App（§23 就栽在这里）。但下面这些量是**结构性**的，
 * 在真机上同样成立：
 *   · 合成层数量 / 每层的合成原因（LayerTree.compositingReasons）
 *   · 一次滑动带来的 LayoutCount / RecalcStyleCount / 各自耗时
 *
 * 用法：
 *   node _tools/perf-layers.js                       # 现状
 *   node _tools/perf-layers.js --css '.item{will-change:auto}'
 */
const http = require('http');

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const css = args.includes('--css') ? args[args.indexOf('--css') + 1] : null;
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : (css === null ? '现状' : `对照：${css}`);

  const targets = await getJson('http://127.0.0.1:9222/json');
  const page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1:8099/.test(t.url));
  if (!page) throw new Error('找不到 App 的 WebView 页面');
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map(); const events = [];
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    } else if (m.method) events.push(m);
  });
  await new Promise((r) => ws.on('open', r));
  const evaluate = async (expr, awaitPromise) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: !!awaitPromise });
    if (r.exceptionDetails) throw new Error('页面 JS 异常: ' + JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    return r.result && r.result.value;
  };

  // 注入对照样式
  if (css !== null) {
    await evaluate(`(() => { let s = document.getElementById('perf-css');
      if (!s) { s = document.createElement('style'); s.id = 'perf-css'; document.head.appendChild(s); }
      s.textContent = ${JSON.stringify(css)}; return 'ok'; })()`);
  } else {
    await evaluate(`(() => { const s = document.getElementById('perf-css'); if (s) s.remove(); return 'ok'; })()`);
  }

  /* ---------- ① 合成层 ---------- */
  await send('LayerTree.enable');
  events.length = 0;
  await evaluate(`(() => { document.querySelector('.feed').scrollTop += 1; return 'ok'; })()`);
  await new Promise((r) => setTimeout(r, 900));
  const layerEv = events.filter((e) => e.method === 'LayerTree.layerTreeDidChange').pop();
  const layers = (layerEv && layerEv.params && layerEv.params.layers) || [];

  // 每层的合成原因（只问前 25 层，避免太久）
  const reasonCount = {};
  let bigLayers = 0;
  for (const L of layers.slice(0, 25)) {
    try {
      const r = await send('LayerTree.compositingReasons', { layerId: L.layerId });
      for (const s of (r.compositingReasons || [])) reasonCount[s] = (reasonCount[s] || 0) + 1;
    } catch (_) {}
  }
  const fullScreen = layers.filter((L) => L.width >= 1080 && L.height >= 1900).length;

  /* ---------- ② 一次滑动的布局/样式成本 ---------- */
  await send('Performance.enable');
  const M = async () => {
    const r = await send('Performance.getMetrics');
    const o = {}; for (const m of r.metrics) o[m.name] = m.value; return o;
  };
  const a = await M();
  await evaluate(`(async () => {
    const feed = document.querySelector('.feed');
    feed.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 1200));
    const mk = (t, y) => new PointerEvent(t, { bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 180, clientY: y, buttons: t === 'pointerup' ? 0 : 1 });
    feed.dispatchEvent(mk('pointerdown', 560));
    for (let k = 1; k <= 66; k++) {
      feed.dispatchEvent(mk('pointermove', 560 - 520 * (k / 66)));
      await new Promise((r) => setTimeout(r, 8));
    }
    feed.dispatchEvent(mk('pointerup', 40));
    await new Promise((r) => setTimeout(r, 1200));
    return 'ok';
  })()`, true);
  const b = await M();
  const d = (k) => Math.round(((b[k] || 0) - (a[k] || 0)) * 1000) / 1000;

  console.log(`\n【${label}】`);
  console.log(`  合成层总数 ${layers.length}（其中整屏尺寸 ${fullScreen} 层）`);
  const rs = Object.entries(reasonCount).sort((x, y) => y[1] - x[1]);
  console.log(`  前 25 层的合成原因：` + (rs.length ? rs.map(([k, v]) => `${k}×${v}`).join('  ') : '(没取到)'));
  console.log(`  一次滑动：Layout ${d('LayoutCount')} 次 / ${(d('LayoutDuration') * 1000).toFixed(0)}ms` +
              `   RecalcStyle ${d('RecalcStyleCount')} 次 / ${(d('RecalcStyleDuration') * 1000).toFixed(0)}ms`);
  console.log(`            Script ${(d('ScriptDuration') * 1000).toFixed(0)}ms   Task ${(d('TaskDuration') * 1000).toFixed(0)}ms` +
              `   堆内存 ${(d('JSHeapUsedSize') / 1048576).toFixed(1)}MB`);
  ws.close();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
