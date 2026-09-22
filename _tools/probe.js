/**
 * 用 CDP 连到 App 里的 WebView，把每行输入当表达式求值。
 *
 * ⚠️ 几个踩过的坑（别重复踩）：
 *  1) socket 名带 pid 后缀：@webview_devtools_remote_<pid>，写死一个名字下次就连不上
 *  2) adb forward 和后面的连接必须放在**同一条命令**里执行；分开做的话
 *     adb daemon 会被回收，forward 就没了，表现是 connect ECONNREFUSED
 *  3) 整个进程只开一条 ws 连接，反复用；每行开一条会被 WebView 限流
 *  4) 页面是 ES module，顶层 const S / NAV / player **不在 window 上**，
 *     要访问得从闭包里想办法（或者调已经挂到 window 上的桥）
 */
const { execSync } = require('child_process');
const WebSocket = require('ws');
// ⚠️ 用 Windows 路径：execSync 走的是 cmd.exe，Git Bash 那套 /d/... 它不认
const ADB = process.env.ADB || 'D:/leidian/LDPlayer14/adb.exe';
// ⚠️ 同时插着模拟器和真机时，`adb shell` 会直接报 more than one device 而失败；
//    而且两台机器的 webview socket 都叫 webview_devtools_remote_<pid>，
//    不指定序列号会连到「先被 grep 到的那台」，串味。用 ADB_SERIAL / 第一个参数指定。
const SERIAL = process.env.ADB_SERIAL || process.argv[2] || '';
const A = SERIAL ? `${ADB} -s ${SERIAL}` : ADB;
// 端口也跟着设备分开，否则两台的 forward 会抢同一个本地端口
const PORT = Number(process.env.ADB_PORT || (SERIAL === '6518ec54' ? 9224 : 9223));

function sh(cmd) { return execSync(cmd, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim(); }

(async () => {
  // ① 先拿到带 pid 的 socket 名
  const out = sh(`${A} shell "cat /proc/net/unix | grep webview_devtools"`);
  const pid = (/remote_(\d+)/.exec(out) || [])[1];
  if (!pid) { console.error('找不到 webview socket:', out); process.exit(1); }
  // ② 立刻 forward（和上一步在同一个 node 进程里连着做，避免 adb daemon 被回收）
  sh(`${A} forward tcp:${PORT} localabstract:webview_devtools_remote_${pid}`);
  console.error(`# 设备 ${SERIAL || '(默认)'}  pid=${pid}  tcp:${PORT}`);
  const list = await new Promise((res, rej) => {
    require('http').get(`http://127.0.0.1:${PORT}/json/list`, (r) => {
      let b = ''; r.on('data', d => b += d); r.on('end', () => res(b));
    }).on('error', rej);
  });
  const page = JSON.parse(list).find(x => x.webSocketDebuggerUrl && /^https?:/.test(x.url||'') || x.type === 'page');
  if (!page) { console.error('没有可用的 page:', list.slice(0,300)); process.exit(1); }
  console.error('# 连上', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64*1024*1024 });
  let id = 0; const pend = new Map();
  ws.on('message', (m) => {
    const r = JSON.parse(m);
    if (r.id && pend.has(r.id)) { pend.get(r.id)(r); pend.delete(r.id); }
  });
  const call = (method, params) => new Promise((res) => {
    const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  await new Promise((r) => ws.on('open', r));

  const lines = [];
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => {
    for (const l of d.split('\n')) if (l.trim()) lines.push(l.trim());
  });
  process.stdin.on('end', async () => {
    for (const expr of lines) {
      const r = await call('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.result && r.result.exceptionDetails) {
        console.log(expr, '=> ERR', JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description || r.result.exceptionDetails.text));
      } else {
        console.log(expr, '=>', JSON.stringify(r.result && r.result.result && r.result.result.value));
      }
    }
    ws.close(); process.exit(0);
  });
})();
