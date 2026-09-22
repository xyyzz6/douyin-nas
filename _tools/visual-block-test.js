/**
 * 视觉判定：**滚动已经开始之后**堵死主线程，画面还走不走？
 *
 * ⚠️ 实验设计上踩过两个坑，都记在这里，别再犯：
 *   ① 先堵住、再起手势 → 整段手势直接死掉（scrollTop 全程 0）。
 *      原因：合成器要**先拿到主线程对第一个 touchmove 的 ack**（确认没有
 *      preventDefault）才敢自己接管滚动。所以必须「滚动已经开始」再堵。
 *   ② 不等片库加载稳定就开始测 → 片库异步加载完成会在中途把列表整个重建，
 *      截图 A 和 B 里的 item[0] 根本不是同一条视频，结论全废。
 *
 * 判据用**截图**而不是 scrollTop：scrollTop 是主线程属性，合成器滚动时它不更新，
 * 数值上分不开「合成器在滚」和「JS 把积压的事件一次补上」。
 * 做法是给每条 .item 注入一个大号序号（纯 CSS `content:attr(data-i)`，不动业务代码）。
 *
 * 用法：node _tools/visual-block-test.js
 */
const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => { let s = ''; r.on('data', (d) => (s += d)); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej);
  });
}


/* 用注入的方式**复现旧架构**：touch-action:none + rAF 里写 scrollTop。
   这样 A/B 两轮不用来回重装 APK，而且除了「谁在驱动滚动」之外其他条件完全一致。 */
const LEGACY_SIM = `(() => {
  let s = document.getElementById('legacy-css');
  if (!s) { s = document.createElement('style'); s.id = 'legacy-css'; document.head.appendChild(s); }
  s.textContent = '.feed{touch-action:none !important}';
  const feed = document.querySelector('.feed');
  const P = { active: false, y0: 0, base: 0, applied: 0, dirty: false };
  (function r() { requestAnimationFrame(r); if (P.dirty) { P.dirty = false; if (P.active) feed.scrollTop = P.applied; } })();
  const T = (e) => (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
  feed.addEventListener('touchstart', (e) => { const t = T(e); P.active = true; P.y0 = t.clientY;
    P.base = feed.scrollTop; P.applied = P.base;
    // ⚠️ 必须跟旧代码一样先把吸附关掉：mandatory 的 scroll-snap 会把程序化写入的
    //    scrollTop 立刻吸回最近一条（实测写 198 读回 0），不关就完全滚不动。
    feed.style.scrollSnapType = 'none'; }, { passive: true });
  feed.addEventListener('touchmove', (e) => { const t = T(e); const dy = t.clientY - P.y0;
    const max = Math.max(0, feed.scrollHeight - feed.clientHeight);
    P.applied = Math.max(0, Math.min(max, P.base - dy)); P.dirty = true; }, { passive: true });
  feed.addEventListener('touchend', () => { P.active = false; P.dirty = false;
    const h = feed.clientHeight || 616;
    feed.style.scrollSnapType = '';
    feed.scrollTo({ top: Math.round(P.applied / h) * h, behavior: 'smooth' }); }, { passive: true });
  return 'legacy sim armed';
})()`;

const MARKER = `(() => { let s = document.getElementById('ta-marker');
  if (!s) { s = document.createElement('style'); s.id = 'ta-marker'; document.head.appendChild(s); }
  s.textContent = '.item::before{content:attr(data-i);position:absolute;top:10px;left:10px;' +
    'font:900 120px/1 sans-serif;color:#0f0;z-index:999;text-shadow:0 0 12px #000;pointer-events:none}';
  return 'marker'; })()`;

async function shoot(file) {
  await new Promise((res) => {
    const p = spawn('adb', ['-s', 'emulator-5554', 'exec-out', 'screencap', '-p']);
    const bufs = [];
    p.stdout.on('data', (d) => bufs.push(d));
    p.on('exit', () => { fs.writeFileSync(file, Buffer.concat(bufs)); res(); });
  });
}

async function main() {
  const args = process.argv.slice(2);
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
  const st = () => evaluate(`document.querySelector('.feed').scrollTop`);
  const id0 = () => evaluate(`document.querySelector('.item') ? document.querySelector('.item').dataset.id : ''`);

  if (args.includes('--legacy')) console.log('注入旧架构模拟：' + await evaluate(LEGACY_SIM));
  await evaluate(MARKER);
  // ① 等片库加载完、列表稳定
  console.log('等片库稳定… ' + await evaluate(`(async () => {
    for (let k = 0; k < 80; k++) {
      const n = document.querySelectorAll('.item').length;
      const i = document.querySelector('.item') ? document.querySelector('.item').dataset.id : '';
      if (n > 100 && i && window.__lid === i && window.__ln === n) return 'stable(' + n + ')';
      window.__lid = i; window.__ln = n;
      await new Promise((r) => setTimeout(r, 300));
    }
    return 'timeout';
  })()`, true));

  await evaluate(`(async () => { const f = document.querySelector('.feed'); f.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 1800)); return f.scrollTop; })()`, true);
  const idA = await id0();
  console.log(`起点 scrollTop=${await st()}  item[0]=${idA}`);
  await shoot('_vis-A.png');
  console.log('已截图 A（滚动开始前）');

  // ② 起一次长手势，**等滚动真的开始**再堵主线程
  // ⚠️ 起手点必须避开进度条热区：`.progress` 在 y 540~566 CSS（= 1620~1698 设备px），
  //    它挂了 `touch-action:none`，从那儿起手浏览器根本不会滚（实测 scrollTop 全程 0，
  //    白白浪费一轮实验）。所以从屏幕中部 1000 起手。
  const swipe = spawn('adb', ['-s', 'emulator-5554', 'shell', 'input', 'swipe', '540', '1000', '540', '400', '3000']);
  const swipeDone = new Promise((res) => { if (swipe.exitCode !== null) return res(); swipe.on('exit', res); setTimeout(res, 20000); });

  let startedAt = -1;
  for (let k = 0; k < 60; k++) {
    await new Promise((r) => setTimeout(r, 40));
    if ((await st()) > 8) { startedAt = k * 40; break; }
  }
  if (startedAt < 0) { console.log('❌ 滚动一直没开始，本次作废'); ws.close(); return; }
  console.log(`滚动已在 ${startedAt}ms 处开始 → 现在堵死主线程 2500ms`);

  send('Runtime.evaluate', {
    expression: `(() => { const t = performance.now(); while (performance.now() - t < 2500) {} return 'blocked'; })()`,
    returnByValue: true,
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 700));
  await shoot('_vis-B.png');
  console.log('已截图 B（主线程正被堵死，手指还在划）');

  await swipeDone;
  await new Promise((r) => setTimeout(r, 2000));
  const idB = await id0();
  console.log(`解锁后 scrollTop=${await st()}  item[0]=${idB}  ${idA === idB ? '✅ 列表没被重建' : '❌ 列表被重建，作废'}`);
  console.log(`\n看图：_vis-A.png / _vis-B.png 左上角那个绿色大号数字（= 视口顶部第几条）`);
  console.log(`  数字变了 → ✅ 合成器在滚：主线程堵死，画面照样跟手`);
  console.log(`  数字没变 → ❌ 画面冻住：滚动仍然依赖主线程`);
  ws.close();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
