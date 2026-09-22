/**
 * 用 CDP 的 Profiler 抓一次滑动期间的**主线程 CPU 采样**，按函数聚合 self time。
 *
 * 这是唯一能回答「时间到底花在哪个函数」的工具 —— 帧率、布局次数都只能告诉你
 * 「慢」，不能告诉你「谁慢」。
 *
 * 用法：
 *   node _tools/perf-profile.js                 # 现状
 *   node _tools/perf-profile.js --top 25
 *   node _tools/perf-profile.js --css '.item{content-visibility:visible}'
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
  const top = Number(args.includes('--top') ? args[args.indexOf('--top') + 1] : 18);
  const label = args.includes('--label') ? args[args.indexOf('--label') + 1] : (css === null ? '现状' : `对照：${css}`);

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

  if (css !== null) {
    await evaluate(`(() => { let s = document.getElementById('perf-css');
      if (!s) { s = document.createElement('style'); s.id = 'perf-css'; document.head.appendChild(s); }
      s.textContent = ${JSON.stringify(css)}; return 'ok'; })()`);
  } else {
    await evaluate(`(() => { const s = document.getElementById('perf-css'); if (s) s.remove(); return 'ok'; })()`);
  }

  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: 200 });   // 200us，够细

  // ⚠️ 预热（等视频起播、滚回顶部）必须放在**采样窗口之外**。
  //    第一版把它框进来了，于是 1.5s 的纯等待把「空闲」稀释到 95%，
  //    得出了「主线程完全没事干」的假结论。这是个纯粹的度量错误。
  await evaluate(`(async () => {
    const feed = document.querySelector('.feed');
    feed.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 1500));
    return 'warm';
  })()`, true);

  await send('Profiler.start');
  await evaluate(`(async () => {
    const feed = document.querySelector('.feed');
    const mk = (t, y) => new PointerEvent(t, { bubbles: true, cancelable: true, composed: true,
      pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: 180, clientY: y, buttons: t === 'pointerup' ? 0 : 1 });
    feed.dispatchEvent(mk('pointerdown', 560));
    for (let k = 1; k <= 66; k++) {
      feed.dispatchEvent(mk('pointermove', 560 - 520 * (k / 66)));
      await new Promise((r) => setTimeout(r, 8));
    }
    feed.dispatchEvent(mk('pointerup', 40));
    await new Promise((r) => setTimeout(r, 300));
    return 'ok';
  })()`, true);
  const { profile } = await send('Profiler.stop');

  // 按 self time 聚合
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] || 0;
    total += dt;
    self.set(profile.samples[i], (self.get(profile.samples[i]) || 0) + dt);
  }
  const agg = new Map();
  for (const [nid, us] of self) {
    const n = byId.get(nid); if (!n) continue;
    const cf = n.callFrame || {};
    const url = (cf.url || '').replace(/^.*\//, '');
    const key = `${cf.functionName || '(anonymous)'}  @${url}:${(cf.lineNumber || 0) + 1}`;
    agg.set(key, (agg.get(key) || 0) + us);
  }
  const rows = [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, top);
  console.log(`\n【${label}】采样 ${profile.samples.length} 个，合计 ${(total / 1000).toFixed(0)}ms`);
  console.log('  self time 排行（只算「自己烧的」，不含子调用）：');
  for (const [k, us] of rows) {
    const pctv = ((us / total) * 100).toFixed(1);
    console.log(`    ${(us / 1000).toFixed(1).padStart(7)}ms  ${pctv.padStart(5)}%   ${k}`);
  }
  // 按「大类」再聚合一次，便于看整体构成
  const bucket = {};
  for (const [k, us] of agg) {
    let b = '其它';
    if (/\(program\)|\(idle\)/.test(k)) b = '(空闲/浏览器内部)';
    else if (/@app\.js/.test(k)) b = 'app.js 脚本';
    else if (/Layout|layout|UpdateLayoutTree|Recalc/.test(k)) b = '样式/布局';
    else if (/Paint|paint|Raster|Composite/.test(k)) b = '绘制/合成';
    else if (/Timer|setTimeout|Interval/.test(k)) b = '定时器';
    bucket[b] = (bucket[b] || 0) + us;
  }
  console.log('  按大类：');
  for (const [b, us] of Object.entries(bucket).sort((x, y) => y[1] - x[1])) {
    console.log(`    ${(us / 1000).toFixed(1).padStart(7)}ms  ${((us / total) * 100).toFixed(1).padStart(5)}%   ${b}`);
  }
  ws.close();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
