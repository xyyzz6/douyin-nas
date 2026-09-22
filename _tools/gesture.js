/**
 * 跟手度测量仪 —— 用 CDP 往页面里**注入真实节奏的 pointer 事件流**，量三件事：
 *
 *   ① 跟手延迟：每帧发一个 pointermove，同时读 scrollTop，算「手指位移」和
 *      「画面位移」的差。差值越大 = 越不跟手。
 *   ② 落点：松手后停在**第几条**（对比应该停在第几条）。
 *   ③ 回弹：短拖之后有没有回到起手那一条。
 *
 * ⚠️⚠️ 为什么不能用 `adb shell input swipe`：
 *   它是**匀速插值 + 直接跳到终点**的，中间只有 25~40 个合成事件，
 *   而且抬手那一刻手指已经"瞬移"到终点了 —— 它只能测「落在第几条」，
 *   永远测不出「跟不跟手」。跟手是**逐帧**的事，必须在页面里按帧喂事件。
 *
 * 用法：
 *   node _tools/gesture.js [serial]          跑全部用例
 *   node _tools/gesture.js emulator-5554 --lag   只测跟手延迟
 */
const { execSync } = require('child_process');
const WebSocket = require('ws');

const ADB = process.env.ADB || 'D:/leidian/LDPlayer14/adb.exe';
const SERIAL = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '';
const ONLY = process.argv.find((a) => a.startsWith('--')) || '';
const A = SERIAL ? `${ADB} -s ${SERIAL}` : ADB;
const PORT = Number(process.env.ADB_PORT || (SERIAL === '6518ec54' ? 9224 : 9223));

