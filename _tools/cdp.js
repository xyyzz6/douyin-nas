/**
 * 通过 CDP 驱动 App 里的 WebView 执行 JS。
 *
 * 为什么不用 `adb shell input tap`：本 App 整页都是 WebView，
 * uiautomator dump 只能看到一个 com.nas.douyin:id/web 节点，内层 bounds 拿不到，
 * tap 全靠目测坐标，试过几次都打偏。CDP 直接执行 JS，稳得多。
 *
 * 用法：
 *   node _tools/cdp.js "<JS 表达式>"        # 执行并打印返回值
 *   node _tools/cdp.js --file <脚本路径>    # 执行文件里的 JS
 *
 * ⚠️ 页面里 `S` 是模块作用域，CDP 访问不到 —— 只能查 DOM 事实，
 *    或者点按钮触发页面自己的逻辑。
 */
const http = require('http');

function getJson(url) {
  return new Promise((res, rej) => {
    http.get(url, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function main() {
  const args = process.argv.slice(2);
  let code;
  if (args[0] === '--file') code = require('fs').readFileSync(args[1], 'utf8');
  else code = args.join(' ');

  const targets = await getJson('http://127.0.0.1:9222/json');
  const page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1:8099/.test(t.url));
  if (!page) throw new Error('找不到 App 的 WebView 页面，检查 adb forward tcp:9222');

  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();

  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  ws.on('message', (buf) => {
    let m;
    try { m = JSON.parse(buf.toString()); } catch (_) { return; }
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error)));
      else res(m.result);
    }
  });

  await new Promise((r) => ws.on('open', r));

  const r = await send('Runtime.evaluate', {
    // 包成 **async** IIFE：这样脚本里可以用 await 采样「点完之后一段时间内的变化」。
    // （页面里 `S` 是模块作用域，CDP 拿不到 —— 只能查 DOM 事实 / 点按钮。）
    expression: `(async function(){ ${code} })()`,
    returnByValue: true,
    awaitPromise: true,
  });

  if (r.exceptionDetails) {
    console.error('JS 异常:', JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
    process.exitCode = 1;
  } else {
    const v = r.result && r.result.value;
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
  ws.close();
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
