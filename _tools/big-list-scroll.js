/* 大列表滚动实测（2026-09-18：片库从 549 涨到 5231 条之后）                       *
 * --------------------------------------------------------------------------- *
 * ⚠️ 用**真触摸**（adb input swipe），不用合成事件 —— 竖向滚动已经交回浏览器原生   *
 *    scroll-snap，JS 派发 pointer 事件根本不会滚动。                            *
 *                                                                             *
 * 判据：                                                                       *
 *   ① 帧间隔分布（p50 / p90 / 长帧数）—— 跟同机空转基线比，不能看绝对值         *
 *   ② 一次快甩跨过多少条 —— content-visibility:auto 有没有真的跳过视口外的       *
 *   ③ 滚动到底后 DOM 规模有没有继续膨胀                                        *
 * --------------------------------------------------------------------------- */
const { spawn } = require('child_process');
const WebSocket = require('ws');

const DEV = 'emulator-5554';
const args = process.argv.slice(2);
const SWIPES = Number((args.find((a) => a.startsWith('--swipes=')) || '--swipes=3').split('=')[1]);
const DIST = (args.find((a) => a.startsWith('--dist=')) || '--dist=900').split('=')[1];
const DUR = (args.find((a) => a.startsWith('--dur=')) || '--dur=400').split('=')[1];
/* ⚠️ 起手点 y 必须避开进度条热区（CSS 540~566 = 设备 1693~1771，那儿 touch-action:none），
   且**位移要超过半屏**（616 CSS px / 2 = 308 = 设备 924），否则原生 scroll-snap 会正确回弹
   —— 那不是卡，是「没翻过去」，会得出「跨过 0 条」的假象（§40.7 同样的坑）。 */
const FROM = (args.find((a) => a.startsWith('--from=')) || '--from=1600').split('=')[1];

let ws, id = 0;
const waiting = new Map();
function send(method, params) {
  return new Promise((res, rej) => {
    const mid = ++id;
    waiting.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
async function evaluate(expr, awaitPromise = false) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise,
  });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
  return r.result.value;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const list = await new Promise((res, rej) => {
    const http = require('http');
    http.get('http://127.0.0.1:9222/json', (r) => {
      let b = ''; r.on('data', (c) => { b += c; });
      r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('找不到可调试页面');

  ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r) => ws.on('open', r));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id).res(m.result); waiting.delete(m.id); }
  });
  await send('Runtime.enable');

  // ---- 0. 场景事实 ----
  const facts = JSON.parse(await evaluate(`(() => {
    const items = [...document.querySelectorAll('.item')];
    return JSON.stringify({
      item数: items.length,
      DOM节点数: document.getElementsByTagName('*').length,
      scrollHeight: document.querySelector('.feed').scrollHeight,
      屏高: document.querySelector('.feed').clientHeight,
      video元素: document.querySelectorAll('video').length,
    });
  })()`));
  console.log(`场景：${facts.item数} 条 / ${facts.DOM节点数} 个 DOM 节点 / ` +
    `${facts.video元素} 个 video / 滚动高度 ${(facts.scrollHeight / 1000).toFixed(0)}k px`);

  // ---- 1. 空转基线（同一台机器，不做手势）----
  const idle = JSON.parse(await evaluate(`(async () => {
    const d = [];
    let last = performance.now();
    await new Promise((res) => {
      let n = 0;
      const step = (t) => { d.push(t - last); last = t; if (++n < 120) requestAnimationFrame(step); else res(); };
      requestAnimationFrame(step);
    });
    d.shift();
    return JSON.stringify(d);
  })()`, true));
  const idleStat = stat(idle);
  console.log(`基线（空转）      p50=${idleStat.p50.toFixed(1)}ms  p90=${idleStat.p90.toFixed(1)}ms  ` +
    `长帧(>32ms)=${idleStat.longs}/${idleStat.n}`);

  // ---- 2. 真触摸快甩若干次 ----
  for (let k = 0; k < SWIPES; k++) {
    await evaluate(`(() => {
      window.__sr = { raf: [], sc: [] };
      const f = document.querySelector('.feed');
      window.__sr.t0 = performance.now();
      const step = (t) => { window.__sr.raf.push(t); requestAnimationFrame(step); };
      window.__sr.rafId = requestAnimationFrame(step);
      f.addEventListener('scroll', () => window.__sr.sc.push(f.scrollTop), { passive: true });
      return 'armed';
    })()`);

    const swipe = spawn('adb', ['-s', DEV, 'shell', 'input', 'swipe',
      '540', String(FROM), '540', String(Number(FROM) - Number(DIST)), DUR]);
    await new Promise((r) => swipe.on('exit', r));
    await sleep(2000);

    const r = JSON.parse(await evaluate(`(() => {
      cancelAnimationFrame(window.__sr.rafId);
      const f = document.querySelector('.feed');
      const raf = window.__sr.raf, sc = window.__sr.sc;
      return JSON.stringify({
        raf, sc,
        from: sc.length ? sc[0] : f.scrollTop,
        to: f.scrollTop,
      });
    })()`));
    const st = stat(r.raf.slice(1).map((t, i) => t - r.raf[i]));
    const crossed = Math.abs(r.to - r.from) / facts.屏高;
    console.log(`第 ${k + 1} 次快甩      p50=${st.p50.toFixed(1)}ms  p90=${st.p90.toFixed(1)}ms  ` +
      `max=${st.max.toFixed(0)}ms  长帧(>32ms)=${st.longs}/${st.n}  ` +
      `跨过 ${crossed.toFixed(1)} 条  scroll 事件 ${r.sc.length} 次`);
  }

  // ---- 3. 滚完一轮后 DOM 有没有继续膨胀 ----
  const after = JSON.parse(await evaluate(`(() => JSON.stringify({
    item数: document.querySelectorAll('.item').length,
    DOM节点数: document.getElementsByTagName('*').length,
    video元素: document.querySelectorAll('video').length,
  }))()`));
  console.log(`滚完一轮后        ${after.item数} 条 / ${after.DOM节点数} 个 DOM 节点 / ${after.video元素} 个 video`);

  ws.close();
}

function stat(a) {
  const s = [...a].filter((x) => x > 0).sort((x, y) => x - y);
  if (!s.length) return { n: 0, p50: 0, p90: 0, max: 0, longs: 0 };
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return {
    n: s.length, p50: q(0.5), p90: q(0.9), max: s[s.length - 1],
    longs: s.filter((x) => x > 32).length,
  };
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1); });