const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = sh(`${A} shell "cat /proc/net/unix | grep webview_devtools"`);
  const pid = (/remote_(\d+)/.exec(out) || [])[1];
  if (!pid) { console.error('找不到 webview socket:', out); process.exit(1); }
  sh(`${A} forward tcp:${PORT} localabstract:webview_devtools_remote_${pid}`);
  const list = await new Promise((res, rej) => {
    require('http').get(`http://127.0.0.1:${PORT}/json/list`, (r) => {
      let b = ''; r.on('data', (d) => b += d); r.on('end', () => res(b));
    }).on('error', rej);
  });
  const page = JSON.parse(list).find((x) => x.type === 'page');
  if (!page) { console.error('没有 page:', list.slice(0, 300)); process.exit(1); }
  console.error(`# 设备 ${SERIAL || '(默认)'} pid=${pid} tcp:${PORT}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
  let id = 0; const pend = new Map();
  ws.on('message', (m) => {
    const r = JSON.parse(m);
    if (r.id && pend.has(r.id)) { pend.get(r.id)(r); pend.delete(r.id); }
  });
  const call = (method, params) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => ws.on('open', r));

  const evalJs = async (expr) => {
    const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval err');
    }
    return r.result?.result?.value;
  };

  // ⚠️ 页面的 performance.now() 和宿主 Node 的 Date.now() **时间原点不同**，
  //    直接相减会得到 -1789698342758 这种鬼数字。统一用页面自己的时钟。
  const pageNow = async () => await evalJs(`performance.now()`);

  // ---- 装测量钩子：在页面里记录每帧「手指 y」和「scrollTop」----
  await evalJs(`
    (() => {
      const c = document.querySelector('.feed') || document.getElementById('feed');
      if (!c) return 'no feed';
      window.__g = { c, log: [], on: false, snap: [] };
      // 拿真实的 scrollTop，不走任何缓存
      const tick = () => {
        if (window.__g.on) {
          window.__g.log.push([performance.now(), window.__g.fy, c.scrollTop]);
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      // 记录每次 scroll 落点
      c.addEventListener('scroll', () => {
        window.__g.snap.push(c.scrollTop);
      }, { passive: true });
      return 'ok';
    })()
  `);

  /**
   * 用 CDP 的 Input.dispatchTouchEvent 发一条**按帧**的触摸轨迹。
   * ⚠️ 这里必须用 touch 而不是 mouse：页面挂的是 pointer 事件，
   *    而 Android WebView 上 pointerType 会被识别成 touch。
   *    用 mouse 的话 touch-action / 指针类型都对不上，测出来的不是真实路径。
   */
  const trace = async (fromY, toY, ms, steps) => {
    // 起手前先记一个**干净基线**：手指在 fromY、画面在 scrollTop
    await evalJs(`
      (window.__g.log.length = 0, window.__g.snap.length = 0,
       window.__g.on = true, window.__g.fy = ${fromY},
       window.__g.y0 = ${fromY}, window.__g.st0 = window.__g.c.scrollTop, 'ok')
    `);
    const x = 180;                       // 屏幕水平中间（CSS px）
    const dt = ms / steps;
    const T0 = await pageNow();
    await call('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x, y: fromY }],
    });
    for (let k = 1; k <= steps; k++) {
      const y = fromY + (toY - fromY) * (k / steps);
      // 手指 y 先记下来，rAF 采样时会带上它 —— 这样「手指在这帧走到哪」和
      // 「画面在这帧滚到哪」是同一个时间点的，差值才是真延迟
      await evalJs(`(window.__g.fy = ${y}, 'ok')`);
      await call('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: [{ x, y }],
      });
      await sleep(dt);
    }
    await evalJs(`(window.__g.fy = ${toY}, 'ok')`);
    await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const tEnd = await pageNow();
    await sleep(800);                    // 等 smooth 收尾
    await evalJs(`(window.__g.on = false, 'ok')`);
    return {
      samples: await evalJs(`JSON.stringify(window.__g.log.slice(0, 400))`),
      final: await evalJs(`window.__g.c.scrollTop`),
      snaps: await evalJs(`JSON.stringify(window.__g.snap.slice(-12))`),
      t0: T0, tEnd,
    };
  };

  const reset = async (i) => {
    await evalJs(`
      (() => {
        const c = window.__g.c;
        c.style.scrollSnapType = 'none';
        c.scrollTop = ${i} * c.clientHeight;
        c.style.scrollSnapType = '';
        return c.scrollTop;
      })()
    `);
    await sleep(400);
  };

  const geo = await evalJs(`(()=>{const c=window.__g.c;return JSON.stringify({h:c.clientHeight,n:c.children.length,top:c.scrollTop})})()`);
  const { h } = JSON.parse(geo);
  console.error(`# feed clientHeight=${h}  条数=${JSON.parse(geo).n}`);

  /* ---------------- ① 跟手延迟 ---------------- */
  if (!ONLY || ONLY === '--lag') {
    await reset(2);
    const r = await trace(500, 260, 400, 20);   // 240 CSS px ↑，400ms，20 帧
    const S = JSON.parse(r.samples);
    const Y0 = 500, ST0 = 2 * h;                // 用明确的起手基线，不用采样的第一条
    let worst = 0, sum = 0, cnt = 0;
    const rows = [];
    for (const [t, fy, st] of S) {
      if (fy == null) continue;
      const finger = Y0 - fy;             // 手指往上走了多少（正）
      const pic = st - ST0;               // 画面跟着滚了多少（正）
      const gap = finger - pic;           // 滞后量（正 = 画面落后于手指）
      worst = Math.max(worst, gap);
      sum += Math.abs(gap); cnt++;
      if (cnt % 4 === 0) rows.push({ t: Math.round(t - r.t0), finger: +finger.toFixed(1), pic: +pic.toFixed(1), gap: +gap.toFixed(1) });
    }
    console.log(`\n① 跟手延迟（拖 240px / 400ms，20 帧；基线 手指@500 画面@${ST0}）`);
    for (const g of rows) console.log(`   t=${g.t}ms  手指↑${g.finger}  画面↑${g.pic}  滞后=${g.gap}px`);
    console.log(`   平均滞后 ${(sum / (cnt || 1)).toFixed(1)}px   最大滞后 ${worst.toFixed(1)}px`);
    console.log(`   松手落在 scrollTop=${r.final} → 第 ${(r.final / h).toFixed(2)} 条`);
  }

  /* ---------------- ② 落点 ---------------- */
  if (!ONLY || ONLY === '--land') {
    console.log(`\n② 落点（每次先回到第 3 条，h=${h}）`);
    const cases = [
      { name: '短慢拖 60px/300ms  → 期望 弹回第3条', from: 500, to: 440, ms: 300, exp: 3 },
      { name: '中速拖 200px/400ms → 期望 第4条', from: 500, to: 300, ms: 400, exp: 4 },
      { name: '大拖  400px/400ms → 期望 第4条', from: 600, to: 200, ms: 400, exp: 4 },
      { name: '快甩  200px/120ms → 期望 第4条', from: 520, to: 320, ms: 120, exp: 4 },
      { name: '下拖  200px/400ms → 期望 第2条', from: 300, to: 500, ms: 400, exp: 2 },
    ];
    for (const c of cases) {
      await reset(3);
      const r = await trace(c.from, c.to, c.ms, Math.max(8, Math.round(c.ms / 20)));
      const got = +(r.final / h).toFixed(2);
      const ok = Math.abs(got - c.exp) < 0.06;
      console.log(`   ${ok ? '✓' : '✗'} ${c.name}  → 实得第 ${got} 条  (scrollTop=${r.final})`);
    }
  }

  /* ---------------- ③ 回弹 ---------------- */
  if (!ONLY || ONLY === '--bounce') {
    console.log(`\n③ 回弹（在第 5 条上做极短拖）`);
    for (const dy of [8, 20, 40]) {
      await reset(5);
      const r = await trace(400, 400 + dy, 200, 10);
      const got = +(r.final / h).toFixed(2);
      console.log(`   ${Math.abs(got - 5) < 0.06 ? '✓' : '✗'} 下拖 ${dy}px → 第 ${got} 条（期望 5）`);
    }
    for (const dy of [8, 20, 40]) {
      await reset(5);
      const r = await trace(400, 400 - dy, 200, 10);
      const got = +(r.final / h).toFixed(2);
      console.log(`   ${Math.abs(got - 5) < 0.06 ? '✓' : '✗'} 上拖 ${dy}px → 第 ${got} 条（期望 5）`);
    }
  }

  ws.close();
  process.exit(0);
})();
