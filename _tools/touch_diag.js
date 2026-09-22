/**
 * 诊断：CDP 的 Input.dispatchTouchEvent 到底有没有被 WebView 当成本地触摸？
 *
 * 背景：用 dispatchTouchEvent 发手势时，「拖满安全区」那种从 y=480 起手的用例
 * 在页面上**一点位移都没有**；而 `adb shell input swipe` 同样的距离却完全正常。
 * 怀疑 dispatchTouchEvent 少了 id / radius 这些字段，WebView 没把它当真实触摸链。
 *
 * 页面侧先挂好 window.__ev 监听，再跑本脚本。
 */
const { execSync } = require('child_process');
const WebSocket = require('ws');

const ADB = process.env.ADB || 'D:/leidian/LDPlayer14/adb.exe';
const SERIAL = process.argv[2] || 'emulator-5554';
const A = `${ADB} -s ${SERIAL}`;
const PORT = Number(process.env.ADB_PORT || 9223);
const sh = (c) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const o = sh(`${A} shell "cat /proc/net/unix | grep webview_devtools"`);
  const pid = (/remote_(\d+)/.exec(o) || [])[1];
  sh(`${A} forward tcp:${PORT} localabstract:webview_devtools_remote_${pid}`);
  const l = await new Promise((r, j) => require('http').get(`http://127.0.0.1:${PORT}/json/list`,
    (x) => { let b = ''; x.on('data', (d) => b += d); x.on('end', () => r(b)); }).on('error', j));
  const p = JSON.parse(l).find((x) => x.type === 'page');
  const ws = new WebSocket(p.webSocketDebuggerUrl, { maxPayload: 1 << 26 });
  let i = 0; const m = new Map();
  ws.on('message', (x) => { const r = JSON.parse(x); if (r.id && m.has(r.id)) { m.get(r.id)(r); m.delete(r.id); } });
  const call = (me, pa) => new Promise((res) => { const q = ++i; m.set(q, res); ws.send(JSON.stringify({ id: q, method: me, params: pa })); });
  await new Promise((r) => ws.on('open', r));
  const ev = async (e) => (await call('Runtime.evaluate', { expression: e, returnByValue: true })).result?.result?.value;

  const hook = `(()=>{const c=document.querySelector('.feed');window.__ev=[];
    ['pointerdown','pointermove','pointerup','touchstart','touchmove','touchend'].forEach(t=>
      c.addEventListener(t,e=>{window.__ev.push([t,Math.round(e.clientY||(e.touches&&e.touches[0]?e.touches[0].clientY:-1))])},true));
    return c.scrollTop})()`;

  /* --- A. 裸 dispatchTouchEvent（现在用的） --- */
  console.log('\n=== A. 裸 dispatchTouchEvent（x,y only） ===');
  console.log('base scrollTop =', await ev(hook));
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y: 480 }] });
  await sleep(120);
  await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 380 }] });
  await sleep(120);
  await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 180, y: 260 }] });
  await sleep(120);
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
  console.log('事件:', await ev('JSON.stringify(window.__ev)'));
  console.log('scrollTop =', await ev("document.querySelector('.feed').scrollTop"));

  /* --- B. 带 id / radiusX / radiusY / force 的完整触摸点 --- */
  console.log('\n=== B. 带 id+radius 的完整 TouchPoint ===');
  console.log('base scrollTop =', await ev(hook));
  const tp = (y) => ({ x: 180, y, id: 1, radiusX: 12, radiusY: 12, force: 1 });
  await call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [tp(480)] });
  await sleep(120);
  await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(380)] });
  await sleep(120);
  await call('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [tp(260)] });
  await sleep(120);
  await call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
  console.log('事件:', await ev('JSON.stringify(window.__ev)'));
  console.log('scrollTop =', await ev("document.querySelector('.feed').scrollTop"));

  ws.close(); process.exit(0);
})();
