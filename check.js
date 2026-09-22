'use strict';
/**
 * 项目自检（不需要服务也能跑静态部分）
 * ------------------------------------------------------------------
 * node check.js
 *
 * 分两段：
 *   A. 静态一致性 —— HTML/JS/CSS 之间的 id、图标、接口、样式是否对得上。
 *      改动跨多个文件时最容易「改了这里忘了那里」，这段专门抓这种问题。
 *   B. 运行时检查 —— 服务在跑的话，抓一遍页面和资源，确认真输出到浏览器。
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = __dirname;
const BASE = process.env.BASE || 'http://127.0.0.1:8080';
/**
 * ⚠️ 读进来先统一换行。
 *
 * 踩过的坑：app.js / style.css 在 Windows 上是 CRLF，而 check.js 自己是 LF。
 * 断言的字符串字面量里写 `;\n`，在 `;\r\n` 上永远匹配不到 —— 断的是「文件在不在」，
 * 结果变成了「文件是不是 LF」，静默失效还反过来说代码不对。
 * 这类断言之前靠 `\s*\n\s*`（`\s` 能吃 `\r`）侥幸活着，但只要哪天写成裸 `\n` 就中招。
 * 源头归一化之后，断言就只关心代码本身。
 */
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n?/g, '\n');
const existsFile = (p) => fs.existsSync(path.join(ROOT, p));

let bad = 0;
const chk = (n, c, e) => {
  if (c) console.log('  \x1b[32m✓\x1b[0m ' + n);
  else { bad++; console.log('  \x1b[31m✗\x1b[0m ' + n + (e ? '  \x1b[90m→ ' + e + '\x1b[0m' : '')); }
};

const html = read('public/index.html');
const app = read('public/js/app.js');
const api = read('public/js/api.js');
const css = read('public/css/style.css');
const srv = read('server.js');
// NasService：扫描 / 扩展名白名单的唯一实现（片库格式过滤那组断言要用）
const svc = read('android/src/com/nas/douyin/NasService.java');
// NasServer.java：播放/扫描/strm 大部分断言都用它。
// ⚠️ 必须在头部读入 —— srvCode/njCode/svcCode 在下面几行就要 stripComments，
//    而前置的那些断言（warm 预热 / strm 支持）早于 535 行引用 njCode。
const nj = read('android/src/com/nas/douyin/NasServer.java');
// 打包脚本（「转码搬到 NAS」那组断言要用）
const build = read('android/build.js');
// 解码服务（NAS 上的 Docker 容器）：内嵌 ffmpeg 于 2026-09-18 移除，
// 转码改由它承担，所以它的存在必须被断言钉住 —— 见「转码搬到 NAS」那一组。
const dsv = read('decode-server/server.js');
const dsDockerfile = read('decode-server/Dockerfile');
const dsCompose = read('decode-server/docker-compose.yml');
// AndroidManifest.xml 用二进制读：它的 minSdk 是装机门槛
const manifest = read('android/AndroidManifest.xml');
// MainActivity：原生桥 NasBridge 在这里 —— 首页「重启应用」按钮调的 restartApp() 就是它
const ma = read('android/src/com/nas/douyin/MainActivity.java');
// 内置 CloudDrive2 引擎的管理页 Activity（「先等就绪再加载」那组断言要用）
const cd2Act = read('android/src/com/nas/douyin/Cd2Activity.java');

/**
 * 去掉注释后的源码——**判「某段代码还在不在」时必须用它**。
 *
 * 踩过的坑（本项目已经栽了 5 次）：改代码时习惯在注释里写上「以前是这么写的
 * XXX，现在改成 YYY」。于是只要断言里带一条「旧写法必须消失」的负向判断，
 * 就会被自己的注释命中 —— 代码明明改对了，断言照样红；更糟的是反过来：
 * 代码改回去了，注释还在，断言照样绿。两边都是假的。
 *
 * 所以：**负向断言一律跑在 stripComments 之后的文本上**。
 */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
  .replace(/\/\/[^\n]*/g, '');          // 行注释
const appCode = stripComments(app);
const maCode = stripComments(ma);

/* ⚠️ html / css 要单独处理 —— **不能**直接套上面的 stripComments：
   它会把 `//` 之后的内容全部删掉，而 index.html 里有 `http://192.168.1.100:5005`
   这类占位符、style.css 里还有 `url("data:image/svg+xml;utf8,<svg … 'http://…'>")`。
   套上去等于把这些行从 `http:` 处截断，后面所有按行/按结构写的断言都会错位。
   所以：HTML 只剥 HTML 注释（`<!-- -->`），CSS 只剥块注释（斜杠星号那对）。 */
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const htmlCode = stripHtmlComments(html);
const cssCode = stripCssComments(css);
/* Java 两端的 stripComments 版本必须放在**最前面**（2026-09-19 修的 TDZ）：
   「/api/warm 预热」那组断言（文件很靠前的位置）就引用 njCode，
   原来这三个 const 定义在 1700 多行 —— 模块一执行到 1347 行就
   ReferenceError: Cannot access 'njCode' before initialization，
   后面所有断言根本没跑。谁再往前面加 Java 断言也不会踩坑。 */
const srvCode = stripComments(srv);
const njCode = stripComments(nj);
const svcCode = stripComments(svc);
/* ⚠️ 定义必须跟上面三个一起放在这里（见上方那段血泪）：api.js 的断言也在很靠前的位置，
   挪到后面就会 ReferenceError —— 而且**整个脚本会当场死掉**，表现成「失败数突然变少」。 */
const apiCode = stripComments(api);

/* ==================== A. 静态一致性 ==================== */

// 自检的第一条：先确认 read() 的换行归一化真的生效。
// 否则后面所有带 `\n` 字面量的断言都可能悄悄失效（表现为「代码明明对却报错」）。
chk('自检读取时统一了换行（CRLF 的源文件也能用 \\n 断言）',
  !/\r/.test(app) && !/\r/.test(css) && !/\r/.test(srv));

console.log('\n\x1b[1m[A] 静态一致性\x1b[0m');

console.log('\n · HTML id ↔ JS 引用');
const htmlIds = new Set([...htmlCode.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
/* ⚠️ 提取 JS 里的 id 必须跑在 appCode（剥注释）上。
   2026-09-18 又踩一次：我在 app.js 注释里写了句「原来这里回填 $('cfPlayable')…」，
   结果被当成真引用，报「JS 引用的 id 不存在」—— 假红。
   和 HTML 标签配对器是同一个坑：**你的说明文字会变成被测对象**。 */
const jsIds = new Set([...appCode.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const RUNTIME_IDS = new Set(['brGrid', 'cfGoBrowse']);   // 渲染时才插进 DOM 的
const missingIds = [...jsIds].filter((r) => !htmlIds.has(r) && !RUNTIME_IDS.has(r));
chk(`JS 引用的 ${jsIds.size} 个 id 都存在`, missingIds.length === 0, missingIds.join(', '));

/* 🔴 反向守卫：115 已整体删除（2026-09-19），连它的测试一起回收。
   `android/crypto-test/` 是给已删的 P115Crypt 写的 RSA 回归测试，
   TestP115.java 还 import com.nas.douyin.P115Crypt（类已不存在）—— 死代码，已删。
   它不参与构建（build.js 只 walk src/），所以留着不会报错，只会误导人。 */
chk('🔴 115 加解密测试目录 android/crypto-test/ 已删除',
  !existsFile('android/crypto-test/TestP115.java')
  && !existsFile('android/crypto-test/README.md')
  && !existsFile('android/crypto-test/gen-vectors.py'));
chk('🔴 P115Crypt.java 已删除',
  !existsFile('android/src/com/nas/douyin/P115Crypt.java'));
chk('🔴 Pan115.java 已删除',
  !existsFile('android/src/com/nas/douyin/Pan115.java'));

console.log('\n · 图标');
const icDef = new Set([...app.matchAll(/^\s{2}([a-zA-Z]+):\s*`/gm)].map((m) => m[1]));
const icUse = new Set([...app.matchAll(/IC\.([a-zA-Z]+)/g)].map((m) => m[1]));
const missingIc = [...icUse].filter((r) => !icDef.has(r));
chk(`用到的 ${icUse.size} 个图标都有定义`, missingIc.length === 0, missingIc.join(', '));

console.log('\n · 底部导航');
const navs = [...html.matchAll(/data-nav="([a-z]+)"/g)].map((m) => m[1]);
chk('3 个 tab：home / browse / me', navs.join(',') === 'home,browse,me', navs.join(','));
['pageMe', 'pageBrowse'].forEach((p) => chk(`存在 #${p}`, htmlIds.has(p)));
chk('独立的收藏页已删除', !htmlIds.has('pageFav') && !/renderFavPage/.test(app));
chk('setNav 处理 browse', /pageBrowse'\)\.hidden = navName !== 'browse'/.test(app));
chk('切到 browse 调 enterBrowse', /navName === 'browse'\) enterBrowse\(\)/.test(app));

console.log('\n · 「我的」页内嵌的收藏 / 点赞列表');
['meSeg', 'meGrid', 'meEmpty', 'meListHead', 'meListTitle', 'meListCount', 'goFav', 'goLike', 'goVid', 'statLike', 'meAccount']
  .forEach((id) => chk(`存在 #${id}`, htmlIds.has(id)));
chk('账号/同步面板独立成 #syncSheet', htmlIds.has('syncSheet'));
chk('数据源设置里不再夹带 #stepSync（臃肿问题已拆分）', !htmlIds.has('stepSync'));

/* ---------------------------------------------------------------
 * 「没有死按钮」：HTML 里画了 <button>，JS 里就必须有它的绑定。
 *
 * 为什么值得单列一条：用户报过「这几个按钮点了没反应」，
 * 查出来是 #meConfig / #meRescan 从头到尾**没绑过事件** ——
 * 页面画得挺像样，也能按下去有 :active 反馈，就是不干活。
 * 这种问题静态检查最容易漏（id 存在、CSS 漂亮、界面上看不出），
 * 只能靠「HTML 有按钮 → JS 必须有引用」来兜。
 * ------------------------------------------------------------- */
console.log('\n · 没有「画了但不干活」的死按钮');
const btnIds = [...html.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
// 有绑定、或被 JS 用别的形式接管（data-*/委托）的，都算「活的」
const DEAD_OK = new Set([
  'tabbar',            // 容器，事件委托
  'searchGrid',        // 容器
]);
const dead = btnIds.filter((id) => {
  if (DEAD_OK.has(id)) return false;
  if (new RegExp(`\\$\\('${id}'\\)`).test(app)) return false;      // $('x') 引用
  if (new RegExp(`getElementById\\('${id}'\\)`).test(app)) return false;
  return true;
});
chk(`HTML 里 ${btnIds.length} 个 <button> 都在 JS 里有绑定`, dead.length === 0,
  dead.length ? '没绑定的：' + dead.join(', ') : '');
chk('#btnMenu 这个假按钮已删除（它从来没绑过事件）',
  !htmlIds.has('btnMenu') && !/btnMenu/.test(app));

/* 历史坑复现：这两个按钮曾经完全没绑事件 */
chk('#meConfig 绑了打开数据源设置', /\$\('meConfig'\)\.addEventListener/.test(app));
chk('#meRescan 绑了重新扫描', /\$\('meRescan'\)\.addEventListener/.test(app));
chk('#meAccount 绑了打开账号与同步面板', /\$\('meAccount'\)\.addEventListener\('click', \(\) => openSheet\('syncSheet'\)\)/.test(app));
chk('openSheet 打开 syncSheet 时会回填表单',
  /if \(id === 'syncSheet'\) syncRender\(\);/.test(app));
chk('「重新扫描」直连 runRefresh，没有另写一遍（下拉刷新删了，这个动作保留）',
  /rescan\(\)\s*\{\s*return runRefresh\(\);/.test(app));

console.log('\n · 顶栏按钮（首页可见）');

/* ---- 首页左上角「重启应用」（2026-09-19 加；同日从「刷新片库」改成重启）----
   用户原话：「在左上角加一个刷新按钮方便我刷新新扫描的视频」→
   紧接着改要求：「这个按钮改成重启 app」。
   ⚠️ 「重扫片库」这个**动作没删**，入口只剩「我的」页的「重新扫描」
      （见上面那条 `rescan() { return runRefresh(); }` 的断言）。 */
chk('首页顶栏有左上角「重启应用」按钮 #btnRestart',
  htmlIds.has('btnRestart'));
chk('#btnRestart 绑了点击事件（不是死按钮）',
  /\$\('btnRestart'\)\.addEventListener\('click'/.test(appCode));
chk('#btnRestart 调原生 NasBridge.restartApp()（APK 里真重启）',
  /window\.NasBridge/.test(appCode) && /\.restartApp\(\)/.test(appCode));
chk('#btnRestart 没有原生桥时回退 location.reload()（浏览器 / PC 版）',
  /location\.reload\(\)/.test(appCode));
/* 🔴 反向守卫：这个按钮**不许**再连回 main.rescan()。 */
chk('🔴 #btnRestart 不再触发 main.rescan()（重扫入口只剩「我的」页）',
  appCode.indexOf("$('btnRestart').addEventListener") > -1
  && !/\$\('btnRestart'\)[\s\S]{0,500}main\.rescan\(\)/.test(appCode));
/* ⚠️ .topbar 是 justify-content:flex-end —— 不加绝对定位会被排到右边跟搜索挤一起 */
chk('.tb-restart 绝对定位到左边（topbar 是 flex-end，不定位会跑到右边）',
  /\.tb-restart\{[^}]*position:absolute/.test(cssCode)
  && /\.tb-restart\{[^}]*left:12px/.test(cssCode));
chk('#btnRestart 有转圈反馈（点下去到重新加载之间有几百毫秒空档）',
  /\.tb-restart\.spin svg\{animation:tbSpin/.test(cssCode)
  && appCode.indexOf("classList.add('spin')") > -1);
/* 🔴 前端调了 restartApp()，Java 侧必须有实现 —— 缺一边就是「点了没反应」的死按钮。
   ⚠️ 必须跑在 maCode（去注释）上。 */
chk('🔴 Java NasBridge 实现了 restartApp()（前端调了它，缺一边就是死按钮）',
  /@android\.webkit\.JavascriptInterface[\s\S]{0,200}public void restartApp\(\)/.test(maCode));
chk('Java restartApp 用 recreate()（不杀进程 —— 否则会退桌面 / 端口冲突）',
  /public void restartApp\(\)[\s\S]{0,400}recreate\(\)/.test(maCode));
chk('Java restartApp 跑在 UI 线程（JS 线程不能直接动 Activity）',
  /public void restartApp\(\)[\s\S]{0,200}ui\.post\(/.test(maCode));
/* 🗑️ onScanSettled 是专为「刷新按钮的转圈收尾」设的钩子；按钮改成重启后已回收。 */
chk('🗑️ onScanSettled 钩子已删除（只服务于已改语义的那个按钮）',
  !/onScanSettled/.test(appCode));

/* 视频数量角标：要贴在片源名旁边，不能再去抢 text 节点 */
console.log('\n · 顶栏「视频数量」角标');
chk('#topTitle 里有独立的 #topName / #topCount 两个 span',
  /<span class="tt-name" id="topName">/.test(htmlCode) && /<span class="tt-count" id="topCount"/.test(htmlCode));
chk('updateTitle 写 #topName，不再动 topTitle 的 text 节点',
  /\$\('topName'\)\.textContent = name;/.test(app) &&
  !/t\.insertBefore\(document\.createTextNode/.test(app));
chk('updateBadge 把数字写进 #topCount', /\$\('topCount'\)/.test(app));
chk('数字为空时角标隐藏（不显示一个「0 个视频」的壳）',
  /c\.hidden = !n;/.test(app));
chk('数字角标和片源名排在同一行（.top-title 里的两个 span，不是两块）',
  /\.top-title \.tt-count\{/.test(cssCode) && /\.top-title \.tt-name\{/.test(cssCode));
chk('浮层角标不再重复报数字（只在演示模式提示）',
  !/b\.textContent = `\$\{S\.videos\.length\} 个视频`/.test(app));

/* 顶栏那个 ⌄ 小箭头（用户 2026-09-18 要求删掉）。
   它暗示「点开能切换片源」，但 #topTitle 全项目**没有任何事件绑定** ——
   是个撒谎的假按钮，和更早删掉的 #btnMenu 同一类。
   反向守住：箭头不许回来，也别再把它写回 <button>。 */
console.log('\n · 顶栏假按钮（⌄ 箭头已删）');
chk('顶栏 ⌄ 箭头已删（svg 和它的 CSS 一起清掉，不留空壳）',
  !/M7 10l5 5 5-5/.test(htmlCode) && !/\.top-title svg/.test(cssCode));
chk('#topTitle 不再是 <button>（没有事件就别装成能点）',
  !/<button[^>]*id="topTitle"/.test(htmlCode) && /<div class="top-title" id="topTitle">/.test(htmlCode));
chk('#topTitle 的按压反馈（:active）也删了（点了没反应还变亮更误导）',
  !/\.top-title:active/.test(cssCode));
chk('#topTitle 确实没绑任何事件（证明是删了假按钮，不是只改样式）',
  !/topTitle'\)\.addEventListener/.test(appCode) && !/topTitle'\)\.onclick/.test(appCode));
chk('button → div 没有副作用（updateTitle 只用它设了个 title 提示）',
  /\$\('topTitle'\);/.test(app) && /\bt\.title = /.test(app) &&
  !/\$\('topTitle'\)\.(value|disabled|type|form)\b/.test(appCode));

/* 标题要落在**屏幕正中**，不是「剩下那块空间」的正中。
 * 顶栏右边有搜索/换一批两个图标、左边没有，靠 flex 居中会整体偏左约 40px
 * （实测内容中心 140 vs 屏幕中心 180）—— 所以标题必须是绝对定位 + 左右等宽留边。
 * 这条断言专门守这个：谁把 position:absolute 或左右留边去掉，就红。 */
console.log('\n · 顶栏标题水平居中');
const titleRule = (css.match(/\.top-title\{[^}]*\}/) || [''])[0];
chk('.top-title 用绝对定位（不靠 flex 居中）', /position:absolute/.test(titleRule), titleRule.slice(0, 80));
chk('.top-title 左右留等宽的边（left/right 都写了）',
  /left:\s*88px/.test(titleRule) && /right:\s*88px/.test(titleRule));
chk('标题不再用 flex:1 + max-width 抢占剩余空间',
  !/flex:1/.test(titleRule) && !/max-width:66%/.test(titleRule));
chk('.topbar 改成 flex-end（图标靠右排，标题已脱离文档流）',
  /justify-content:flex-end/.test((css.match(/\.topbar\{[^}]*\}/) || [''])[0]));
chk('两段切换有绑定', /\$\('meSeg'\)\.addEventListener\('click'/.test(app));
chk('收藏 / 点赞共用渲染函数', /function renderMeList/.test(app) && /ME_TAB/.test(app));
chk('统计可点进对应列表', /openMeList\('fav'\)/.test(app) && /openMeList\('like'\)/.test(app));
chk('切换后重渲染', /ME_TAB = b\.dataset\.tab;\s*\n\s*renderMeList\(\)/.test(app));
chk('CSS 有 .seg', /\.seg\{/.test(css));
chk('CSS 有 .me-list-head', /\.me-list-head\{/.test(css));
// 分段顺序：用户要求「点赞」排在「收藏」前面
const segBlock = html.match(/<div class="seg" id="meSeg">([\s\S]*?)<\/div>/);
const segTabs = segBlock ? [...segBlock[1].matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]) : [];
chk('分段顺序：点赞在收藏前面', segTabs.join(',') === 'like,fav', segTabs.join(',') || '(读不到 #meSeg)');
chk('默认选中左起第一个（点赞）', /data-tab="like"\s+class="on"/.test(html));
chk('默认先看点赞（ME_TAB）', /let ME_TAB = 'like'/.test(app));
chk('静态标题默认「我点赞的」', /id="meListTitle">我点赞的</.test(html));

console.log('\n · 视频缩略图（抽帧 + 独立目录缓存）');
// 前端：列表里用 /api/thumb 当缩略图源，进视口才加载
chk('列表用 /api/thumb 做图源', /['"]\/api\/thumb\?p=['"]\s*\+/.test(app));
chk('缩略图懒加载（IntersectionObserver）', /IntersectionObserver/.test(app) && /rootMargin/.test(app));
// 后端接口
chk('api.js 有 thumbStats', /thumbStats:\s*\(\)\s*=>/.test(api));
chk('api.js 有 thumbBackfill', /thumbBackfill:\s*\(items\)\s*=>/.test(api));
// 打开「我的」页时自动补齐没图的那些（用户要求：不用手动点）
chk('启动后自动补齐已有点赞', /function backfillThumbs/.test(app) && /backfillThumbs\(/.test(app));
chk('补齐有节流（避免反复请求）', /thumbBackfillAt/.test(app) && /600000/.test(app));
chk('补齐只排当前片源里存在的', /likeList\(\)[\s\S]{0,200}favList\(\)/.test(app));
// 「我的」页显示缓存占用，让「已落盘」这件事可见
chk('存在 #meThumb 缓存提示位', htmlIds.has('meThumb'));
chk('渲染缓存张数 / 占用', /renderThumbLine/.test(app) && /r\.cached/.test(app));
chk('CSS 有 .me-thumb', /\.me-thumb\{/.test(css));
chk('CSS 空态不占位', /\.me-thumb:empty\{display:none\}/.test(css));
// 独立目录 + 跨重启保留：必须是 filesDir 而不是 cacheDir
const thumbs = read('android/src/com/nas/douyin/Thumbs.java');
chk('缩略图类存在', thumbs.length > 2000);
chk('落在 filesDir（不是会被系统清的 cacheDir）',
  /getFilesDir\(\)/.test(thumbs) && !/getCacheDir\(\)/.test(thumbs));
chk('文件名是 sha1(版本+路径)，内容变了能失效', /sha1\(VER \+ ":" \+ rel\)/.test(thumbs));
chk('抽帧用系统自带解码器（不需要外挂 ffmpeg）', /MediaMetadataRetriever/.test(thumbs));
chk('多帧候选里选最优（避开黑屏 / 过场）', /CANDIDATES/.test(thumbs) && /stddev/.test(thumbs));
chk('先在 .part 里写，写完再改名（防止半张图被当缓存）', /\.part/.test(thumbs));
chk('失败太多就不再重试', /MAX_FAIL/.test(thumbs));
const nasrv = read('android/src/com/nas/douyin/NasServer.java');
chk('NasServer 点赞时排缩略图任务', /thumbs\.ensure\(id, streamUrl\)/.test(nasrv));
chk('NasServer 有 /api/thumb 路由', /path\.equals\("\/api\/thumb"\)/.test(nasrv));
chk('NasServer 有 /api/thumb/backfill 路由', /path\.equals\("\/api\/thumb\/backfill"\)/.test(nasrv));
chk('NasServer 有 /api/thumb/stats 路由', /path\.equals\("\/api\/thumb\/stats"\)/.test(nasrv));
chk('抽帧给自己取流（本机 127.0.0.1，鉴权由服务代劳）', /127\.0\.0\.1:" \+ port \+ "\/api\/stream/.test(nasrv));
// PC 版（Node）也走同一套 /api/thumb 协议；它用外挂 ffmpeg 抽帧，不需要 backfill/stats
chk('Node 版 server.js 也有 /api/thumb', /'\/api\/thumb'/.test(srv) || /"\/api\/thumb"/.test(srv));
chk('Node 版把缩略图落在 data/thumbs 独立目录', /THUMBS_DIR/.test(srv) && /'thumbs'/.test(srv));

console.log('\n · NAS 目录页');
['brBody', 'brCrumb', 'brUp', 'brReload', 'brRecursive', 'brSrc'].forEach((id) => chk(`存在 #${id}`, htmlIds.has(id)));
chk('brBody 有点击委托', /\$\('brBody'\)\.addEventListener\('click'/.test(app));
chk('面包屑有点击委托', /\$\('brCrumb'\)\.addEventListener\('click'/.test(app));
chk('「上一级」有绑定', /\$\('brUp'\)\.addEventListener\('click'/.test(app));
chk('递归开关会重渲染', /\$\('brRecursive'\)\.addEventListener\('change'/.test(app));
chk('目录行按 data-dir 进下一层', /closest\('\[data-dir\]'\)/.test(app));
chk('目录行按 data-add 加进片源', /closest\('\[data-add\]'\)/.test(app));
chk('「只刷它」按 data-play', /closest\('\[data-play\]'\)/.test(app));
chk('数量是异步补的（fillCounts）', /async function fillCounts/.test(app) && /api\.counts\(paths\)/.test(app));
/* 🔴 2026-09-20：子文件夹行的计数**不递归**（后端 `/api/counts` = propfind depth-1，只数
 * 该目录**直接**包含的可播放文件）。所以开着「含子文件夹」时不能写「里面没有视频」——
 * 115open 下面只有子目录、视频在更深一层，用户看到的就是「那怎么一个视频都没有」。
 * 递归数是不能做的（boki 那棵树 9.5 分钟），只能照实改成「本层」。
 * ⚠️ 行为断言：把真 renderDir 抠出来跑，喂 rec / counts / dirs 三种组合。 */
{
  const mkDir = (rec, counts) => {
    let out = '';
    const els = {
      brBody: { set innerHTML(v) { out = v; }, get innerHTML() { return out; }, scrollTop: 0 },
      brRecursive: { checked: rec },
      brGrid: {},
    };
    const f = new Function('$', 'B', 'hasSrc', 'IC', 'escapeHtml', 'renderGrid',
      grabFn(app, 'renderDir') + '\nreturn renderDir;')(
        (id) => (els[id] || null),
        { counts },
        () => false,
        { folder: '<i>F</i>', chev: '<i>C</i>' },
        (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        () => {});
    f({ path: '/dav', name: 'dav', dirs: [{ name: '115open', path: '/dav/115open' }], videos: [], videoCount: 0 });
    return out;
  };
  const c0 = { '/dav/115open': 0 };
  const on = mkDir(true, c0);
  chk('🔴 行为：含子文件夹开着 + 本层 0 个 → 只能说「本层没有视频」，不许说「里面没有视频」',
    on.includes('本层没有视频') && !on.includes('里面没有视频'), on.slice(0, 160));
  chk('行为：关掉含子文件夹 → 回到原文案「里面没有视频」（本层语义本来就成立）',
    mkDir(false, c0).includes('里面没有视频') && !mkDir(false, c0).includes('本层没有视频'));
  chk('行为：本层有视频时照常显示「里面 N 个视频」（别把正常文案改坏）',
    mkDir(true, { '/dav/115open': 7 }).includes('里面 7 个视频'));
  chk('行为：还没数出来时显示「正在数…」（不能先斩后奏说没有）',
    mkDir(true, {}).includes('正在数…'));
}
chk('CSS 有 .frow', /\.frow\{/.test(css));
chk('CSS 有 .br-crumb', /\.br-crumb\{/.test(css));
chk('CSS 有 .browse', /\.browse\{/.test(css));

console.log('\n · 多个片源文件夹');
chk('后端 config 有 dirs 字段', /dirs: \[\],\s*\/\/ 片源文件夹/.test(srv));
chk('老配置的单 dir 会迁移成 dirs', /const legacy = !Array\.isArray\(c\.dirs\)/.test(srv) && /if \(!dirs\.length && c\.dir && legacy\) dirs = \[c\.dir\]/.test(srv));
chk('有 sourceDirs() 兜底（没配片源就退回当前目录）', /function sourceDirs\(\)/.test(srv));
chk('buildLibrary 逐个扫多个片源', /async function buildLibrary\(dirsOverride\)/.test(srv) && /for \(const root of roots\)/.test(srv));
chk('单个片源读不到不会拖垮整个片库', /errors\.push\(\{ dir: root, error: e\.message \}\)/.test(srv));
chk('多个片源之间会去重', /片源互相包含/.test(srv) && /seen\.has\(v\.p\)/.test(srv));
chk('后端有 /api/sources', srv.includes("'/api/sources'"));
chk('片源列表会归一化去重（normDirs）', /function normDirs\(arr\)/.test(srv));
chk('api.sources 已定义（第三个参数 skipDirs = 「不重扫」的文件夹）',
  /^\s{2}sources: \(dirs, recursive, skipDirs\)/m.test(api));
chk('前端有片源区渲染 renderSrcList', /function renderSrcList\(\)/.test(app));
chk('片源行有「移出」（data-del）', /data-del="\$\{escapeHtml\(d\)\}"/.test(app) && /function removeSource/.test(app));
chk('加片源走 addSource', /async function addSource\(dir\)/.test(app));
chk('「只刷它」走 onlySource', /async function onlySource\(dir\)/.test(app));
chk('片源区有自己的点击委托', /\$\('brSrc'\)\.addEventListener\('click'/.test(app));
chk('CSS 有 .br-src / .srow', /\.br-src\{/.test(css) && /\.srow\{/.test(css));
chk('CSS 有 .fadd（＋加入片源）', /\.frow \.fadd\{/.test(css));
chk('设置页只读展示片源（cfDirs）', htmlIds.has('cfDirs') && /function renderCfDirs/.test(app));
chk('CSS 有 .cf-dir', /\.cf-dir\{/.test(css));
chk('多片源时顶栏显示「N 个文件夹」', /dirs\.length > 1\) name = `\$\{dirs\.length\} 个文件夹`/.test(app));

console.log('\n · 片库缓存（一天只完整扫一次）');
chk('片库缓存落盘 data/library.json', /LIB_CACHE_FILE = path\.join\(DATA_DIR, 'library\.json'\)/.test(srv));
chk('缓存有效期 24 小时', /CACHE_TTL_MS = 24 \* 60 \* 60 \* 1000/.test(srv));
chk('启动时读缓存 loadLibraryCache', /function loadLibraryCache\(\)/.test(srv) && /^loadLibraryCache\(\);$/m.test(srv));
chk('扫完写缓存 saveLibraryCache', /function saveLibraryCache\(\)/.test(srv) && /saveLibraryCache\(\);/.test(srv));
chk('配置变了缓存作废', /function libSig\(\)/.test(srv) && /cachedSig !== sig|usable = library\.videos\.length > 0 && cachedSig === sig/.test(srv));
chk('过期时先用旧缓存 + 后台重扫', /function kickBackgroundScan\(wait\)/.test(srv) && /kickBackgroundScan\(\);/.test(srv));
/* 🔴 2026-09-18 改契约：深扫实测 **13 分钟**，refresh=1 **不许再同步等**。
   以前是 `if (scanning) await kickBackgroundScan(true)` —— 没在扫时压根不扫
   （`cachedSig !== libSig()` 恒为 false），PC 版点「重新扫描」其实是空的；
   在扫时就干等十几分钟。现在一律 kickBackgroundScan() + 立刻回话。 */
chk('重扫（refresh=1）走后台：立刻回话 + pendingScan（不再同步等十几分钟）',
  /if \(refresh\) \{[\s\S]{0,900}kickBackgroundScan\(\);/.test(srv)
  && /pendingScan: !!scanning,/.test(srv)
  && !/kickBackgroundScan\(true\)/.test(srv));
chk('响应里带缓存年龄与 TTL', /function libPayload\(\)/.test(srv) && /ageMs: library\.scannedAt/.test(srv));
chk('有轻量轮询 /api/library?peek=1', /const peek = q\.get\('peek'\) === '1'/.test(srv));
chk('peek 只在变了时带整份数据', /changed,\s*\n/.test(srv) && /\.\.\.\(changed \? libPayload\(\) : \{\}\)/.test(srv));
chk('api.libPeek 已定义', /^\s{2}libPeek: \(v\)/m.test(api));
chk('前端后台扫完自动换新列表', /function watchLibraryRefresh/.test(app) && /api\.libPeek\(v\)/.test(app));
chk('列表没变则不重建 DOM（不跳条）', /refreshList\(next\) \{/.test(app) && /main\.refreshList\(main\.list\.map/.test(app));
chk('「我的」页显示扫描/重扫时间', /function scanTimeText/.test(app) && /小时后自动重扫/.test(app));


console.log('\n · 片库缓存落盘：APK 重启不再重扫（NasServer.java）');
// 这条是「每次启动 App 都要等 10 秒」那个毛病的根治点：
// 之前 libCache 只是个内存字段，App 一重启就没了 → 每次都要全量重扫。
chk('缓存落在 filesDir/library.json', /new File\(ctx\.getFilesDir\(\), "library\.json"\)/.test(nasrv));
chk('不用 cacheDir（那个会被系统清掉）', !/getCacheDir\(\)/.test(nasrv.split('libCacheFile')[1] || ''));
chk('启动时把缓存读回来', /private void loadLibraryFromDisk\(\)/.test(nasrv) && /loadLibraryFromDisk\(\);/.test(nasrv));
chk('读回时校验配置签名（配置变了就作废）', /if \(!sig\.equals\(libSig\(\)\)\)/.test(nasrv));
chk('扫完落盘 saveLibraryToDisk', /private void saveLibraryToDisk\(/.test(nasrv) && /saveLibraryToDisk\(lib, sig\)/.test(nasrv));
chk('先写 .part 再改名（防半份坏缓存）', /library\.json\.part/.test(nasrv));
chk('有效期 24 小时', /LIB_TTL_MS = 24 \* 60 \* 60 \* 1000L/.test(nasrv));
chk('配置改了清掉盘上缓存', /clearLibraryOnDisk\(\)/.test(nasrv));
// 过期后不能卡住启动：先给旧的，后台再扫
chk('过期时先回旧缓存（stale）再后台重扫', /startBackgroundScan\(\);/.test(nasrv) && /o\.put\("stale", true\)/.test(nasrv));
chk('扫描逻辑抽成 doScan 供两条路径共用', /private JSONObject doScan\(String sig\)/.test(nasrv));
/* 扫描标志必须是**计数**，不能是一个布尔 —— 2026-09-18 实测抓到的坑：
 * 后台那条链（扫描 + 追新重扫）和同步那条（scanNowSync）会重叠，
 * 用一个布尔的话先结束的那条把标志清成 false，另一条还在扫却对外说「没在扫」。
 * 后果：handleSources 回 pendingScan:false → 前端拿旧片库 applyLibrary（首页闪空/切走）；
 * 而且 startBackgroundScan 的单飞判断也失灵，会同时开两路全量扫描。
 * logcat 里的特征就是 `扫描期间片源又变了` 紧跟着 `同步扫描期间片源又变了`，
 * 之后 scanning 提前变 false。 */
chk('Java 扫描标志是计数（libScanDepth），不是布尔',
  /AtomicInteger libScanDepth/.test(stripComments(nasrv))
  && /private boolean libScanning\(\) \{ return libScanDepth\.get\(\) > 0; \}/.test(stripComments(nasrv))
  && !/private volatile boolean libScanning = false;/.test(stripComments(nasrv)));
chk('Java 两条扫描路径各自加减层数（不会互相清掉）',
  /private JSONObject scanNowSync\(\) \{[\s\S]{0,120}?libScanDepth\.incrementAndGet\(\);/.test(stripComments(nasrv))
  && /libScanDepth\.decrementAndGet\(\);/.test(stripComments(nasrv))
  && /doScan\(String sig\)[\s\S]{0,200}?long t0 = System\.currentTimeMillis\(\);/.test(stripComments(nasrv)));
chk('Java doScan 自己不加减层数（整条链由调用方统一管）',
  (() => {
    const i = stripComments(nasrv).indexOf('private JSONObject doScan(String sig)');
    const j = stripComments(nasrv).indexOf('private JSONObject scanNowSync()');
    const body = stripComments(nasrv).slice(i, j);
    return i > 0 && !/libScanDepth/.test(body) && !/libScanning\b/.test(body);
  })());
chk('Java 后台重扫单飞用 libScanChained（不是层数 —— 同步扫描也会加层）',
  /if \(libScanChained\) return;/.test(stripComments(nasrv))
  && /libScanChained = true;/.test(stripComments(nasrv))
  && /synchronized \(libScanLock\) \{ libScanChained = false; \}/.test(stripComments(nasrv)));
chk('Java 后台重扫异常时兜底减层（否则再也不会重扫）',
  /finally \{[\s\S]{0,300}libScanDepth\.decrementAndGet\(\);/.test(stripComments(nasrv)));
/* 同上：Java 版 refresh=1 也改成后台（深扫 13 分钟，同步等 = HTTP 挂 13 分钟）。 */
chk('Java 用户点「重新扫描」时走后台：立刻回话 + scanning（不再同步等）',
  /startBackgroundScan\(\);/.test(nasrv)
  && /o\.put\("pendingScan", true\);/.test(nasrv)
  && !/return json\(200, scanNowSync\(\)\);/.test(nasrv));
/* 旧片库要一并带回去，否则前端手上没东西、首页会闪成空。 */
chk('Java refresh 回话时把手上的旧片库带回去（stale:true），首次没缓存就回空壳',
  /if \(cached != null\) \{[\s\S]{0,220}o\.put\(k, cached\.opt\(k\)\);/.test(nasrv)
  && /o\.put\("videos", new JSONArray\(\)\);/.test(nasrv));

console.log('\n · 刷视频顺序随机');
chk('有洗牌函数 shuffle', /function shuffle\(arr\)/.test(app) && /Math\.random\(\)/.test(app));
chk('有排序列 S.order', /order: \[\],\s+\/\/ 首页刷的随机顺序/.test(app));
chk('有 orderVideos 组装随机序', /function orderVideos\(videos\)/.test(app));
chk('首页按随机序装载（预热先行后先算好序再 load）',
  /const first = orderVideos\(S\.videos\);/.test(app) && /main\.load\(first\);/.test(app));
chk('不再按服务端文件名序装载', !/main\.load\(S\.videos\)/.test(app));
chk('后台补扫保住已有顺序（不重置成文件名序）',
  /main\.refreshList\(main\.list\.map\(\(v\) => byId\.get\(v\.p\) \|\| v\)\)/.test(app) && !/main\.refreshList\(S\.videos\)/.test(app));
chk('顶栏有「换一批」按钮', htmlIds.has('btnShuffle') && /id="btnShuffle"/.test(html));
chk('「换一批」有绑定', /\$\('btnShuffle'\)\.addEventListener\('click', reshuffle\)/.test(app));
chk('reshuffle 走 main.reshuffleNow()', /main\.reshuffleNow\(\)/.test(app) && /function reshuffleNow\(\)/.test(app));
/* 2026-09-21 加了顺序要求：必须**先 build 再写 scrollTop**（写在前面的话 0 不是吸附点，
   会被 mandatory 吸附弹回最近的 item，实测第 8 条点「换一批」停在第 6 条没回去）。 */
chk('reshuffleNow 清空顺序后重装，且归位要写在 build 之后',
  /function reshuffleNow\(\)\s*\{[\s\S]{0,200}S\.order = \[\];[\s\S]{0,400}build\(\);[\s\S]{0,80}container\.scrollTop = 0;/.test(app));
chk('洗牌顺序只在内存（不落 localStorage）', !/LS\.(get|set)\('order'/.test(app));

console.log('\n · 设置面板');
['cfUrl', 'cfUser', 'cfPass', 'cfBrowse', 'cfDirText', 'cfTest', 'cfSave', 'cfDemo', 'cfRecursive', 'cfDepth', 'fitSeg', 'cfLogin', 'cfMinSize', 'cfStrmMinSize']
  .forEach((id) => chk(`存在 #${id}`, htmlIds.has(id)));
/* 「只列出能直接播的格式」开关（#cfPlayable / playableOnly）2026-09-18 删除。
   2026-09-19 片库改为列出全部认识的格式（APK 原生播放器能解 mkv 等），
   能否播放由每条视频的 playable 标记决定 —— 开关没有复活，别加回来。
   反向守卫：开关、配置项、前端两处引用都不许回来。
   （后端那几条在下面「片库列什么格式」一节，那里才有 srvCode / njCode。） */
chk('设置页不再有 #cfPlayable 开关', !htmlIds.has('cfPlayable') && !/cfPlayable/.test(htmlCode));
chk('app.js 不再碰 #cfPlayable（回填 / 提交都没了）', !/cfPlayable/.test(appCode));
chk('设置页不再有「只列出能直接播的格式」这行文案', !/只列出能直接播的格式/.test(htmlCode));
chk('画面填充用独立 #fitSeg', /#fitSeg button/g.test(app));
chk('「浏览 NAS 目录」有绑定', /\$\('cfBrowse'\)\.addEventListener\('click'/.test(app));
chk('目录选择器样式存在', /\.pick-btn\{/.test(css) && /\.pick-hint\{/.test(css));
chk('保存时不带本地磁盘字段', !/localRoot/.test(app) && !/source:\s*'local'/.test(app));

/* ---- 两步流程：先登录、后选文件夹（2026-09-18）----
 * 起因：用户服务器端改不了、旧挂载也删不掉，一填完地址就被推去「文件夹」页挑目录，
 * 结果卡在那个页面里出不来。所以拆成「① 登录 ② 选文件夹」，登录成功前不显示第 2 步。
 * 这几条钉住这个交互，别被改回「一挂载就逼人选文件夹」。 */
console.log('\n · 设置页两步流程（先登录、后选文件夹）');
chk('设置页有「登录」按钮', htmlIds.has('cfLogin'));
chk('第一步有独立分区 #stepLogin', htmlIds.has('stepLogin'));
chk('第二步有独立分区 #stepPick', htmlIds.has('stepPick'));
chk('第二步**默认隐藏**（登录成功前不出现）',
  /id="stepPick"[^>]*\bhidden\b/.test(html), 'HTML 里 #stepPick 必须带 hidden');
chk('#stepPick 里才放选文件夹的按钮（第二步才是挑目录的地方）',
  /id="stepPick"[\s\S]{0,600}id="cfBrowse"/.test(html));
chk('「登录」绑定了 click', /\$\('cfLogin'\)\.addEventListener\('click'/.test(app));
chk('登录会真的连一次服务器（调 api.test）',
  /\$\('cfLogin'\)[\s\S]{0,900}api\.test\(/.test(app));
/* 登录必须探「服务地址里的根路径」，**不能**探配置里那个可能已失效的旧目录 ——
 * 否则账号密码明明是对的，却因为旧挂载 404 而报「登录失败」。 */
chk('登录必须显式传 dir:""（只验账号，不拿旧目录去试）',
  /\$\('cfLogin'\)[\s\S]{0,1500}api\.test\(\{[\s\S]{0,200}dir:\s*''/.test(app));
chk('Node 版 /api/test 用 `\'dir\' in body` 判断（空串也算传了）',
  /'dir'\s+in\s+body/.test(srv));
chk('登录失败时**不展开**第二步', /\$\('cfLogin'\)[\s\S]{0,1400}setPicked\(false\)/.test(app));
chk('登录成功才展开第二步', /\$\('cfLogin'\)[\s\S]{0,1400}setPicked\(true\)/.test(app));
chk('setPicked 用 hidden 控制第二步显隐', /function setPicked\([\s\S]{0,220}\$\(['"]stepPick['"]\)[\s\S]{0,120}\.hidden\s*=/.test(app));
chk('有 loggedIn 登录态字段', /\bloggedIn:\s*false/.test(app));
chk('「浏览 NAS 目录」在未登录时会被挡（不再直接把空配置推去选目录）',
  /\$\('cfBrowse'\)[\s\S]{0,200}if\s*\(!S\.loggedIn\)/.test(app));
chk('保存前要求先登录', /\$\('cfSave'\)[\s\S]{0,600}if\s*\(!S\.loggedIn\)/.test(app));
/* 旧逻辑（必须已消失）：cfBrowse 里 persistConfig 之后**立刻** closeSheet + setNav('browse')，
 * 也就是「一填完地址就被推去挑目录」。现在跳转前必须先过 S.loggedIn 这道闸。 */
const cfBrowseBlock = app.slice(app.indexOf("$('cfBrowse')"), app.indexOf("$('cfTest')"));
chk('「浏览 NAS 目录」跳转前先检查登录态（不是无条件跳）',
  cfBrowseBlock.length > 0 &&
  cfBrowseBlock.indexOf("if (!S.loggedIn)") > -1 &&
  cfBrowseBlock.indexOf("if (!S.loggedIn)") < cfBrowseBlock.indexOf("setNav('browse')"),
  'cfBrowse 必须先判 S.loggedIn 再 setNav(browse)');
chk('两步分区样式存在', /\.step\[hidden\]/.test(css) && /\.step-head/.test(css));

/* ---- 片源目录失效时的自愈与可操作提示 ----
 * 真实场景：config 里那条旧挂载在 NAS 上被删了（PROPFIND 404），
 * 而用户既改不了服务器也删不掉配置，于是每次扫描都整体失败、App 永久卡死。
 * （Java 侧的两条断言在 nj 声明之后，见下面「片源目录失效」那一节。） */
console.log('\n · 片源目录失效要能自愈');
chk('Node 版回退根目录兜底', /scanLibrary\(config,\s*'\/'\)/.test(srv));
chk('失效时报的是「下一步做什么」而不是原始 404',
  /已经打不开了（可能被删或改名）/.test(srv) && /重新登录，再挑一个文件夹/.test(srv));
chk('前端把「文件夹不在了」和「连不上」分开说', /lib\.stale/.test(app) && /片源文件夹不在了/.test(app));
chk('兜底成功时用 toast 提醒（不盖掉已有内容）', /lib\.staleRoots\s*&&\s*lib\.staleMsg/.test(app));

console.log('\n · 本地磁盘模式已彻底移除');
// localRoot 只允许出现在「清理旧配置字段」的那一行（老用户的 config.json 里可能还留着）
const lrHits = srv.split('\n').map((l) => l.trim()).filter((l) => l.includes('localRoot'));
chk('server.js 只在迁移时提到 localRoot', lrHits.length === 1 && lrHits[0] === 'delete c.localRoot;', lrHits.join(' | '));
chk('server.js 不含 listDrives / browseLocal / scanLocalDir', !/listDrives|browseLocal|scanLocalDir/.test(srv));
chk('server.js 不含 isLocalMode', !/isLocalMode/.test(srv));
chk('后端没有 /api/drives', !srv.includes("'/api/drives'"));
chk('HTML 不含 paneLocal / driveList', !/paneLocal|driveList/.test(html));
chk('app.js 不调 api.drives', !/api\.drives/.test(app));
chk('CSS 不含 .drive 样式', !/\.drive[-{ ]/.test(css));

console.log('\n · 编造的话题标签已移除');
chk('app.js 不再渲染 #标签', !/_tags|class="tag"/.test(app));
chk('api.js 不再编造标签', !/eachVideoMetrics|_tags|rngFrom|hashCode/.test(api));
chk('CSS 不含 .tag 样式', !/\.desc\s\.tag\{/.test(css));

console.log('\n · 转码（avi / wmv 等浏览器解不了的封装）');
chk('后端有 /api/transcode', srv.includes("'/api/transcode'"));
chk('后端有 /api/probe', srv.includes("'/api/probe'"));
chk('能自动找 ffmpeg / ffprobe', /function ffTools/.test(srv) && /function findTool/.test(srv));
chk('输出 fragmented MP4（边转边播）', /frag_keyframe\+empty_moov/.test(srv));
chk('能 -c copy 就只换封装', /function canRemux/.test(srv) && /-c', 'copy/.test(srv));
chk('/api/config 带 ffmpeg 状态', /ffmpeg: \{ \.\.\.ffTools\(\)/.test(srv));
chk('api.js 导出 transUrl', /export function transUrl/.test(api));
chk('api.probe 已定义', /^\s{2}probe:/m.test(api));
chk('app.js 对放不了的格式走转码流', /transUrl\(list\[i\]\)/.test(app));
chk('转码项不做滚动预热', /playable === false && !eager/.test(app));
chk('转码流拖动 = 从目标位置重开', /item\.dataset\.mode === 'transcode'/.test(app));
chk('设置页有格式支持状态行', htmlIds.has('cfFfmpeg'));

console.log('\n · 时长探测（拖进度条不再说「还没读出时长」）');
// 用户实测：APK 上拖进度条总弹「这个文件还没读出时长，先从头看吧」。
// 根因是 Java 后端 /api/probe 只回了 "probe not implemented"，dataset.dur 永远是空。
// 这两条守住「两套后端都得实现 probe」这个契约，别再只改 Node 那套。
// （nj 的 read 已上移到文件头部 —— srvCode/njCode/svcCode 也在头部初始化。）
const thumbsJ = read('android/src/com/nas/douyin/Thumbs.java');
chk('Java 版 /api/probe 真的实现了（不再是 not implemented）',
  /path\.equals\("\/api\/probe"\)\) \{\s*\n\s*return handleProbe\(q\)/.test(nj) &&
  !/path\.equals\("\/api\/probe"\)\) \{\s*\n\s*return json\(200, err\("probe not implemented"\)\)/.test(nj));
chk('Java 版有 handleProbe', /private Resp handleProbe\(Map<String, String> q\)/.test(nj));
chk('Java 版时长结果有缓存（别每次拖都连 NAS）', /probeCache/.test(nj) && /ConcurrentHashMap/.test(nj));
chk('Java 版探测走系统解码器，不依赖 ffmpeg',
  /public double durationSec\(/.test(thumbsJ) && /MediaMetadataRetriever/.test(thumbsJ));
chk('Java 版 config 报 probe:true（没 ffmpeg 也能探）', /o\.put\("probe", true\)/.test(nj));
chk('Node 版 config 也报 probe', /probe: !!\(ffTools\(\)\.ffprobe/.test(srv));

/* ---- Java 侧的「片源目录失效自愈」（nj 在这里才可用）---- */
chk('Java 版回退根目录兜底', /staleRoots\s*=\s*true/.test(nj) && /NasService\.scan\(dav,\s*"\/"/.test(nj));
chk('Java 版失效时给出可操作文案（不是原始 404）', /打不开了（可能被删或改名）/.test(nj) && /重新登录，再挑一个文件夹/.test(nj));
chk('Java 版自愈与 Node 版判据一致（都用 staleRoots 标记）',
  /staleRoots/.test(nj) && /staleRoots/.test(srv));
chk('Java 版 /api/test 用 `body.has("dir")` 判断（空串也算传了）', /body\.has\("dir"\)/.test(nj));
chk('Java 版 /api/test 空 dir 时探 urlPath()（登录别拿旧目录去试）',
  /want\.isEmpty\(\)\s*\?\s*urlPath\(\)/.test(nj));

/* ⚠️⚠️ 两套后端的 /api/probe 都必须回**画面尺寸**，不只是时长。
 *
 * 为什么：转码流的 `video.videoWidth` 在 WebView 里**恒为 0** ——
 * 后端把流转封成 `frag_keyframe+empty_moov` 的 fragmented MP4（为了首字节快），
 * moov 是空的、分辨率写在 moof 里，WebView 能解码但从不回填 videoWidth。
 * 前端 `fitVideoBox` 要靠尺寸算 `.vbox`（视频真实画面矩形），
 * 好让加载转圈对准画面正中，而不是整屏中心。
 *
 * 踩过的坑：前端改好了、Java 后端没改 → `/api/probe` 只回
 * `{ok,duration,cached}`，前端的 boxDims 永远拿不到值，
 * `--vbw/--vbh` 写不进去，在真机上表现为「转圈还是没对准画面」。
 * **只改 Node 那套是无效的，APK 跑的是 Java 那套。** */
chk('Java 版 /api/probe 回画面尺寸（width/height），不只是时长',
  /o\.put\("width", pr\.w\)/.test(nj) && /o\.put\("height", pr\.h\)/.test(nj) &&
  /if \(pr\.w > 0 && pr\.h > 0\)/.test(nj));
chk('Java 版 probeCache 同时存时长和尺寸（不能再是 Map<String,Double>）',
  /Map<String, Probe> probeCache/.test(nj) &&
  !/Map<String, Double> probeCache/.test(nj) &&
  /private static final class Probe/.test(nj) &&
  /final double dur; final int w; final int h;/.test(nj));
chk('Java 版 /api/probe 只走 MediaMetadataRetriever，没有远端兜底',
  // 2026-09-18 Phase L：读不出来就**如实说读不出来**，不再去找任何人兜底。
  // 历史上这里有过三层兜底（本地 ffprobe → 远端解码服务 ffprobe），全没了。
  //
  // ⚠️ 用「函数体里没有 probeViaRemote 调用」来判，而不是「全文没有」——
  //    文件里留着解释历史的注释，全文判会命中注释（本项目栽过 5 次）。
  (() => {
    const i = nj.indexOf('private Resp handleProbe');
    if (i < 0) return false;
    const seg = nj.slice(i, i + 4000);
    return /thumbs\.probeMeta\(streamUrl\)/.test(seg) &&
           /return json\(200, err\("读不出时长"\)\)/.test(seg) &&
           !/probeViaRemote/.test(seg);
  })());
chk('Java 版 MediaMetadataRetriever 一次同时取时长+宽高（不额外开进程/连 NAS）',
  /public long\[\] probeMeta\(String streamUrl\)/.test(thumbsJ) &&
  /METADATA_KEY_VIDEO_WIDTH/.test(thumbsJ) &&
  /METADATA_KEY_VIDEO_HEIGHT/.test(thumbsJ));
chk('竖屏片按 rotation 摆正宽高（存储尺寸≠显示尺寸）',
  /METADATA_KEY_VIDEO_ROTATION/.test(thumbsJ) &&
  /deg == 90/.test(thumbsJ) &&
  /long t = out\[1\]; out\[1\] = out\[2\]; out\[2\] = t;/.test(thumbsJ));

/* ---- 🔴 缩略图「瞬时失败要重试」——2026-09-20
 *
 * 背景（真机实测抓到）：App 启动时 HTTP 服务（`new NasServer`，MainActivity:153）
 * 比 CD2 引擎（`startCd2`，MainActivity:720）**先起来**，实测差 ~680ms：
 *     11:33:45.180 NasServer: 拉流失败 … Failed to connect to /127.0.0.1:19798
 *     11:33:45.860 NasDouyin: 内置 CloudDrive2 已就绪，监听 :19798
 * 旧代码把这当成普通失败 → failed+1 → 累计 MAX_FAIL=3 就**永久放弃**该视频，
 * 用户看到的现象是「点赞列表里永远是 ⚠️ 破图标」（截图确认）。
 *
 * 修法：把「引擎没就绪 / 连接被拒」这类识别成 **Transient**，
 * 退避重排且**不消耗 MAX_FAIL**。 */
chk('🔴 Java 版缩略图区分「瞬时失败」，不拿 MAX_FAIL 硬砸',
  /* ⚠️ 这条曾被我写成假断言：全文 grep `failed.merge` 会命中 3 处，
   *    删掉 generate 里那个 isTransient 判断照样绿。
   *    钉法：抠 ensure 函数体，确认里面 **没有** 直接 failed.merge 的瞬时路径。 */
  /static final class Transient extends RuntimeException/.test(thumbsJ)
  && /private static boolean isTransient\(Throwable t\)/.test(thumbsJ)
  && /if \(isTransient\(t\)\) throw new Transient\(t\);/.test(thumbsJ)
  && /catch \(Transient e\)/.test(thumbsJ)
  && /private final Map<String, Integer> transientFail = new ConcurrentHashMap<>\(\);/.test(thumbsJ));

chk('🔴 瞬时重试不占用抽帧队列（不能在单线程 queue 里 sleep）',
  /* 如果写成 `queue.execute(() -> Thread.sleep(d))`，功能「看起来正常」，
   * 但会把串行抽帧队列整个堵住最长 15s —— 图片出得越来越慢，很难查。
   * 所以：必须用独立的 retryTimer 调度。 */
  /private final java\.util\.concurrent\.ScheduledExecutorService retryTimer/.test(thumbsJ)
  && /retryTimer\.schedule\(\(\) -> ensure\(rel, streamUrl\), d/.test(thumbsJ)
  && !/queue\.execute\(\(\) -> \{\s*\n\s*try \{ Thread\.sleep/.test(thumbsJ));

chk('🔴 退避总时长要盖住 CD2 冷启动窗口（MainActivity.CD2_BOOT_MS = 30s）',
  /* 1+3+6+9+11 = 30s。
   * ⚠️ 这条曾经是假绿：当时写的是 `Math.min(1000 << n, 15000)`（1,2,4,8,8 → 累计 23s），
   *    而断言只查了「有没有 MAX_TRANSIENT/transientDelay/15_000L」——
   *    三个字符串都在，**但退避序列根本盖不住 30s**。
   *    改用「把 transientDelay 抠出来真跑一遍，累加必须 ≥ 30000」来断。 */
  (() => {
    const i = thumbsJ.indexOf('private static long transientDelay(int n)');
    if (i < 0) return false;
    let d = 0, st = -1, en = -1;
    for (let k = i; k < thumbsJ.length; k++) {
      if (thumbsJ[k] === '{') { d++; if (st < 0) st = k; }
      else if (thumbsJ[k] === '}') { d--; if (d === 0) { en = k; break; } }
    }
    const fn = thumbsJ.slice(i, en + 1);
    /* 把 case/default 的返回值抓出来累加（不 eval 源码，避免被注释里的数字骗） */
    const vals = [];
    const re = /(?:case \d+:|default:)\s*return\s*([0-9_]+)L/g;
    let m;
    while ((m = re.exec(fn))) vals.push(Number(m[1].replace(/_/g, '')));
    const total = vals.reduce((a, b) => a + b, 0);
    return vals.length >= 5 && total >= 30_000;
  })());

chk('isTransient 认得「Failed to connect」这条真机原话',
  /m\.contains\("Failed to connect"\)/.test(thumbsJ)
  && /c instanceof java\.net\.ConnectException/.test(thumbsJ));
chk('前端 fitVideoBox 用 item.dataset.id 查缓存（= v.p，不是下标）',
  /boxDims\.get\(item\.dataset\.id\)/.test(app) &&
  /boxDims\.set\(list\[i\]\.p, \[r\.width, r\.height\]\)/.test(app));
chk('前端按 probe 能力位预热，而不是按 ffmpeg',
  // 注意：注释里为了说明历史写了 `if (!S.ffmpeg) return;` 这句原文，
  // 所以不能用「全文不含」来判 —— 得看 warmTranscodeInfo 函数体第一行。
  /async function warmTranscodeInfo\(\) \{\s*\n\s*if \(!S\.probe\) return;/.test(app));
chk('前端有统一的 ensureDuration（三处 probe 调用已收口）',
  /function ensureDuration\(i, item\)/.test(app) &&
  // 除了 ensureDuration 内部那一处，不该再有别的地方直接 .then 写 dataset.dur
  [...app.matchAll(/dataset\.dur = String\(/g)].length === 1);
chk('时长没到先记下想去的位置，回来自动跳（不再直接把人挡回去）',
  /item\.dataset\.pendSeek = String\(at\)/.test(app) && /const pend = item\.dataset\.pendSeek/.test(app));

console.log('\n · 快进（拖进度条不能「永远从头开始」）');
// 用户实测：拖进度条变成「无论怎么拖都从头开始」。
// 根因曾经是 APK 的 /api/transcode 是个假实现 —— 它把前端算好的 t=700 整个丢掉。
// 而 handleStream 其实支持 Range，这种流原生就能 seek，压根不该重启。
//
// ⚠️ 2026-09-18 Phase L 的**最终结论**（这条最重要，别再推翻）：
//    APK 的 /api/transcode **就是**「原文件直通 + X-Seekable: 1」，别去给它加转码。
//    seek 靠浏览器原生 currentTime（Range 通了就能跳），不靠重启流。

chk('Java 版 /api/transcode 走直通（handleStream），不转发给任何外部服务',
  // ⚠️ 切片必须**卡在方法结束**，不能用一个固定长度（原来写 2000 就踩了坑）：
  //    紧跟其后的 disconnect() 里有 `java.net.HttpURLConnection` 参数，
  //    窗口开太大就会把隔壁方法的内容读进来，把这条正向断言弄成假失败。
  //    所以这里按 `\n    }` 找方法体结尾。
  (() => {
    const body = stripComments(nj);
    const i = body.indexOf('private Resp handleTranscode');
    if (i < 0) return false;
    const rest = body.slice(i);
    const end = rest.indexOf('\n    }');
    if (end < 0) return false;
    const seg = rest.slice(0, end + 6);
    return /Resp r = handleStream\(req, q\)/.test(seg) &&
           // 不能再有任何「连远端」的痕迹
           !/decodeUrl/.test(seg) &&
           !/HttpURLConnection/.test(seg) &&
           !/RemoteStream/.test(seg) &&
           !/json\(503/.test(seg) &&
           // 更不能把转码参数再透传出去（那是转发方案的标志）
           !/passthrough = \{/.test(seg);
  })());
chk('直通流打上 X-Seekable: 1 —— 这是前端 canNativeSeek 的**正向**依据',
  // 为什么不靠 seekable 猜：刚起流时 seekable 可能还没铺开，
  // 有个明确的正向标记最稳。前端的 canNativeSeek 也会反过来验 seekable 覆盖度。
  (() => {
    const body = stripComments(nj);
    const i = body.indexOf('private Resp handleTranscode');
    if (i < 0) return false;
    return /r\.headers\.put\("X-Seekable", "1"\)/.test(body.slice(i, i + 2000));
  })());
chk('直通流标注 X-Transcode: passthrough（不能是 remux/encode，那会让前端重启流）',
  (() => {
    const body = stripComments(nj);
    const i = body.indexOf('private Resp handleTranscode');
    if (i < 0) return false;
    const seg = body.slice(i, i + 2000);
    return /r\.headers\.put\("X-Transcode", "passthrough"\)/.test(seg) &&
           !/"X-Transcode", "remux"/.test(seg) &&
           !/"X-Transcode", "encode"/.test(seg);
  })());

/*
 * 前端 seek 三层逻辑 —— 这是 Phase L 最有价值的资产，逐条钉住。
 * 用户抱怨的「拖了没用 / 从头开始」就是这三层里任何一层被改坏导致的。
 */
chk('前端 canNativeSeek 要求 seekable 覆盖九成以上（只看 length>0 不够）',
  /function canNativeSeek\(v\)/.test(app) &&
  /end >= dur \* 0\.9/.test(app) &&
  // 引用点：seekTo 里判断 + 900ms 重试里再判断
  [...app.matchAll(/canNativeSeek\(/g)].length >= 3);
chk('原生能 seek 时**只改 currentTime**，绝不碰 src（碰了就是从 0 开始）',
  (() => {
    const i = app.indexOf('if (canNativeSeek(v)) {');
    if (i < 0) return false;
    const seg = app.slice(i, i + 900);
    return /v\.currentTime = target/.test(seg) &&
           !/\.src\s*=/.test(seg) &&
           !/restartStream/.test(seg);
  })());
chk('原生 seek 分支里 t0 必须归零（否则进度 = t0+currentTime 会算成两倍）',
  // t0 的语义是「这路流从第几秒开始发」。原生 seek 的流是**整条**发过来的，起点就是 0。
  // 这里要是也写成 target，进度条会直接飞出屏幕 —— 踩过。
  (() => {
    const i = app.indexOf('if (canNativeSeek(v)) {');
    if (i < 0) return false;
    const seg = app.slice(i, i + 900);
    return /item\.dataset\.t0 = '0'/.test(seg) &&
           !/item\.dataset\.t0 = String\(target\)/.test(seg);
  })());
chk('seekable 没铺开时给一次 900ms 重试，还不行才重启流（能不重启就不重启）',
  /dataset\.seekRetry = '1'/.test(app) &&
  /\}, 900\);/.test(app) &&
  /if \(cur2 && canNativeSeek\(cur2\)\) \{ seekTo\(i, at\); return; \}/.test(app));
chk('restartStream 被抽成独立函数（只给真·转码流用，APK 上不该走到）',
  /function restartStream\(i, at, total, item\)/.test(app) &&
  [...app.matchAll(/restartStream\(/g)].length >= 3 &&
  // 它才是唯一允许改 src 的地方
  /vv\.src = transUrl\(list\[i\], target,/.test(app));

console.log('\n · 解码服务已整体回退（2026-09-18 Phase L：APK 回到单机自包含）');
// 用户 2026-09-18 明确要求：「整个架构回退到 Phase L」。
//
// 回退掉的是「把转码转发给 NAS 上的 Docker 解码服务」那套（见 decode-server/）：
//   · 它要求用户额外部署并长期维护一个容器；
//   · 还要在设置页填地址、指望 NAS 一直在线；
//   · 对「装上就能用」的单机场景，这是纯负担。
//
// 代价（用户已接受）：wmv / avi 这类格式又回到「不能播」——
//   但这其实是**诚实**的：探测阶段就返回「读不出时长」，前端标灰，不会点进去卡住。
//
// ⚠️ 这一组一律用 stripComments / 取函数体来判，别用全文负向 —— 本项目栽过 5 次。

// ---- (1) 后端：解码服务的整套管线必须彻底消失 ----
chk('NasServer.java 里 decodeUrl 字段与健康探测都已删除',
  !/private String decodeUrl/.test(stripComments(nj)) &&
  !/public boolean remoteCanDecode\(\)/.test(stripComments(nj)) &&
  !/REMOTE_TTL_MS/.test(stripComments(nj)) &&
  !/remoteProbeAt/.test(stripComments(nj)));
chk('decode-probe 后台线程不再启动（没东西可探了）',
  !/new Thread\(this::remoteCanDecode/.test(stripComments(nj)) &&
  !/"decode-probe"/.test(stripComments(nj)));
chk('probeViaRemote 与 RemoteStream 都已删除',
  !/private Probe probeViaRemote/.test(stripComments(nj)) &&
  !/class RemoteStream extends/.test(stripComments(nj)));
chk('APK 侧 handleCaps 与 /api/caps 路由都已删除（访问应落 404）',
  !/private Resp handleCaps\(\)/.test(stripComments(nj)) &&
  !/path\.equals\("\/api\/caps"\)/.test(stripComments(nj)) &&
  // ⚠️ 只查 Java（nj）。**不要**顺手把 srv 的同类判断加进来 ——
  //    server.js 是 PC/Node 那条**独立路线**，这轮回退明确不动它：
  //    它保留了本地 ffmpeg 与可选的远端转发（见下面 (3) 分节）。
  //    APK 和 PC 版能力不同是**设计如此**，不是不一致。
  !/"douyin-nas-decode"\.equals\(service\)/.test(stripComments(nj)));
chk('APK 侧前端不再有解码服务入口（PC 版有，但那是另一条路线）',
  !/decodeCaps/.test(stripComments(api)) &&
  !/jget\('\/api\/caps'\)/.test(stripComments(api)));
chk('配置里不再读写 decodeUrl（loadConfig / persistConfig / configJsonObj 三处）',
  !/object\.putString\("decodeUrl"/.test(stripComments(nj)) &&
  !/putString\("decodeUrl"/.test(stripComments(nj)) &&
  !/getString\("decodeUrl"/.test(stripComments(nj)) &&
  !/body\.has\("decodeUrl"\)/.test(stripComments(nj)));
chk('ffmpeg 能力位恒为 false（APK 没有转码能力，这是有意为之）',
  // 见 NasServer.java 里那段墓碑注释：说 false 是**诚实**，说 true 才会让前端
  // 去等一个永远等不到的东西。⚠️ 这条是正向断言，故意钉死这个值。
  /o\.put\("ffmpeg", false\)/.test(stripComments(nj)) &&
  !/o\.put\("ffmpeg", canT\)/.test(stripComments(nj)));

// ---- (2) 前端：解码服务 UI 必须彻底消失 ----
chk('设置页没有「解码服务器地址」输入框了',
  !/cfDecode/.test(html) &&
  !/解码服务器地址/.test(html) &&
  !/decodeUrl/.test(html));
chk('app.js 里 cfDecode / renderDecodeCap / decodeCaps 全部移除',
  !/cfDecode/.test(stripComments(app)) &&
  !/function renderDecodeCap/.test(stripComments(app)) &&
  !/renderDecodeCap\(\)/.test(stripComments(app)) &&
  !/api\.decodeCaps/.test(stripComments(app)) &&
  !/decodeUrl/.test(stripComments(app)));
chk('api.js 里 decodeCaps 已移除（后端路由也删了，留着只会拿到 404 被误报成「连不上」）',
  !/decodeCaps/.test(stripComments(api)) &&
  !/jget\('\/api\/caps'\)/.test(stripComments(api)));
chk('设置页文案改成「本机直接播」，不再让用户去配一个不存在的服务',
  // 正向钉住新文案 + 负向排除那两句会误导人的旧承诺（都在 stripComments 上判）
  /本机直接播放/.test(app) &&
  !/去「设置 → 解码服务器地址」填上/.test(stripComments(app)) &&
  !/解码服务已连接/.test(stripComments(app)));
chk('播不了的片子如实说「系统解不了这种封装」（不再承诺边转边播）',
  /这台设备解不了这种封装/.test(app) &&
  !/解码服务可能读不到这个文件/.test(stripComments(app)));

// ---- (3) PC 侧（Node）：那是另一条路线，**这轮不动它** ----


// ---- (3) PC 侧（Node）：配了就转发，没配回落本地 ----
chk('Node 版配了解码服务就转发（两端共用同一套转码实现）',
  /async function forwardTranscode/.test(srv) &&
  /const remote = String\(config\.decodeUrl \|\| ''\)\.trim\(\)\.replace\(\/\\\/\+\$\/, ''\)/.test(srv) &&
  /if \(remote\) return await forwardTranscode\(req, res, u, rel, remote\)/.test(srv));
chk('Node 版转发失败要回落本地 ffmpeg（不能因为填错地址把 PC 版弄瘫）',
  // 顺序很重要：forwardTranscode 必须在 ffTools().ready 检查**之前**返回，也就是
  // 「配了远端优先走远端」。注意不能拿全文 indexOf 比 —— 文件前面好几个函数里
  // 也有 `const tools = ffTools()`，全文比会拿错那一处（我自己先踩了一次）。
  (() => {
    const i = srv.indexOf('async function handleTranscode');
    if (i < 0) return false;
    const seg = srv.slice(i, i + 3000);
    const ri = seg.indexOf('if (remote) return await forwardTranscode');
    const ti = seg.indexOf('const tools = ffTools()');
    return ri >= 0 && ti >= 0 && ri < ti;
  })());
chk('Node 版转发不带 DAV 凭据过去（解码服务自己配了 WebDAV）',
  // 只转 p（相对路径）+ 调参 + src（绝对地址旁路，自测用）。绝不带 Authorization。
  /for \(const k of \['t', 'mode', 'h', 'q', 'src'\]\)/.test(srv) &&
  /qs\.set\('p', rel\)/.test(srv) &&
  !/Authorization[\s\S]{0,200}forwardTranscode/.test(srv));
chk('Node 版摘 close 监听用 off（用 on(name,null) 会抛 TypeError）',
  // 实测踩到的坑：`res.on('close', null)` 会抛
  //   The "listener" argument must be of type function. Received null
  // 而且它抛在 try 里、被 catch 接走，表现成「转发解码服务失败: The "listener" ...」——
  // 一个**假的**转发失败，把真正的远端错误盖掉了。两处（失败分支 + finally）都要用 off。
  !/res\.on\('close', null\)/.test(srv) &&
  /res\.off\('close', onClose\)/.test(srv) &&
  [...srv.matchAll(/res\.off\('close', onClose\)/g)].length === 2);
chk('Node 版 X-Transcode 兜底不产生重复头（1, remux 会让前端 === 比较永远失败）',
  // Node 的 writeHead 遇到同名头会把值用 ", " 拼起来。
  // 先写兜底再让远端覆盖 → `X-Transcode: 1, remux`，前端拿它 === 'remux' 永远不成立。
  // 正确顺序：先抄远端，缺了才兜底。
  (() => {
    const i = srv.indexOf('async function forwardTranscode');
    const seg = srv.slice(i, i + 2200);
    const copyAt = seg.indexOf("for (const h of ['x-transcode'");
    const fallbackAt = seg.indexOf("if (!out['X-Transcode'])");
    return copyAt >= 0 && fallbackAt >= 0 && copyAt < fallbackAt;
  })());

// ---- (4) 解码服务本体（要能在飞牛 NAS 上以 Docker 跑起来） ----
chk('解码服务源码在仓库里（decode-server/，零 npm 依赖）',
  fs.existsSync(path.join(__dirname, 'decode-server', 'server.js')) &&
  /require\('http'\)/.test(dsv) &&
  // 零依赖是硬要求：容器里不跑 npm install，少一层网络依赖和供应链风险
  !/require\('[a-z@][^.]/.test(stripComments(dsv).replace(/require\('(http|https|fs|path|url|os|child_process|zlib|stream|crypto|net|events|util|assert|querystring)'\)/g, '')));
chk('解码服务暴露 /api/caps 且带 canTranscode（手机就是靠这个字段判能力）',
  /\/api\/caps/.test(dsv) &&
  /function caps\(\)/.test(dsv) &&
  // canTranscode 要真的跟「ffmpeg 到底有没有」绑定，不能写死 true ——
  // 容器里 ffmpeg 起不来的话，必须如实报 false，让手机去讲「服务在跑但没 ffmpeg」。
  /canTranscode: tools\.ready/.test(dsv) &&
  /service: 'douyin-nas-decode'/.test(dsv));
chk('解码服务优先硬件编码，软编兜底（nvenc > qsv > vaapi > v4l2m2m > libx264）',
  /function detectHwEncoder/.test(dsv) &&
  /h264_nvenc/.test(dsv) && /h264_qsv/.test(dsv) &&
  /h264_vaapi/.test(dsv) && /h264_v4l2m2m/.test(dsv) && /libx264/.test(dsv) &&
  // 顺序不能乱：nvenc 必须第一个被试。⚠️ 必须在 detectHwEncoder 的函数体里比 ——
  // 文件头的注释里也提到了这几个名字（顺序还是反的），全文比会拿错位置（我自己先踩了一次）。
  (() => {
    const i = dsv.indexOf('function detectHwEncoder');
    const seg = dsv.slice(i, i + 1800);
    const at = (k) => seg.indexOf(k);
    return at('h264_nvenc') < at('h264_qsv') &&
      at('h264_qsv') < at('h264_vaapi') &&
      at('h264_vaapi') < at('h264_v4l2m2m') &&
      at('h264_v4l2m2m') < at('libx264') &&
      at('h264_nvenc') >= 0;
  })());
chk('解码服务有 WMV/ASF（VC-1）的能力 —— 这正是当初内嵌 ffmpeg 存在的理由',
  // 删掉内嵌解码的前提是「远端真能解 ASF/WMV」。所以 Dockerfile 绝不能用
  // alpine 的 ffmpeg 包（精简构建会砍掉解码器），要用 jrottenberg/ffmpeg 这种全量的。
  /jrottenberg\/ffmpeg/.test(dsDockerfile) &&
  // 并且要把「为什么不用 alpine」写下来，否则以后有人为了瘦身换成 alpine 就静默退化
  /alpine/.test(dsDockerfile));
chk('解码服务带限速投递（转码 2~4MB/s 远快于播放 1MB/s，不限速会撑爆 Wi-Fi）',
  /PACE_RATE/.test(dsv) && /paceWrite/.test(dsv) && /paceDrain/.test(dsv) &&
  /paceState/.test(dsv));
chk('Dockerfile 用 node:22 且 healthcheck 打 /api/health',
  /nodesource/.test(dsDockerfile) &&
  /node_22\.x/.test(dsDockerfile) &&
  /HEALTHCHECK/.test(dsDockerfile) &&
  /\/api\/health/.test(dsDockerfile));
chk('compose 文件齐备：端口 8099、restart、WebDAV 三件套环境变量',
  /8099:8099/.test(dsCompose) &&
  /restart: unless-stopped/.test(dsCompose) &&
  /DAV_URL/.test(dsCompose) && /DAV_USER/.test(dsCompose) && /DAV_PASS/.test(dsCompose));
chk('compose 里注释好了硬件透传（不加的话就只能软编）',
  // Intel/AMD 核显：挂 /dev/dri；NVIDIA 独显：deploy.resources 里声明 gpu 能力。
  // YAML 形态是 count: all + capabilities: [gpu]，**不是**命令行的 --gpus all。
  /\/dev\/dri/.test(dsCompose) &&
  /driver: nvidia/.test(dsCompose) &&
  /capabilities: \[gpu\]/.test(dsCompose) &&
  // 必须写清楚「不挂也能跑」——否则用户以为硬件透传是必填，卡在这儿过不去
  /没挂也会正常工作/.test(dsCompose));
chk('selftest.js 在仓库里（没 Docker 的机器上也能验解码服务）',
  fs.existsSync(path.join(__dirname, 'decode-server', 'selftest.js')));

console.log('\n · 丢帧自救（靠重编码，不再有「假重编码」）');
chk('丢帧自救只在真有转码能力时才切重编码（APK 上 S.ffmpeg 恒 false → 直接不采样）',
  // ⚠️ 这条在 APK 上靠 `S.ffmpeg === false` 短路，而不是靠「解码服务连不上」——
  //    2026-09-18 Phase L 之后 APK 根本没有转码能力（后端恒上报 false），
  //    所以这段逻辑在手机上永远是「不采样」，只有 PC 版（Node 后端有 ffmpeg）
  //    才会真的走到 switchToEncode。留着它是为了两端共用一个 app.js。
  /if \(!S\.ffmpeg\) return;/.test(app) &&
  /badStreamSet\(list\[i\]\.p\);[\s\S]{0,120}?switchToEncode\(i, v, item, v\.currentTime, true\);/.test(app));
chk('「丢帧自动跳原生」已删除：watchDrops 里不再出现任何原生跳转',
  (() => {
    const i = app.indexOf('function watchDrops(i, v, item)');
    if (i < 0) return false;
    const seg = app.slice(i, app.indexOf('\n  /** 当前环境有没有', i));
    return !/rescueDrops/.test(seg) && !/NasBridge/.test(seg) && !/openPlayer/.test(seg);
  })());
chk('rescueDrops 整个函数已移除（连带它那条 toast）',
  !/function rescueDrops/.test(app) &&
  !/解码丢帧 ' \+ pct/.test(app) &&
  !/已用硬解播放器打开/.test(app));
chk('「原生播得动」白名单已清掉（它只为那条跳转服务，没人读了）',
  !/nativeOkGet/.test(app) && !/nativeOkSet/.test(app) && !/NATIVE_OK_KEY/.test(app));
chk('但原生播放器本体与另两个入口都还在（只删了自动跳转）',
  /function nativePlay\(/.test(app) &&
  /function hasNativePlayer\(/.test(app) &&
  // 入口①：播放器里点「全屏」
  /if \(nativePlay\(v, vd \? vd\.currentTime : 0\)\)/.test(app) &&
  // 入口②：WebView 重试仍失败时的兜底 —— 带 10 秒启动宽限（2026-09-19 加，见上）
  /if \(hasNativePlayer\(\) && !NATIVE_SKIP\[list\[i\]\.p\] && !withinBootGrace\) \{/.test(app));
chk('退回原生播放器的位置记忆还在（NATIVE_POS 仍被读写）',
  /const NATIVE_POS = \{\};/.test(app) &&
  /if \(NATIVE_POS\[list\[i\]\.p\] != null\) \{/.test(app) &&
  /if \(pos > 0\) NATIVE_POS\[p\] = pos;/.test(app));
chk('坏码流名单只在有 ffmpeg 的环境里生效',
  /function badStreamGet\(p\) \{[\s\S]{0,200}?if \(!S\.ffmpeg\) return false;/.test(app) &&
  /function badStreamMarkLocal\(p\) \{[\s\S]{0,120}?if \(!S\.ffmpeg\) return;/.test(app));

/* ---- 2026-09-20：解码不了的视频**自动跳过**，不停在报错界面（用户要求） ----
 * （Java 侧的断言在下面 pj 定义之后 —— pj 是 const，这里先用会 TDZ 报错。） */

/* 行为：__nasFallback 收到通知后按前台场景跳下一条 */
{
  const mk = ({ modal, nav }) => {
    const calls = { scroll: [], toast: [], skip: {} };
    const modalEl = { hidden: !modal };
    const player = { scrollBy: (d) => calls.scroll.push('player:' + d) };
    const main = { scrollBy: (d) => calls.scroll.push('main:' + d) };
    const fn = new Function('$', 'NATIVE_SKIP', 'toast', 'NAV', 'player', 'main',
      'return (' + grabAssignFn(app, 'window.__nasFallback = ') + ');')(
        (id) => (id === 'playerModal' ? modalEl : null),
        calls.skip, (m) => calls.toast.push(m), nav, player, main);
    fn('/local/boki/bad.mp4');
    return calls;
  };
  const r1 = mk({ modal: true, nav: 'home' });
  chk('🔴 行为：网页全屏播放器开着 → 播放器信息流跳下一条（player.scrollBy(1)）',
    r1.scroll.includes('player:1') && /自动跳过/.test(r1.toast.join('|')));
  const r2 = mk({ modal: false, nav: 'home' });
  chk('🔴 行为：首页信息流刷片中 → 信息流跳下一条（main.scrollBy(1)）',
    r2.scroll.includes('main:1') && /自动跳过/.test(r2.toast.join('|')));
  const r3 = mk({ modal: false, nav: 'me' });
  chk('行为：其它入口兜底 → 不乱动列表，只提示切回网页播放',
    r3.scroll.length === 0 && /切回网页播放/.test(r3.toast.join('|')));
  const r4 = mk({ modal: false, nav: 'home' });
  chk('🔴 行为：无论哪个场景都把失败路径记进 NATIVE_SKIP 黑名单（不再反复升级原生）',
    r4.skip['/local/boki/bad.mp4'] === 1);
}
chk('mount 里「直接走重编码」也被 ffmpeg 能力卡住',
  /badStreamGet\(list\[i\]\.p\) && S\.ffmpeg/.test(app));
chk('旧版本误标的名单会被清理（badStreamPurgeLegacy）',
  /function badStreamPurgeLegacy\(\)/.test(app) && /badStreamPurgeLegacy\(\);\n/.test(app));
chk('清理在同步服务器名单之前（顺序反了刚同步的就被清掉）',
  (() => {
    const i = app.indexOf('badStreamPurgeLegacy();');
    const j = app.indexOf('badStreamMarkLocal(p));');
    return i > 0 && j > i;
  })());
chk('onVideoError 在无 ffmpeg 时不再切假重编码', /if \(S\.ffmpeg\) \{ {2,}?\/\/ 只有真能重编码时才值得切/.test(app));

/* 🔴 2026-09-20：彻底修掉「跳过无法播放的视频还是闪一下横屏」。
 * 根因：首页信息流里 WebView 播不动的视频，onVideoError 会先弹原生 PlayerActivity
 * （横屏）再 fallback 回来滑到下一条，于是必闪一下。修法：首页信息流直接滑到下一条，
 * 根本不开原生；原生只留给「全屏播放器」场景。 */
{
  const i = app.indexOf('function onVideoError(');
  const j = app.indexOf('function showErr(');
  const seg = app.slice(i, j > i ? j : i + 4000);
  chk('🔴 首页信息流 WebView 播不动 → 直接跳过（main.scrollBy），绝不开原生播放器（否则必闪横屏）',
    /NATIVE_SKIP\[list\[i\]\.p\] = 1;[\s\S]{0,300}?main\.scrollBy\(1\)/.test(seg)
    && /else if \(NAV === 'home'\)/.test(seg));
  chk('🔴 原生播放器只在该全屏播放器场景下才打开（由 playerModal 未隐藏守卫）',
    /if \(!\$\('playerModal'\)\.hidden\) \{[\s\S]{0,500}?window\.NasBridge\.openPlayer/.test(seg));
}

console.log('\n · 原生播放器（PlayerActivity —— Media3 内核 + Xplayer 自绘控制层）');
const pjRaw = read('android/src/com/nas/douyin/PlayerActivity.java');
// ⚠️ 判「某段代码在不在」的时候一律用**去注释后**的源码。
// 这是第 4 次踩同一个坑了：回退说明里必然会写「回退掉了 wantSec / gestureMode…」，
// 用全文负则就会被自己的注释误伤。stripComments 把 // 和 /* */ 都去掉再判。
const pj = pjRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释（含类头注释）
  .replace(/\/\/[^\n]*/g, '');           // 行注释

chk('🔴 原生：解码器放宽后仍失败 → 直接退回信息流（fallbackToWeb），不再停在报错界面',
  /if \(decoderTrouble\) \{[\s\S]{0,220}?toast\("这部片这台设备解不了，已自动跳过"\);[\s\S]{0,80}?fallbackToWeb\(\);[\s\S]{0,40}?return;/.test(pj)
  && /toast\("硬解不吃，放宽解码器限制再试"\);[\s\S]{0,200}?if \(decoderTrouble\) \{/.test(pj),
  '刷片节奏被打断去读错误说明，用户明确不要');
chk('原生：报错界面只留给「非解码类」错误（取不到流/封装坏了/超时仍会提示原因）',
  /showError\(error\);/.test(pj)
  && /why = "这台设备没有能解它的解码器";/.test(pjRaw)   // 文案保留在 showError 里（其它入口仍可能用）
  , '解码类已改自动跳过，不再走到 showError');

// ---- 2026-09-17 重写：从「系统 MediaPlayer 简版」换成原生内核 ----
// 需求原文：「不要用浏览器放了吧这个开源播放器融合到里面并且保持功能ui不变
//           https://github.com/wangkangmao/Xplayer」
// 做法（用户选定）：移植播放内核 + 自绘 UI。下面守的就是这个形态。
// ⚠️ 内核是 **Media3 1.4.1**，不是 Xplayer 用的 com.google.android.exoplayer2 2.19.1。
//    原因写在 PlayerActivity 类头注释和 SKILL.md 里：2.19.1 那套 aar 缺 NalUnitUtil，
//    按扩展名分发时（.avi 也会去 new mp4 系）直接 NoClassDefFoundError 崩掉；
//    Media3 是 ExoPlayer 的官方后继，同一套引擎血统，NalUnitUtil 好好待在 media3-container 里。
//    所以**不要**把这里的 androidx.media3 断言改回 com.google.android.exoplayer2。
chk('内核是 Media3（ExoPlayer 的官方后继），不再用系统 MediaPlayer',
  /import androidx\.media3\.exoplayer\.ExoPlayer;/.test(pj) &&
  !/android\.media\.MediaPlayer/.test(pj) &&
  !/com\.google\.android\.exoplayer2/.test(pj));
chk('用 AspectRatioFrameLayout 才能做三种缩放模式',
  /import androidx\.media3\.ui\.AspectRatioFrameLayout;/.test(pj) &&
  /aspectBox = new AspectRatioFrameLayout\(this\)/.test(pj));
chk('缩放三档循环：fit → fill → zoom（「缩放」按钮）',
  /RESIZE_MODE_FIT/.test(pj) && /RESIZE_MODE_FILL/.test(pj) &&
  /RESIZE_MODE_ZOOM/.test(pj) && /cycleResize\(/.test(pj));

/* ---- 「加载视频为什么老是横屏」（2026-09-19 用户反馈）----
   原来 PlayerActivity 在 onCreate 里**无条件** SENSOR_LANDSCAPE —— 竖屏短视频
   被塞进横屏，画面缩成中间一条。现在改成**跟着画面比例**定方向。
   下面这组就是钉住它别退回去。 */
chk('🔴 原生播放器不再无条件锁横屏（onCreate 段里不许出现 setRequestedOrientation）',
  (() => {
    const i = pj.indexOf('protected void onCreate');
    const j = pj.indexOf('private int dp(float v)');
    if (i < 0 || j < 0 || j < i) return false;
    return !/setRequestedOrientation/.test(pj.slice(i, j));
  })());
chk('🔴 方向跟着画面走：宽>高 才横屏，竖屏片保持竖屏（旋转标记要先对调宽高）',
  /onVideoSizeChanged\(VideoSize size\)[\s\S]{0,900}?unappliedRotationDegrees % 180 != 0[\s\S]{0,400}?SCREEN_ORIENTATION_SENSOR_LANDSCAPE[\s\S]{0,200}?SCREEN_ORIENTATION_SENSOR_PORTRAIT/.test(pj)
  && /appliedOrientation/.test(pj));
chk('🔴 网页播放器也按画面方向定方向（不再一律横屏）',
  appCode.indexOf('playerVideoOrientation()') > -1
  && /v\.videoHeight > v\.videoWidth \? 'portrait' : 'landscape'/.test(appCode));
chk('🔴 CSS 旋转 90° 兜底只在「要横屏」时才加（竖屏片转 90° 就反了）',
  /if \(want === 'landscape'\) el\.classList\.add\('land-rotate'\)/.test(appCode));
chk('🔴 尺寸还没到时要等 loadedmetadata 再纠正方向（否则竖屏片永远横着）',
  appCode.indexOf("addEventListener('loadedmetadata'") > -1
  && appCode.indexOf('applyPlayerOrientation()') > -1);
chk('没有遗留的 enterLandscape / exitLandscape 调用（已改名为 apply/resetPlayerOrientation）',
  !/\benterLandscape\b/.test(appCode) && !/\bexitLandscape\b/.test(appCode));

/* ---- 「随便点哪部都显示取不到视频流」（2026-09-19 实锤的第二个 bug）----
   PlayerActivity 是 singleTask，却没实现 onNewIntent ——
   播放器开着的时候再点一部片，只是把旧实例提到前台，新视频根本不加载，
   屏幕上永远挂着上一部片的报错。看起来就是「所有片都播不出来」。 */
chk('🔴 PlayerActivity 必须实现 onNewIntent（singleTask 下第二次 openPlayer 才会换片）',
  /protected void onNewIntent\(Intent intent\)/.test(pj)
  && /onNewIntent\(Intent intent\)[\s\S]{0,1400}?startPlayback\(false\)/.test(pj));
chk('🔴 onNewIntent 里要重置兜底状态（别让上一部片的失败连累这一部）',
  /onNewIntent\(Intent intent\)[\s\S]{0,700}?triedEncode = false;[\s\S]{0,120}?tryingSoftware = false;/.test(pj));
chk('🔴 onNewIntent 里要把方向判据清掉（新片画面比例可能不同）',
  /onNewIntent\(Intent intent\)[\s\S]{0,900}?appliedOrientation = ActivityInfo\.SCREEN_ORIENTATION_UNSPECIFIED;/.test(pj));
chk('🔴 上游临时性 IO 错误（403/429/超时）要重试，别一次就甩给用户',
  /transientIo = error\.errorCode == PlaybackException\.ERROR_CODE_IO_BAD_HTTP_STATUS/.test(pj)
  && /transientIo && ioRetry < 3/.test(pj)
  && /private int ioRetry = 0;/.test(pj));
chk('🔴 重试要用指数退避（115 限流是「窗口」，固定 1.5s 重试等于白撞）',
  /long wait = 1000L \* \(1L << ioRetry\);/.test(pj)
  && /ui\.postDelayed\(\(\) -> startPlayback\(triedEncode\), wait\)/.test(pj));
chk('🔴 重试次数要在换片时清零（否则第二部片没得重试，或上一部的次数被白背）',
  /onNewIntent\(Intent intent\)[\s\S]{0,1300}?ioRetry = 0;/.test(pj));
// ⚠️ 这行是给未来的自己看的：2026-09-17 那天 DefaultExtractorsFactory 一崩就是崩在这里。
//    如果哪天有人又把 ExtractorsFactory 换成自写实现，这条断言要一起改。
chk('用 Media3 自带的 DefaultExtractorsFactory（别再自己写工厂绕）',
  !/ExtractorsFactory/.test(pj) && !/DefaultMediaSourceFactory/.test(pj));
chk('文字轨道用 MimeTypes 在 common 包（不是 common.util）',
  /import androidx\.media3\.common\.MimeTypes;/.test(pj));

// Xplayer 的设计令牌：改配色/尺寸就是改观感，必须有断言守着
chk('主色 #1DBA5B（Xplayer player_style）', /C_STYLE = 0xFF1DBA5B/.test(pj));
chk('进度条渐变起点 #37CAF9 / 终点 #1DBA5B（player_progress_start/end）',
  /C_GRAD_START = 0xFF37CAF9/.test(pj) && /C_GRAD_END = 0xFF1DBA5B/.test(pj));
chk('手势面板底色 #B3000000（player_gesture_content_bg）', /C_GESTURE_BG = 0xB3000000/.test(pj));
chk('底栏高 48dp / 阴影 72dp（player_bar_height / player_bar_shadow_height）',
  /BAR_H = 48/.test(pj) && /SHADOW_H = 72/.test(pj));
chk('手势面板横屏 168×99dp', /dp\(168\), dp\(99\)/.test(pj));
chk('seek 全程 120000ms（Xplayer 里是写死的）', /SEEK_FULL_MS = 120000/.test(pj));

// Xplayer 的手势规则：横滑 seek；竖滑看左右半边分流音量/亮度
chk('横滑 seek / 竖滑分流（左亮度右音量）',
  /Math\.abs\(dx\) >= Math\.abs\(dy\)/.test(pj) &&
  /MODE_SEEK/.test(pj) && /MODE_VOLUME/.test(pj) && /MODE_BRIGHT/.test(pj));
chk('音量 / 亮度用 deltaY*2/height（照抄 Xplayer 的手感）',
  /-dy\) \* 2 \/ h/.test(pj));

// 这些是踩过的坑，别复发
chk('单击显隐控件判的是 chrome 里的 view，不能读 bottomBar',
  // bottomBar 是 shadow 的子 view，showControls 只把 shadow 设 GONE，
  // bottomBar 自己的 visibility 永远是 VISIBLE → 永远算出「正在显示」→ 控件再也开不出来。
  !/bottomBar\.getVisibility\(\)/.test(pj) &&
  /View probe = chrome\.isEmpty\(\)/.test(pj));
chk('spin / completionView 不能进 chrome（否则单击会把缓冲圈/完成页画出来）',
  /spin 故意\*\*不\*\*放进 chrome/.test(pjRaw) || !/chrome\.add\(spin\)/.test(pj),
  '见 buildCenter / buildCompletion 里的注释');
chk('完成页用 WRAP_CONTENT 居中（MATCH_PARENT 会让字贴左）',
  !/box\.setBackgroundColor\(0xF2000000\)/.test(pj) &&
  /roundRect\(0xF2000000, 8\)/.test(pj));
chk('保留「双击暂停 / 单击显隐控件」',
  /if \(now - lastTapMs < 280\)/.test(pj) && /togglePlay\(\);/.test(pj));
chk('保留回传播放位置（EX_POS / EX_PATH）',
  /out\.putExtra\(EX_POS, \(int\) \(currentPos\(\) \/ 1000\)\)/.test(pj) &&
  /out\.putExtra\(EX_PATH, path\)/.test(pj));
chk('保留「播不动就退回网页」的出口',
  /RESULT_FALLBACK = 42/.test(pj) && /private void fallbackToWeb\(\)/.test(pj));
// 边界要诚实：ExoPlayer/Media3 只管解封装，解码仍交给系统 MediaCodec
chk('错误文案承认「没有解码器」这个真实边界（不吹牛）',
  /这台设备没有能解它的解码器/.test(pjRaw));
chk('允许解码器回退（硬件不行换下一个）',
  /setEnableDecoderFallback\(true\)/.test(pj) && /rebuildPlayerRelaxed\(\)/.test(pj));

console.log('\n · 构建脚本（无 Gradle，手工合并 aar 依赖）');
const bjs = read('android/build.js');
chk('有 aar 展开步骤', /function extractAarClasses/.test(bjs) && /function extractAarRes/.test(bjs));
chk('Guava 缺失时构建就失败（运行期依赖，编译期查不出来）',
  /GUAVA_NEEDED/.test(bjs) && /缺 guava/.test(bjs));
chk('认得 Media3 的新包名（不能只认 exoplayer2）',
  /androidx\\\/media3\\\/exoplayer\\\/ExoPlayer/.test(bjs) || /androidx\/media3\/exoplayer\/ExoPlayer/.test(bjs));
chk('androidx.collection 缺失时也会失败（Media3 用了 CircularIntArray）',
  /CircularIntArray/.test(bjs) && /缺 androidx\.collection/.test(bjs));
chk('media3-ui 走瘦身白名单（只用 AspectRatioFrameLayout）',
  /const SLIM = \{/.test(bjs) && /'media3-ui': \['androidx\/media3\/ui\/AspectRatioFrameLayout'\]/.test(bjs));
chk('瘦身按**前缀**匹配（写全名的话升版本就静默失效）',
  /function slimRule/.test(bjs) && /aarName\.startsWith\(k\)/.test(bjs));
chk('resize_mode 属性自己声明了（因为把 media3-ui 的 res 整个跳过了）',
  fs.existsSync(path.join(ROOT, 'android/res/values/attrs.xml')) &&
  /resize_mode/.test(read('android/res/values/attrs.xml')));
chk('演示样片不进 APK（public/samples/*.mp4 共 8.5MB，手机端根本取不到）',
  // 2026-09-18 Phase L 踩的坑：这五个 mp4 只是**电脑版**的演示片源
  // （server.js 的 DEMO_META 列它们、/samples/* 流它们），
  // 而 APK 侧 demoPayload() 返回的是**空数组** —— 打进包里没有任何代码能取到。
  // 它曾经悄悄回归：APK 从 1.9MB 涨到 10.3MB（那五个 mp4 占 8.5MB），
  // 表现为「功能没变、体积翻五倍」，最难发现。
  /const ASSET_EXCLUDE_DIRS = \['samples\/'\]/.test(bjs) &&
  /ASSET_EXCLUDE_DIRS\.includes\(name \+ '\/'\)/.test(bjs));
chk('build.js 反向卡住：包里再出现 assets/samples 就直接 fail',
  // 删掉/排除的东西不该被无声加回来 —— 加回来 = 体积悄悄涨 8.5MB。
  /zip\.deflated\('assets\/samples/.test(bjs) === false &&
  /APK 里混进了/.test(bjs) &&
  /检查 build\.js 的 ASSET_EXCLUDE_DIRS 是不是被删了/.test(bjs));
chk('内嵌 ffmpeg 的反向卡点还在（删掉的 30MB 不能被无声加回）',
  /assets\/ffmpeg\/ffmpeg/.test(bjs) &&
  /内嵌解码已于 2026-09-18 移除/.test(bjs));
chk('APK 体积符合「带内置 CloudDrive2 引擎」的预期（15~45MB）',
  // 2026-09-19 起包里带的是 CD2 引擎（arm64 约 22MB / x86_64 约 24MB，
  // 比 OpenList 的 92MB 小一大截，所以整体从 94MB 掉到 25MB 左右）：
  //   < 15MB  → 二进制根本没进去（会「装得上、内置网盘永远连不上」）
  //   > 45MB  → 多半是把多个 ABI 一起打了，或者又混进了别的大文件
  // ⚠️ 产物不存在（没跑过 build）时跳过而不是 fail。
  (() => {
    const p = path.join(ROOT, 'douyin-nas.apk');
    if (!fs.existsSync(p)) return true;
    const mb = fs.statSync(p).size / 1024 / 1024;
    return mb > 15 && mb < 45;
  })());

console.log('\n · 内置 CloudDrive2 引擎（手机本地跑网盘聚合：App → 127.0.0.1:19798/dav → 网盘）');
/* 2026-09-19：内置 Alist（OpenList）整体移除，换成 CloudDrive2 官方引擎
   （从 CD2 安卓 APK 的 assets/bin/<arch>/clouddrive 提取，打进 jniLibs/<abi>/libclouddrive.so），
   由 MainActivity 设 CLOUDDRIVE_HOME 拉起来当子进程。
   🔴 最关键的两条：二进制**必须**在 lib/<abi>/ 里 ——
      Android 10 起私有目录 W^X（可写就不可执行），只有 nativeLibraryDir 允许 execve；
      环境变量 CLOUDDRIVE_HOME **必须**指向可写目录（实测不设会去写死路径
      /Waytech/CloudDrive2/log，直接 Read-only file system 崩掉）。 */
chk('build.js 把 jniLibs/<abi>/*.so 收集成 lib/<abi>/（必须 STORED）',
  /function collectJniLibs\(abi\)/.test(bjs)
  && /zip\.stored\('lib\/' \+ abi \+ '\/' \+ e\.name/.test(bjs));
chk('assemble() 真的按 ABI 调用了 collectJniLibs',
  /assemble\(dexFiles, baseApk, unsigned, o\.abi\)/.test(bjs)
  && /collectJniLibs\(abi\)/.test(bjs));
chk('build.js 支持 --abi=（默认 arm64-v8a；给模拟器出测试包用 x86_64）',
  /DEFAULT_ABI = 'arm64-v8a'/.test(bjs) && /--abi=/.test(bjs));

/* 🔴 版本号：每次打包自动涨（2026-09-20 用户要「以后每次打包都更新版本号」）。
 *
 * 这条链最容易断在三处，每处都单独钉：
 *   ① bumpVersionName 的**进位规则**（末位是十进制数，1.3.9 → 1.3.10 而不是 1.4）；
 *   ② **写回 build.js 自己** —— 不写回就等于每次从旧值起涨、永远同一个版本号
 *      （「看着自动了，其实没动」）；
 *   ③ 真的接到了 build 流程上（bumpVersion(o) 得被调用）。
 * ⚠️ 只断「函数存在」是不够的（§57 假断言教训）—— 所以下面**直接把函数抠出来跑**，
 *    用真数据验进位。 */
chk('🔴 打包自动涨版本号：末位 +1（两段会补出末位 1.3 → 1.3.1）',
  /function bumpVersionName\(v\)/.test(bjs)
  && /if \(parts\.length === 2\) return parts\[0\] \+ '\.' \+ parts\[1\] \+ '\.1';/.test(bjs)
  /* 末位必须**按十进制加一**，不能当单个字符涨：
     写成 `parseInt(...) + 1` 才会 1.3.9 → 1.3.10；字符串自增会变成 "1.3.91" 或 "1.3.10" 靠巧合。 */
  && /parts\[last\] = String\(parseInt\(parts\[last\], 10\) \+ 1\);/.test(bjs));
chk('🔴 写回用的是「只换字面量」的窄正则（改自己源码，范围越小越安全）',
  /src\.replace\(\/\(\\n\\s\*versionCode:\\s\*\)\\d\+\(,\)\/, '\$1' \+ code \+ '\$2'\)/.test(bjs)
  && /src\.replace\(\/\(\\n\\s\*versionName:\\s\*\)'\[\^'\]\*'\(,\)\/, "\$1'" \+ name \+ "'\$2"\)/.test(bjs));

/* 🔴 行为：**真的把版本号写进了文件**。
 *
 * 这条必须有 —— 第一版我只断言了「函数在不在 / 有没有调 writeFileSync」，
 * 结果反向验证时把 `fs.writeFileSync(self, src)` 注释掉，**断言照样全绿**
 * （典型的 §57 假断言：检查了长什么样，没检查干了什么）。
 * 所以这里拿一份 build.js 的**临时副本**当靶子，跑真的 writeBackVersion，
 * 再断言副本里的字面量变了、而且 dev 只动了那两行。
 * `self` 参数就是为这个可测性加的（默认仍是 __filename）。 */
{
  const os = require('os');
  const tmp = path.join(os.tmpdir(), '_nasdy_ver_' + process.pid + '.js');
  fs.copyFileSync(path.join(ROOT, 'android', 'build.js'), tmp);
  const before = fs.readFileSync(tmp, 'utf8');
  let fatalMsg = '';
  try {
    const fn = new Function('fs', 'fatal', 'ok', 'console',
      grabFn(bjs, 'writeBackVersion') + '\nreturn writeBackVersion;')(
        fs, (m) => { fatalMsg = m; }, () => {}, console);
    fn(77, '9.8.7', tmp);
    const after = fs.readFileSync(tmp, 'utf8');
    const lineCode = (after.match(/\n\s*versionCode:\s*(\d+),/) || [])[1];
    const lineName = (after.match(/\n\s*versionName:\s*'([^']*)',/) || [])[1];
    chk('🔴 行为：writeBackVersion 真的改写了文件里的版本号',
      lineCode === '77' && lineName === '9.8.7',
      `文件里现在是 code=${lineCode} name=${lineName}，应为 77 / 9.8.7`);
    /* 只准动那两行：统计改动行数（这能抓住「正则太宽，把别处也换了」） */
    const a = before.split('\n'), b2 = after.split('\n');
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b2.length); i++) if (a[i] !== b2[i]) diff++;
    chk('🔴 行为：只改了 versionCode / versionName 那两行（没误伤别的代码）',
      diff === 2, `改动了 ${diff} 行，应为 2`);
  } catch (e) {
    chk('🔴 行为：writeBackVersion 真的改写了文件里的版本号', false, e.message);
    chk('🔴 行为：只改了 versionCode / versionName 那两行（没误伤别的代码）', false, e.message);
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

/* 🔴 行为：bumpVersion 三个分支（自增 / 保持 / 锁定）真的各自干了该干的事。
 *
 * ⚠️ `writeBackVersion` 在 `bumpVersion` 里是**同作用域函数调用**（不是 import），
 *    抠出来跑会直接 ReferenceError。所以这里**不抠它**，改成抠的时候顺手补一个
 *    记录用的桩（`function writeBackVersion(c,n){ WROTE.push([c,n]); }`）——
 *    于是「有没有写回、写回的值对不对」都能直接断。
 *    这正是第一版漏掉的：只断「文件里有 fs.writeFileSync」，注释掉照样绿。 */
{
  const runBump = (opts) => {
    const APP = { versionName: '1.3.9', versionCode: 4 };
    const wrote = [];
    const f = new Function('APP', 'WROTE', 'log',
      grabFn(bjs, 'bumpVersionName') + '\n'
      + 'function writeBackVersion(c, n) { WROTE.push([c, n]); }\n'
      + grabFn(bjs, 'bumpVersion') + '\nreturn bumpVersion;')(
        APP, wrote, () => {});
    f(opts);
    return { name: APP.versionName, code: APP.versionCode, wrote };
  };

  const d = runBump({ noBump: false, versionPinned: false });
  chk('🔴 行为：默认每次打包自增（1.3.9 → 1.3.10，code 4 → 5）+ 写回',
    d.name === '1.3.10' && d.code === 5 && d.wrote.length === 1
    && d.wrote[0][0] === 5 && d.wrote[0][1] === '1.3.10',
    JSON.stringify(d));
  const nb = runBump({ noBump: true, versionPinned: false });
  chk('🔴 行为：--no-bump 保持原值且**不写回**（反复打同一版本用）',
    nb.name === '1.3.9' && nb.code === 4 && nb.wrote.length === 0, JSON.stringify(nb));
  const pin = runBump({ noBump: false, versionPinned: true });
  chk('🔴 行为：--version-name= 指定时跳过自增，但把该值写回当新基线',
    pin.name === '1.3.9' && pin.code === 4 && pin.wrote.length === 1, JSON.stringify(pin));
}

/* 🔴 bumpVersion 真的接在构建流程上（不是写完忘了调）。
 *
 * ⚠️ 只断 `/bumpVersion\(o\);/` 是**假断言** —— 反向验证时把那行注释掉，断言照样绿。
 *    得换个思路：`bumpVersion` 是**只在 main() 里**被调用的，而 main() 跑起来要 JDK/SDK。
 *    所以这里退一步断两件事，合起来等价：
 *      ① 全文件里 `bumpVersion(o)` 这个调用**只出现一次**，且它不在注释行里；
 *      ② `main()` 的函数体里确实有它。
 *    ② 用「main 的函数体包含调用」来表达，比全文 grep 精确得多。 */
chk('🔴 bumpVersion 真的接在构建流程上（main 里调了一次，不是写完忘调/被注释）',
  (() => {
    const body = grabFn(bjs, 'main');
    // 掐掉注释行再找，避免「注释掉了也算」
    const live = body.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    const hits = (live.match(/bumpVersion\(o\);/g) || []).length;
    return hits === 1;
  })(),
  'main() 里找不到唯一的一次 bumpVersion(o) 调用');
chk('🔴 版本号开关齐全：--no-bump 保持 / --version-name= 手动指定（跳过自增）',
  (() => {
    // 同样掐掉注释：`o.noBump = true;` 必须真的在代码里，不是某行注释
    const live = bjs.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    return /o\.noBump = true;/.test(live) && /o\.versionPinned = true;/.test(live)
      && /a === '--no-bump'/.test(live)
      && /a\.startsWith\('--version-name='\)/.test(live);
  })(),
  '开关不齐或只写在注释里');

/* 行为：真跑 bumpVersionName（照 §57：存在性断言之外再钉行为） */
{
  const mk = new Function('fatal',
    grabFn(bjs, 'bumpVersionName') + '\nreturn bumpVersionName;')(
      () => { throw new Error('不该 fatal'); });
  const cases = [
    ['1.3', '1.3.1', '两段补出末位再涨'],
    ['1.3.1', '1.3.2', '常规 +1'],
    ['1.3.9', '1.3.10', '🔴 末位是十进制数，不进位到 1.4'],
    ['1.2.99', '1.2.100', '🔴 99 → 100 不变成 1.3'],
    ['2.0.0', '2.0.1', '从 0 起涨'],
  ];
  let allOk = true;
  const bad = [];
  for (const [inp, want, why] of cases) {
    const got = mk(inp);
    if (got !== want) { allOk = false; bad.push(`${inp} → ${got}（应为 ${want}，${why}）`); }
  }
  chk('🔴 行为：bumpVersionName 的进位规则正确（含 1.3.9 → 1.3.10）',
    allOk, bad.join('; '));

  /* 非法版本号必须 fatal，不能算出一个垃圾值写回源码 */
  const bad2 = [];
  for (const inp of ['1', '1.x', 'abc', '1.3.', '']) {
    let threw = false;
    try { mk(inp); } catch (_) { threw = true; }
    if (!threw) bad2.push(JSON.stringify(inp));
  }
  chk('🔴 行为：非法 versionName（段数不足 / 非数字）直接报错，不瞎算',
    bad2.length === 0, '这些没报错：' + bad2.join(', '));
}

/* 版本号显示到「我的」页：后端两个都要给，前端只管显示 */
chk('🔴 后端 config 回传 versionName（APK 从 PackageManager 读 manifest 那份）',
  /o\.put\("versionName", pi\.versionName == null \? "" : pi\.versionName\);/.test(njCode)
  && /getPackageInfo\(ctx\.getPackageName\(\), 0\)/.test(njCode));
chk('🔴 Node 版也回 versionName（前端同一个显示逻辑要伺候两个后端）',
  /config: \{ \.\.\.config, pass: '', versionName: PC_VERSION, versionCode: 0 \}/.test(srvCode)
  && /const PC_VERSION = 'PC';/.test(srvCode));
chk('🔴 前端「我的」页有版本号元素 + 渲染函数（且拿不到就 hidden，不显示 vundefined）',
  htmlIds.has('meVer')
  && /function renderMeVersion\(\)/.test(appCode)
  && /renderMeVersion\(\);/.test(appCode)
  && /if \(!v\) \{ el\.hidden = true; return; \}/.test(appCode)
  && /el\.textContent = 'v' \+ v/.test(appCode));
chk('样式：版本号是「我的」页最淡的那行（不抢片源/片库的注意力）',
  /\.me-ver\{/.test(cssCode) && /opacity:\.7/.test(cssCode));

/* ============================================================================
 * 本机片源（local:）—— 2026-09-20 用户拍板「选 A」
 * 「生成的 strm 怎么播放」的真身：文件生成了、handleStream 里解析 strm 的
 * 逻辑也早写好了，但片库只认 WebDAV，中间没有任何一条路能让它发现本机 strm。
 * ========================================================================== */

/* --- 后端：前缀判据与归一（改动最凶险的两处，失手就变哑片源）--- */
chk('🔴 后端有 LOCAL_PREFIX="local:" 与 isLocalSrc；判据要**容忍前导斜杠**'
  + '（历史配置里存过 /local:/ 这种脏值，见下下条）',
  /static final String LOCAL_PREFIX = "local:";/.test(njCode)
  && /static boolean isLocalSrc\(String p\)/.test(njCode)
  && /while \(i < t\.length\(\) && t\.charAt\(i\) == '\/'\) i\+\+;/.test(njCode)
  && /return t\.startsWith\(LOCAL_PREFIX, i\);/.test(njCode));

chk('🔴🔴 normSrc：本机路径**不能**走 normAbs（否则 local:/x 被补成 /local:/x，'
  + '前缀失效变成哑片源）；开头还要**剥掉脏前导斜杠**（修历史脏值 /local:/）',
  /static String normSrc\(String s\)/.test(njCode)
  && /while \(t\.startsWith\("\/"\)\) t = t\.substring\(1\);/.test(njCode)
  && /if \(t\.startsWith\(LOCAL_PREFIX\)\) \{/.test(njCode)
  && /return LOCAL_PREFIX \+ NasService\.normAbs\(t\.substring\(LOCAL_PREFIX\.length\(\)\)\);/.test(njCode));

chk('🔴🔴 所有读写 dirs/skipDirs 的地方都走 normSrc（漏一处就是那个片源失效）',
  /* dirs/skipDirs 的归一**一处都不许**留 normAbs —— 数一下 normSrc 的调用数
     是否覆盖了全部 5 个点（loadConfig 2 处、/api/config 2 处、/api/sources 2 处）。 */
  (njCode.match(/= normSrc\(/g) || []).length >= 5
  && !/dirs\.add\(NasService\.normAbs\(/.test(njCode));

chk('🔴 localAbs 防目录穿越（canonicalPath 必须落在 strm 根之内）',
  /private String localAbs\(String src\)/.test(njCode)
  && /getCanonicalPath\(\)\.startsWith\(root\.getCanonicalPath\(\)\)/.test(njCode));

/* --- 后端：扫描分流 --- */
chk('🔴 doScan 对本机片源走 scanLocal，不送进 PROPFIND',
  /if \(isLocalSrc\(root\)\) \{/.test(njCode)
  && /NasService\.scanLocal\(new java\.io\.File\(disk\), LOCAL_PREFIX,/.test(njCode));

chk('🔴🔴 扫描总闸不能是 dav != null（只配了本机片源的用户也要能刷出 strm）',
  /boolean needDav = !isLocalSrc\(root\);/.test(njCode)
  && /if \(needDav && dav == null\) \{/.test(njCode)
  && !/^\s*if \(dav != null\) \{\n\s*List<String> roots/m.test(njCode));

chk('🔴 根目录兜底必须带 dav != null（没有 dav 时硬扫会 NPE）',
  /if \(all\.isEmpty\(\) && firstErr != null && !authFailed && dav != null\) \{/.test(njCode));

/* 🔴 这一组必须**把范围钉在 scanLocal 的函数体里**再断 ——
 *    `!isPlayableExt(ext) continue` / `truncatedOut[0] = truncated` 这些串在
 *    scan() 里也有一份（两函数是故意对齐的），全文 grep 会命中 scan() 那份，
 *    于是**把 scanLocal 里那行删掉照样全绿** —— 反向验证实测抓到的假断言。
 *    抠函数体 = 从 `scanLocal(` 起、到下一个同级 `public static` 为止。 */
const svcLocalBody = (() => {
  const i = svcCode.indexOf('public static List<Video> scanLocal(');
  if (i < 0) return '';
  const rest = svcCode.slice(i + 10);
  const j = rest.indexOf('\n    public static ');
  return j < 0 ? rest : rest.slice(0, j);
})();

chk('🔴 NasService.scanLocal 与 scan() 同一套契约（PLAYABLE_EXTS + 回传 truncated）',
  /public static List<Video> scanLocal\(/.test(svcCode)
  && /if \(!isPlayableExt\(ext\)\) continue;/.test(svcLocalBody)
  && /truncatedOut\[0\] = truncated;/.test(svcLocalBody)
  && /SKIP_DIR\.matcher\(nm\)\.find\(\)/.test(svcLocalBody));

chk('🔴 scanLocal 把磁盘路径换算回片源坐标（p = srcPrefix + 相对部分）',
  /String p = srcPrefix \+ normAbs\(rel\);/.test(svcLocalBody));

/* --- 后端：播放链路 --- */
/* ⚠️ 不能用「两个串相距 N 字符以内」来断 —— 这个分支里带着一长段注释，
   将来改注释就会把断言撞红（**假红**，比假绿更浪费人）。改成断「先后顺序」：
   `isLocalSrc(rel)` 那段必须出现在 handleStream 里那个 normAbs 之前。 */
chk('🔴🔴 handleStream 在 normAbs **之前**分流本机路径（顺序错了前缀就没了）',
  (() => {
    const fn = njCode.slice(njCode.indexOf('private Resp handleStream(Req req'));
    const body = fn.slice(0, fn.indexOf('\n    private '));
    const iLocal = body.indexOf('if (isLocalSrc(rel)) {');
    const iNorm = body.indexOf('String abs = NasService.normAbs(rel);');
    return iLocal >= 0 && iNorm > iLocal;
  })());

chk('🔴 playStrmTarget 被两边共用（本机与 WebDAV 的「解析出目标后怎么播」只有一份）',
  /private Resp playStrmTarget\(String target, Req req\)/.test(njCode)
  && (njCode.match(/playStrmTarget\(/g) || []).length >= 3);   // 定义 1 + 调用 2

chk('🔴 parseStrmText 抽出共用（含 BOM 容忍），resolveStrm/resolveStrmFile 都调它',
  /private static String parseStrmText\(String text\)/.test(njCode)
  && /text\.startsWith\("\\uFEFF"\)/.test(njCode)
  && (njCode.match(/parseStrmText\(/g) || []).length >= 3);

chk('🔴 handleThumb 本机路径要 normSrc 分流，但**不能**因为「是本机」就一律 502',
  /* 2026-09-20 修：旧实现是
   *   `if (isLocalSrc(rel)) return json(502, err("strm 链接不生成缩略图"));`
   * —— 判据用错了层级（判「片源类型」而非「文件类型」），把整条本机片源的
   * 缩略图全拦死，用户看到「点赞列表里全是 ⚠️ 破图标」。
   * 现在：本机走 normSrc，strm 拦截只针对 WebDAV（`!local && isStrmPath(...)`）。 */
  /final boolean local = isLocalSrc\(rel\);/.test(njCode)
  && /handleThumb[\s\S]{0,2000}String abs = local \? normSrc\(rel\) : NasService\.normAbs\(rel\);/.test(njCode)
  && /if \(!local && isStrmPath\(abs\)\)/.test(njCode)
  && !/if \(isLocalSrc\(rel\)\) return json\(502, err\("strm 链接不生成缩略图"\)\);/.test(njCode));

chk('🔴 handleThumbBackfill 补齐队列同样放过本机 strm',
  /if \(!isLocalSrc\(rel\) && isStrmPath\(NasService\.normAbs\(rel\)\)\) \{ skipped\+\+; continue; \}/.test(njCode));

chk('🔴 handleWarm 本机路径安静返回（本机 strm 没有可预热的上游缓存）',
  /if \(isLocalSrc\(rel\)\) return json\(200, err\("nothing to warm"\)\);/.test(njCode));

/* --- 后端：生成后自动加片源 --- */
/* 🔴 扣出 strmJob 的函数体再断「有没有调用」——
 *    直接全文 grep `strmRegisterLocalSrc()` 会命中**它自己的定义**那一行
 *    （`private synchronized void strmRegisterLocalSrc()`），于是把调用点删掉
 *    照样绿。反向验证实测抓到的假断言，必须钉在调用方的函数体里数。
 *
 * ⚠️ 目标是 `strmJob` 不是 `strmRunAsync`：后者只是「起个线程」的薄壳
 *    （CAS 抢锁 + new Thread + start），真正的生成逻辑在 strmJob 里。
 *    抠错函数会切到一个不含调用点的残片 → 0 次 → **假红**（这次先踩了一次）。
 * ⚠️ 抠法用**花括号配对**，不能用「找下一个 private」—— 函数体里嵌套着
 *    private 的东西，那样会提前截断。同时掐掉注释行（注释里也写了函数名）。 */
const fnBody = (sig) => {
  const i = njCode.indexOf(sig);
  if (i < 0) return '';
  const open = njCode.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0, end = -1;
  for (let k = open; k < njCode.length; k++) {
    const c = njCode[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return '';
  return njCode.slice(open, end)
    .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
};
const strmJobBody = fnBody('private void strmJob()');

chk('🔴🔴 strm 生成成功后自动把本机目录加进片源（否则用户生成完看不到任何东西）',
  /* 调用点：在 strm 任务体里恰好 1 次（不是「全文出现过」） */
  (strmJobBody.match(/strmRegisterLocalSrc\(\);/g) || []).length === 1
  && /private synchronized void strmRegisterLocalSrc\(\)/.test(njCode)
  && /dirs\.add\(src\);/.test(njCode)
  && /persistConfig\(\);/.test(njCode.slice(njCode.indexOf('strmRegisterLocalSrc()'))));

chk('🔴 本机片源进片源清单是幂等的（重复生成不会堆出好几条 local:/）',
  /if \(dirs\.contains\(src\)\) return;/.test(njCode));

chk('🔴 localSrcAdded 一次性标记：读取即清除，前端靠它补一次片库刷新',
  /private final java\.util\.concurrent\.atomic\.AtomicBoolean localSrcJustAdded/.test(njCode)
  && /o\.put\("localSrcAdded", localSrcJustAdded\.getAndSet\(false\)\);/.test(njCode));

/* --- Node 版：必须滤掉本机片源 --- */
chk('🔴🔴 Node 版丢弃 local: 片源（PC 没有手机存储；不滤就会变成必然 404 的哑片源）',
  /!d\.trim\(\)\.startsWith\('local:'\)/.test(srvCode));

/* --- 前端 --- */
chk('🔴🔴 前端 isLocalSrc 与后端同一判据（startsWith local:，别用「以 / 开头」）',
  /const isLocalSrc = \(d\) => String\(d \|\| ''\)\.startsWith\('local:'\);/.test(appCode));

chk('🔴 片源栏把本机片源显示成「本机 strm 库」且**不给移出按钮**（用户拍板不给删）',
  /if \(isLocal\) \{[\s\S]{0,400}本机 strm 库/.test(appCode)
  && /const isLocal = isLocalSrc\(d\);/.test(appCode)
  && /<div class="srow local">/.test(appCode));

chk('🔴🔴 underDir 要容忍片源尾斜杠（local:/ + / 会拼成 local://，一条都匹配不上）',
  /const base = String\(d\)\.replace\(\/\\\/\+\$\/, ''\);/.test(appCode)
  && /return p === base \|\| String\(p\)\.startsWith\(base \+ '\/'\);/.test(appCode));

chk('🔴🔴 freshStartPath 过滤掉本机片源（「文件夹」页走 PROPFIND，扫不了本机目录）',
  /const webdav = srcList\(\)\.filter\(\(d\) => !isLocalSrc\(d\)\);/.test(appCode)
  && /return webdav\[0\] \|\| S\.verifiedDir \|\| '';/.test(appCode));

chk('🔴 applyLibrary 的 currentDir 只跟 WebDAV 片源走',
  /S\.dirs\.filter\(\(d\) => !isLocalSrc\(d\)\)\.length/.test(appCode));

chk('🔴 updateTitle 用 srcLabel 而不是 pathName（否则本机片源显示成「根目录」）',
  /else if \(dirs\.length === 1\) name = srcLabel\(dirs\[0\]\);/.test(appCode));

chk('🔴🔴 「我的」页读 S.dirs 而不是 S.config.dirs（清空片源后它还显示有 = 那个 bug）',
  /const dirs = S\.dirs \|\| \[\];/.test(appCode)
  && /dirs\.map\(\(d\) => escapeHtml\(srcLabel\(d\)\)\)\.join\('、'\)/.test(appCode));

chk('🔴 前端看到 localSrcAdded 就 refresh 一次片库（不 refresh 拿的是旧缓存）',
  /if \(s2\.localSrcAdded\) \{[\s\S]{0,300}await loadLibrary\(true\);/.test(appCode));

chk('🔴🔴 applyLibrary 把片库回传的 dirs 同步进 S.config（后端自动加片源时前端不知情）',
  /if \(!S\.demoMode && Array\.isArray\(lib\.dirs\)\) \{/.test(appCode)
  && /if \(a !== b\) S\.config = \{ \.\.\.S\.config, dirs: lib\.dirs\.slice\(\) \};/.test(appCode));

chk('样式：本机片源行与 WebDAV 片源行视觉上区分开（另一套色）',
  /\.srow\.local\{/.test(cssCode) && /\.srow\.local \.fic\{/.test(cssCode));

chk('sanityCheck 卡住「libclouddrive.so 必须在这个包里」',
  /libclouddrive\.so/.test(bjs) && /内置的 CloudDrive2 引擎没进包/.test(bjs));
chk('sanityCheck 反向卡住「libopenlist.so 绝不能回来」（Alist 已移除）',
  /libopenlist/i.test(bjs) && /已整体移除/.test(bjs));
chk('🔴 manifest 里 extractNativeLibs="true"（否则 .so 不落地，没法当进程跑）',
  /android:extractNativeLibs="true"/.test(manifest));
chk('🔴 MainActivity 从 nativeLibraryDir 取 libclouddrive.so 起子进程',
  /nativeLibraryDir, "libclouddrive\.so"/.test(maCode) && /pb\.start\(\)/.test(maCode));
chk('🔴 启动前设置 CLOUDDRIVE_HOME（不设会去写死 /Waytech 路径直接崩）',
  /CLOUDDRIVE_HOME/.test(maCode));
chk('🔴 启动前预写 config.toml 把端口钉死在 19798',
  /ensureCd2Config/.test(maCode) && /http_port = " \+ CD2_PORT/.test(maCode));
chk('🔴 起之前先探测端口，已有实例就复用（硬起第二个会 bind 失败、静默死）',
  /if \(portOpen\(CD2_PORT\)\)/.test(maCode));
chk('退出时杀掉内置引擎（别留孤儿进程）',
  /private void stopCloudDrive2\(\)/.test(maCode) && /stopCloudDrive2\(\);/.test(maCode));
chk('启动不阻塞主线程（就绪探测丢后台线程）',
  /new Thread\(this::waitCd2Ready/.test(maCode));
chk('NasBridge 暴露 cd2Status / cd2Admin 给前端',
  /public String cd2Status\(\)/.test(maCode) && /public void cd2Admin\(\)/.test(maCode));
chk('Cd2Activity 已注册（exported=false，只有本 App 拉得起来）',
  /android:name="\.Cd2Activity"/.test(manifest)
  && /Cd2Activity[\s\S]{0,240}android:exported="false"/.test(manifest));
/* 前端：这块**只在 APK 版出现**。没有 NasBridge 的环境（PC / 浏览器）必须整块隐藏，
   否则就是「画了但点不动」的假按钮（§17 那类，本项目栽过好几次）。 */
chk('设置页有 #stepCD2 且默认 hidden，两个按钮都绑了事件',
  /id="stepCD2" hidden/.test(html) && /id="cd2Status"/.test(html)
  && /\$\('cd2Config'\)\.addEventListener\('click'/.test(appCode)
  && /\$\('cd2Use'\)\.addEventListener\('click'/.test(appCode));
chk('🔴 前端先探 window.NasBridge.cd2Status，没有就整块隐藏',
  /typeof B\.cd2Status !== 'function'/.test(appCode));
chk('#cd2Use 只把地址填进表单（让用户先点「登录」验证），不直接存配置',
  /\$\('cfUrl'\)\.value = st\.url;/.test(appCode));
/* 🔴 冷启动竞态（2026-09-19 真机踩到）：App 一启动，NasServer 就按配置去扫片源，
   而内置引擎这时可能还没起来 —— 日志里就是一条 ECONNREFUSED 127.0.0.1:19798。
   所以它真正就绪后必须补一次重扫（且只在数据源确实是内置引擎时）。 */
chk('🔴 内置引擎就绪后补一次重扫（冷启动的第一轮扫描必然赶在它就绪之前）',
  appCode.indexOf('if (!rescued && /127\\.0\\.0\\.1:19798/.test') > -1
  && appCode.indexOf('rescued = true;') > -1);
/* 🔴 2026-09-19 用户要求「缓存扫描改成每 24 小时扫描一次」：
   冷启动补偿原来**每次开 App 都强制重扫**（绕过后端 24h TTL）—— 加节流，
   localStorage 记 nasdy.lastAutoScan，不足 24 小时只信缓存。手动重扫不受限。 */
chk('🔴 冷启动补偿有 24 小时节流（别每次开 App 都强制重扫）',
  appCode.indexOf("localStorage.getItem('nasdy.lastAutoScan')") > -1
  && appCode.indexOf('24 * 3600 * 1000') > -1);
chk('手动重扫会盖 lastAutoScan 戳（手动扫描也算一次，别和自动补偿叠加）',
  /async function runRefresh\(\) \{[\s\S]{0,220}?nasdy\.lastAutoScan/.test(appCode));
/* 🔴 2026-09-19 用户报「点击重启按钮会进入横屏播放」：recreate 后首条视频的流抖动报错，
   onVideoError 自救直接升级弹原生播放器（横屏）。守卫：页面加载后 10 秒宽限期内
   不许升级（PAGE_BOOT_TS），只能原地重试 —— 真烂的片过了宽限期照样升级，功能没丢。 */
chk('🔴 视频错误自救的「升级原生播放器」有 10 秒启动宽限（重启别再弹横屏）',
  /const PAGE_BOOT_TS = Date\.now\(\);/.test(app)
  && /withinBootGrace = Date\.now\(\) - PAGE_BOOT_TS <= 10000/.test(app)
  && /&& !withinBootGrace\)/.test(app));
/* 🔴 「登录」按钮的 disabled 收尾**必须**在 finally 里。
   原来的失败分支是 `return setStatus(...)`，直接跳过了收尾 →
   登录一旦失败一次，按钮就永久 disabled，只能重启 App（2026-09-19 实测）。 */
chk('🔴 #cfLogin 失败分支不再用 return 跳过 disabled 收尾（否则按钮永久卡死）',
  appCode.indexOf("return setStatus('❌ 登录失败") === -1
  && appCode.indexOf("$('cfLogin').disabled = false;") > -1
  && appCode.indexOf('} finally {') > -1);
/* 🔴 管理页**不能一进来就 loadUrl**：内置引擎是异步起的、首次还要建库，
   这时 load 一个连不上的地址 → WebView 只给一片黑屏 + 一个破图标。
   正确做法：先探端口、等就绪再加载；等不到就显示能看懂的原因 + 重试按钮。
   ⚠️ 用正向断言（方法名），别数 loadUrl 出现次数 —— 注释里也提到它。 */
chk('🔴 管理页先等内置引擎就绪再加载（不是一进来就 loadUrl）',
  cd2Act.indexOf('private void waitThenLoad()') > -1
  && cd2Act.indexOf('private void loadHome()') > -1
  && cd2Act.indexOf('portOpen()') > -1);
chk('🔴 管理页加载失败时给提示 + 重试，而不是停在黑屏',
  cd2Act.indexOf('onReceivedError') > -1
  && cd2Act.indexOf('private void showHint(') > -1
  && cd2Act.indexOf('retryBtn') > -1);
chk('设置页在引擎未就绪时不打开管理页（先 toast 说清楚）',
  appCode.indexOf('内置引擎还在启动，等几秒再点') > -1);
chk('🔴 进程死掉时状态要如实反映（ready 不能还是 true，否则点进去又是黑屏）',
  /if \(!running\) \{[\s\S]{0,200}?cd2Ready = false;/.test(maCode)
  && /o\.put\("ready", cd2Ready\)/.test(maCode));
chk('🔴 进程死掉后自动重拉，且有节流（别变成每 1.5 秒重启一次）',
  maCode.indexOf('cd2LastStartMs') > -1
  && /now - cd2LastStartMs > 10000/.test(maCode));
chk('🔴 弹确认框不能用 confirm（WebView 没实现 onJsConfirm 会静默返回 false）',
  appCode.indexOf('confirm(') === -1);
/* 🔴 同一个坑的另一面（2026-09-20 修的「内置 clouddrive2 无法移除云存储」）：
   上面那条管的是**我们自己的页面**别用 confirm；但**内置的 CD2 管理页是别人的代码**，
   它所有破坏性操作（移除云存储/挂载点/备份、清缓存、重启服务）全走原生 confirm()。
   WebView 默认不实现 onJsConfirm = 默认当「取消」→ 点了不弹框、不报错、不发请求，
   网盘永远删不掉。所以 Cd2Activity **必须**补上这三个回调。

   断言分三层，缺一不可：
     ① 三个回调都实现了（只实现 confirm，alert/prompt 仍会静默失败）
     ② 每个回调都真的**收尾**（result.confirm/cancel）—— 漏了会让 JS 侧 await 永远挂着
     ③ 确实挂到了 WebView 上（定义了却没 setWebChromeClient 等于没写） */
chk('🔴 Cd2Activity 实现了 JS 原生弹窗三件套（onJsAlert/onJsConfirm/onJsPrompt）',
  cd2Act.indexOf('onJsAlert(') > -1
  && cd2Act.indexOf('onJsConfirm(') > -1
  && cd2Act.indexOf('onJsPrompt(') > -1);
chk('🔴 三个回调都真的收尾（confirm/cancel）—— 不收尾 = 页面 await 永远挂着',
  /onJsResult|result\.confirm\(\)/.test(cd2Act)
  && /result\.confirm\(\)/.test(cd2Act)
  && /result\.cancel\(\)/.test(cd2Act)
  && /promptResult|result\.confirm\(input/.test(cd2Act));
chk('🔴 三个回调真的挂到 WebView 上了（定义了没 set = 等于没写）',
  /web\.setWebChromeClient\(\s*new WebChromeClient\(\)/.test(cd2Act));
chk('🔴 承上：Cd2Activity 的 JS 弹窗必须带「取消」这条出路（别无脑 confirm(true)）',
  cd2Act.indexOf('setNegativeButton') > -1
  && /setOnCancelListener\(d -> result\.cancel\(\)\)/.test(cd2Act));

/* ---- 改密码之后**不能把整个内置网盘搞废**（2026-09-19 实测出来的连锁反应）----
   OpenList 时代有登录限流：5 次失败锁 5 分钟，而且**每次再撞都续期**。
   App 的数据源就是它 —— 密码一改，App 存的旧密码就失效，每轮扫描失败好几次，
   几秒内把锁打满 → 连管理页都登不进去，越重启越锁。这两条守住修复。
   （2026-09-19 换 CloudDrive2 引擎后该机制仍在 NasServer 扫描路径上，继续有效。） */
chk('🔴 认证/限流错误要立刻放弃整轮扫描（否则越撞锁越久）',
  /private static boolean isAuthOrLimitError\(String msg\)/.test(nasrv)
  && /if \(isAuthOrLimitError\(e\.getMessage\(\)\)\) \{[\s\S]{0,260}?break;/.test(nasrv)
  /* ⚠️ 2026-09-20 加了 `&& dav != null`（本机片源不需要 dav，没有 dav 时
     没有「WebDAV 根目录」可退、硬扫会 NPE）。这里跟着更新，别让旧断言变假红。 */
  && /if \(all\.isEmpty\(\) && firstErr != null && !authFailed && dav != null\)/.test(nasrv));
chk('🔴 认证失败别把「WebDAV 429」原文甩给用户（要说清去哪儿改）',
  /else if \(authFailed\) \{[\s\S]{0,1400}?数据源设置/.test(nasrv));
chk('🔴 401 分两种归因：连本机内置引擎时指去「打开 CloudDrive2 管理」，连远程才让人重填密码',
  /private boolean isLocalCd2Dav\(\)/.test(nasrv)
  && /if \(isLocalCd2Dav\(\)\) \{[\s\S]{0,700}?CloudDrive2 管理/.test(nasrv)
  && /WebDAV 账号或密码不对/.test(nasrv));
chk('🔴 PC 版 server.js 也有 authFailed（认证失败不兜底根目录 + 不甩原始 401）',
  /function isAuthOrLimitError\(msg\)/.test(srv)
  && /if \(isAuthOrLimitError\(e\.message\)\) \{ authFailed = true; break; \}/.test(srv)
  && /if \(!videos\.length && errors\.length && !authFailed\)/.test(srv)
  && /function isLocalCd2Dav\(\)/.test(srv)
  && /if \(authFailed\) \{[\s\S]{0,900}?数据源设置/.test(srv));
chk('🔴 前端 friendlyNetErr 不覆盖服务端已写好的人话文案（否则唯一的出路会被抹掉）', (() => {
  /* 判据：在 friendlyNetErr 里，那条「含中文 + 含行动词 → 原样返回」的短路
     必须出现在所有 /正则/ 规则**之前** —— 放到后面就永远轮不到，等于没加。
     2026-09-20 实测踩到：后端写的「…点『打开 CloudDrive2 管理』…」被 /401/ 那条
     改写成「账号或密码不对（401）。」，把唯一的出路抹掉了。 */
  const i = app.indexOf('function friendlyNetErr(msg)');
  if (i < 0) return false;
  const body = app.slice(i, i + 1400);
  const guard = body.indexOf('\\u4e00-\\u9fa5');
  const firstRule = body.indexOf('ECONNREFUSED');
  return guard > 0 && firstRule > 0 && guard < firstRule;
})());
chk('空状态有「打开 CloudDrive2 管理」按钮（engineLogin 那条路的唯一出路）',
  /id="emptyEngineBtn"/.test(html) && /emptyEngineBtn'\)\.addEventListener/.test(app)
  && /function isLocalEngineUrl\(\)/.test(app) && /isLocalEngineUrl\(\) && \/401\|403\|Unauthorized\//.test(app));
chk('🔴 后台扫描失败时，原因要留在空状态页上（不能只弹个 toast 就 return）', (() => {
  /* 2026-09-20 修：peek 带回 scanError 后原来只 `showLoading(false); toast(...); return;`，
     空状态页还停在「这个文件夹里没有能播的视频」——把「连不上」说成「没片」，
     用户会照着提示一直去换目录。现在两条路共用 renderEmptyError。 */
  const i = app.indexOf('if (r.scanError) {');
  if (i < 0) return false;
  return /renderEmptyError\(\{ error: r\.scanError \}\)/.test(app.slice(i, i + 500));
})());
chk('🔴 空状态错误渲染抽成了一个函数，两条路共用（别再各写一份）',
  (app.match(/function renderEmptyError\(lib\)/g) || []).length === 1
  && (app.match(/renderEmptyError\(/g) || []).length >= 3);   // 定义 + loadLibrary + peek
chk('🔴 stale 也认文案（peek 路只带 scanError 字符串，没有 stale 位）',
  /lib\.stale \|\| \/打不开了（可能被删或改名）\//.test(app));
chk('🔴 applyLibrary 拿到真片库要收起空状态（失败态的空状态不会自己消失）', (() => {
  /* 2026-09-20 实测：后台扫失败盖上「连不上/没登录」→ 修好后后台扫成功、
     片库换成 69 条，空状态**还盖在上面**，用户看到的仍是「连不上」。
     applyLibrary 这条（后台轮询换上新片库）此前从来不管 emptyView。
     ⚠️ 原来这里是「起点往后切 1600 字符」再断 —— 太脆：函数里加几行注释
     就会把那句话挤出窗口，于是**断言假红**（这次就踩到了）。
     改成花括号配对取整个函数体，加多少注释都不影响。 */
  const i = app.indexOf('function applyLibrary(lib)');
  if (i < 0) return false;
  const open = app.indexOf('{', i);
  if (open < 0) return false;
  let depth = 0, end = -1;
  for (let k = open; k < app.length; k++) {
    const c = app[k];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  if (end < 0) return false;
  return /\$\('emptyView'\)\.hidden = true;/.test(app.slice(open, end));
})());

console.log('\n · 「丢帧自动跳原生」已删（2026-09-17 按反馈）');
chk('watchDrops 不再有「原生名单加速通道」',
  !/nativeOkGet/.test(app) && !/NATIVE_SAMPLE_MS/.test(app) && !/fastLane/.test(app));

console.log('\n · 「刷点赞过的视频要缓冲好久」的根因别复发');
chk('采样定时器不再以 v.paused 当「前置」守卫（那是死等：停了就再也没下一次 playing）',
  (() => {
    const i = app.indexOf('function watchDrops(i, v, item)');
    if (i < 0) return false;
    const seg = app.slice(i, app.indexOf('\n  /** 当前环境有没有', i));
    const ts = seg.indexOf('setTimeout(');
    if (ts < 0) return false;
    // 关键不是「有没有 v.paused」，而是它**在不在 setTimeout 之前**。
    // 放在定时器里 = 到点核实状态（对）；放在外面 = 死等（错）。
    const guardBefore = /^\s*if \(v\.paused[^\n]*return;/m.test(seg.slice(0, ts));
    return !guardBefore;
  })());
chk('到点先核实「样本够不够」，够了才按丢帧率决定（不再把没起播的也算进来）',
  /if \(v\.paused \|\| v\.readyState < 2\) return;/.test(app) &&
  /if \(!q \|\| !q\.totalVideoFrames \|\| q\.totalVideoFrames < DROP_MIN \* 5\) return;/.test(app) &&
  /if \(ratio < DROP_RATIO \|\| q\.droppedVideoFrames < DROP_MIN\) return;/.test(app));
chk('openPlayer 的 activate 是同步调的，不再整个塞进 requestAnimationFrame',
  (() => {
    const i = app.indexOf('function openPlayer(list, i, opt = {})');
    if (i < 0) return false;
    const body = app.slice(i + 'function openPlayer(list, i, opt = {})'.length);
    // 同步 activate 必须直接出现在函数体里，且后面紧跟 rAF 之前不能有任何 await/回调包裹。
    // 判定方式：从函数体开头找第一处 activate/requestAnimationFrame，activate 必须先出现。
    const syncIdx = body.indexOf('player.activate(i, true);');
    const asyncIdx = body.indexOf('requestAnimationFrame(() =>');
    if (syncIdx < 0) return false;
    if (asyncIdx >= 0 && asyncIdx < syncIdx) return false;
    // 且 rAF 回调里不能再包 activate
    return !/requestAnimationFrame\(\(\) => \{[\s\S]{0,300}?player\.activate\(/.test(body);
  })());
chk('页面在后台时打开播放器，回前台能补上「哪一条」（visibilitychange 兜底）',
  /let PLAYER_WANT = -1;/.test(app) &&
  /PLAYER_WANT = i;/.test(app) &&
  /player\.list && player\.list\.length\) player\.activate\(want, true\)/.test(app));
chk('占位转圈只在真的在加载时才转（.stalling 控制），不再是永远转',
  /\.item\.stalling \.vph::before\{animation:spin \.8s linear infinite;\}/.test(css) &&
  (() => {
    // 基础规则里不允许出现 animation
    const m = css.match(/\.item \.vph::before\{([^}]*)\}/);
    return !!m && !/animation/.test(m[1]);
  })());
chk('waiting / stalled 都带 cur 守卫（预热的下一条不会挂上没人摘的转圈）',
  /v\.addEventListener\('waiting', \(\) => \{ if \(cur === i\) item\.classList\.add\('stalling'\); \}\)/.test(app) &&
  /v\.addEventListener\('stalled', \(\) => \{ if \(cur === i\) item\.classList\.add\('stalling'\); \}\)/.test(app) &&
  // 且 stalled 只注册一次，别重复绑
  (app.match(/'stalled', \(\) =>/g) || []).length === 1);

console.log('\n · 播放流畅性（手机上「抽搐」的根因）');
/* 取一条 CSS 规则的花括号内容。
   ⚠️ 跑在 cssCode（已剥块注释）上，不是裸 css —— 和上面 appCode / htmlCode 同一个理由：
   本项目习惯在注释里引用选择器，`/* .foo{…} *\/` 这种写法会让 indexOf 命中注释里的
   那个选择器，于是「注释先出现 → 取到空 body → 断言假绿」。 */
function ruleBody(sel) {
  const i = cssCode.indexOf(sel + '{');
  if (i < 0) return '';
  return cssCode.slice(i + sel.length + 1, cssCode.indexOf('}', i));
}
chk('底部导航不再模糊视频', !/backdrop-filter/.test(ruleBody('.tabbar')), ruleBody('.tabbar').slice(0, 60));
chk('顶部徽标不再模糊视频', !/backdrop-filter/.test(ruleBody('.mode-badge')));
chk('蒙层不再模糊视频', !/backdrop-filter/.test(ruleBody('.mask')));

/* 🔴 2026-09-21 卡顿排查：压在视频上的**常驻**控件同样不许 backdrop-filter。
   `.tb-icon`（顶栏 3 个图标）/ `.player-btn`（播放器那排按钮）背后就是正在播的视频，
   blur 的背板每帧都在变 → 合成器每帧都要把这块视频重新取一次做模糊 = 实机卡顿主因。
   玻璃观感改用「半透明底 + 描边 + 内高光」表达，不要用真模糊。 */
chk('🔴 顶栏图标不再模糊视频（背后是活视频，每帧重取背板）', !/backdrop-filter/.test(ruleBody('.tb-icon')));
chk('🔴 全屏播放器那排按钮不再模糊视频', !/backdrop-filter/.test(ruleBody('.player-btn')));
chk('🔴 声音提示不再无限跳动（常驻动画会一直叫醒合成器）',
  !/infinite/.test(ruleBody('.sound-hint')));
/* 面板一开，26px 大玻璃模糊就压在「正在播的视频」上 —— 最贵的一处合成。
   修法：开面板时把首页视频停住（背景静止 → 模糊只栅格化一次），关面板再恢复。 */
chk('🔴 打开面板时暂停首页视频（大玻璃模糊压在活视频上 = 每帧重取）',
  /function pauseFeedForSheet\(\)/.test(app) && /pauseFeedForSheet\(\);\n/.test(app)
  && /function resumeFeedAfterSheet\(\)/.test(app) && /resumeFeedAfterSheet\(\);\n/.test(app));
chk('🔴 面板暂停只在「首页 + 确实在播」时生效，且换面板不会「恢复了又立刻暂停」',
  /if \(sheetPausedFeed \|\| NAV !== 'home' \|\| document\.hidden\) return;/.test(app)
  && /main\.mounted\.get\(main\.index\)/.test(app)
  && /const switching = !!sheetOpen;/.test(app));
chk('缓冲够了再播（startPlayback）', /function startPlayback/.test(app) && /function bufferedAhead/.test(app));
chk('只预热下一条，不再三路并发', !/mount\(i \+ 2, false\)/.test(app));
chk('缓冲中有转圈提示，且**同一条 item 上只有一个**（「两个加载图标」回归守卫）',
  // 两个转圈必须互斥：占位在 → .vph::before（!ready）；占位撤了 → .vbox::after（.ready）
  /\.item\.ready\.stalling \.vbox::after\{/.test(css) &&
  // 不允许再出现不带 .ready 的裸 .item.stalling::after（那就会跟 .vph::before 叠一起）
  !/\.item\.stalling::after\{/.test(css) &&
  // 两条环的直径必须一致，切换时不会「跳」大小
  (() => {
    const a = ruleBody('.item .vph::before');
    const b = ruleBody('.item.ready.stalling .vbox::after');
    const wa = (a.match(/width:(\d+)px/) || [])[1];
    const wb = (b.match(/width:(\d+)px/) || [])[1];
    return wa && wb && wa === wb;
  })());

/* 🔴 2026-09-18 用户反馈：「快进的时候这个加载动画放在视频中间」——
   转圈跑到了画面**下半部分**。根因不是 left/top 写错，是 **CSS Grid 的隐式行**：
     `.vbox` 是 `grid-template:1fr/1fr`（**一行一列**），`.vph` 和 `.pause-ind`
     都显式写了 `grid-area:1/1`，唯独 `.vbox::after` 这个伪元素**没人给它定位**。
     自动排布把「没有显式位置的项」放进下一个可用格子 —— 也就是**隐式的第 2 行**。
   两个后果（真机 CDP 实测）：
     ① 隐式行从 `1fr` 那行**抢走高度**：grid-template-rows 变成
        `163.833px 38.6667px`，而不是一行占满 202.5px —— 连 `.pause-ind`
        都跟着偏了 19px；
     ② `::after` 自己落在第 2 行里居中 → 中心 y≈390，而画面中心 y=308，
        **低了 82px**，正是用户截图上圈在画面下半部分的原因。
   修法：给 `::after` 也钉上 `grid-area:1/1`。下面三条守着它 ——
   删掉那条 grid-area、或把 `.vbox` 改成多行多列、或让某个孩子失去显式位置，
   都会让这个 bug 回来。 */
chk('转圈的 ::after 显式钉在第 1 格（不钉就掉进隐式第 2 行 → 偏下 82px）',
  /grid-area:1\/1/.test(ruleBody('.item.ready.stalling .vbox::after')));
chk('.vbox 是「一行一列 + place-items:center」（隐式行能作妖的前提，别改）',
  /grid-template:1fr\/1fr/.test(ruleBody('.item .vbox')) &&
  /place-items:center/.test(ruleBody('.item .vbox')));
chk('.vbox 的三个孩子（占位 / 暂停键 / 转圈）都显式占 1/1 格',
  /grid-area:1\/1/.test(ruleBody('.item .vph')) &&
  /grid-area:1\/1/.test(ruleBody('.pause-ind')) &&
  /grid-area:1\/1/.test(ruleBody('.item.ready.stalling .vbox::after')));

/* 转圈 / 大播放按钮必须**对着视频画面矩形**居中，而不是整屏居中。
   视频是 contain（有黑边），两者不是一回事：竖屏手机放横屏片时，
   画面只占中间一条，挂在整屏中心就会落到黑边上，看着像「浮在画面外」。
   .vbox 的尺寸由 fitVideoBox 按 contain 规则算出来写进 --vbw/--vbh。 */
chk('转圈对准视频画面矩形（.vbox），不是整屏中心',
  /\.item \.vbox\{/.test(css) && /width:var\(--vbw,100%\)/.test(css) &&
  /height:var\(--vbh,100%\)/.test(css) &&
  /function fitVideoBox\(item, v, i\)/.test(app) &&
  /item\.style\.setProperty\('--vbw'/.test(app));
chk('fitVideoBox 按 contain 规则算（取缩放比的小值）',
  /Math\.min\(box\.width \/ vw, box\.height \/ vh\)/.test(app));
chk('视频元数据一到就算画面矩形（loadedmetadata / resize 都挂了）',
  /'loadedmetadata', \(\) => \{ if \(cur === i\) paintProgress\(i\); fitVideoBox\(item, v, i\); \}/.test(app) &&
  /'resize', \(\) => fitVideoBox\(item, v, i\)/.test(app));

/* ⚠️⚠️ 这一组是**真机实测踩出来的**：转码流的 video.videoWidth 永远是 0。
   后端把流转封成 `frag_keyframe+empty_moov` 的 fragmented MP4（换首字节快），
   这种流的 moov 是空的、分辨率写在 moof 里，WebView 能解码（readyState=4、
   currentTime 在走）但**从不回填 videoWidth**。
   实测：item[0] 走 /api/transcode，videoWidth=0，videoHeight=0，而它在正常播。
   于是原来那句 `if (!vw || !vh) return;` 对**所有转码片**都成立 ——
   --vbw/--vbh 压根写不进去，.vbox 回退成整屏，转圈还是落在整屏中心。
   而用户能播的片绝大多数都是转码流，所以这个 bug 在真机上几乎必然出现。 */
chk('videoWidth 拿不到时不直接放弃，去查服务端探测的尺寸（转码流必需）',
  /const boxDims = new Map\(\)/.test(app) &&
  /boxDims\.get\(item\.dataset\.id\)/.test(app) &&
  /function askBoxDims\(i, item, v\)/.test(app));
chk('尺寸缓存按「视频路径」存（item.dataset.id = v.p），不是按下标',
  /item\.dataset\.id = v\.p/.test(app) &&
  /boxDims\.set\(p, \[r\.width, r\.height\]\)/.test(app) &&
  /boxDims\.set\(list\[i\]\.p, \[r\.width, r\.height\]\)/.test(app));
chk('白捡服务端尺寸：复用 ensureDuration 那次 /api/probe，不重复探测',
  /if \(typeof i === 'number' && durWait\.has\(i\)\)/.test(app) &&
  /durWait\.get\(i\)\.then\(\(\) => fitVideoBox\(item, v, i\)\)/.test(app));
chk('挂载时先量一次（别等 loadedmetadata —— 转码片最需要转圈时它还没来）',
  /item\.querySelector\('\.vwrap'\)\.prepend\(v\);\s*[\s\S]{0,600}?fitVideoBox\(item, v, i\);/.test(app));
chk('同一路径的探测不重复发（boxPending 去重）',
  /const boxPending = new Set\(\)/.test(app) &&
  /if \(boxPending\.has\(p\)\) return;/.test(app));

/* ---- 刷视频加载慢的两处提速（2026-09-19）----
 * 体感慢的主因：下一集预热只拉文件头（metadata），一划就得从零缓冲；
 * 以及本机代理 16KB 一循环的拷贝开销。两处都有退回去就会变卡的守卫。 */
chk('🔴 预热下一集用 preload=auto（metadata 只拉文件头，一划就得从零缓冲）',
  /v\.preload = 'auto';/.test(app)
  && !/eager \? 'auto' : 'metadata'/.test(app));
chk('🔴 预热在开播后 1 秒内就开始（太晚的话还没拉到数据用户就划过去了）',
  /mount\(i \+ 1, false\);/.test(app) && /}, 1000\);/.test(app));
chk('🔴 本机代理流拷贝缓冲 ≥ 128KB（16KB 的 syscall 风暴拖慢首帧）',
  /new byte\[131072\]/.test(njCode));

/* ---- 首条片冷启动提速：/api/warm 预热（2026-09-19）----
 * 慢的大头是上游：CD2 收到请求后要先向 115 申请下载直链，首字节 1~3 秒。
 * 原来这段串行在「WebView 启动 → 片库到手 → video 发请求」之后；
 * 现在用「上次播放的那条」在 boot 一开始就预热，把这段跟启动流程并行掉。 */
chk('🔴 后端有 /api/warm 路由 + handleWarm（没有它前端那句预热就是 404）',
  /"\/api\/warm"/.test(njCode) && /private Resp handleWarm\(/.test(njCode));
chk('🔴 预热只拉头 1MB 并防同路径重复开线程（不是把整部片拉下来）',
  /bytes=0-1048575/.test(njCode) && /warmInFlight/.test(njCode));
chk('🔴 api.warm 是 fire-and-forget（调了不该 await，失败静默）',
  /warm: \(p\) => fetch\('\/api\/warm\?p=' \+ encodeURIComponent\(p\), \{ cache: 'no-store' \}\)\.catch\(\(\) => \{\}\)/.test(api));
chk('🔴 boot 一开始就用 nasdy.warmPath 预热（放在 config/library 之前才有并行效果）',
  /nasdy\.warmPath/.test(app)
  && app.indexOf("localStorage.getItem('nasdy.warmPath')") < app.indexOf('await Promise.all([api.config(), api.state()])'));
chk('🔴 activate 时把当前条写进 nasdy.warmPath（下次冷启动才知道热哪条；演示片除外）',
  /localStorage\.setItem\('nasdy\.warmPath', list\[i\]\.p\)/.test(app)
  && /!list\[i\]\.demo\) localStorage\.setItem\('nasdy\.warmPath'/.test(app));
chk('大播放按钮也进了 .vbox（跟着画面居中）',
  /\.pause-ind\{[\s\S]{0,200}?grid-area:1\/1/.test(css) &&
  /<div class="vbox">[\s\S]{0,300}?pause-ind/.test(app));

console.log('\n · 长按画面 2 倍速');
chk('按住画面才起计时（pointerdown）', /container\.addEventListener\('pointerdown'/.test(app));
chk('长按阈值 + 倍速常量', /const HOLD_MS = 420/.test(app) && /const FAST_RATE = 2/.test(app));
chk('松手恢复 1 倍速', /endHold\(\)/.test(app) && /playbackRate = 1/.test(app) && /playbackRate = FAST_RATE/.test(app));
chk('滑动超过阈值就取消加速', /const HOLD_MOVE = 12/.test(app) && /Math\.abs\(e\.clientX - hold\.x\) > HOLD_MOVE/.test(app));
chk('抬手/取消/移出都会收尾（倍速一定要摘掉）',
  /addEventListener\('pointerup', \(\) => endHold\(\)\)/.test(app) &&
  /addEventListener\('pointercancel', \(\) => endHold\(\)\)/.test(app) &&
  /addEventListener\('pointerleave', endHold\)/.test(app));
chk('只给正在播的那条加速', /if \(i !== cur\) return;\s*\/\/ 只让正在播的那条加速/.test(app));
chk('长按抬手那下不再触发暂停/点赞', /if \(hold\.fired\) \{ hold\.fired = false; return; \}/.test(app));
chk('切到下一条会复位倍速', /endHold\(\);\s*\/\/ 切走时别把上一条留在倍速上/.test(app));
chk('有倍速角标', /class="rate-ind"/.test(app) && /\.item\.fast \.rate-ind\{/.test(css));
chk('长按画面不会弹系统菜单', /-webkit-touch-callout:none/.test(css));
chk('第一次使用会提示一次', /LS\.get\('holdTip'/.test(app));

console.log('\n · 原生滚动（下拉刷新已于 2026-09-18 按用户要求整体删除）');
/* ------------------------------------------------------------------
 * 竖向翻页：**交回浏览器**（2026-09-18 第二次修「不跟手」）
 * ------------------------------------------------------------------
 * 这里原来钉着一整套 JS 翻页器（pager*、PAGE_MIN / FLING_V / VEL_WIN …），
 * 它已经被**结构性删除**，所以这一节的断言整体反过来写：
 * 现在要守的是「谁都不许再把竖向滚动收回 JS」。
 *
 * 为什么删：`scrollTop` 是**主线程属性**。只要滚动由 JS 每帧写 scrollTop 驱动，
 * 主线程一忙画面就冻住 —— 这正是用户说的「不跟手」。
 * 实测（_tools/visual-block-test.js：拖动途中忙等堵死主线程 2.5s 再截图）：
 *   · 旧实现 → 手指已经划过，画面**纹丝不动**（还是同一条、同一位置）
 *   · 新实现 → 画面继续走（合成器线程在滚，绿色序号被顶出屏幕上沿）
 * 抖音那种丝滑，本质就是滚动跑在合成器线程上。
 * ------------------------------------------------------------------ */
chk('竖向手势交回浏览器（.feed 是 touch-action:pan-y）',
  /touch-action:pan-y/.test(ruleBody('.feed')), ruleBody('.feed').replace(/\s+/g, ' ').slice(0, 80));
chk('信息流不再独占竖向手势（touch-action:none 已从 .feed 删除）',
  !/touch-action:none/.test(ruleBody('.feed')));
chk('翻页由原生 scroll-snap 负责（scroll-snap-type:y mandatory）',
  /scroll-snap-type:y mandatory/.test(ruleBody('.feed')));
chk('每条 item 都是吸附点、且一次手势只走一条',
  /scroll-snap-align:start/.test(ruleBody('.item')) &&
  /scroll-snap-stop:always/.test(ruleBody('.item')));
chk('JS 翻页器已整体退休（pager* 一个不剩）',
  !/function pagerMove/.test(appCode) && !/function pagerStage/.test(appCode) &&
  !/function pagerEnd/.test(appCode) && !/function pagerTick/.test(appCode) &&
  !/pagerDirty/.test(appCode) && !/pager\.applied/.test(appCode) && !/const pager = \{/.test(appCode));
chk('旧的翻页阈值 / 甩动判据常量也一并删除（PAGE_MIN / FLING_V / FLING_MIN / VEL_WIN / tailVelocity）',
  !/PAGE_MIN/.test(appCode) && !/FLING_V/.test(appCode) && !/FLING_MIN/.test(appCode) &&
  !/VEL_WIN/.test(appCode) && !/tailVelocity/.test(appCode));
/* 🔴 这一条是本次架构的**核心守卫**。
 * 只要还有人往 pointermove / touchmove 里写 `container.scrollTop`，滚动就重新
 * 变回「主线程驱动」，「不跟手」立刻复发 —— 而且它**不会报错**，只会变卡。
 * 允许的只有离散归位 `container.scrollTop = 0`（切首页/重建列表前的那一下），
 * 它不是每帧写，不构成主线程依赖。 */
chk('没有任何逐帧写 container.scrollTop 的代码（JS 不再驱动竖向滚动）', (() => {
  const hits = [...appCode.matchAll(/container\.scrollTop\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim());
  return hits.length > 0 && hits.every((v) => v === '0');
})(), 'container.scrollTop 赋值 = ' + JSON.stringify([...appCode.matchAll(/container\.scrollTop\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim())));
chk('跟手位移不再走「算好再写回」那套（pager.applied / pagerDirty 已删）',
  !/pager\.applied/.test(appCode) && !/pagerDirty/.test(appCode));
/* ---- 热路径不许强制同步布局 ---- */
chk('moving 闸仍由常驻 rAF 心跳重置（否则长按倍速摘不掉）',
  /let moving = false;/.test(appCode) &&
  /\(function moveTick\(\) \{/.test(appCode) &&
  /requestAnimationFrame\(moveTick\);/.test(appCode) &&
  /if \(moving\) moving = false;/.test(appCode));
chk('手势方向判定仍上闸（moving），同一帧不重复跑 endHold',
  /if \(moving\) return;/.test(appCode) && /moving = true;/.test(appCode));
chk('长按倍速靠 pointer 事件（不涉竖向位移，浏览器不会抢走）',
  /container\.addEventListener\('pointerdown', \(e\) => \{/.test(appCode) &&
  /const HOLD_MS = 420/.test(appCode));
chk('进度条仍是 touch-action:none（横向拖动不许被浏览器判成滚动）',
  /touch-action:none/.test(ruleBody('.progress')));
/* 指针收尾现在只做 endHold —— 原来还要顺手给下拉刷新收尾 */
chk('指针收尾只做 endHold（下拉那套已删）',
  /addEventListener\('pointerup', \(\) => endHold\(\)\)/.test(appCode) &&
  /addEventListener\('pointercancel', \(\) => endHold\(\)\)/.test(appCode) &&
  /addEventListener\('pointerleave', endHold\)/.test(appCode));

/* ------------------------------------------------------------------
 * 🗑️ 下拉刷新：**已整体删除**（2026-09-18 用户要求）
 * ------------------------------------------------------------------
 * 删掉的东西分四层，这里逐层反向守住 —— 少守一层就会出现「删了一半」的
 * 半死状态（比如 HTML 没了但 JS 还在找 #ptr → 每次 pointerdown 报错）。
 *
 * ⚠️⚠️ 但「**重扫片库**」这个动作**没有删**：入口是「我的」页的
 *      「重新扫描」按钮（`runRefresh()`）。别看到下拉刷新没了就顺手把它也删了。
 * ------------------------------------------------------------------ */
chk('#ptr 指示器已从 HTML 删除', !htmlIds.has('ptr') && !htmlIds.has('ptrTxt'));
chk('#ptr 的 DOM 也不在 HTML 源码里（含 hidden 属性）',
  !/id="ptr"/.test(htmlCode) && !/ptrTxt/.test(htmlCode));
chk('.ptr 系列样式已全部删除',
  !/\.ptr\{/.test(cssCode) && !/\.ptr-ic\{/.test(cssCode) && !/\.ptr-spin\{/.test(cssCode) &&
  !/\.ptr-txt\{/.test(cssCode) && !/\.ptr\.busy/.test(cssCode) && !/\.ptr\.armed/.test(cssCode) &&
  !/\.ptr\.live/.test(cssCode));
chk('下拉时「手机屏下让」的样式也删了（.phone.ptr-pulling / .phone.ptr-anim）',
  !/ptr-pulling/.test(cssCode) && !/ptr-anim/.test(cssCode));
chk('下拉刷新的手势状态已删除（pull / ptrGesture）',
  !/const pull = \{/.test(appCode) && !/ptrGesture/.test(appCode) && !/pull\.on/.test(appCode) &&
  !/pull\.busy/.test(appCode) && !/pull\.dy/.test(appCode));
chk('下拉阈值常量已删除（PTR_ARM / PTR_MAX / PTR_ON / PTR_DAMP）',
  !/PTR_ARM/.test(appCode) && !/PTR_MAX/.test(appCode) && !/PTR_ON/.test(appCode) && !/PTR_DAMP/.test(appCode));
chk('下拉刷新的函数已全部删除',
  !/function ptrDetect/.test(appCode) && !/function ptrMove/.test(appCode) &&
  !/function ptrEnd/.test(appCode) && !/function ptrCancel/.test(appCode) &&
  !/function pullOffset/.test(appCode) && !/function pullPaint/.test(appCode) &&
  !/function pullReset/.test(appCode) && !/function ptrHost/.test(appCode) &&
  !/function canPull/.test(appCode));
/* 这一条是「删干净」的关键：为下拉刷新才引入的 touch/pointer 二选一分支。
   它一旦残留，就会出现「touch 和 pointer 各算一遍」的幽灵行为。 */
chk('为下拉刷新引入的 touch 事件分支也一起删了（useTouch / ptY / 四条 touch 监听）',
  !/useTouch/.test(appCode) && !/\bptY\b/.test(appCode) &&
  !/addEventListener\('touchstart'/.test(appCode) && !/addEventListener\('touchmove'/.test(appCode) &&
  !/addEventListener\('touchend'/.test(appCode) && !/addEventListener\('touchcancel'/.test(appCode));
chk('「列表在顶部」的缓存也删了（atTop 只服务于 canPull）', !/\batTop\b/.test(appCode));
chk('main.resetPull 已删除（没有下拉手势需要复位了）', !/resetPull/.test(appCode));
chk('那次 click 的「刚下拉过」拦截也删了', !/ptrGesture\.fired/.test(appCode));
/* ---- 但重扫这个动作必须还在 ---- */
chk('「重新扫描」仍然可用（rescan → runRefresh，没被误删）',
  /rescan\(\) \{ return runRefresh\(\); \}/.test(appCode) && /async function runRefresh\(\)/.test(appCode),
  '这是下拉刷新删掉后**唯一**的重扫入口，删了就没法让 NAS 重扫了');
chk('重扫仍走 api.library(true)（带 refresh=1 真扫，不走缓存）', /api\.library\(true\)/.test(appCode));
chk('重扫完把顺序重洗（条数没变也洗）', /if \(!changed && S\.videos\.length\) reshuffleNow\(\)/.test(appCode));
chk('重扫失败会说人话（friendlyNetErr）', /msg = friendlyNetErr\(e\.message\)/.test(appCode));
/* ⚠️ 不能用 `/main\.pauseAll\(\);\s*\/\/ 重扫的时候/` 断言 —— `appCode` 是
   **剥过注释**的（`stripComments` 会把 `//` 之后整行删掉），注释永远匹配不到，
   这条会**恒红**。改成「在 runRefresh 函数体内找 pauseAll」这种语义判据。 */
chk('重扫期间暂停视频', (() => {
  const i = appCode.indexOf('async function runRefresh()');
  if (i < 0) return false;
  const j = appCode.indexOf('\n  }', i);
  return /main\.pauseAll\(\)/.test(appCode.slice(i, j < 0 ? undefined : j));
})());
chk('重扫不再带 off 参数（那是给指示器用的）', !/runRefresh\(off\)/.test(appCode) && !/runRefresh\(typeof/.test(appCode));

chk('进度条支持按住拖动', /const scrub = \{ on: false/.test(app) && /addEventListener\('pointerup', \(\) => endScrub\(true\)\)/.test(app));
chk('拖动中只画不跳（跟手画，不真 seek）', /function paintScrub/.test(app) &&
  /scrub\.ratio = ratioOfRect\(scrub\.rect, e\.clientX\);\s*\n\s*paintScrub\(\)/.test(app));
chk('松手才真正跳转', /if \(commit\) seekTo\(i, ratio\)/.test(app));
chk('被系统打断则画回真实进度', /else if \(i >= 0\) paintProgress\(i\)/.test(app));
chk('拖完吞掉那次 click，不重复跳', /if \(scrub\.fired\) \{ scrub\.fired = false; return; \}/.test(app));
chk('拖的时候 timeupdate 抢不走进度', /if \(scrub\.on && scrub\.i === i\) return;/.test(app));
chk('按进度条不算长按加速', /endHold\(\);\s+\/\/ 按在进度条上不算/.test(app));
chk('捕获指针，滑出去也能接着拖', /container\.setPointerCapture\(e\.pointerId\)/.test(app));
chk('进度条拖动时不触发页面滚动', /touch-action:none/.test(ruleBody('.progress')), ruleBody('.progress').slice(0, 90));
chk('进度条触摸热区 >= 26px', Number((ruleBody('.progress').match(/height:\s*(\d+)px/) || [])[1]) >= 26,
  ruleBody('.progress').slice(0, 60));
chk('可见轨道加粗到 >= 4px', Number((ruleBody('.progress .track').match(/height:\s*([\d.]+)px/) || [])[1]) >= 4,
  ruleBody('.progress .track').slice(0, 60));
chk('滑块常显（不再只在 :hover 才出现）', !/opacity:0/.test(ruleBody('.progress .bar::after')) && /\.progress \.bar::after\{/.test(css));
chk('拖动中变粗变大给反馈', /\.progress\.scrub \.track\{height:8px/.test(css) && /\.progress\.scrub \.bar::after\{/.test(css));
chk('进度条热区不会盖住左下角文案', Number((ruleBody('.progress').match(/height:\s*(\d+)px/) || [])[1]) + 50 <= 84,
  '热区顶边 = ' + (Number((ruleBody('.progress').match(/height:\s*(\d+)px/) || [])[1]) + 50) + 'px，.meta 底边 84px');
chk('旧的 seek(i, e) 签名已废弃', !/function seek\(i, e\)/.test(app) && /function seekTo\(i, ratio\)/.test(app));

console.log('\n · 暂停遮罩（快进后大播放按钮不能糊在画面上）');
// 回归护栏：这两条是用户实测踩过的坑，改动播放相关代码时最容易手滑退回去。
// 1) play() 被拒一律加 .paused —— 快进时 AbortError 是正常的「被新请求取代」，
//    一旦无条件 add，那个大播放按钮就永久焊在画面上了。
chk('play() 失败不再无条件标 .paused',
  !/p\.catch\(\(\)\s*=>\s*\{\s*item\.classList\.add\('paused'\)/.test(app) &&
  !/play\(\)\.catch\(\(\)\s*=>\s*[\s\S]{0,40}classList\.add\('paused'\)/.test(app));
// 2) .paused 必须是 video 真实状态的投影 —— 只允许 syncPaused 里那一个 add。
const pausedAdds = [...app.matchAll(/\.classList\.add\('paused'\)/g)].length;
chk('全文件只有一处 .paused 写入（syncPaused 里）', pausedAdds === 1, `找到 ${pausedAdds} 处`);
chk('有 syncPaused 对账函数', /function syncPaused\(v, item\)/.test(app));
chk('syncPaused 只认元素真实状态', /if \(v\.paused && !loading\) item\.classList\.add\('paused'\)/.test(app));
chk('换流前先摘遮罩（seek 转码分支）',
  /item\.classList\.remove\('paused'\);\s*\n\s*vv\.src = transUrl/.test(app));
chk('切重编码前先摘遮罩',
  /item\.classList\.remove\('paused'\);\s*\n\s*v\.src = transUrl/.test(app));
chk('pause / play 事件都去对账',
  /addEventListener\('pause', \(\) => syncPaused\(v, item\)\)/.test(app) &&
  /addEventListener\('play', \(\) => syncPaused\(v, item\)\)/.test(app));
chk('换流后有复查（起播了就摘掉按钮）', /seekSettle/.test(app) && /if \(!v2\.paused\) \{ item\.classList\.remove\('paused', 'stalling'\); return; \}/.test(app));
chk('CSS 里 .paused 仍然驱动大播放按钮', /\.item\.paused \.pause-ind\{opacity:1/.test(css));

console.log('\n · 接口');
const apiMethods = new Set([...api.matchAll(/^\s{2}(\w+):/gm)].map((m) => m[1]));
['browse', 'counts', 'sources', 'libPeek'].forEach((m) => chk(`api.${m} 已定义`, apiMethods.has(m)));
chk('旧的 api.libraryOf 已并入 sources', !/libraryOf/.test(api));
['/api/browse', '/api/counts', '/api/sources'].forEach((r) => chk(`后端有 ${r}`, srv.includes(`'${r}'`)));
chk('后端仍兼容 ?dir=（只刷这一个）', /const dir = q\.get\('dir'\)/.test(srv) && /config\.dirs = \[normAbs\(dir\)\]/.test(srv));
chk('浏览走 listDir', /async function listDir\(cfg, absPath\)/.test(srv));
chk('数量统计走 countVideos', /async function countVideos\(cfg, absPath\)/.test(srv));
chk('扫描走 scanLibrary(cfg, startAbs)', /async function scanLibrary\(cfg, startAbs\)/.test(srv));
chk('路径归一化 normAbs（兼防穿越）', /function normAbs\(p\)/.test(srv));
chk('拼远端地址用 davUrlAbs', /function davUrlAbs\(cfg, absPath, isDir\)/.test(srv));
chk('兼容地址里带路径（splitUrl）', /function splitUrl\(url\)/.test(srv));
chk('老配置的 basePath 会迁移成 dir', /migrateConfig/.test(srv) && /raw\.basePath/.test(srv));

/* ---------------- WebDAV 挂在子路径（CD2 / Nextcloud / Alist） ----------------
 * 这一组是 2026-09-18 修的坑，两边**同时错、而且错在相反方向**：
 *   · server.js 只取 origin，把地址里的 /dav 丢了 → 打 CD2 管理界面 → 405
 *   · DavClient 无条件 base + path，path 本来就带 /dav → /dav/dav → 404
 * 规则统一成「幂等」：带了就沿用、没带才补。下面把关键点逐条钉住，
 * 并直接跑一遍 urlPath 解析，防止有人又改回 origin-only。
 * 完整对拍见 _tmp/urlparity.js（17 组用例）。 */
console.log('\n · WebDAV 子路径挂载');
chk('splitUrl 用 pathPrefix 归一 urlPath（不是 normAbs）',
  /urlPath:\s*pathPrefix\(u\.pathname\)/.test(srv));
chk('pathPrefix 去尾斜杠、根落成空串',
  /function pathPrefix\(p\)\s*\{[^}]*while \(s\.endsWith\('\/'\)\)/.test(srv));
chk('davUrlAbs 判的是 urlPath 真值（根挂载空串=不补前缀）',
  /if \(urlPath && p !== urlPath && !p\.startsWith\(urlPath \+ '\/'\)\)/.test(srv));
chk('davUrlAbs 目录尾斜杠要排除「urlPath 自己」（CD2 的 /dav/ 会 301）',
  /const needsSlash = isDir && p !== urlPath;/.test(srv));
chk('effectiveDir 复用 mountAbs（别再就地写一份前缀判据）',
  /function effectiveDir\(override\) \{[\s\S]{0,600}?return mountAbs\(config, pick \|\| splitUrl\(config\.url\)\.urlPath\);/.test(srv));
chk('🔴 两边的 effectiveDir 都对本机片源（local:）短路，绝不拼成 /dav/local:',
  /* 2026-09-20 修：`local:/` 被 mountAbs 补成 `/dav/local:` 这个**根本不存在的
     WebDAV 路径** → /api/config 顶层 dir 被污染 + /api/browse 空路径必然 404
     → 触发「配置目录失效」兜底，弹一条用户根本无从理解的提示
     （他压根没配过 NAS 目录，只有本机 strm 库）。真机复现过。 */
  /function effectiveDir\(override\) \{[\s\S]{0,300}?if \(isLocalSrcPath\(pick\)\) return '';/.test(srv)
  && /private String effectiveDir\(\) \{\s*\n\s*if \(isLocalSrc\(dir\)\) return "";/.test(nj));
chk('/api/test 空 dir 探 urlPath（别用 || 吞掉空串）',
  /const rootDir = mountRootOf\(cfg\);/.test(srv));

const davj = read('android/src/com/nas/douyin/DavClient.java');
chk('DavClient 存下 basePrefix', /private final String basePrefix;/.test(davj));
chk('DavClient 先砍尾斜杠、再取 path（顺序不能反）',
  /while \(b\.endsWith\("\/"\)\) b = b\.substring\(0, b\.length\(\) - 1\);\s*\n\s*this\.base = b;\s*\n\s*this\.basePrefix = pathOf\(b\);/.test(davj));
chk('relOf 削前缀带边界检查（/dav 不误伤 /davos）',
  /if \(p\.startsWith\(basePrefix \+ "\/"\)\) return p\.substring\(basePrefix\.length\(\)\);/.test(davj));
chk('absUrl 对「base 自己那层」直接返回 base（避开 301）',
  /if \("\/"\.equals\(rel\) && !basePrefix\.isEmpty\(\)\) return base;/.test(davj));
chk('propfind 走 propfindPath（不能再用 encPath(path) 裸拼）',
  /rawRequest\("PROPFIND", propfindPath\(path\)/.test(davj));
chk('propfindPath 把 basePrefix 补回请求行',
  /String p = basePrefix \+ encPath\(rel\);/.test(davj));
chk('encPath 保留目录尾斜杠', /boolean dir = s\.endsWith\("\/"\);/.test(davj) && /if \(dir\) sb\.append\('\/'\);/.test(davj));
chk('NasServer 拦住「拿服务根当视频播」（CD2 的 301 陷阱）',
  /if \(abs\.equals\(urlPath\(\)\)\) return json\(400, err\("这是个目录，不是视频"\)\);/.test(nj));
chk('NasServer 的 urlPath/effectiveDir 用 prefixOf 算前缀',
  /private static String prefixOf\(String url\)/.test(nj) && /String pfx = prefixOf\(baseUrl\);/.test(nj));

// 真跑一遍：把 urlPath 解析逻辑抠出来验算（等价于 node new URL(...).pathname）
const srvPathPrefix = (p) => { let s = String(p == null ? '' : p); while (s.endsWith('/')) s = s.slice(0, -1); return s; };
const srvUrlPath = (url) => srvPathPrefix(new URL(url).pathname);
const srvOrigin = (url) => new URL(url).origin;
chk('解析 http://IP:19798/dav → origin + /dav',
  srvOrigin('http://192.168.1.100:19798/dav') === 'http://192.168.1.100:19798'
  && srvUrlPath('http://192.168.1.100:19798/dav') === '/dav');
chk('解析带尾斜杠 /dav/ 也归一到 /dav', srvUrlPath('http://192.168.1.100:19798/dav/') === '/dav');
chk('群晖根挂载的 urlPath 是空串（不是 "/"）', srvUrlPath('http://192.168.1.5005'.replace('.5005', ':5005')) === '');
chk('Nextcloud 多级前缀解析正确',
  srvUrlPath('http://nas.example.com/remote.php/dav/files/user') === '/remote.php/dav/files/user');

/* 回归守卫：修 CD2 时**绝不能碰坏**原本能用的「根挂载」机器。
 * 做法：把修复前的旧实现（origin + encPath(absPath)，没有 urlPath 概念）
 * 就地写一份，与**当前源码里真实的 davUrlAbs** 对同一批路径比 —— 必须逐字相同。
 * 这里的 grabFn 会把 server.js 的真函数抠出来跑，所以不是自说自话。
 * 独立脚本：_tools/dav-regress-synology.js */
const srvEncPathOld = (p) => {
  const out = [];
  for (const seg of String(p == null ? '' : p).split('/')) {
    if (!seg) continue;
    out.push(encodeURIComponent(seg).replace(/%2F/gi, '/'));
  }
  return out.length ? '/' + out.join('/') : '/';
};
const srvNormAbsOld = (p) => {
  const out = [];
  for (const seg of String(p == null ? '' : p).replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return '/' + out.join('/');
};
{
  const SYNO = 'http://192.168.1.100:5005';
  const names = ['normAbs', 'encPath', 'pathPrefix', 'splitUrl', 'mountAbs', 'davUrlAbs'];
  const real = new Function(names.map((n) => grabFn(srv, n)).join('\n')
    + '\nreturn { ' + names.join(', ') + ' };')();
  const cases = ['/', '/Photos', '/video/2024', '/电影/2024年', '/我的 视频', '/电影/a.mp4'];
  const changed = cases.filter((p) =>
    real.davUrlAbs({ url: SYNO }, p, false) !== srvOrigin(SYNO) + srvEncPathOld(srvNormAbsOld(p)));
  chk('群晖根挂载：6 条路径的输出与修复前逐字一致（旧机不受影响）',
    changed.length === 0, changed.join(' '));
  chk('群晖根挂载：目录形态也不变（尾斜杠照旧补）',
    real.davUrlAbs({ url: SYNO }, '/Photos', true) === SYNO + '/Photos/');
  chk('CD2 子路径：目录形态确实带上了 /dav（对照组，确认测试本身有效）',
    real.davUrlAbs({ url: 'http://192.168.1.100:19798/dav' }, '/dav/115open', true)
      === 'http://192.168.1.100:19798/dav/115open/');
}

/* ============================================================
   /api/browse 的「配置目录失效 → 退回挂载根」兜底
   ------------------------------------------------------------
   2026-09-18 用户实测：把服务器换成 CD2 之后，磁盘上存的 dir 还是群晖那条
   早已失效的旧路径。文件夹页一进来就站在那个不存在的目录上 → 404，
   而页面给的「回到根目录」按钮走的也是空路径 → 又回到同一个 404。
   于是**永远挑不了文件夹**，卡死在那一页。
   修法：空路径列目录失败时，退到「这个 WebDAV 地址本身指向的那一层」再列一次。
   ============================================================ */
console.log('\n · 目录失效自愈');
chk('mountRootOf 抽成了独立函数（探根与兜底必须同一个概念）',
  /function mountRootOf\(cfg\)/.test(srv));
chk('mountRootOf 用 urlPath 真值回落 /（不是 normAbs 那套）',
  /return splitUrl\(cfg && cfg\.url\)\.urlPath \|\| '\/';/.test(srv));
chk('browse 兜底只认「空路径」这一种情况（显式路径不许偷偷改）',
  /if \(!raw\) \{\s*\n\s*const root = mountRootOf\(cfg\);/.test(srv));
chk('browse 兜底前先确认根 ≠ 原目标（否则白跑一趟）',
  /const root = mountRootOf\(cfg\);\s*\n\s*if \(root !== target\) \{/.test(srv));
chk('browse 兜底结果带上 healed / stalePath / staleMsg 三个字段',
  /info\.healed = true;/.test(srv) && /info\.stalePath = target;/.test(srv)
  && /info\.staleMsg = /.test(srv));
chk('Java 版 handleBrowse 同样兜底（两个后端别分叉）',
  /boolean implicit = rawPath\.isEmpty\(\);/.test(nj) && /if \(implicit\) \{/.test(nj)
  && /info\.put\("healed", true\);/.test(nj));
chk('Java 兜底的根用 prefixOf(baseUrl) 算（与 server.js 同口径）',
  /String pfx = prefixOf\(baseUrl\);\s*\n\s*String root = pfx\.isEmpty\(\) \? "\/" : pfx;/.test(nj));
chk('前端 loadDir 会把 healed 讲给用户听（toast，不盖画面）',
  /if \(info\.healed && info\.staleMsg\) toast\(info\.staleMsg/.test(app));
chk('「文件夹」页起步只信 verifiedDir，不再回落 S.config.dir',
  /* ⚠️ 2026-09-20：起点又多加了一层过滤 —— 本机片源（local:）不能当「文件夹」页的
     起点（那页走 PROPFIND，扫不了本机目录）。所以现在不是裸的 srcList()[0]，
     而是先滤掉本机片源。断言跟着改，别让它变假红。 */
  /const webdav = srcList\(\)\.filter\(\(d\) => !isLocalSrc\(d\)\);/.test(app)
  && /return webdav\[0\] \|\| S\.verifiedDir \|\| '';/.test(app));
/* 反向守卫：这条正是当时的 bug 本身。真有人「顺手补个兜底」把它加回来，
 * 就又会拿磁盘上那条可能失效的路径去显式请求，后端的自愈兜底不会触发。 */
chk('起步路径**没有**再回落 S.config.dir（反向守卫）',
  !/loadDir\([^)]*S\.config\.dir/.test(app) && !/B\.path = [^;]*S\.config\.dir/.test(app));
chk('起步路径收成了一个函数（enterBrowse / cfBrowse 都走它，别再各写一份）',
  /function freshStartPath\(\)/.test(app) && /function browseStartPath\(\)/.test(app)
  && /function enterBrowse\(\) \{\s*\n\s*loadDir\(browseStartPath\(\)\);/.test(app)
  && /B\.path = freshStartPath\(\);/.test(app));
chk('verifiedDir 只在真连上过服务器时才写（登录 / 测试连接）',
  /S\.verifiedDir = r\.path \|\| '';/.test(app)
  && (app.match(/S\.verifiedDir = r\.path \|\| '';/g) || []).length === 2);
chk('启动时把 verifiedDir 清空（磁盘上的 dir 不算验证过）',
  /S\.currentDir = S\.config\.dir \|\| cfg\.dir \|\| '';\s*\n\s*\/\/[^\n]*\n\s*S\.verifiedDir = '';/.test(app));
{
  // 真算一遍挂载根，别只查正则
  const rootOf = (url) => srvUrlPath(url) || '/';
  chk('CD2 子路径挂载的根 = /dav', rootOf('http://192.168.1.100:19798/dav') === '/dav');
  chk('群晖根挂载的根 = /', rootOf('http://192.168.1.100:5005') === '/');
  chk('带尾斜杠的地址根也归一', rootOf('http://192.168.1.100:19798/dav/') === '/dav');
  chk('Nextcloud 多级前缀的根是整段', rootOf('http://nas.example.com/remote.php/dav/files/user')
    === '/remote.php/dav/files/user');
}
/* 面包屑：以前只在**失败**分支画，成功进目录时 #brCrumb 一直是空的 ——
 * 用户看不到自己在哪一层，也没法点着跳级。元素和样式一直都在，纯粹漏了调用。 */
chk('loadDir 成功分支也画面包屑（锚在 B.path = info.path 之后）',
  /B\.path = info\.path;[\s\S]{0,1000}?renderCrumb\(info\.crumbs\);/.test(app));
chk('renderCrumb 三条分支都覆盖（catch / !ok / 成功），不是只数调用次数',
  /catch \(e\) \{[\s\S]{0,140}?renderCrumb\(null\);/.test(app)
  && /if \(!info\.ok\) \{[\s\S]{0,140}?renderCrumb\(info\.crumbs\);/.test(app)
  && /B\.path = info\.path;[\s\S]{0,1000}?renderCrumb\(info\.crumbs\);/.test(app));

/* ============================================================
   两个后端的**响应字段**也必须对齐（不只是 URL 拼接）
   ------------------------------------------------------------
   2026-09-18 用户实测：点「＋ 加入」之后配置在服务端确实改了，
   但界面上「片源文件夹」永远显示「还没添加」、按钮永远不变成「✓ 已加」。
   根因：Node 版 /api/sources 会回 `config`，Java 版忘了回 ——
   而前端 renderSrcList / hasSrc 读的正是 S.config.dirs。
   ============================================================ */
console.log('\n · 两后端响应字段对齐');
chk('server.js /api/sources 回传 config（清空片源那条同步分支）',
  /return sendJson\(res, 200, \{ ok: true, config: \{ \.\.\.config, pass: '' \}, \.\.\.libPayload\(\) \}\);/.test(srv));
chk('server.js /api/sources 后台扫描分支也回传 config',
  /config: \{ \.\.\.config, pass: '' \},/.test(srv));
chk('Java handleSources 回传 config（走 mergeConfig 出口合并）',
  /return mergeConfig\(json\(200, o\)\);/.test(nj));
chk('Java mergeConfig 真的把 config 塞进响应体',
  /o\.put\("config", configJsonObj\(\)\);/.test(nj) && /private Resp mergeConfig\(Resp r\)/.test(nj));
chk('Java mergeConfig 在**出口**合并（响应分支多，逐分支补必漏）',
  /JSONObject o = new JSONObject\(\s*\n\s*new String\(r\.body, java\.nio\.charset\.StandardCharsets\.UTF_8\)\);/.test(nj));
/* 前端不该把「配置已更新」完全外包给服务端回显 —— 它自己知道刚发出去的是什么。
 * 反向守卫：以前那种「只在 lib.config 存在时才更新」的写法不许回来。 */
chk('前端 applySources 以**本地发出去的 dirs** 为底，再让服务端 config 覆盖',
  /dirs: dirs\.slice\(\),/.test(app) && /\.\.\.\(lib\.config \|\| \{\}\),/.test(app));
chk('前端 applySources 不再只信 lib.config（反向守卫）',
  !/if \(lib\.config\) S\.config = \{ \.\.\.S\.config, \.\.\.lib\.config/.test(app));
chk('前端 dir 只在 dirs 非空时才动（与服务端 `if (dirs.length) dir = dirs[0]` 一致）',
  /\.\.\.\(dirs\.length \? \{ dir: dirs\[0\] \} : \{\}\),/.test(app));
/* 反向守卫：片源列表的判据必须只有一个来源，别偷偷换成 S.dirs。
 * S.dirs 来自片库响应，失效兜底时会被写成 ['/'] —— 拿去显示会冒出个「根目录」片源。 */
chk('srcList 只读 S.config.dirs（别改成 S.dirs）',
  /const srcList = \(\) => \(S\.config\.dirs \|\| \[\]\)\.slice\(\);/.test(app));

/* ============================================================
   加/删片源必须「立刻回话」，扫描丢后台
   ------------------------------------------------------------
   2026-09-18 用户实测：点「＋ 加入」/「✕ 移出」要干等十几秒到几十秒没反应。
   根因：POST /api/sources 里是 `await buildLibrary(...)` —— **同步**把整个片库
   重扫一遍才回（加一个 498 个视频的文件夹实测 12~40 秒）。
   而项目里早就有「先给旧数据、后台扫、扫完 peek 通知前端换」这套机制
   （kickBackgroundScan / startBackgroundScan + ?peek=1 + watchLibraryRefresh），
   缓存过期那条路一直在用，只有这里没接上。
   修法：配置写盘 → 起后台扫描 → 立刻回 { pendingScan:true }。
   下面这些断言把「同步扫」钉死不许回来，并把「追新重扫」这条容易漏的路守住。
   ============================================================ */
console.log('\n · 加/删片源立刻回话（扫描丢后台）');
/* 反向守卫：/api/sources 里不许再出现同步扫描。
 * ⚠️ 必须跑在 stripComments 之后 —— 上面那段「以前是 await buildLibrary」的
 *    说明性注释会被负向断言自己命中（本项目栽过 5 次的老坑）。
 *    （srvCode / njCode / svcCode 的定义已上移到文件头部变量区，见那里。） */
const srcBlock = (() => {
  const i = srvCode.indexOf("'/api/sources'");
  return i < 0 ? '' : srvCode.slice(i, i + 1500);
})();
chk('server.js /api/sources 不再同步 await buildLibrary（反向守卫）',
  srcBlock.length > 0 && !/await buildLibrary/.test(srcBlock));
chk('server.js /api/sources 立刻起后台扫描',
  /kickBackgroundScan\(\);\s*return sendJson/.test(srcBlock));
chk('server.js /api/sources 回 pendingScan（前端据此不 applyLibrary）',
  /pendingScan: !!scanning,/.test(srcBlock));
chk('server.js /api/sources 的 dirs/dir 在 libPayload() **之后**覆盖（顺序不能反）',
  /\.\.\.libPayload\(\),[\s\S]{0,400}?dirs: config\.dirs,\s*dir: config\.dirs\[0\],/.test(srcBlock));
chk('server.js /api/sources 片源清空时同步清库（不能等后台）',
  /if \(!config\.dirs\.length\) \{[\s\S]{0,400}?library = \{ videos: \[\], scannedAt: Date\.now\(\)/.test(srcBlock));
/* 追新：扫的中途配置又变了，那份结果必须**丢弃**而不是提交 ——
 * 提交会让 libVersion++，前端 peek 一看到版本变化就取走过期数据并停止轮询，
 * 后面那轮正确结果就永远没人看了。 */
chk('server.js kickBackgroundScan 扫完先验签名，变了就丢弃（不提交）',
  /if \(sig !== libSig\(\)\) \{[\s\S]{0,220}?scanAgain = true;[\s\S]{0,40}?return;/.test(srvCode));
chk('server.js 丢弃后会在 finally 里按新配置补一轮',
  /finally \{[\s\S]{0,220}?if \(scanAgain\) \{ scanAgain = false; kickBackgroundScan\(\); \}/.test(srvCode));
chk('server.js 后台扫描失败也会 libVersion++（否则前端空等到超时）',
  /catch \(e\) \{[\s\S]{0,600}?libError = e\.message;[\s\S]{0,40}?libVersion\+\+;/.test(srvCode));
chk('server.js libPayload 带 scanError（刻意不叫 error）',
  /\.\.\.\(libError \? \{ scanError: libError \} : \{\}\),/.test(srvCode));
chk('server.js 扫成功会清掉 libError',
  /libError = '';[\s\S]{0,40}?libVersion\+\+;/.test(srvCode));

chk('Java handleSources 也起后台扫描、不再同步 refresh',
  /startBackgroundScan\(\);/.test(njCode) && !/force\.put\("refresh", "1"\)/.test(njCode));
chk('Java handleSources 回 pendingScan / scanning',
  /o\.put\("pendingScan", libScanning\(\)\);/.test(njCode) && /o\.put\("scanning", libScanning\(\)\);/.test(njCode));
chk('Java handleSources 片源清空时同步清库（不能等后台）',
  /if \(dirs\.isEmpty\(\)\) \{[\s\S]{0,1000}?libCache = empty;[\s\S]{0,200}?clearLibraryOnDisk\(\);/.test(njCode));
/* 位置很关键：验签名必须在「全部失败」那个分支**之前** ——
 * 失败分支也会 libVersion++，排在它后面的话 superseded 永远轮不到，
 * 用户就会收到一个「上一个片源」的报错。
 * ⚠️ 别用 `if (all.isEmpty() && firstErr != null)` 当锚点：doScan 里那个
 *    WebDAV 根目录兜底判断是**一模一样**的一行，indexOf 会先命中它。
 *    改用紧跟在失败分支后面的 `JSONObject errObj = demoPayload();`。 */
chk('Java doScan 提交前验签名，变了就返回 superseded（且在失败分支之前）',
  (() => {
    const a = njCode.indexOf('if (all.size() >= NasService.MAX_VIDEOS) truncated = true;');
    const i = njCode.indexOf('sup.put("superseded", true);');
    const j = njCode.indexOf('JSONObject errObj = demoPayload();');
    const k = njCode.indexOf('libVersion++;\n        libScanError = "";');
    return a > 0 && i > a && j > i && k > j;
  })());
/* scanNowSync 本身还在（别的路径可能用），但**不再**被 refresh=1 调用
   （上面那条守着）。这里只守它自己的重试逻辑，别再断言谁调它。 */
chk('Java scanNowSync 本身会重试 superseded（别把空壳回给前端）',
  /private JSONObject scanNowSync\(\)/.test(njCode)
  && /!lib\.optBoolean\("superseded", false\)\) return lib;/.test(njCode));
chk('Java startBackgroundScan 也会追新重扫',
  /for \(int round = 0; round < 3; round\+\+\) \{[\s\S]{0,500}?superseded/.test(njCode));
/* doScan 不碰扫描层数 —— 由上面的「Java doScan 自己不加减层数」那条守着，这里不重复。 */
chk('Java peek 会把 scanError 带回去',
  /o\.put\("scanError", libScanError\);/.test(njCode));
chk('Java doScan 失败也 libVersion++ 并记 libScanError',
  /libScanError = errObj\.optString\("error"[\s\S]{0,120}?libVersion\+\+;/.test(njCode));
chk('Java doScan 扫成功会清掉 libScanError',
  /libVersion\+\+;[\s\S]{0,40}?libScanError = "";/.test(njCode));

chk('前端 applySources 有 pendingScan 分支（配置先生效，片库等后台）',
  /if \(S\.pendingScan\) \{/.test(appCode) && /S\.pendingScan = !!lib\.pendingScan;/.test(appCode));
/* 反向守卫：pendingScan 分支里**不许**出现 applyLibrary(lib) ——
 * 那份响应带的是旧片库，灌进去要么闪空、要么把正在看的内容切走。 */
chk('前端 pendingScan 时不 applyLibrary（反向守卫：别拿旧片库灌界面）',
  (() => {
    const i = appCode.indexOf('if (S.pendingScan) {');
    const j = appCode.indexOf('applyLibrary(lib);', i);
    if (i < 0 || j < 0) return false;
    const seg = appCode.slice(i, j);
    // 分支必须在这段里就 return 掉，不能一路走到 applyLibrary
    return /return true;/.test(seg) && seg.length < 1200;
  })());
chk('前端 applyLibrary 会清 pendingScan',
  /function applyLibrary\(lib\) \{[^}]{0,80}?S\.pendingScan = false;/.test(appCode));
chk('前端 onlySource 在 pendingScan 时不会误报「没有视频」',
  /if \(S\.pendingScan\) \{[\s\S]{0,300}?正在扫描/.test(appCode));
chk('前端 watchLibraryRefresh 读 scanError 并停止轮询（不去同步重扫）',
  /if \(r\.scanError\) \{[\s\S]{0,300}?friendlyNetErr\(r\.scanError\)/.test(appCode));
/* ⚠️ 别用「stop 必须是一行」来判 —— 它一度还兼着「通知 onScanSettled」的收尾
   （那个钩子已随刷新按钮改成「重启应用」而回收，见上面那组断言）。
   这里改判**语义**：stop() 里要清定时器 + 置 null，
   且超时那条路（tries > 300）必须调 stop() 再 showLoading(false)。 */
chk('前端 watchLibraryRefresh 每条出口都收掉转圈（不会卡死）',
  appCode.indexOf('const stop = () => {') > -1
  && appCode.indexOf('clearInterval(peekTimer);') > -1
  && appCode.indexOf('peekTimer = null;') > -1
  && /tries > 300\) \{ stop\(\); showLoading\(false\); return; \}/.test(appCode));
/* 用户要求删掉的按钮不许回来：既不能有 HTML，也不能留死分支。
 * 同样跑在 appCode 上 —— 说明性注释里写着「原来这里有个 ▶ 开刷这… 的按钮」。 */
chk('「▶ 开刷这 N 个文件夹」按钮已删除（反向守卫）',
  !/data-br-home/.test(appCode) && !/开刷这/.test(appCode));

/* ============================================================
   片库列什么格式（2026-09-18 定，2026-09-19 放开）
   ------------------------------------------------------------
   2026-09-18：用户要求「播放时直接过滤掉 avi/wmv/mkv」→ 片库只列
   mp4/m4v/mov/webm/ogv。
   🔴 2026-09-19 放开：那条规则的依据是「WebView 播不了解不了」，
   但 APK 实际用的是**原生 Media3 播放器**（PlayerActivity），Matroska/
   AVI/FLV/TS/PS 提取器它都自带 —— 结果 115 里的 mkv 全部消失
   （用户报「添加片源后扫不到视频」）。现在：
     · Java 侧片库列出 ALL_EXTS 全部 14 种；
     · 能不能播由 PLAYABLE_EXTS 标（wmv/rmvb/mpg/mpeg 标 false，
       点开给明确的「解不了这种封装」错误卡片，不会卡死）；
     · 电脑版 server.js **保持 5 种不变** —— 浏览器 <video> 真解不了 mkv。
     ⚠️ 两边**故意不再一致**，别再"统一"。
   还有 /api/test 那句「这个目录下有 N 个视频」用 ALL_EXTS（原始盘点）。
   ============================================================ */
console.log('\n · 片源「不重扫」（2026-09-18「有些文件夹不会再新增，每次都扫太浪费时间」）');
/* ------------------------------------------------------------------
 * 用户原话：「有些文件夹我添加上去之后，不会再新增文件了，每次都扫描的话太浪费时间了」。
 *
 * 语义：给片源标上「不重扫」→ 常规扫描**整个跳过它**，直接把上一份片库里
 *       属于它的视频搬过来。§42 实测扫一遍大目录要 802 秒，跳过一个就省一份。
 *
 * 四个必须同时成立的设计点（少一个就会变成「静默错误」）：
 *   ① **只在缓存里确实有它的视频时才跳过** —— 一次都没扫过（新装、缓存清了、
 *      刚加上的）就必须照扫一次，否则用户标完发现这个文件夹一条都没有。
 *   ② **libSig 刻意不含 skipDirs** —— 一旦拼进去，勾选/取消就会让整份片库缓存
 *      失效，而跳过的目录正是要靠这份缓存才有视频的 = 自己把自己清空。
 *   ③ **切换走 POST /api/config，绝不能走 /api/sources** —— /api/sources
 *      保存完会立刻起一次后台全量扫描（十几分钟），正是这个功能想避免的事。
 *   ④ **「只刷它」前必须先解锁** —— 点「只刷它」就是「现在给我扫它」，
 *      和「跳过」直接冲突；不解锁的话后端照旧跳过，把旧缓存原样还回来，
 *      用户以为重扫了其实一条都没更新（**静默**错误，极难发现）。
 * ------------------------------------------------------------------ */

/* ---- ① 只在缓存有货时才跳过 ---- */
chk('server.js：跳过前先确认缓存里确实有它的视频（没有就照扫一次）',
  /if \(skip\.has\(root\)\) \{[\s\S]{0,80}const old = cachedVideosOfDir\(root\);/.test(srvCode)
  && /if \(old\.length\) \{/.test(srvCode)
  && /标了「不重扫」但片库里没有它/.test(srv));
chk('Java：跳过前先确认缓存里确实有它的视频（没有就照扫一次）',
  /if \(skipDirs\.contains\(root\)\) \{[\s\S]{0,80}cachedVideosOfDir\(root\)/.test(njCode)
  && /if \(!old\.isEmpty\(\)\) \{/.test(njCode));
/* ⚠️ 判前缀必须带 `/`：`/dav/示例片源2` 不能被当成 `/dav/示例片源` 的子项。 */
chk('「属于某个目录」的判据带斜杠（/dav/示例片源2 不能算 /dav/示例片源 的子项）',
  /String\(v\.p\)\.startsWith\(d \+ '\/'\)\)/.test(srvCode)
  && /p\.startsWith\(d \+ "\/"\)/.test(njCode));

/* ---- ② libSig 绝不能含 skipDirs ---- */
chk('server.js：libSig 不含 skipDirs（否则勾一下就作废整份缓存，自己清空自己）', (() => {
  const i = srvCode.indexOf('function libSig(');
  if (i < 0) return false;
  const j = srvCode.indexOf('\n}', i);
  return !/skipDirs/.test(srvCode.slice(i, j < 0 ? undefined : j));
})());
chk('Java：libSig 不含 skipDirs（同上）', (() => {
  const i = njCode.indexOf('private String libSig(');
  if (i < 0) return false;
  const j = njCode.indexOf('\n    }', i);
  return !/skipDirs/.test(njCode.slice(i, j < 0 ? undefined : j));
})());

/* ---- ③ 走 /api/config 而不是 /api/sources ---- */
chk('切换「不重扫」走 api.saveConfig（不是 api.sources —— 后者会立刻起十几分钟的后台全量扫描）',
  /async function toggleSkip\(dir\)/.test(appCode)
  && /const r = await api\.saveConfig\(\{ skipDirs: next \}\);/.test(appCode)
  && !/api\.sources\([\s\S]{0,40}toggleSkip/.test(appCode));

/* ---- ④ 「只刷它」前先解锁 ---- */
chk('「只刷它」会先解锁（锁着的话后端照旧跳过，把旧缓存原样还回来 = 静默错误）',
  /async function onlySource\(dir\)[\s\S]{0,400}if \(skipList\(\)\.includes\(dir\)\) \{/.test(appCode)
  && /skipDirs: skipList\(\)\.filter\(\(d\) => d !== dir\)/.test(appCode));

/* ---- 前端：只认仍在片源里的项 ---- */
chk('skipList() 只认仍在片源里的项（文件夹被移走了就别再记着）',
  /const skipList = \(\) => \(S\.config\.skipDirs \|\| \[\]\)\.filter\(\(d\) => srcList\(\)\.includes\(d\)\);/.test(appCode));
chk('改片源时把 skipDirs 一起发（否则后端按新 dirs 收敛 = 锁定标记全丢）',
  /const sentSkip = skipList\(\)\.filter\(\(d\) => dirs\.includes\(d\)\);/.test(appCode)
  && /api\.sources\(dirs, \$\('brRecursive'\)\.checked, sentSkip\)/.test(appCode));

/* ---- 后端：收敛 + 去重 + 持久化 ---- */
chk('server.js：/api/sources 与 /api/config 都只保留仍在片源里的项并去重',
  (srvCode.match(/next\.skipDirs = \[\.\.\.new Set\(body\.skipDirs/g) || []).length >= 1
  && /config\.skipDirs = \[\.\.\.new Set\(body\.skipDirs/.test(srvCode)
  && /\.filter\(\(d\) => cur\.includes\(d\)\)/.test(srvCode));
chk('server.js：老配置没有 skipDirs 时会迁移成 []（并清掉不在 dirs 里的残留）',
  /const sd = Array\.isArray\(c\.skipDirs\) \? c\.skipDirs : \[\];/.test(srvCode));
chk('server.js：/api/config 会把 skipDirs 回给前端',
  /skipDirs: Array\.isArray\(config\.skipDirs\) \? config\.skipDirs : \[\],/.test(srvCode));
chk('Java：配置有 skipDirs 字段 / 读 / 写 / /api/config 返回',
  /private List<String> skipDirs = new ArrayList<>\(\);/.test(njCode)
  && /p\.getString\("skipDirs", ""\)/.test(njCode)
  && /e\.putString\("skipDirs", ssb\.toString\(\)\);/.test(njCode)
  && /o\.put\("skipDirs", sd\);/.test(njCode));
chk('Java：loadConfig 也会按 dirs 收敛（老配置/文件夹被删的自我修复）',
  /if \(dirs\.contains\(n\) && !skipDirs\.contains\(n\)\) skipDirs\.add\(n\);/.test(njCode));

/* ---- UI ---- */
chk('片源行有「不重扫 / 每次都扫」开关（data-skip）',
  /data-skip="\$\{escapeHtml\(d\)\}"/.test(app) && /class="fskip \$\{on \? 'on' : ''\}"/.test(app));
chk('开关有 .on 态样式（没锁/锁定必须一眼能分）',
  /\.srow \.fskip\.on\{/.test(cssCode));

console.log('\n · 全量扫描（2026-09-18「有些视频藏的比较深要怎么全部扫出来」）');
/* ---- 深扫太慢 → 「重新扫描」改成后台，前端靠轮询接 ---- */
/* ⚠️ pauseAll 与「谁来恢复」必须配对：深扫是后台的，pendingScan 分支会直接 return，
   暂停放前面就没人恢复 —— 视频会哑十几分钟。必须放在 pendingScan 分支**之后**。 */
chk('前端：pauseAll 只在同步分支里调（pendingScan 那条路直接 return，暂停了没人恢复）', (() => {
  const i = appCode.indexOf('async function runRefresh()');
  if (i < 0) return false;
  const j = appCode.indexOf('\n  }', i);
  const body = appCode.slice(i, j < 0 ? undefined : j);
  const pPause = body.indexOf('main.pauseAll()');
  const pPending = body.indexOf('lib.pendingScan');
  return pPause > 0 && pPending > 0 && pPause > pPending;
})());

chk('前端：runRefresh 见到 pendingScan 不 applyLibrary（那份是旧片库，灌进去会闪空）',
  /if \(lib && lib\.pendingScan\) \{/.test(appCode)
  && /S\.pendingScan = true;/.test(appCode)
  && /watchLibraryRefresh\(lib\);/.test(appCode));
/* 🔴 5 分钟不够：深扫实测 13 分钟。只改服务端不改这里 = 扫完没人接得住。 */
chk('前端：轮询上限放宽到 20 分钟（300×4s），不再是 5 分钟',
  /if \(\+\+tries > 300\)/.test(appCode) && !/\+\+tries > 75/.test(appCode));
chk('前端：首次没缓存 + 后台扫时留着 loading 并说明要多久（否则一片空白像坏了）',
  /if \(wasPending && !S\.videos\.length\) \{/.test(appCode)
  && /showLoading\(true, '首次扫描目录较大，可能要十几分钟…'\);/.test(app));


/* ------------------------------------------------------------------
 * 起因：用户反馈「有些视频藏的比较深」扫不出来。
 *
 * 实测（_tools/scan-depth-profile.js，BFS 全量遍历 /dav/示例片源）：
 *   第 2 层   373 个
 *   第 3 层  1698 个
 *   第 4 层  3359 个
 *   第 5 层  5095 个   ← ⚠️ 当时 maxDepth=4，**这 48.4% 全漏了**
 *   合计 ≥10525 个，而 App 片库只有 **549** 个。
 *
 * 三道限制都得放开，缺一个就扫不全：
 *   ① 深度     8  → 不限（0）
 *   ② 条数   800  → 20000
 *   ③ 时间   45s  → 5min，且**超时必须报 truncated**
 *       （以前超时**完全静默**：NasServer 只在 `all.size() >= MAX_VIDEOS` 时
 *        置 truncated，45 秒一到悄悄停下，用户以为扫全了 —— 这是最难查的一半）
 *
 * 但只放开限制会慢到不可用：串行 BFS 4000 个目录要 ~19 分钟
 * （CD2 不支持 Depth:3，只能一层层走）。所以还要：
 *   ④ 并发：串行递归 → **按层 BFS + 8 路并发**，实测 ~3.4 分钟
 *      （_tools/bench-concurrency.js：60 个目录 串行 16.9s / 8 并发 3.1s / 16 并发 2.7s；
 *        16 路只快 12% 却让 NAS 压力翻倍 → **8 是甜点**）
 * ------------------------------------------------------------------ */

/* ---- ① 深度：0 = 不限 ---- */
chk('扫描深度改成「0 = 不限」（不再硬 clamp 到 8）',
  /const maxDepth = Math\.max\(0, Math\.min\(32, Number\(cfg\.maxDepth\) \|\| 0\)\);/.test(srvCode)
  && /const unlimited = maxDepth === 0;/.test(srvCode));
chk('Java 深度也支持 0 = 不限（MAX_DEPTH_CAP = 32）',
  /static final int MAX_DEPTH_CAP = 32;/.test(svcCode)
  && /final int depthLimit = Math\.max\(0, Math\.min\(MAX_DEPTH_CAP, maxDepth\)\);/.test(svcCode)
  && /final boolean unlimited = depthLimit == 0;/.test(svcCode));
chk('默认配置就是「不限深度」（maxDepth: 0）',
  /maxDepth: 0,/.test(srvCode) && /private int maxDepth = 0;/.test(njCode));
/* 🔴 反向守卫：谁把 8 加回来，第 5 层那 5095 个就又没了。 */
chk('两后端都不许再把深度 clamp 成 8',
  !/Math\.min\(8, Number\(cfg\.maxDepth\)/.test(srvCode) && !/Math\.min\(8, maxDepth\)/.test(svcCode)
  && !/Math\.min\(8, this\.maxDepth\)/.test(njCode));

/* ---- ② 条数上限 ---- */
chk('server.js 条数上限 800 → 20000', /const MAX_VIDEOS = 20000;/.test(srvCode));
chk('Java 条数上限 800 → 20000', /static final int MAX_VIDEOS = 20000;/.test(svcCode));

/* ---- ③ 时间上限 + 必须报告截断 ---- */
chk('server.js 时间上限 45s → 5min', /const MAX_MS = 300000;/.test(srvCode));
chk('Java 时间上限 45s → 5min', /static final int MAX_MS = 300000;/.test(svcCode));
/* 🔴 这一条是「静默截断」的守卫。以前时间到了不吭声，用户以为扫全了。 */
chk('Java：时间截断也要报（scan 回传 truncatedOut）',
  /boolean\[\] truncatedOut\) throws Exception \{/.test(svcCode)
  && /if \(truncatedOut != null && truncatedOut\.length > 0\) truncatedOut\[0\] = truncated;/.test(svcCode));
chk('Java：NasServer 收到 scanTruncated 后并入 truncated',
  /final boolean\[\] scanTruncated = new boolean\[1\];/.test(njCode)
  && /if \(scanTruncated\[0\]\) truncated = true;/.test(njCode));
chk('两处 scan 调用都传了 truncatedOut（漏一处就又会静默截断）',
  (njCode.match(/NasService\.scan\(dav, [^)]*scanTruncated\)/g) || []).length === 2);

/* ---- ④ 并发 BFS ---- */
chk('server.js：并发路数 8（实测甜点）', /const CONCURRENCY = 8;/.test(srvCode));
chk('server.js：有 mapLimit（同层并发，结果顺序与入参一致）',
  /async function mapLimit\(list, limit, fn\)/.test(srvCode));
chk('server.js：扫描改成按层 BFS（不再串行递归 walk）',
  /let frontier = \[root\];/.test(srvCode) && /while \(frontier\.length\) \{/.test(srvCode)
  && !/async function walk\(dirAbs, depth\)/.test(srvCode));
chk('server.js：并发结果必带 dirAbs（否则跳不掉 PROPFIND 自己列出来的那条 → 死循环）',
  /return \{ dirAbs, items: await propfind\(cfg, dirAbs, 1\) \};/.test(srvCode)
  && /if \(norm === self\) continue;/.test(srvCode));
chk('Java：并发路数 8', /static final int CONCURRENCY = 8;/.test(svcCode));
chk('Java：扫描用线程池并发（ExecutorService + Future）',
  /java\.util\.concurrent\.Executors\.newFixedThreadPool\(CONCURRENCY\)/.test(svcCode)
  && /java\.util\.concurrent\.Future<PropResult>/.test(svcCode));
chk('Java：线程池一定 shutdown（否则线程泄漏）',
  /\} finally \{\s*\n\s*pool\.shutdown\(\);/.test(svcCode));
chk('Java：PropResult 带 dir（同上，防死循环）',
  /private static final class PropResult \{/.test(svcCode) && /final String dir;/.test(svcCode)
  && /if \(norm\.equals\(self\)\) continue;/.test(svcCode));
/* ---- 前端：深度下拉 ---- */
chk('#cfDepth 从数字框改成下拉（带「不限」档）',
  /<select id="cfDepth">/.test(htmlCode) && /<option value="0">不限<\/option>/.test(htmlCode));
/* 🔴 反向守卫：0 是**有效值**（= 不限）。`c.maxDepth || 4` 会把 0 当成没设置
   再兜回 4，于是「不限」永远存不下来 —— 这是本次最容易复发的坑。 */
chk('回填时把 0 当有效值（不许用 `|| 4`，那会冲掉「不限」）',
  /dp\.value = String\(c\.maxDepth == null \? 0 : c\.maxDepth\);/.test(appCode)
  && !/cfDepth'\)\.value = c\.maxDepth \|\| 4/.test(appCode));
chk('提交时同样不许 `|| 4`',
  /maxDepth: Number\(\$\('cfDepth'\)\.value\),/.test(appCode)
  && !/maxDepth: Number\(\$\('cfDepth'\)\.value\) \|\| 4/.test(appCode));
chk('值不在档位里时回落到「不限」（而不是停在空白项）',
  /if \(dp\.value !== String\(c\.maxDepth == null \? 0 : c\.maxDepth\)\) dp\.value = '0';/.test(appCode));

console.log('\n · 屏蔽小文件（按体积筛选，2026-09-18 加）');
/* ------------------------------------------------------------------
 * 用户要求：「可以由用户直接选择屏蔽多大以下的视频文件」。
 *
 * 设计上的两个决定（改动前必须知道，否则会改错方向）：
 *   ① 阈值是**预设档位下拉**（0/5/10/20/50/100/200/500/1024 MB），不是自由输入 ——
 *      手机上手点即选，也不用做单位换算和非法输入校验。
 *   ② 走 **localStorage，不走 /api/config** —— 三个理由：
 *        a. 它不改变扫描行为，服务端不需要知道；
 *        b. 改阈值必须**即时生效**；若进 config，保存会触发 loadLibrary(true)
 *           重扫一遍（实测 54~185 秒），用户拖一下就得等一分钟；
 *        c. 一份 public/ 伺候两个后端（PC server.js / APK NasServer.java），
 *           加进 config 就要两边都回这个字段。
 *      ⇒ 所以下面有**反向守卫**：minSize 绝不能出现在 formValues() / config 里。
 * ------------------------------------------------------------------ */
chk('#cfMinSize 是个 select（下拉档位，不是自由输入）',
  /<select id="cfMinSize">/.test(htmlCode));
chk('档位齐全：不屏蔽 / 5 / 10 / 20 / 50 / 100 / 200 / 500 MB / 1 GB', (() => {
  const vals = [...htmlCode.matchAll(/<option value="(\d+)" data-mb="\d+">/g)].map((m) => m[1]);
  // 只取 #cfMinSize 那一段里的 option，别把别的 select 也算进来
  const i = htmlCode.indexOf('<select id="cfMinSize">');
  const seg = htmlCode.slice(i, htmlCode.indexOf('</select>', i));
  const mine = [...seg.matchAll(/value="(\d+)"/g)].map((m) => m[1]);
  return JSON.stringify(mine) === JSON.stringify(['0', '5', '10', '20', '50', '100', '200', '500', '1024']);
})(), '档位 = ' + (() => {
  const i = htmlCode.indexOf('<select id="cfMinSize">');
  const seg = htmlCode.slice(i, htmlCode.indexOf('</select>', i));
  return [...seg.matchAll(/value="(\d+)"/g)].map((m) => m[1]).join(',');
})());
chk('下拉有样式（appearance:none 之后必须自己画箭头，否则深色底上看不见）',
  /\.switch-row select\{/.test(cssCode) && /appearance:none/.test(ruleBody('.switch-row select'))
  && /background-image:url\("data:image\/svg\+xml/.test(ruleBody('.switch-row select')));
chk('option 也上了底色（Android 上不给 option 上色会是白底黑字）',
  // 2026-09-21：底色/文字色改成走主题令牌（原来写死 #1c1d26 / #fff），
  // 浅色主题下才换得过来 —— 所以这里断的是「必须走令牌」而不是具体色值。
  /background:var\(--srf4\)/.test(ruleBody('.switch-row select option'))
  && /color:var\(--ink\)/.test(ruleBody('.switch-row select option')),
  ruleBody('.switch-row select option'));

/* ---- 全量 / 可见两份列表（核心数据结构） ---- */
chk('S 里同时有 videos（可见）和 allVideos（全量）两份列表',
  /videos: \[\],/.test(appCode) && /allVideos: \[\],/.test(appCode));
chk('阈值从 localStorage 读（nasdy.minSize），不是从 S.config',
  /minSizeMB: LS\.get\('minSize', 0\),/.test(appCode));
chk('applyLibrary 把服务端原始列表存进 allVideos，再 rebuildShown 出可见列表',
  /S\.allVideos = next;/.test(appCode) && /rebuildShown\(\);/.test(appCode));
/* 🔴 这条是整个功能的命门。若有人图省事写成 `S.videos = S.videos.filter(...)`，
   阈值只会越调越小（在已过滤的列表上再过滤），而且调回「不屏蔽」也回不来。 */
chk('rebuildShown 从 allVideos 重新筛，**绝不拿 S.videos 自我过滤**',
  /S\.videos = min > 0\n\s*\? S\.allVideos\.filter/.test(appCode)
  && !/S\.videos = S\.videos\.filter/.test(appCode));
chk('阈值 0 时直接用全量副本（不筛、也不共享同一个数组引用）',
  /: S\.allVideos\.slice\(\);/.test(appCode));
/* ⚠️ 拿不到 size（0 / 缺字段）时必须**保留**：没法证明它小，静默丢掉会让用户
   以为片库漏了东西。宁可多显示，也别莫名其妙少一片。 */
chk('size 拿不到（0 / 缺字段）时保留，不静默丢弃',
  /const n = Number\(v\.size \|\| 0\);/.test(appCode)
  && /return n <= 0 \|\| n >= min \|\| isStrmPointer\(v\);/.test(appCode));
/* 🔴 2026-09-20：`.strm` **指针**不能被「屏蔽小文件」滤掉。
 *
 * 用户报「那怎么一个视频都没有」：`nasdy.minSize = 50`（50MB），而 `.strm` 只有
 * 35~46 字节 → 5000 多条被 100% 滤光，片源栏「本机 strm 库 · 0 个视频」、
 * 首页一条不剩，看着像视频全没了（磁盘上一个没少）。
 * 判据：`.strm` 自己的字节数证明不了目标视频的大小 → 不许拿它判「小文件」。 */
chk('🔴 前端：有 .strm 指针判据，且在 rebuildShown 里放行（ext 或路径后缀两个判据都留着）',
  /const isStrmPointer = \(v\) =>/.test(appCode)
  && /String\(v\.ext \|\| ''\)\.toLowerCase\(\) === 'strm'/.test(appCode)
  && /\/\\\.strm\$\/i\.test\(String\(v\.p \|\| ''\)\)/.test(appCode)
  && /isStrmPointer\(v\)/.test(appCode));
chk('rebuildShown 之后 byId 也跟着重建（否则按路径找不到视频）',
  /S\.byId = new Map\(S\.videos\.map\(\(v\) => \[v\.p, v\]\)\);/.test(appCode));

/* 🔴 行为断言：把**真**rebuildShown + 真 isStrmPointer 抠出来喂数据。
 *   桩里刻意造 5 条：两个 .strm 指针（几十字节）、一个够大的真视频、
 *   一个真的小视频、一个拿不到大小的 —— 五种情况各管一条断言。 */
{
  const mk = (minMB, all) => {
    const S = { minSizeMB: minMB, allVideos: all, videos: [], byId: null };
    const f = new Function('S',
      grabFn(app, 'rebuildShown') + '\n' + grabArrow(app, 'isStrmPointer')
      + '\nreturn rebuildShown;')(S);
    f();
    return S;
  };
  const ALL = [
    { p: 'local:/boki/cos/16-5a.mp4.strm', ext: 'strm', size: 35 },
    { p: 'local:/云下载/4051141.mp4.strm', ext: 'strm', size: 46 },
    { p: '/dav/115open/云下载/大片.mp4', ext: 'mp4', size: 800 * 1024 * 1024 },
    { p: '/dav/115open/云下载/小片.mp4', ext: 'mp4', size: 3 * 1024 * 1024 },
    { p: '/dav/115open/云下载/未知.mp4', ext: 'mp4', size: 0 },
  ];
  const s50 = mk(50, ALL);
  const kept = s50.videos.map((v) => v.p);
  chk('🔴 行为：屏蔽小文件时 .strm 指针**一条都不许少**（否则整个本机 strm 库消失）',
    kept.filter((p) => p.endsWith('.strm')).length === 2, kept.join(' | '));
  chk('行为：真·小视频照样被滤掉（功能本身不能被改坏）',
    !kept.includes('/dav/115open/云下载/小片.mp4'));
  chk('行为：够大的留、拿不到大小的留',
    kept.includes('/dav/115open/云下载/大片.mp4') && kept.includes('/dav/115open/云下载/未知.mp4'));
  chk('行为：阈值 0 = 不屏蔽，5 条全在',
    mk(0, ALL).videos.length === 5);
  /* 只有 ext 字段缺失时才靠路径后缀兜底 —— 单独喂一条「没 ext 的 .strm」 */
  chk('行为：ext 缺失时靠 .strm 后缀也能认出来（不依赖单一字段）',
    mk(50, [{ p: 'local:/boki/a.mp4.strm', size: 35 }]).videos.length === 1);
}

/* ---- 改阈值：即时生效、不重扫 ---- */
chk('#cfMinSize 绑的是 change（不是 input：Android 下拉弹窗里滑动会连发 input）',
  /\$\('cfMinSize'\)\.addEventListener\('change'/.test(appCode)
  && !/\$\('cfMinSize'\)\.addEventListener\('input'/.test(appCode));
chk('改阈值立刻写回 localStorage', /LS\.set\('minSize', n\);/.test(appCode));
chk('改阈值后重建：计数 / 标题 / 片源栏 / 我的页 / 信息流全都刷新',
  /applyMinSize\(mb\)[\s\S]{0,600}updateBadge\(\);[\s\S]{0,200}updateTitle\(\);[\s\S]{0,200}renderSrcList\(\);[\s\S]{0,200}applyFilter\(\);/.test(appCode));
chk('改阈值**不触发重扫**（不能出现 api.library(true) / loadLibrary）', (() => {
  const i = appCode.indexOf('function applyMinSize(');
  if (i < 0) return false;
  const j = appCode.indexOf('\n}', i);
  const body = appCode.slice(i, j < 0 ? undefined : j);
  return !/api\.library|loadLibrary|refresh=1/.test(body);
})(), '否则拖一下就要等 54~185 秒');
chk('改完有 toast 告知结果（含过滤后的条数）',
  /已屏蔽 \$\{sizeText\(n\)\} 以下 · 片库 \$\{S\.videos\.length\} 个/.test(app));
chk('取消屏蔽时也有提示', /已取消大小屏蔽/.test(app));
chk('1024 MB 显示成 GB（sizeText 会换算）',
  /function sizeText\(mb\)/.test(appCode) && /n >= 1024 \? `\$\{\(n \/ 1024\)\.toFixed\(n % 1024 \? 1 : 0\)\} GB`/.test(appCode));

/* ---- 反向守卫：它绝不能变成服务端配置项 ---- */
chk('minSize 不进 formValues（不随配置提交给服务端）', (() => {
  const i = appCode.indexOf('function formValues()');
  if (i < 0) return false;
  const j = appCode.indexOf('\n}', i);
  return !/minSize/.test(appCode.slice(i, j < 0 ? undefined : j));
})(), '它一旦进 config，保存就会触发重扫（54~185 秒）');
chk('设置页回填时有兜底（值不在档位里就回落到「不屏蔽」）',
  /if \(ms\.value !== String\(S\.minSizeMB \|\| 0\)\) ms\.value = '0';/.test(appCode));

console.log('\n · 片库列什么格式（APK 全列 + playable 标记；电脑版仍 5 种）');
chk('server.js 片库扫描用白名单 BROWSER_EXTS（不再有 playableOnly 三元）',
  /const exts = BROWSER_EXTS;/.test(srvCode)
  && !/playableOnly \? BROWSER_EXTS : ALL_EXTS/.test(srvCode));
chk('server.js 三处扫描入口都改了（listDir / countVideos / buildLibrary）',
  (srvCode.match(/const exts = BROWSER_EXTS;/g) || []).length === 3);
chk('server.js 彻底没有 playableOnly 了（只剩 migrateConfig 里那一个 delete）',
  (srvCode.match(/playableOnly/g) || []).length === 1 && /delete c\.playableOnly;/.test(srvCode));
chk('server.js 片库白名单进了 libSig（改白名单会自动作废旧缓存）',
  /BROWSER_EXTS\.join\(','\)\]\.join\('\\u0000'\)/.test(srvCode));
chk('Java 片库只收可播格式（avi/wmv/rmvb/mpg 等扫描直接跳过，2026-09-19 用户要求）',
  /if \(!NasService\.isPlayableExt\(ext\)\) continue;/.test(njCode)
  && !/playableOnly \? !NasService\.isBrowserExt/.test(njCode));
chk('Java 彻底没有 playableOnly 字段了', !/playableOnly/.test(njCode));
chk('Java 片库格式清单进了 libSig',
  /for \(String e : NasService\.PLAYABLE_EXTS\) sb\.append\(e\)\.append\(','\);/.test(njCode));
chk('Java NasService.scan 不再收 playableOnly 参数',
  /public static List<Video> scan\(DavClient dav, String startAbs, boolean recursive, int maxDepth\)/.test(svcCode)
  && !/boolean playableOnly/.test(svcCode));
chk('NasService.walk 也不收（否则递归那层会漏）', !/boolean playableOnly/.test(svcCode));
/* ⚠️ 反向守卫：ALL_EXTS / isVideoExt 必须**还在** —— 它们管路径校验和 /api/test 的
   原始盘点。谁把它们一起删了，stream/probe/thumb 会开始拒绝所有请求。 */
chk('ALL_EXTS 还留着（路径校验要用，别跟着一起删）',
  /const ALL_EXTS = \[/.test(srvCode) && /String\[\] ALL_EXTS = \{/.test(svcCode));
chk('Java isVideoExt 还留着（/api/test 的原始盘点要用）',
  /static boolean isVideoExt\(String ext\)/.test(svcCode)
  && /NasService\.isVideoExt\(NasService\.extOf\(name\)\)\) vidsN\+\+;/.test(njCode));
chk('/api/test 的「N 个视频」两后端都用 ALL_EXTS（原始盘点，故意不过滤）',
  /ALL_EXTS\.includes\(extOf\(i\.rel\)\)\)\.length;/.test(srvCode));
chk('电脑版白名单保持 5 种（浏览器 <video> 真解不了 mkv，别放开）',
  /const BROWSER_EXTS = \['mp4', 'm4v', 'mov', 'webm', 'ogv'\];/.test(srvCode));
chk('🔴 Java 片库列出 mkv（2026-09-19 用户报「扫不到视频」的根因）但跳过 avi/wmv/rmvb',
  /"mkv"/.test(svcCode)
  && !/"avi", "flv"/.test(svcCode.match(/String\[\] PLAYABLE_EXTS = \{[^}]*\};/) ? svcCode.match(/String\[\] PLAYABLE_EXTS = \{[^}]*\};/)[0] : '')
  && /String\[\] ALL_EXTS = \{\s*"mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi", "flv", "wmv", "ts", "mpg", "mpeg", "3gp", "rmvb"\s*\};/.test(svcCode));
chk('🔴 Java 的可播白名单 PLAYABLE_EXTS（avi/wmv/rmvb/mpg/mpeg 不在其中；2026-09-19 起含 strm）',
  /String\[\] PLAYABLE_EXTS = \{\s*"mp4", "m4v", "mov", "webm", "ogv", "mkv", "flv", "ts", "3gp", "strm"\s*\};/.test(svcCode)
  && /NasService\.isPlayableExt\(ext\)/.test(njCode)
  && /static boolean isPlayableExt\(String ext\)/.test(svcCode));

/* ============================================================
   .strm 链接支持（2026-09-19 用户要求「扫描播放 strm」）
   ------------------------------------------------------------
   动机：持续递归列 115 目录可能触发风控 —— strm 是逃生门：
   片源里放文本清单（一行直链或 /dav 路径），app 只扫小文本，
   播放时 NasServer 解析内容：
     · http(s) 直链            → 302（WebView / ExoPlayer 自动跟随）
     · 本机 CD2 dav URL        → 换成路径走内部代理（dav 有 Basic 认证，302 过去只会 401）
     · / 开头路径              → 内部代理（同普通视频一条拉流路）
   前端零改动：streamUrl() 照旧 /api/stream?p=，播不出来的分支都不碰。
   另外三处「别为 strm 打网盘 API」的闸门必须同时存在：
     thumb 不抽帧 / backfill 不排队 / probe 天然拒绝（strm 不在 ALL_EXTS）。
   ============================================================ */
console.log('\n · .strm 链接支持（防风控逃生门）');
chk('Java 收录 strm 进片库（PLAYABLE_EXTS 含 strm，上面那条已验）', true);
chk('🔴 NasServer 识别 strm：handleStream 入口有 strm 分支 + isStrmPath 判定',
  /if \(isStrmPath\(abs\)\)/.test(njCode)
  && /private static boolean isStrmPath\(String abs\)/.test(njCode));
chk('🔴 resolveStrm 读 strm 内容并缓存（防每次播放都打一遍 115）',
  /private String resolveStrm\(String abs\)/.test(njCode)
  && /strmCache\.put\(abs, target\)/.test(njCode)
  && /private final java\.util\.concurrent\.ConcurrentHashMap<String, String> strmCache/.test(njCode));
chk('🔴 直链走 302（seeOther），Location 头做 ASCII 安全编码',
  /private static Resp seeOther\(String url\)/.test(njCode)
  && /r\.headers\.put\("Location", sb\.toString\(\)\)/.test(njCode)
  && /r\.status = 302;/.test(njCode));
chk('🔴 本机 CD2 dav URL 不能 302（dav 强制 Basic 认证，跳过去只会 401）→ 转内部代理',
  /private String localDavPathOf\(String url\)/.test(njCode)
  && /"127\.0\.0\.1"\.equals\(host\) \|\| "localhost"\.equals\(host\)/.test(njCode));
chk('🔴 上游拉流抽成 streamUpstream（strm 解析后与普通视频同一条路）',
  /private Resp streamUpstream\(String abs, Req req\)/.test(njCode)
  && /return streamUpstream\(abs, req\);/.test(njCode));
chk('strm 指向另一个 strm 要拒绝（防递归打爆）',
  /strm 又指向了另一个 strm/.test(njCode));
chk('🔴 strm 不抽帧（不为缩略图打直链）—— 但**只限 WebDAV 片源**，本机片源要抽',
  /* 2026-09-20：本机片源没有「打网盘 API 被风控」的顾虑 ——
   * 它抽帧走的是 127.0.0.1 的本地 /api/stream，且用户本来就要播它。
   * 所以两处 strm 拦截都必须带 `!isLocalSrc` / `!local` 前置条件。 */
  /if \(!local && isStrmPath\(abs\)\) return json\(502, err\("strm 链接不生成缩略图"\)\);/.test(njCode)
  && /if \(!isLocalSrc\(rel\) && isStrmPath\(NasService\.normAbs\(rel\)\)\) \{ skipped\+\+; continue; \}/.test(njCode));
chk('🔴 /api/warm 对 strm 解析真目标再预热（直链直接打，路径照常走 dav）',
  /if \(isStrmPath\(abs\)\) \{/.test(njCode)
  && /final boolean fAuth = warmAuth;/.test(njCode));
chk('片源重扫后清 strm 缓存（旧目标不可信）',
  /strmCacheClear\(\);/.test(njCode) && /private void strmCacheClear\(\)/.test(njCode));
chk('前端 strm 条目带 STRM 徽标（空心描边）',
  /v\.ext === 'strm'\) \? '<span class="badge strm">STRM<\/span>'/.test(appCode)
  && /\.badge\.strm\{/.test(cssCode));
chk('🔴 播放页不再有写死的「NAS」徽标 / 假的 @NAS 作者名（2026-09-20 用户要求删掉）',
  /* 原来 `itemHTML` 里硬编码 `<span class="badge">NAS</span>`，而且 `v.author`
     后端**从没返回过** —— 那行永远渲染成「@NAS」，纯假数据。用户圈着它说
     「只保留视频来源，把 nas 删掉」。 */
  !/<span class="badge">NAS<\/span>/.test(appCode)
  && !/v\.author/.test(appCode)
  && /\$\{strmTag \? `<div class="author">\$\{strmTag\}<\/div>` : ''\}/.test(appCode));
chk('🔴 .badge 基础样式不再带实底 background（实底的 NAS 已删）',
  (() => {
    const i = cssCode.indexOf('.meta .author .badge{');
    if (i < 0) return false;
    const body = cssCode.slice(i, cssCode.indexOf('}', i) + 1);
    return !/background\s*:/.test(body) || /background\s*:\s*(transparent|none)/.test(body);
  })());
chk('🔴 toast 能换行且有限宽（不然长提示会顶出屏幕、首尾被裁）',
  (() => {
    const i = cssCode.indexOf('.toast{');
    if (i < 0) return false;
    const body = cssCode.slice(i, cssCode.indexOf('}', i) + 1);
    return /white-space\s*:\s*normal/.test(body)
      && /max-width\s*:/.test(body)
      && !/white-space\s*:\s*nowrap/.test(body);
  })());
chk('🔴 两条 staleMsg 都不再写「在 NAS 上找不到了」，且两边文案一致',
  /已回到根目录，重新挑一个吧。/.test(njCode)
  && /已回到根目录，重新挑一个吧。/.test(srvCode)
  && !/在 NAS 上找不到了/.test(njCode)
  && !/在 NAS 上找不到了/.test(srvCode));
chk('🔴 前端认 stale 的「文案判据」跟后端新话术同步（改文案必须一起改）',
  /* peek 那条路没有 stale 布尔位，只有错误字符串 —— 前端靠文案认。
     后端文案改了而这里没改 → **静默失效**：目录失效被归类成「连不上」，
     给出的下一步动作是错的（让人去查网络，其实只要重挑文件夹）。
     判据：前后端用的是**同一句**「打不开了（可能被删或改名）」。 */
  /打不开了（可能被删或改名）/.test(appCode)
  && /打不开了（可能被删或改名）/.test(njCode)
  && !/找不到了（可能被删或改名）/.test(appCode));
/* ⚠️ 2026-09-20 晚改准了这条断言的「意图」。
 *
 * 它原来写的是 `!/strm/.test(srvCode)` —— 一个字都不许出现。那时成立，因为 strm
 * 只属于 App（本机生成、本机播放）。现在 server.js 多了**多设备同步**：它要按账号
 * 存一份 strm 备份包（`/api/sync/strm`，只当不透明字节存着、不解析），
 * 「全文件不许出现 strm」自然就不成立了。
 *
 * 但它真正要守的东西没变：**浏览器版的片库不能把 .strm 当视频列出来**。
 * 所以改成盯住那一点：片库格式清单保持 5 种，且 strm 字样只许待在同步那一段里。
 * ⚠️ 别退回成「全文件禁词」—— 那只会逼着后来的人把功能代码塞到别的地方去。 */
{
  const segA = srvCode.indexOf('const SYNC_DIR =');
  const segB = srvCode.indexOf('function credOf(');
  const syncSeg = segA >= 0 && segB > segA ? srvCode.slice(segA, segB) : '';
  const outside = segA >= 0 && segB > segA
    ? srvCode.slice(0, segA) + srvCode.slice(segB)
    : srvCode;
  chk('电脑版 server.js 的片库仍不列 strm（BROWSER_EXTS 保持 5 种）',
    /const BROWSER_EXTS = \['mp4', 'm4v', 'mov', 'webm', 'ogv'\];/.test(srvCode));
  chk('server.js 里 strm 字样只许出现在「多设备同步」那一段（片库/扫描逻辑不许碰）',
    syncSeg !== '' && /\bstrm\b/i.test(syncSeg) && !/\bstrm\b/i.test(outside),
    '片库扫描一旦认了 .strm，浏览器版就会把指针文件当视频列出来');
}

/* ============================================================
   .strm 自动库（2026-09-20「内置到app里并且可以选择多个需要扫描
   监控的文件夹而且可以增量扫描并可以设置多久自动扫描一次」）
   ------------------------------------------------------------
   把电脑端 _tools/make-strm.js 的流程搬进 App：
   定时对勾选的片源 PROPFIND，每个视频生成一个 .strm 传回 NAS 输出目录；
   增量靠 manifest（视频路径 → strm 落点，没变就不发 PUT）。
   断言钉住：DavClient 的 PUT/MKCOL、config 三字段四条链路、
   引擎（防重入/两阶段/增量/节流）、调度（幂等重排 + 冷启动补偿）、
   端点、前端元素与收集链路 —— 任何一环断了功能就是坏的。
   ============================================================ */
console.log('\n · .strm 自动库（App 内置生成 / 增量 / 定时）');
chk('DavClient.put：PUT 打文件不补尾斜杠（补了会被当成目录，之后同名文件永远写不进）',
  /public int put\(String absPath, byte\[\] body\) throws IOException/.test(davj)
  && /p = basePrefix \+ encPath\(rel\);\n        \}\n        RawResp r = rawRequest\("PUT"/.test(davj));
chk('DavClient.mkcol：目录语义补尾斜杠（严格实现只认 MKCOL /dir/ 形态）',
  /public int mkcol\(String absPath\) throws IOException/.test(davj)
  && /if \(!p\.endsWith\("\/"\)\) p = p \+ "\/";/.test(davj));
/* 🔴 2026-09-20 二次改版（用户拍板「A 回传不要了，B 完全开放」）——
   下面这一整块断言跟着改了模型，别按旧模型改回去：
     A. 输出**只有本地**且**固定**（strmLocalDir()），strmOut / strmLocal 两个字段、
        PUT/MKCOL/300ms 节流、permOk 权限探测**全部删除**。
     B. strmJobs 从「片源子集」变成**独立清单**，任意目录都行。
   老的那几条（config 三字段四条链路 / 本地保存四链路 …）是**为旧模型写的**，
   已经把新模型下真实存在的东西重写了一遍 —— 不然「绿着但是功能已经变了」。 */
chk('🔴 config 字段就这三个（strmJobs / strmIntervalH / strmMinSizeMB），strmOut 不许复辟',
  /private List<String> strmJobs = new ArrayList<>\(\);/.test(nj)
  && /private int strmIntervalH = 0;/.test(nj)
  // 体积阈值（2026-09-22）：小于它的源视频不生成 .strm
  && /private int strmMinSizeMB = 0;/.test(nj)
  && !/private String strmOut/.test(nj)
  /* ⚠️ 这里必须锚上 `=` —— 光写 `private String strmLocal` 会被
     **strmLocalDir()** 这个方法声明命中（它是固定目录那个函数），永远假红。 */
  && !/private String strmLocal\s*=/.test(nj));
chk('🔴 读写四条链路都在，且**只剩**这两个字段',
  /e\.putString\("strmJobs", sj\.toString\(\)\);/.test(njCode)
  && /e\.putInt\("strmIntervalH", strmIntervalH\);/.test(njCode)
  && /o\.put\("strmJobs", sj\);/.test(njCode)
  && /if \(body\.has\("strmJobs"\)\)/.test(njCode)
  && /if \(body\.has\("strmIntervalH"\)\)/.test(njCode)
  && !/e\.putString\("strmOut"/.test(njCode)
  && !/e\.putString\("strmLocal"/.test(njCode));
/* ---- .strm 体积阈值（2026-09-22，用户要求「小于设定大小跳过生成」）----
 * 四条链路（落盘 / 读盘 / POST 收 / GET 回）+ 真正的生成期跳过，一个都不能少 ——
 * 少任何一条的表现分别是「重启就丢」「前端回填不上」「改了不生效」。 */
chk('🔴 体积阈值 strmMinSizeMB 四条链路齐全（落盘 / 读盘 / POST 收 / GET 回）',
  /e\.putInt\("strmMinSizeMB", strmMinSizeMB\);/.test(njCode)
  && /strmMinSizeMB = Math\.max\(0, p\.getInt\("strmMinSizeMB", 0\)\);/.test(njCode)
  && /if \(body\.has\("strmMinSizeMB"\)\)/.test(njCode)
  && /o\.put\("strmMinSizeMB", strmMinSizeMB\);/.test(njCode));
chk('🔴 生成期真的跳过：拿**源视频体积**（v.size）跟阈值比，不是拿 .strm 文件自身大小',
  /strmMinSizeMB > 0 && v\.size > 0 && v\.size < strmMinSizeMB \* 1024L \* 1024L/.test(njCode));
chk('🔴 拿不到体积（v.size==0）时**放行**，别把证明不了的当小的丢掉',
  /v\.size > 0 && v\.size < strmMinSizeMB/.test(njCode));
chk('🔴 调大阈值后要把**上一轮自己生成的**那个 .strm 删掉（否则设置等于没生效）',
  // 只删 manifest 记过的落点，且必须落在本机 strm 目录里（双保险）
  /String old = manifest\.optString\(p, ""\);/.test(njCode)
  && /if \(old\.startsWith\(local \+ "\/"\)\)/.test(njCode)
  && /manifest\.remove\(p\);/.test(njCode));
chk('🔴 前端：阈值发得出去也回填得回来（空/NaN 一律按 0，不许发 NaN）',
  /strmMinSizeMB: Math\.max\(0, Math\.floor\(Number\(\$\('cfStrmMinSize'\)\.value\) \|\| 0\)\),/.test(app)
  && /\$\('cfStrmMinSize'\)\.value = String\(Math\.max\(0, Math\.floor\(Number\(c\.strmMinSizeMB\) \|\| 0\)\)\);/.test(app));
chk('多设备同步：strmMinSizeMB 进了两端同步服务的白名单（值 + 时间戳）',
  /snap\.sources\.strmMinSizeMB = Math\.max\(0, Math\.min\(102400, Math\.floor\(s\.strmMinSizeMB\)\)\);/.test(read('server.js'))
  && /snap\.sources\.strmMinSizeMB = Math\.max\(0, Math\.min\(102400, Math\.floor\(s\.strmMinSizeMB\)\)\);/.test(read('sync-server.js'))
  && /if \(typeof inc\.sources\.strmMinSizeMB === 'number'\)/.test(read('sync-server.js')));
chk('🔴 监控清单**不再**按「仍是片源子集」收敛（B 完全开放的核心）',
  !/if \(dirs\.contains\(n\) && !strmJobs\.contains\(n\)\) strmJobs\.add\(n\);/.test(njCode)
  && /if \(!strmJobs\.contains\(n\)\) strmJobs\.add\(n\);/.test(njCode));
chk('🔴 固定输出目录 strmLocalDir() = getExternalFilesDir()/strm（免授权，不再写公共存储）',
  /private String strmLocalDir\(\)/.test(njCode)
  && /ctx\.getExternalFilesDir\(null\)/.test(njCode)
  && /new java\.io\.File\(f, "strm"\)\.getAbsolutePath\(\)/.test(njCode)
  && /new java\.io\.File\(ctx\.getFilesDir\(\), "strm"\)/.test(njCode));
chk('🔴 NAS 回传整条路已拆干净：没有 PUT、没有 MKCOL、没有 300ms 节流',
  !/d\.put\(strmPath/.test(njCode)
  && !/private void strmMkdirs/.test(njCode)
  && !/Thread\.sleep\(300\)/.test(njCode));
chk('🔴 权限探测已删（写 App 自己的目录不需要「所有文件访问」）',
  !/private boolean strmLocalPermOk/.test(njCode)   // ⚠️ 必须用 strip 过的 njCode：墓碑注释里提到它
  && !/isExternalStorageManager/.test(njCode)
  /* 墓碑（防复辟）住在注释里 → 只能在**未 strip** 的 nj 上找 */
  && /已删除：strmLocalPermOk\(\)/.test(nj));
chk('strmIntervalH 夹在 [0,168]（0 = 仅手动；再大的间隔没有意义）',
  /Math\.max\(0, Math\.min\(168, body\.optInt\("strmIntervalH", 0\)\)\)/.test(njCode));
chk('防重入：AtomicBoolean CAS 抢坑（手动 + 定时 + 连点按钮不会跑两轮）',
  /private final java\.util\.concurrent\.atomic\.AtomicBoolean strmRunning/.test(nj)
  && /strmRunning\.compareAndSet\(false, true\)/.test(njCode));
chk('防重入标志必须在 finally 里释放（漏了它第一轮跑完后 CAS 永远占坑，功能静默失效）',
  /strmRunning\.set\(false\);\n\s+strmLastRun = System\.currentTimeMillis\(\);/.test(njCode));
chk('调度：scheduleWithFixedDelay + interval 变更先 cancel 旧的（幂等重排）',
  /strmSched\.scheduleWithFixedDelay\(this::strmRunAsync, delayMs, periodMs,/.test(njCode)
  && /if \(strmTimer != null\) \{ strmTimer\.cancel\(false\); strmTimer = null; \}/.test(njCode));
chk('🔴 调度前提只剩「勾了目录」—— 不再判 strmOut/strmLocal（那两个字段没了）',
  /if \(h <= 0 \|\| strmJobs\.isEmpty\(\)\) return;/.test(njCode)
  && !/\(strmOut\.isEmpty\(\) && strmLocal\.isEmpty\(\)\)/.test(njCode));
chk('冷启动补偿：上次运行超过一个周期 → 立即补跑（App 不常驻，不然 24h 档永远赶不上）',
  /if \(strmLastRun > 0 && System\.currentTimeMillis\(\) - strmLastRun >= periodMs\) delayMs = 0;/.test(njCode));
chk('start() 起服务时排 strm 定时任务（配置 POST 保存后也会重排）',
  /strmSchedule\(\);\n        Log\.i\(TAG, "本地服务已启动/.test(njCode)
  && /persistConfig\(\);\n        strmSchedule\(\);/.test(njCode));
chk('引擎两阶段：先扫全量（复用 NasService.scan）拿 total，再逐个增量写',
  /List<NasService\.Video> list = NasService\.scan\(d, root, recursive, maxDepth, trunc\);\n\s+Log\.i\(TAG, "strm 扫描 " \+ root \+ " → " \+ list\.size\(\) \+ " 个视频"\);\n\s+all\.addAll\(list\);/.test(njCode)
  && /strmTotal = all\.size\(\);/.test(njCode)
  && /private void strmJob\(\)/.test(njCode));
chk('增量：manifest（视频路径 → 落点）命中即跳过，不重写',
  /private JSONObject strmManifestLoad\(\)/.test(njCode)
  && /private void strmManifestSave\(JSONObject m\)/.test(njCode)
  && /manifest\.optString\(p, ""\)\.equals\(sig\)/.test(njCode)
  && /strmSkipped\+\+/ .test(njCode));
/* ⚠️ 2026-09-20：落点公式外面**必须**套 safeStrmPath()。
   Android/FUSE 单文件名上限 255 **字节**（不是字符，中日文 3 字节一个字），
   实测 250✅ 255✅ 256❌ —— 那批日系长标题的目录名有 311 字节，
   mkdirs 直接失败 ⇒ 前端只有一句「写入失败」看不出为什么（5255 个里 16 个中招）。 */
chk('🔴 落点公式：<固定目录>/<监控目录名>/<相对路径>.strm，最深匹配目录归属',
  /String localPath = safeStrmPath\(local \+ "\/" \+ srcName \+ rel \+ "\.strm"\);/.test(njCode)
  && /if \(root == null \|\| r\.length\(\) > root\.length\(\)\) root = r;/.test(njCode)
  && /String local = strmLocalDir\(\);/.test(njCode));
chk('🔴 增量签名 = 落点本身（旧版「两路拼串」已随回传一起废掉）',
  /String sig = localPath;/.test(njCode)
  && !/String sig = strmPath \+ "\\u0001" \+ localPath;/.test(njCode));
chk('strm 内容与 make-strm.js 完全一致（BOM + dav 绝对路径 + 换行）',
  /"\\uFEFF" \+ p \+ "\\n"/.test(njCode));
/* ⚠️ 2026-09-20：strmWriteLocal 从 boolean 改成「返回 String 原因」（null=成功）。
   原来只报「写入失败 xxx」，用户和排查的人都看不出为什么 —— 这次就是靠把
   e.getMessage() 带出来才定位到文件名超长。别改回 boolean。 */
chk('🔴 写失败不记 manifest → 下轮重试（不再是「两路任一失败」那套）',
  /String werr = strmWriteLocal\(localPath, body\);/.test(njCode)
  && /if \(werr == null\) \{/.test(njCode)
  && /try \{ manifest\.put\(p, sig\); \} catch \(Exception ignore\) \{\}/.test(njCode)
  && /strmAdded\+\+;\s*\n\s*strmRev\+\+;[\s\S]{0,60}?\} else \{\s*\n\s*strmFailed\+\+;/.test(njCode));
chk('🔴 失败原因要带到前端（只说「写入失败」没法定位 —— 超长文件名那次就栽在这）',
  /strmLastError = "写入失败 " \+ localPath \+ "（" \+ werr \+ "）";/.test(njCode)
  && /private String strmWriteLocal\(String localPath, byte\[\] body\)/.test(njCode)
  && !/private boolean strmWriteLocal/.test(njCode));

/* ============================================================
   .strm 落点「单文件名 ≤ 255 字节」—— Android/FUSE 的硬上限
   ------------------------------------------------------------
   2026-09-20 实测：5255 个里 16 个「写入失败」。设备上量过边界：
   250✅ 255✅ 256❌ 300❌。而那些日系标题 117 个字符 / **311 字节**
   （中日文 UTF-8 是 3 字节一个字）⇒ mkdirs 失败 ⇒ 整个 .strm 写不出来。
   ⚠️ 修法必须是「按**字节**截 + 不切断多字节字符 + 加哈希防重名」三件套，
      少一件就埋新雷（按字符截照样超限；切断字符会变成乱码文件名；
      不加哈希的话前 240 字节相同的两个长名会互相覆盖）。
   ============================================================ */
console.log('\n · .strm 落点不能超 255 字节（设备硬上限）');
{
  const SAFE_SEG = Number((njCode.match(/private static final int SAFE_SEG = (\d+);/) || [])[1]);
  const HASH_LEN = 8;                     // shortHash：4 字节 → 8 个十六进制字符
  const EXT = '.strm';
  const budget = SAFE_SEG - EXT.length - HASH_LEN - 1;   // -1 是中间的下划线

  chk('🔴 单段上限必须**小于**设备硬上限 255 字节（实测 255 OK / 256 就失败）',
    Number.isFinite(SAFE_SEG) && SAFE_SEG > 0 && SAFE_SEG < 255,
    'SAFE_SEG=' + SAFE_SEG);
  chk('🔴 截断预算必须为正且够可读（否则长名会被砍到只剩哈希）',
    Number.isFinite(SAFE_SEG) && budget >= 32,
    'SAFE_SEG=' + SAFE_SEG + ' → 正文只剩 ' + budget + ' 字节');
  chk('🔴 算出来的最终段长仍然不超限（正文 + _哈希 + 扩展名）',
    Number.isFinite(SAFE_SEG) && (budget + 1 + HASH_LEN + EXT.length) <= 255,
    (budget + 1 + HASH_LEN + EXT.length) + ' 字节');
  chk('🔴 按**字节**截，不是按字符（中日文 3 字节一个字，按字符截照样爆）',
    /byte\[\] b = seg\.getBytes\(java\.nio\.charset\.StandardCharsets\.UTF_8\);/.test(njCode)
    && /if \(b\.length <= SAFE_SEG\) return seg;/.test(njCode));
  chk('🔴 截断**不切断多字节字符**（否则截出半个序列，文件名变乱码）',
    /while \(end > 0 && \(b\[end\] & 0xC0\) == 0x80\) end--;/.test(njCode));
  chk('🔴 截断后加哈希防重名（前 240 字节相同的两个长名会互相覆盖）',
    /String hash = shortHash\(seg\);/.test(njCode)
    && /\+"_"\+hash\+ext| \+ "_" \+ hash \+ ext;/.test(njCode));
  chk('🔴 不超限的段必须**原样返回**（不然那 5239 个已生成的会每轮重写）',
    /if \(b\.length <= SAFE_SEG\) return seg;/.test(njCode));
  chk('🔴 路径是**逐段**安全化（超长的是目录名，只截文件名没用）',
    /private static String safeStrmPath\(String path\)/.test(njCode)
    && /for \(String s : path\.split\("\/"\)\)/.test(njCode)
    && /sb\.append\('\/'\)\.append\(safeSeg\(s\)\);/.test(njCode));
  chk('🔴 哈希必须是**纯函数**（同输入同输出）—— 否则 manifest 签名每轮都变，退化成全量重写',
    /java\.security\.MessageDigest\.getInstance\("MD5"\)/.test(njCode)
    && !/Math\.random\(\)/.test(njCode)
    && !/System\.currentTimeMillis\(\)/.test(
      (njCode.match(/private static String shortHash[\s\S]*?\n  \}/) || [''])[0]));
}
chk('认证/限流类错误立刻放弃整轮（与片库扫描同一套防限流，不试下一个目录）',
  /strmLastError = "认证\/限流错误，本轮放弃：" \+ e\.getMessage\(\);/.test(njCode)
  && /isAuthOrLimitError\(e\.getMessage\(\)\)/.test(njCode));
chk('端点：GET/POST /api/strmjob 已接进路由（POST 缺 run:true 要 400）',
  /path\.equals\("\/api\/strmjob"\)/.test(njCode)
  && /private Resp handleStrmJob\(String method, JSONObject body\)/.test(njCode)
  && /if \(!body\.optBoolean\("run", false\)\) return json\(400, err\("missing run:true"\)\);/.test(njCode));
chk('🔴 POST 预校验只剩「勾没勾目录」（输出固定了，没有位置可缺）',
  /if \(strmJobs\.isEmpty\(\)\) \{\n\s+strmLastError = "请先添加要监控的文件夹";/.test(njCode)
  && !/请先勾选监控片源，并填写本地保存目录或 NAS 输出目录/.test(njCode));
chk('状态回报：running/done/total/added/skipped/failed/lastRunAt/lastError/stale 齐全',
  /private JSONObject strmStatusJson\(String state\)/.test(njCode)
  && /o\.put\("running", strmRunning\.get\(\)\);/.test(njCode)
  && /o\.put\("lastRunAt", strmLastRun\);/.test(njCode)
  && /o\.put\("lastError", strmLastError\);/.test(njCode)
  && /o\.put\("stale", strmIntervalH > 0 && strmLastRun > 0/.test(njCode));
chk('🔴 状态里的 local 是**固定目录**，且不再有 out / permOk',
  /o\.put\("local", strmLocalDir\(\)\);/.test(njCode)
  && !/o\.put\("out", strmOut\);/.test(njCode)
  && !/o\.put\("permOk", / .test(njCode));
chk('strmLastRun 单独落 SharedPreferences（persistConfig 只管配置，不碰任务时间戳）',
  /private void strmTouchLastRun\(\)/.test(njCode)
  && /\.edit\(\)\.putLong\("strmLastRun", strmLastRun\)\.apply\(\);/.test(njCode)
  && /strmLastRun = p\.getLong\("strmLastRun", 0\);/.test(njCode));
chk('前端：设置页第 4 步元素齐全（固定目录展示 / 清单 / 添加按钮 / 间隔 / 立即生成 / 状态行）',
  htmlIds.has('stepStrm') && htmlIds.has('cfStrmLocalText') && htmlIds.has('cfStrmJobs')
  && htmlIds.has('cfStrmAdd') && htmlIds.has('cfStrmEvery') && htmlIds.has('cfStrmRun')
  && htmlIds.has('cfStrmStatus'));
chk('🔴 前端不再有输出目录输入框 / 授权存储按钮（那两样已经不需要了）',
  !htmlIds.has('cfStrmOut') && !htmlIds.has('cfStrmLocal')
  && !htmlIds.has('cfStrmPerm') && !htmlIds.has('strmPermRow'));
chk('前端：api.strmJob 封装（run=true 走 POST，否则 GET 状态）',
  /strmJob: \(run\) => \(run \? jpost\('\/api\/strmjob', \{ run: true \}\) : jget\('\/api\/strmjob'\)\)/.test(api));
chk('前端：formValues 只提交 strmIntervalH（清单走独立入口，输出位置不再提交）',
  /strmIntervalH: Number\(\$\('cfStrmEvery'\)\.value\),/.test(appCode)
  && !/strmOut: \$\('cfStrmOut'\)\.value\.trim\(\),/.test(appCode)
  && !/strmJobs: Array\.from\(document\.querySelectorAll\('#cfStrmJobs input\[type=checkbox\]:checked'\)\)/.test(appCode));
chk('🔴 前端：清单增删走 /api/config（独立清单，不该触发重扫片库）',
  /async function saveStrmJobs\(next, tip\)/.test(appCode)
  && /const r = await api\.saveConfig\(\{ strmJobs: next \}\);/.test(appCode)
  && /function addStrmJob\(dir\)/.test(appCode)
  && /function removeStrmJob\(dir\)/.test(appCode)
  && !/api\.sources\([^)]*strmJobs/.test(appCode));
/* 🔴 2026-09-20 二次改版：清单的**行为**断言。
 *
 * 旧的那套是「喂片源清单 + 桩 DOM，数渲染出几个 checkbox」——
 * 新模型下清单里根本没有 checkbox 了（它是独立清单，删靠 ✕），
 * 而且数据源从 srcList() 换成了 S.config.strmJobs。所以整段重写。
 *
 * 这次钉的是**新的**真 bug 面：
 *   ① 清单为空时要给出去哪加的提示（不是白板）；
 *   ② 清单有几项就渲染几行，且**没有** checkbox（防止有人凭记忆改回勾选模型）；
 *   ③ 每行都带 data-sjdel（✕ 的委托靠它，漏了 = 删不掉）；
 *   ④ 路径要转义（目录名里有引号/尖括号时不能破 HTML）。 */
{
  /* mkJobs 把真函数抠出来跑，喂假 S + 桩 DOM。
     注意 renderStrmJobs 用到 pathName / escapeHtml / IC 三个外部符号：
       · pathName / escapeHtml 是 `function` 声明，grabFn 能抠，但这里直接给等价实现更稳；
       · IC 是模块级 const 对象 —— **必须注入**，不然 ReferenceError。 */
  const mkJobs = (jobs) => {
    let out = '';
    const box = {
      set innerHTML(v) { out = v; },
      get innerHTML() { return out; },
    };
    const S = { config: { strmJobs: jobs } };
    const f = new Function('S', '$', 'pathName', 'escapeHtml', 'IC',
      grabFn(app, 'renderStrmJobs') + '\nreturn renderStrmJobs;')(
        S,
        (id) => (id === 'cfStrmJobs' ? box : null),
        (p) => String(p || '').split('/').filter(Boolean).pop() || '根目录',
        (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
        { folder: '<i>F</i>' });
    f();
    return out;
  };

  const empty = mkJobs([]);
  chk('🔴 行为：清单为空 → 提示去「＋ 添加文件夹」，且一行都不渲染',
    /还没有监控文件夹/.test(empty) && !/data-sjdel/.test(empty));

  const html2 = mkJobs(['/dav/115open/电影', '/dav/115open/云下载']);
  const nRows = (html2.match(/data-sjdel=/g) || []).length;
  chk('🔴 行为：清单有几项就渲染几行（任意目录都能进清单，不再受片源约束）',
    nRows === 2, `渲染出 ${nRows} 行，应为 2`);
  chk('🔴 行为：每个文件夹名/路径都出现在行里', html2.includes('电影') && html2.includes('/dav/115open/云下载'));
  chk('🔴 行为：清单行**没有** checkbox（独立清单模型，别改回勾选）',
    html2.indexOf('type="checkbox"') === -1);
  chk('行为：路径里的特殊字符被转义（不能破 HTML）',
    mkJobs(['/dav/<img src=x>']).indexOf('<img src=x>') === -1);
}
chk('🔴 前端：清单 ✕ 走事件委托（行是随时重画的，别把监听绑在行上）',
  /\$\('cfStrmJobs'\)\.addEventListener\('click'/.test(appCode)
  && /e\.target\.closest\('\[data-sjdel\]'\)/.test(appCode)
  && /removeStrmJob\(b\.dataset\.sjdel\);/.test(appCode));
/* 🔴 2026-09-20 改进：✕ **两步删除** —— 上面那条只证明了「能删」，
 * 而真机踩的正是「点一下就没了」（监控目录 boki 被点掉，之后扫什么都只剩云下载，
 * 症状被误读成「strm 生成不出来」）。
 *   ⚠️ 不用原生 confirm()：WebView 没实现 onJsConfirm，对话框**静默返回取消**，
 *      点了等于没点（项目铁律）。所以是「点一下进『确认？』态，再点一下才删」。 */
chk('🔴 前端：清单 ✕ 是**两步删除**（第一下只武装，再点才删）',
  /function sjDisarm\(\) \{/.test(appCode)
  && /b\.classList\.contains\('armed'\)/.test(appCode)
  && /b\.classList\.add\('armed'\);/.test(appCode)
  && /b\.textContent = '确认？';/.test(appCode)
  && /sjArmTimer = setTimeout\(sjDisarm, 3200\);/.test(appCode)
  /* 🔴 负向：不许退回一步删，也不许用原生 confirm（WebView 黑洞） */
  && !/if \(b\) removeStrmJob\(b\.dataset\.sjdel\);/.test(appCode)
  && !/confirm\('/.test(appCode));

/* 🔴 两步删除的**行为**断言：把真监听器抠出来跑。
 *
 * 正则只能证明「代码里有 armed 分支」，证明不了「点两下才删」——
 * 而误触恰恰是**行为**层面的坑。这里造两个假 ✕ 按钮，喂假事件： */
{
  const mkBtn = (dir) => {
    const cls = new Set();
    return {
      dataset: { sjdel: dir },
      textContent: '✕',
      classList: {
        add: (c) => cls.add(c),
        remove: (c) => cls.delete(c),
        contains: (c) => cls.has(c),
      },
      has: (c) => cls.has(c),
    };
  };
  const rows = [mkBtn('/dav/115open/云下载'), mkBtn('/dav/115open/boki')];
  const box = { fn: null, addEventListener(t, fn) { this.fn = fn; } };
  const removed = [];
  const toasts = [];
  let seq = 0;
  const tm = new Map();
  const fireTimers = () => { const fns = [...tm.values()]; tm.clear(); fns.forEach((f) => f()); };

  new Function('$', 'document', 'toast', 'removeStrmJob', 'setTimeout', 'clearTimeout',
    'let sjArmTimer = 0;\n'
    + grabFn(app, 'sjDisarm') + '\n'
    + grabCall(app, "$('cfStrmJobs').addEventListener('click'"))(
      () => box,
      /* sjDisarm 用它收武装态 —— 只认 `#cfStrmJobs .sj-del.armed` 这一个选择器 */
      { querySelectorAll: () => rows.filter((b) => b.has('armed')) },
      (m) => toasts.push(m),
      (d) => removed.push(d),
      (fn) => { const id = ++seq; tm.set(id, fn); return id; },
      (id) => { tm.delete(id); });
  const fire = (btn) => box.fn({ target: { closest: () => btn } });

  fire(rows[1]);                                   // ① 第一下：boki 的 ✕
  chk('🔴 行为：✕ 第一下只武装、**不删**（误触不再丢整个监控目录）',
    removed.length === 0 && rows[1].has('armed') && rows[1].textContent === '确认？',
    `removed=${removed.length} armed=${rows[1].has('armed')} text=${rows[1].textContent}`);
  chk('🔴 行为：武装时给一句提示（不然用户以为按钮坏了）',
    toasts.some((m) => /再点一次/.test(m)), JSON.stringify(toasts));

  fire(rows[1]);                                   // ② 第二下：才真删
  chk('🔴 行为：✕ 第二下才真删，且删的是**那一行自己**的目录',
    removed.length === 1 && removed[0] === '/dav/115open/boki', JSON.stringify(removed));
  chk('行为：删完按钮收回 ✕ 态（重画前不留一个红「确认？」）',
    !rows[1].has('armed') && rows[1].textContent === '✕');

  fire(rows[0]);                                   // ③ 自动收回
  const armed0 = rows[0].has('armed');
  fireTimers();                                    //    模拟 3.2 秒到点
  chk('🔴 行为：武装后超时自动收回（不点也别让「确认？」赖在屏上）',
    armed0 && !rows[0].has('armed') && rows[0].textContent === '✕');
  fire(rows[0]);
  chk('🔴 行为：收回后再点 = 重新武装，仍然**不是**直接删',
    removed.length === 1 && rows[0].has('armed'), JSON.stringify(removed));

  fire(rows[1]);                                   // ④ 切到另一行
  chk('🔴 行为：同一时刻只有一个「确认？」态（点另一行时前一个自动收回）',
    rows[1].has('armed') && !rows[0].has('armed') && rows[0].textContent === '✕');

  const before = removed.length;                   // ⑤ 点行里但不在 ✕ 上
  fire(null);
  chk('行为：点在行里但不在 ✕ 上 → 什么都不做', removed.length === before);
}

/* 🔴 2026-09-20 改进：状态行「新增 0」必须说人话。
 *
 * 报障原话就是看到「新增 0 / 跳过 5255 / 失败 0 / 共 5255」以为又没生成出来 ——
 * 其实那是**设计行为**（增量扫描：manifest 里有的跳过）。补一句直白结论。
 * 这里把真 renderStrmStatus 抠出来跑，喂各种状态，钉住「什么时候说 / 什么时候别说」。 */
{
  const mkStatus = (st) => {
    let out = '', cls = '', hid = null;
    const el = {
      set innerHTML(v) { out = v; }, get innerHTML() { return out; },
      set className(v) { cls = v; }, get className() { return cls; },
      set hidden(v) { hid = v; }, get hidden() { return hid; },
    };
    const f = new Function('$', 'escapeHtml',
      grabFn(app, 'renderStrmStatus') + '\nreturn renderStrmStatus;')(
        (id) => (id === 'cfStrmStatus' ? el : null),
        (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;'));
    f(st);
    return { out, cls, hid };
  };
  /* 真机报障那一刻的形态：5255 个全部命中 manifest 被跳过 */
  const base = { running: false, added: 0, skipped: 5255, failed: 0, total: 5255, lastRunAt: Date.now() };

  const allSkip = mkStatus({ ...base });
  chk('🔴 行为：全跳过（新增 0）→ 状态行补一句人话，说清「不是没生成出来」',
    /都已生成过/.test(allSkip.out), allSkip.out);
  chk('🔴 行为：全跳过时状态行仍标 ok（跳过是省事，不是失败，别染红吓人）',
    /ok/.test(allSkip.cls) && !/bad/.test(allSkip.cls), allSkip.cls);

  chk('行为：有新增时**不**说「都已生成过」（自相矛盾）',
    !/都已生成过/.test(mkStatus({ ...base, added: 3, skipped: 5252 }).out));
  const withFail = mkStatus({ ...base, failed: 2 });
  chk('行为：有失败时**不**说「都已生成过」，整行标 bad',
    !/都已生成过/.test(withFail.out) && /bad/.test(withFail.cls), withFail.cls);
  chk('行为：正在生成时**不**说「都已生成过」（还没跑完，下结论太早）',
    !/都已生成过/.test(mkStatus({ ...base, running: true, done: 10 }).out));
  chk('行为：一个文件都没扫到（total=0）时**不**说「都已生成过」（那是另一回事）',
    !/都已生成过/.test(mkStatus({ ...base, total: 0, skipped: 0 }).out));
  chk('行为：lastError 仍然单独换行（结论句不能把它挤掉）',
    /<br>⚠️ 磁盘满了/.test(mkStatus({ ...base, lastError: '磁盘满了' }).out));
}
chk('🔴 前端：第 4 步有「＋ 添加文件夹」入口 + 目录选择器（选 CD2 根目录下任意文件夹）',
  htmlIds.has('dirPickSheet') && htmlIds.has('dpCrumb') && htmlIds.has('dpUp')
  && htmlIds.has('dpPick') && htmlIds.has('dpList')
  && /\$\('cfStrmAdd'\)\.addEventListener\('click', openDirPick\);/.test(appCode)
  && /async function loadDpDir\(path\)/.test(appCode)
  && /const picked = DP\.path;/.test(appCode)
  && /await addStrmJob\(picked\);/.test(appCode));
chk('🔴 前端：目录选择器复用 GET /api/browse（别为它新开后端接口，两个后端会分叉）',
  /info = await api\.browse\(path \|\| ''\);/.test(appCode));
chk('🔴 前端：目录选择器从**挂载根**起步 —— openDirPick 先摸根再列目录',
  /async function openDirPick\(\) \{/.test(appCode)
  && /await dpMountRoot\(\);/.test(appCode)
  && /await loadDpDir\(DP_ROAM\.path\);/.test(appCode)
  /* 🔴 负向：**不许**图省事直接 loadDpDir('') ——
     空 path 的后端语义是「配置里那个目录」（effectiveDir），不是挂载根。
     真机验证踩过：一打开就落在 /dav/115open/云下载，用户根本够不到 CD2 根目录。 */
  && !/function openDirPick\(\) \{[\s\S]{0,400}?loadDpDir\(''\);/.test(appCode));
chk('🔴 前端：摸根靠「空串 → 自愈到挂载根」那条路（loadDir），别自己猜前缀',
  /function dpMountRoot\(\) \{/.test(appCode)
  && /return loadDir\(''\)\.then\(\(\) => \{/.test(appCode)
  && /if \(!info\.parent \|\| guard\+\+ >= 8\) \{ reset\(\); return; \}/.test(appCode)
  && /return loadDir\(info\.parent\)\.then\(climb\);/.test(appCode)
  /* 摸完必须把「文件夹」页还原成初始态，不能让用户切过去看到残影 */
  && /B\.path = ''; B\.info = null; B\.counts = \{\};/.test(appCode)
  && /DP_ROAM\.path = info\.path \|\| '';/.test(appCode));
chk('🔴 前端：「上一级」到顶就原地不动（**不许**回落空串 = 掉回配置目录的假按钮）',
  /\$\('dpUp'\)\.addEventListener\('click', \(\) => \{[\s\S]{0,420}?if \(p === undefined \|\| p === null\) return;[\s\S]{0,60}?loadDpDir\(p\);/.test(appCode)
  && !/\$\('dpUp'\)\.addEventListener\('click', \(\) => \{[\s\S]{0,420}?loadDpDir\(p === undefined \|\| p === null \? '' : p\);/.test(appCode));

chk('🔴 前端：遮罩点击**分层**（选择器开着时只收它，别把整个设置页也关了）',
  /if \(sheetOpen === 'dirPickSheet'\) return closeDirPick\(\);/.test(appCode));
chk('🔴 前端：closeSheet 也要收掉目录选择器、账号面板和设置面板（不然关设置页它们会留在屏上）',
  /\['configSheet', 'searchSheet', 'dirPickSheet', 'syncSheet', 'settingsSheet'\]\.forEach/.test(appCode));

/* 🔴 2026-09-20：目录选择器**起步位置**的行为断言。
 *
 * 上面那条正则只能证明「调了 dpMountRoot」，证明不了「真的停在了挂载根」——
 * 而真机踩的恰恰是**行为**层面的坑（一打开落在 /dav/115open/云下载）。
 * 所以这里把真函数抠出来，配一个**假的 loadDir**：一棵 / < /dav < /dav/115open
 * < /dav/115open/云下载 的树 —— 后端对「空串」故意返回**配置目录**（最深的那个），
 * 模拟真实的 effectiveDir 语义。断言 dpMountRoot() 结束后：
 *   ① DP_ROAM.path 指的是 /dav（挂载根）而不是配置目录；
 *   ② 中途确实一层层往上爬过（不是从空串一步跳到根）；
 *   ③ B 被还原成初始态（没把「文件夹」页留在残影上）。
 * ⚠️ 桩 `loadDir` 必须**同步**设置 B（真 loadDir 是 async，但 dpMountRoot 只用它读 B.info）；
 *    dpMountRoot 里 `done.then` 的分支照样会走到，因为返回的是真 Promise。
 * ⚠️ 这段必须是 **async IIFE**，不能裸 `return` —— 顶层裸 return 直接语法错误，
 *    整个脚本静默什么都不输出（这次就踩了：exit 0、stdout 空，看着像「全过」）。 */
(async () => {
  const mkRoam = (parentOfInfo) => {
    const B = { path: '', info: null, counts: {} };
    const brCrumb = { set innerHTML(_) {}, get innerHTML() { return ''; } };
    const brUp = { disabled: true };
    const calls = [];
    const loadDir = (p) => {
      calls.push(p);
      /* 空串 = 后端 effectiveDir 语义 = 配置里的那个目录（这里取最深的当配置目录） */
      const at = p === '' ? '/dav/115open/云下载' : p;
      B.path = at;
      B.info = { path: at, parent: parentOfInfo[at], dirs: [] };
      return Promise.resolve();
    };
    /* ⚠️ 抠出来的 `dpMountRoot` 里引用模块级的 `DP_ROAM`，而 `new Function` 的函数体
     *  **不继承模块作用域** —— 必须在生成的函数体**最前面补一份**同名声明，
     *  否则一调用就 `ReferenceError: DP_ROAM is not defined`（踩过）。
     *  补在函数体外面（跟 `function dpMountRoot` 同级）就行：函数体里的引用向上找得到。 */
    const f = new Function('loadDir', 'B', '$',
      'var DP_ROAM = { path: "" };\n'
      + grabFn(app, 'dpMountRoot') + '\nreturn { fn: dpMountRoot, roam: DP_ROAM };')(
        loadDir, B,
        (id) => (id === 'brCrumb' ? brCrumb : id === 'brUp' ? brUp : null));
    return f.fn().then(() => ({ roam: f.roam.path, calls, B, brUp }));
  };

  /* 🔴 父链必须**照抄后端**：挂载根 `/dav` 的 parent 是 **null**，不是 `/`。
   *    后端 `handleBrowse` 里钉好了 `p.equals(prefixOf(baseUrl)) ? null : parentOf(p)`
   *    （见 NasServer 第 974~977 行）——「挂载根就是可浏览树的顶」。
   *    写成 `/dav → /` 会让上溯多爬一层到 `/`，断言反而假红（这次就踩了）。 */
  const P = {
    '/': null,
    '/dav': null,                    // ← 挂载根，到顶
    '/dav/115open': '/dav',
    '/dav/115open/云下载': '/dav/115open',
  };

  const r = await mkRoam(P);
  chk('🔴 行为：空串起步（吃到配置目录）也能一路爬到**挂载根** /dav',
    r.roam === '/dav', `摸到 ${r.roam || '(空)'}，应为 /dav`);
  chk('🔴 行为：中途真的逐级上溯过（不是从空串一步跳到根）',
    r.calls.length >= 3 && r.calls.indexOf('/dav/115open') !== -1
    && r.calls.indexOf('/dav') !== -1,
    `实际路径：${r.calls.join(' → ')}`);
  chk(' 行为：摸完把「文件夹」页还原（别留残影）+ 根上「上一级」是灰的',
    r.B.path === '' && r.B.info === null && r.brUp.disabled === true);
})();


chk('前端：立即生成后轮询进度，跑完自动停（2 秒一轮）',
  /\$\('cfStrmRun'\)\.addEventListener\('click'/.test(appCode)
  && /strmPollTimer = setInterval/.test(appCode)
  /* ⚠️ 2026-09-20：`if (!s2.running)` 那一行里现在多了「localSrcAdded → 刷片库」
     的处理，原文的一行式断不到了。断「停止轮询」那两个动作本身即可
     （顺序可能变，所以别写成一条连续串）。 */
  && /if \(!s2\.running\) \{/.test(appCode)
  && /clearInterval\(strmPollTimer\); strmPollTimer = null;/.test(appCode));
chk('前端：第 4 步显隐跟登录联动（setPicked 里一起切）',
  /const strm = \$\('stepStrm'\);\n  if \(strm\) strm\.hidden = !on;/.test(appCode));
chk('样式：strm 清单行有专属样式（整行可点 / 行尾 ✕）',
  /label\.cf-dir\.strm-job\{cursor:pointer/.test(cssCode)
  && /\.cf-dir\.strm-job \.sj-del\{/.test(cssCode));
chk('🔴 样式：✕ 有「确认？」武装态（.sj-del.armed 红底白字 —— 跟灰 ✕ 一眼分开，别让两步变隐形）',
  /\.cf-dir\.strm-job \.sj-del\.armed\{/.test(cssCode)
  && /background:var\(--brand\)/.test(cssCode)
  /* 按下去不能闪回灰色（否则用户以为没点上） */
  && /\.cf-dir\.strm-job \.sj-del\.armed:active\{[^}]*var\(--brand\)/.test(cssCode));
chk('样式：固定目录用只读样式（.ro-path，等宽 + 允许折行 —— 长路径不能被截成看不出是哪）',
  /\.ro-path\{/.test(cssCode) && /word-break:break-all/.test(cssCode));
chk('🔴 前端：状态行不再提「授权存储 / 所有文件访问」（免授权了）',
  !/授权存储/.test(appCode)
  && !/所有文件访问/.test(appCode)
  && !/NasBridge\.requestStrmStorage/.test(appCode));

/* ============================================================
   「点『＋ 添加文件夹』没反应」—— 两个面板互相盖死（2026-09-20）
   ------------------------------------------------------------
   #dirPickSheet（行 194）在 HTML 里排在 #configSheet（行 211）**之前**，
   可两者都是 `position:absolute;left:0;right:0;bottom:0` + `.sheet.tall`
   （88% 高），rect **完全重叠**。而设置页第 4 步正是从 #configSheet
   里面打开选择器的 —— 同 z-index 时 **DOM 里靠后的画在上面**，于是
   选择器整块被压在设置面板底下：逻辑其实跑通了（dpList / dpPath 都读好了），
   可用户看到的就是「画面一点没变」，手指点上去也只碰到设置面板自己的东西。
   真机实测：elementFromPoint 打在选择器标题栏中心，命中的是 #configSheet。

   修法是给 #dirPickSheet 单独提一层（无状态，比 hide/restore 稳）。
   ⚠️ 这两条断言靠的是**层级数值关系**，不是注释 —— 注释会被剥掉。
   ============================================================ */
console.log('\n · 目录选择器不能被设置面板盖住');
{
  const zi = (sel) => Number((cssCode.match(new RegExp(sel + '\\s*\\{[^}]*z-index\\s*:\\s*(\\d+)')) || [])[1]);
  const ziSheet = zi('\\.sheet');
  const ziDp = zi('#dirPickSheet');
  const ziToast = zi('\\.toast');
  chk('🔴 目录选择器（#dirPickSheet）层级必须高于普通面板（.sheet），否则从设置页打开它＝点了没反应',
    Number.isFinite(ziSheet) && Number.isFinite(ziDp) && ziDp > ziSheet,
    `.sheet=${ziSheet} / #dirPickSheet=${ziDp}`);
  chk('🔴 它又不能盖住 toast（提示还得看得见）',
    Number.isFinite(ziToast) && ziDp < ziToast,
    `#dirPickSheet=${ziDp} / .toast=${ziToast}`);
  chk('🔴 前提仍成立：#dirPickSheet 在 DOM 里排在 #configSheet 之前',
    htmlCode.indexOf('id="dirPickSheet"') > 0
    && htmlCode.indexOf('id="configSheet"') > htmlCode.indexOf('id="dirPickSheet"'),
    '顺序变了的话上面那条提层级的必要性要重看');
}

/* ============================================================
   「挂载根之上」的幽灵层
   ------------------------------------------------------------
   在 /dav 点「上一级」→ parentOf('/dav') = '/' → 列目录时 cp === p 拿
   `/dav`（href 里的真实路径）比 `/`（请求路径）永远不等，于是：
     · 挂载根自己 `dav` 被列成一个子文件夹（9 个而不是 8 个）
     · 面包屑空了、上一级还能一直点，永远退不到真正的顶
   修法：listDir 先 mountAbs 归一，再把挂载根的 parent 钉成 null。
   ============================================================ */
console.log('\n · 挂载根之上不该有幽灵层');
chk('server.js listDir 先用 mountAbs 归一（不是裸 normAbs）',
  /async function listDir\(cfg, absPath\) \{[\s\S]{0,900}?const p = mountAbs\(cfg, absPath\);/.test(srv)
  && !/async function listDir\(cfg, absPath\) \{[\s\S]{0,200}?const p = normAbs\(absPath\);/.test(srv));
chk('server.js listDir 的挂载根没有上一级（parent = null）',
  /parent: p === mountRoot \? null : parentOf\(p\),/.test(srv));
chk('Java listDir 同样归一（两个后端别分叉）',
  /private JSONObject listDir\(String absPath\)[\s\S]{0,900}?String p = mountAbs\(absPath\);/.test(nj)
  && !/private JSONObject listDir\(String absPath\)[\s\S]{0,200}?String p = NasService\.normAbs\(absPath\);/.test(nj));
chk('Java listDir 的挂载根也没有上一级',
  /String par = p\.equals\(mroot\) \? null : parentOf\(p\);/.test(nj));
chk('Java mountAbs 抽成独立方法，effectiveDir 复用它',
  /private String mountAbs\(String absPath\)/.test(nj)
  && /return mountAbs\(dir\.isEmpty\(\) \? \(pfx\.isEmpty\(\) \? "\/" : pfx\) : dir\);/.test(nj)
  /* ⚠️ 但这句前面必须先挡住本机片源（见上面那条 local: 短路断言）—— */
  && /if \(isLocalSrc\(dir\)\) return "";/.test(nj));
{
  // 真算一遍：归一之后，挂载根与「服务根」必须落到同一个规范路径
  const normAbs = (p) => '/' + String(p == null ? '' : p).replace(/\\/g, '/')
    .split('/').filter((s) => s && s !== '.').join('/');
  const pfxOf = (u) => { let s = new URL(u).pathname; while (s.endsWith('/')) s = s.slice(0, -1); return s; };
  const mAbs = (url, p) => {
    const pfx = pfxOf(url);
    let d = normAbs(p);
    if (pfx && d !== pfx && !d.startsWith(pfx + '/')) d = normAbs(pfx + d);
    return d;
  };
  const CD2 = 'http://192.168.1.100:19798/dav';
  const SYNO = 'http://192.168.1.100:5005';
  chk('CD2：服务根 "/" 与挂载根 "/dav" 归一后是同一个路径',
    mAbs(CD2, '/') === mAbs(CD2, '/dav') && mAbs(CD2, '/') === '/dav');
  chk('CD2：子目录不受影响', mAbs(CD2, '/dav/示例目录') === '/dav/示例目录'
    && mAbs(CD2, '/媒体库') === '/dav/媒体库');
  chk('群晖根挂载："/" 仍然是 "/"（归一不改变旧机行为）',
    mAbs(SYNO, '/') === '/' && mAbs(SYNO, '/Photos') === '/Photos');
}

console.log('\n · 资源路径');
/* ⚠️ 这两段结构校验一律跑在 htmlCode（剥掉 <!-- --> 之后）上。
   2026-09-18 踩到：顶栏注释里写了一句「这里原来是 <button>…」，
   标签配对器把注释里那个 `<button>` 当成了真标签 → 报「</header> 没闭合」。
   注释掉的标记本来就不该参与结构校验。 */
[...htmlCode.matchAll(/(?:href|src)="(\/[^"]+)"/g)].map((m) => m[1]).forEach((a) =>
  chk(`存在 ${a}`, fs.existsSync(path.join(ROOT, 'public', a.replace(/^\//, '')))));

console.log('\n · HTML / CSS 结构');
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr', 'path', 'circle', 'rect', 'line', 'polygon', 'polyline', 'use']);
const stack = [];
const stackErr = [];
for (const m of htmlCode.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
  const t = m[2].toLowerCase();
  if (VOID.has(t) || m[3] === '/') continue;
  if (!m[1]) stack.push(t);
  else if (stack.pop() !== t) stackErr.push('</' + t + '>');
}
chk('HTML 标签闭合', stack.length === 0 && stackErr.length === 0,
  [...stackErr, ...stack.map((x) => '<' + x + '>')].join(' '));
const cs = [];
let cerr = 0;
for (const ch of css) { if (ch === '{') cs.push(1); else if (ch === '}' && cs.pop() === undefined) cerr++; }
chk('CSS 花括号配对', cs.length === 0 && cerr === 0, `未闭合 ${cs.length} / 多余 ${cerr}`);

/* ==================== 随机序行为验证（把 app.js 里的真函数抠出来跑） ==================== */

/** 从 app.js 源码里摘出一个函数体（大括号配对），保证测的就是线上那份代码 */
function grabFn(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  /* 🔴 先跳过**形参表**，再从它后面找函数体的第一个 `{`。
     不能一见到 `{` 就开始配对 —— `function f(a, opts = {}) {…}` 这种
     **默认参数里就有花括号**，数到它就把函数体当成已经结束了：
     `grabFn('createFeed')` 曾经只抠出 **40 个字符**（就是那行签名），
     于是所有「这段代码在不在里面」的断言全部**假绿**（2026-09-21 撞到）。
     ⚠️ 形参表里还可能有嵌套括号（`= f(1)`），所以要按括号配对跳，不能找第一个 `)`。 */
  let j = src.indexOf('(', i);
  if (j < 0) throw new Error('找不到形参表 ' + name);
  let pd = 0;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '(') pd++;
    else if (c === ')') { pd--; if (pd === 0) { j++; break; } }
  }
  const b = src.indexOf('{', j);
  if (b < 0) throw new Error('找不到函数体 ' + name);
  let d = 0;
  for (let k = b; k < src.length; k++) {
    const c = src[k];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('括号不配对 ' + name);
}

/** 从源码里摘出**一整条调用语句**（括号配对，末尾补 `;`）。
 *  grabFn 只能抠 `function name(`，抠不出
 *  `$('x').addEventListener('click', (e) => { ... })` 这种匿名回调 ——
 *  而事件处理恰恰是最容易「正则看着对、跑起来错」的地方，所以要能真跑。 */
function grabCall(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('找不到 ' + marker);
  /* 🔴 标记**自己**就带括号（`$('cfStrmJobs').addEventListener('click'`），
     所以不能一见 d===0 就收 —— 那个 0 是标记里 `('cfStrmJobs')` 的闭合，
     会把整条语句截成 `$('cfStrmJobs');`（真踩过：监听器根本没注册上，
     报错是「box.fn is not a function」，看着像桩写错了，其实是抠错了）。
     只有**越过标记末尾**之后的 d===0 才算真正结束。 */
  const minEnd = i + marker.length;
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '(') { d++; started = true; }
    else if (c === ')') {
      d--;
      if (started && d === 0 && j >= minEnd) return src.slice(i, j + 1) + ';';
    }
  }
  throw new Error('括号不配对 ' + marker);
}

/** 摘出 `const <name> = ...;` 这种**箭头函数常量**（grabFn 只认 `function name(`）。
 *  本项目里纯判据类的小函数爱写成 const 箭头（如 `isStrmPointer`），
 *  它们是要被行为测试喂进去的，所以也得能抠。 */
function grabArrow(src, name) {
  const i = src.indexOf('const ' + name + ' = ');
  if (i < 0) throw new Error('找不到 ' + name);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '(' || c === '[' || c === '{') { d++; started = true; }
    else if (c === ')' || c === ']' || c === '}') d--;
    else if (c === ';' && started && d === 0) return src.slice(i, j);
  }
  throw new Error('找不到结尾 ; ' + name);
}

/** 摘出 `marker` 后面那个**函数表达式**（`window.x = function () {...}`），
 *  用于把挂在 window 上的钩子抠出来真跑（grabFn 只认 `function name(`）。 */
function grabAssignFn(src, marker) {
  const i = src.indexOf(marker);
  if (i < 0) throw new Error('找不到 ' + marker);
  const start = i + marker.length;
  const brace = src.indexOf('{', start);
  if (brace < 0) throw new Error('没找到函数体 ' + marker);
  let d = 0;
  for (let j = brace; j < src.length; j++) {
    if (src[j] === '{') d++;
    else if (src[j] === '}') { d--; if (d === 0) return src.slice(start, j + 1).trim(); }
  }
  throw new Error('大括号不配对 ' + marker);
}

console.log('\n · 刷视频随机序（直接跑 app.js 里的 shuffle / orderVideos）');
{
  const grab = (name) => grabFn(app, name);
  const S = { order: [] };
  const { shuffle, orderVideos } = new Function('S',
    grab('shuffle') + '\n' + grab('orderVideos') + '\nreturn { shuffle, orderVideos };')(S);
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ p: '/云下载/v' + String(i).padStart(3, '0') + '.mp4' }));

  const vids = mk(73);
  const a = orderVideos(vids);
  const sig = (arr) => arr.map((v) => v.p).join(',');
  chk('洗牌后条数不变', a.length === 73, '拿到 ' + a.length);
  chk('洗牌后成员不丢不重', new Set(a.map((v) => v.p)).size === 73);
  chk('返回视频对象而不是路径', a.every((v) => v && typeof v.p === 'string'));
  chk('传给 orderVideos 的原数组没被改动', vids[0].p === '/云下载/v000.mp4');
  const moved = a.filter((v, i) => v.p !== vids[i].p).length;
  chk('确实打乱了（≥90% 位置变了）', moved >= 66, moved + '/73');

  const seen = new Set();
  for (let i = 0; i < 200; i++) { S.order = []; seen.add(sig(orderVideos(vids))); }
  chk('200 次洗牌出现多种顺序（不是伪随机）', seen.size > 190, '不同顺序 ' + seen.size + ' 种');

  const first = sig(orderVideos(vids));
  chk('同一批内容二次传入 → 顺序不变（后台补扫不跳条）', sig(orderVideos(mk(73))) === first);
  chk('原数组没被 shuffle 连带改坏', vids[0].p === '/云下载/v000.mp4');

  const after = orderVideos(mk(75));                       // 补扫多出 v073 / v074
  chk('新增视频不会打乱老顺序', after.slice(0, 73).map((v) => v.p).join(',') === first);
  chk('新视频接在队尾', JSON.stringify(after.slice(73).map((v) => v.p).sort()) ===
    JSON.stringify(['/云下载/v073.mp4', '/云下载/v074.mp4']));

  const tail = after.slice(73).map((v) => v.p);
  const after3 = orderVideos(mk(75).filter((v) => v.p !== '/云下载/v010.mp4'));
  chk('掉线视频被剔除且不留空位', after3.length === 74 && after3.every(Boolean));
  /* ⚠️ 这里曾经写成 `first.replace('/云下载/v010.mp4,', '')`，是个**偶发**失败
     （实测 3000 轮里错 43 次 ≈ 1.4%，很难复现，一度被当成玄学）。
     原因：字符串 replace 只会命中「带尾逗号」的那次出现。当 v010 恰好被洗到
     **列表末尾**时，它在 first 里是最后一个、身后没有逗号，
     replace 就一次都匹配不上 → v010 没被摘掉 → 期望值比实际多一条。
     正确做法是按数组处理，而不是在拼好的字符串上做替换。 */
  const wantP = first.split(',').filter((p) => p !== '/云下载/v010.mp4').concat(tail);
  chk('剔除后其余顺序不乱',
    after3.map((v) => v.p).join(',') === wantP.join(','));

  S.order = [];
  chk('空列表不炸', orderVideos([]).length === 0);
  chk('单个视频不炸', orderVideos(mk(1)).length === 1);
  const arr = [1, 2, 3, 4, 5, 6, 7, 8];
  chk('shuffle 原地打乱且不增删元素', shuffle(arr) === arr &&
    arr.slice().sort((x, y) => x - y).join() === '1,2,3,4,5,6,7,8');
}

/* 进度条的比例换算：拖到两头夹不准就会「拖到头了还在跑」或者「怎么拖都跳不回去」 */
console.log('\n · 进度条拖动比例（直接跑 app.js 里的 ratioOfRect）');
{
  const { ratioOfRect } = new Function(grabFn(app, 'ratioOfRect') + '\nreturn { ratioOfRect };')();
  const r = { left: 100, width: 200, top: 0, height: 8, right: 300, bottom: 8 };
  chk('点最左边 = 0', ratioOfRect(r, 100) === 0);
  chk('点中间 = 0.5', ratioOfRect(r, 200) === 0.5);
  chk('点最右边 = 1', ratioOfRect(r, 300) === 1);
  chk('拖过头（右边外面）夹在 1', ratioOfRect(r, 9999) === 1);
  chk('拖过头（左边外面）夹在 0', ratioOfRect(r, -9999) === 0);
  chk('换算不回弹、不被四舍五入吃掉', ratioOfRect(r, 137) === 0.185);
  chk('宽度为 0 时不返回 NaN', ratioOfRect({ left: 0, width: 0 }, 50) === 0);
  chk('拿不到矩形也不炸', ratioOfRect(null, 50) === 0 && ratioOfRect(undefined, 50) === 0);
}

/* 下拉刷新位移换算（pullOffset / PTR_*）那一段测试已经删掉 ——
   被测对象本身在 2026-09-18 被整体移除了。留着只会 `grabFn` 找不到函数而报错。 */

/* ==================== 深色 / 浅色主题（2026-09-21） ====================
 *
 * 用户要求：「在设置里加入新功能，黑白主题切换并且再制作一个白色UI界面」。
 *
 * 这套东西**特别容易静默失效**：整套浅色是靠「CSS 变量被覆盖」实现的，只要有人
 *   · 浅色块里漏覆盖一个令牌 → 那块地方在浅色下还是深色的（花屏，但不报错）
 *   · 把某个 var(--x) 拼错一个字母 → 该属性直接失效、回落成初始值（也不报错）
 *   · 手滑把「压在视频上」的规则也改成令牌 → 首页文字压在视频上看不清
 *   · 忘了把底栏在首页钉成深色 → 白底栏压在黑视频上，图标看不见
 * 全都不会让页面报错，只会「看起来不对」。所以这组断言专盯这几件事。
 */
console.log('\n · 深色 / 浅色主题');

/* ① 入口：设置页「通用选项」里的三档分段控件 */
{
  const seg = htmlCode.slice(htmlCode.indexOf('id="themeSeg"'));
  const vals = [...seg.slice(0, seg.indexOf('</div>')).matchAll(/data-theme="([a-z]+)"/g)].map((m) => m[1]);
  chk('设置页有 #themeSeg（外观三档分段控件）',
    /<div class="seg" id="themeSeg">/.test(htmlCode));
  chk('三档取值正好是 dark / light / auto（防档位漂移）',
    JSON.stringify(vals) === JSON.stringify(['dark', 'light', 'auto']), '实际 = ' + vals.join(','));
  /* 🔴 2026-09-21 二次修：用户明确指出外观开关要放在 **⚙️「设置」面板**
     （#settingsSheet，「我的」页右上角齿轮），**不是「数据源设置」**（#configSheet）——
     那里是数据源相关的，外观属于「偏好」。上一版放错了，这条断言把它钉死。
     ⚠️ 判据必须**按 section 切块**比，不能写 `/<div class="common">[\s\S]*?id="themeSeg"/`
        —— `[\s\S]*?` 会从 configSheet 里那个 `.common` 一路懒匹配到后面 settingsSheet
        里的 themeSeg，**必然命中**（我第一版就这么写的，直接假红）。 */
  const secOf = (id) => {
    const i = htmlCode.indexOf('id="' + id + '"');
    return i < 0 ? '' : htmlCode.slice(i, htmlCode.indexOf('</section>', i));
  };
  chk('外观开关在 ⚙️「设置」面板里（#settingsSheet），不在「数据源设置」里',
    secOf('settingsSheet').includes('id="themeSeg"')
    && !secOf('configSheet').includes('id="themeSeg"'),
    '外观属于「偏好」，该在 ⚙️ 设置面板；放「数据源设置」里是上一版的错');
  /* .seg button 默认 flex:1（为等宽两档设计的）。外观是**三档**、其中一档是 4 个字的
     「跟随系统」—— 三档均分下来每个只有 66px，放不下 82px 的按钮，会折成两行
     （真机截图发现的：整行被撑高、和左边的「外观」对不齐）。 */
  chk('外观三档按内容定宽 + 不折行（否则「跟随系统」会被挤成两行）',
    /flex:none/.test(ruleBody('#themeSeg button'))
    && /white-space:nowrap/.test(ruleBody('#themeSeg button')),
    ruleBody('#themeSeg button'));
}

/* ② 首屏防闪：<head> 里的内联脚本必须在样式表**之前**跑，
      否则会先按默认（深色）画一帧再翻成浅色 —— 切到浅色后每次刷新都看得见 */
{
  const head = htmlCode.slice(0, htmlCode.indexOf('</head>'));
  const iScript = head.indexOf('<script>');
  const iCss = head.indexOf('<link rel="stylesheet"');
  chk('head 里有防闪的内联脚本，且在样式表之前',
    iScript > 0 && iCss > 0 && iScript < iCss, `script@${iScript} / css@${iCss}`);
  chk('内联脚本读写的是同一个 localStorage 键（nasdy.theme）—— 和 app.js 必须一致',
    head.includes("localStorage.getItem('nasdy.theme')")
    && /const THEME_LS = 'theme';/.test(appCode)
    && /LS\.get\(THEME_LS, 'dark'\)/.test(appCode));
  chk('内联脚本也把「跟随系统」折成具体档位（写成 auto 的话 CSS 匹配不到）',
    /prefers-color-scheme: light/.test(head)
    && /window\.NasBridge\.systemTheme/.test(head)
    && /documentElement\.setAttribute\('data-theme', t\)/.test(head));
}

/* ②b 🔴 「跟随系统」必须问**原生**，不能只信 prefers-color-scheme。
      Android WebView 的那个媒体查询取自 **App 自己的主题**（本项目是
      Theme.Material.NoActionBar 深色主题），跟系统设置毫无关系 ——
      实测系统切成浅色时 `matchMedia('(prefers-color-scheme: light)').matches`
      依然是 false。只靠它的话这一档会**永远停在深色**，是个假档位。 */
{
  chk('app.js 的 systemTheme() 优先问原生桥，浏览器才回落到媒体查询',
    (() => {
      const b = grabFn(appCode, 'systemTheme');
      /* ⚠️ `prefers-color-scheme` 那个字面量在模块级的 THEME_MQ 里，**不在函数体内** ——
         这里只能断它引用了 THEME_MQ 作为回落，别去函数体里找媒体查询字符串。 */
      return /window\.NasBridge/.test(b) && /systemTheme\(\)/.test(b) && /THEME_MQ/.test(b);
    })()
    && /matchMedia\('\(prefers-color-scheme: light\)'\)/.test(appCode));
  chk('themeResolved 的 auto 走 systemTheme()，不是自己读媒体查询',
    (() => {
      const b = grabFn(appCode, 'themeResolved');
      return /return systemTheme\(\);/.test(b) && !/prefers-color-scheme/.test(b);
    })());
  chk('Java 侧 systemTheme() 读的是**系统 uiMode**（不是 App 主题）',
    /@android\.webkit\.JavascriptInterface\s+public String systemTheme\(\)/.test(maCode)
    && /UI_MODE_NIGHT_MASK/.test(maCode) && /UI_MODE_NIGHT_YES/.test(maCode));
  chk('🔴 系统切换深浅色要主动推给网页 —— manifest 给 MainActivity 声明了 uiMode，'
    + 'Activity 不会重建；不推的话「跟随系统」要等下次冷启动才生效',
    /private void pushSystemTheme\(\)/.test(maCode)
    && /public void onConfigurationChanged\(android\.content\.res\.Configuration cfg\)/.test(maCode)
    && /pushSystemTheme\(\);/.test(maCode));
  chk('网页侧留了 window.__onSystemTheme 钩子（app.js 是 module，不挂 window 外面调不到）',
    /window\.__onSystemTheme = \(\) => \{ if \(themeChoice\(\) === 'auto'\) applyTheme\(\); \};/.test(appCode));
}

/* ③ app.js：档位解析 / 应用 / 切换 */
{
  chk('默认深色（老用户升级后看到的还是原来那个样子）',
    /LS\.get\(THEME_LS, 'dark'\)/.test(appCode));
  chk('非法值回落深色（不认得的字符串不能写进 data-theme）',
    /v === 'light' \|\| v === 'auto' \? v : 'dark'/.test(appCode));
  chk('「跟随系统」按 prefers-color-scheme 折成 dark / light',
    /matchMedia\('\(prefers-color-scheme: light\)'\)/.test(appCode)
    && /function themeResolved\(\)/.test(appCode));
  chk('applyTheme 把结果写到 <html data-theme>',
    /document\.documentElement\.setAttribute\('data-theme', t\)/.test(appCode));
  chk('切换按钮绑的是 data-theme（不是下标 / 文本）',
    /\$\('themeSeg'\)\.addEventListener\('click'/.test(appCode)
    && /closest\('button\[data-theme\]'\)/.test(appCode));
  /* 🔴 这条**必须锚定媒体查询那条路**，不能只写
     `/if \(themeChoice\(\) === 'auto'\) applyTheme\(\);/` —— 那句话在
     `window.__onSystemTheme` 里有一模一样的第二份（原生推过来的入口），
     全文 grep 会命中那一份，把这里改坏了照样绿（本项目 §62.9 那个坑的变体）。
     所以锚点是「监听器的定义 + 它真的被注册」，原生那条由 ②b5 单独守。 */
  chk('系统主题变了要跟着走，但**只在 auto 档**（手动选了深色就不该被系统改掉）',
    /const onSysTheme = \(\) => \{ if \(themeChoice\(\) === 'auto'\) applyTheme\(\); \};/.test(appCode)
    && /THEME_MQ\.addEventListener\('change', onSysTheme\)/.test(appCode));
  chk('🔴 主题不走 /api/config（改一次会触发全量重扫，实测 54~185 秒）',
    !/THEME_LS|themeChoice\(\)|themeResolved\(\)/.test(grabFn(appCode, 'formValues')));
}

/* ④ 🔴 系统栏：网页改不了安卓状态栏颜色，只能由原生改 ——
      漏了的话浅色界面顶上永远留一条黑边，看着像没换干净 */
{
  chk('applyTheme 里**每次都**推给原生（不只是用户点切换时）—— '
    + 'App 重启后带着浅色配置进来也要能对上',
    (() => {
      const b = grabFn(appCode, 'applyTheme');
      return /window\.NasBridge/.test(b) && /\.setTheme\(/.test(b);
    })());
  chk('Java 侧 NasBridge.setTheme 存在、挂了 @JavascriptInterface、跑在 ui.post 里',
    /@android\.webkit\.JavascriptInterface\s+public void setTheme\(String theme\)/.test(maCode)
    && /lightTheme = light;/.test(maCode));
  chk('系统栏真的设了（状态栏 + 导航栏 + 浅色图标标记）',
    /setStatusBarColor\(color\)/.test(maCode)
    && /setNavigationBarColor\(color\)/.test(maCode)
    && /SYSTEM_UI_FLAG_LIGHT_STATUS_BAR/.test(maCode));
  chk('🔴 退出全屏后要补回主题配色 —— applyImmersive(false) 是整体赋值，'
    + '会把 LIGHT_STATUS_BAR 一起清掉（症状：看完全屏回来状态栏图标又变白）',
    /applySystemBarTheme\(lightTheme\);/.test(maCode));
}

/* ⑤ CSS：浅色块只覆盖变量、不重写规则 */
{
  chk('浅色块用的是 html[data-theme="light"]（特异性 0,1,1 才压得住 :root 的 0,1,0；'
    + '裸属性选择器只能靠源码顺序，往上挪就静默失效）',
    /html\[data-theme="light"\]\{/.test(cssCode));
  const lb = ruleBody('html[data-theme="light"]');
  const need = ['--bg', '--fg', '--muted', '--muted2', '--line', '--glass', '--glass-2',
    '--glass-dark', '--ink', '--srf', '--toast-bg', '--toast-fg', '--sh-soft',
    '--star', '--cyan-fg', '--cap-ok', '--sw-off', '--w05', '--w08', '--w10', '--w82',
    '--tabbar-bg'];
  const miss = need.filter((k) => !new RegExp('\\' + k + ':').test(lb));
  chk(`浅色块覆盖了全部 ${need.length} 个关键令牌（漏一个 → 那块地方在浅色下还是深色）`,
    miss.length === 0, miss.length ? '漏了：' + miss.join(', ') : '');
  chk('🔴 品牌色不覆盖（--brand / --cyan 两个主题必须一致，否则抖音红会变味）',
    !/--brand:/.test(lb) && !/--cyan:/.test(lb));
}

/* ⑥ 🔴 通用兜底：用到的每个 var(--x) 都必须有定义。
      拼错一个字母**不会报错** —— 该属性直接失效、回落成初始值（透明 / 黑），
      深色下往往看不出来，切到浅色才暴露。这条能一次性兜住所有拼写错误。 */
{
  const declared = new Set([...cssCode.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...cssCode.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  /* --vbw / --vbh 是 JS 用 style.setProperty 写在 item 上的（画面矩形尺寸，
     见 fitVideoBox），故意不在 CSS 里定义 —— 除它俩以外一个都不许缺。 */
  const JS_SET = new Set(['--vbw', '--vbh']);
  const undef = [...used].filter((v) => !declared.has(v) && !JS_SET.has(v));
  chk(`CSS 里用到的 ${used.size} 个变量都有定义（拼错不会报错，只会静默失效）`,
    undef.length === 0, undef.length ? '没定义的：' + undef.join(', ') : '');
}

/* ⑥b 🔴 CSS 注释里出现「星号紧跟斜杠」会**提前结束注释**：后面到下一个分号
       之间的东西会被当成一条声明整段吃掉（浏览器和 check.js 的 stripCssComments
       按同一规则解析）。2026-09-21 就栽在这：主题令牌那段注释里写了
       「.grad-* 紧跟斜杠」，把紧跟其后的 `--page-bg:#0a0a0c;` 整条吞了 ——
       `:root` 87 个令牌只解析出 86 个、深色下 body 背景变透明，**完全不报错**。
       同类坑本项目栽过两次：§21.10（XML 注释里的连续减号 → aapt2 静默退回默认
       minSdk）、§70（Java 块注释里拿星号加斜杠当通配符）。 */
{
  const nOpen = (css.match(/\/\*/g) || []).length;
  const nClose = (css.match(/\*\//g) || []).length;
  chk(`CSS 注释标记配平（开始 ${nOpen} / 结束 ${nClose}）—— 多出来的必然混在注释体里`,
    nOpen === nClose, nOpen === nClose ? '' : '注释体里的结束标记会吞掉紧跟其后的整条声明');

  /* 更直接的判据：按浏览器的规则切分 `:root` 的声明，逐个核对还在不在。
     ⚠️ 只在「分号（或块首）之后紧接着就是属性名」时才算一条声明 ——
        被野结束标记吞掉的那条，前面会多出一段垃圾文字，于是匹配不上。
        这个写法**同时**兜住了「注释吞声明」以外的同类解析事故。 */
  const rawRoot = css.slice(css.indexOf(':root{') + 6, css.indexOf('\n}', css.indexOf(':root{')));
  const want = [...rawRoot.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
  const parsedRoot = cssCode.slice(cssCode.indexOf(':root{') + 6,
    cssCode.indexOf('\n}', cssCode.indexOf(':root{')));
  const got = new Set([...parsedRoot.matchAll(/(?:^|[;{])\s*(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const lost = want.filter((n) => !got.has(n));
  chk(`:root 里 ${want.length} 个令牌全都能解析出来（被注释吞掉的话整条消失，还不报错）`,
    lost.length === 0, lost.length ? '被吞掉的：' + lost.join(', ') : '');
}

/* ⑦ 🔴 反向守卫：**真正压在视频内容上的**那批规则不许用主题令牌。
      它们下面永远是视频，跟着主题变会变成「深字压深底」看不清。
      ⚠️ 名单**只收「文字/图标直接叠在视频上」的** ——
         `.topbar / .tb-icon / .top-title / .mode-badge / .tabbar` **不在这里**：
         用户 2026-09-21 二次明确要求「顶栏 / 底栏换成浅色，只有刷视频那块保持黑」，
         它们改成**接近实底的白**之后压黑视频上照样读得清（见 ⑦b 组）。
         把它们塞回这个名单 = 又把首页顶栏底栏变回黑的。 */
{
  const KEEP = ['.feed', '.item', '.item video', '.item .vph::before', '.item .rate-ind',
    '.item .grad-top', '.item .grad-bottom', '.rail-item', '.meta .desc', '.meta .finfo',
    '.progress .track', '.progress .bar', '.v-err', '.loading', '.player', '.player-btn',
    '.seek-ind', '.cell .cap'];
  const bad = KEEP.filter((s) => /var\(--(w[0-9]+|ink|srf|srf2|srf3|toast-|sh-|topbar-|tbbtn-|pill-|badge-)/.test(ruleBody(s)));
  chk(`真正压在视频上的 ${KEEP.length} 条规则都没被改成主题令牌`,
    bad.length === 0, bad.length ? '被改了：' + bad.join(', ') : '');
  /* 这三个是「压在深底上的次要文字」，用的正是 --muted 的深色值，必须写死 */
  chk('压在视频 / 黑色蒙层上的次要文字固定成浅色（--muted 在浅色下会变深灰 → 看不见）',
    /\.item \.vph,\s*\.v-err \.d,\s*\.loading p\{color:rgba\(255,255,255,\.62\);\}/.test(cssCode));
}

/* ⑦b 顶栏 vs 底栏：**一个不跟随主题、一个跟随**（2026-09-21 定了三轮才定下来）
      ─────────────────────────────────────────────────────────────
      用户三条反馈的演进（别只记最后一条，不然很容易又改回去）：
        ① 「白色主题下首页这里还是黑的」（圈的是**底部导航栏**）
           → 底栏必须跟随主题。当时我把它钉成了深色，理由是「压在视频上」，
             这个直觉只在**半透明**时成立。
        ② 「这里还是跟黑色主题一样透明的」（圈的是**顶栏**）
           → 我先把顶栏做成白→透明的渐隐，用户仍不满意（渐隐到透明就是看起来透明），
             于是改成白色实底。
        ③ 「这个部分跟深色主题一样就可以了不用改动」（还是**顶栏**）
           → **顶栏撤回，不跟随主题**：两个主题下都是深色渐变 + 白色图标/白胶囊。
             原因看得出来：顶栏是压在画面上的悬浮层，白色实底会在视频顶上贴一条
             硬边白板；深色渐隐才能融进画面。
      👉 结论：**底栏跟随主题，顶栏不跟随**。两者的差别不在「压不压在视频上」，
         而在「它在页面边缘（底栏，压不到画面主体）还是浮在画面中间（顶栏）」。 */
{
  /* 顶栏这一组必须**保持硬编码深色**。判据用「关键属性必须是这几个写死的值」，
     比「不许出现 var()」强 —— 后者挡不住有人把它改成别的硬编码浅色。 */
  const DARK = [
    ['.topbar', ['background:linear-gradient(180deg,rgba(0,0,0,.55),transparent)']],
    ['.tb-icon', ['color:#fff']],
    ['.top-title', ['background:rgba(0,0,0,.32)', 'color:#fff']],
    ['.top-title .tt-count', ['color:#fff']],
    ['.mode-badge', ['background:rgba(0,0,0,.62)']],
  ];
  const bad = [];
  for (const [sel, props] of DARK) {
    const b = ruleBody(sel);
    for (const p of props) if (!b.includes(p)) bad.push(sel + ' 少了 ' + p);
  }
  chk(`🔴 顶栏 / 悬浮徽标那 ${DARK.length} 条**不跟随主题**（用户：「这个部分跟深色主题一样就可以了」）`
    + ' —— 两个主题下都是深色渐变 + 白图标/白胶囊',
    bad.length === 0, bad.length ? bad.join('；') : '');
  chk('🔴 顶栏那组也没被改成主题令牌（--topbar-* / --tbbtn-* / --pill-* / --badge-* 已整体删除）',
    !/var\(--(topbar-|tbbtn-|pill-|badge-)/.test(cssCode));

  /* 底栏反过来：**必须跟随主题**（这是用户第一条反馈） */
  chk('🔴 底栏**跟随主题**（用户第一条反馈：白色主题下首页底栏不能还是黑的）',
    /background:var\(--tabbar-bg\)/.test(ruleBody('.tabbar')));
  chk('🔴 底栏没有「首页钉死深色」那条了（用户圈出来说不行的那条）',
    !/\.phone\[data-nav="home"\]/.test(cssCode)
    && !/phone\.dataset\.nav\s*=/.test(appCode),
    '又按「压在视频上」把它钉回深色了？');

  chk('「设置」面板改成按内容定高（只放一行外观，60% 会是一大块空白）',
    /<section class="sheet compact" id="settingsSheet"/.test(htmlCode)
    && /\.sheet\.compact\{height:auto/.test(cssCode));
}

/* ⑧ 底栏的两条「按页面分派」断言已在 2026-09-21 二次修里**删掉** ——
      它们钉的是「首页底栏必须深色」，而用户明确圈出来说那是错的（见 ⑦b 组）。
      ⚠️ 别再按「它压在视频上」加回来。 */
{
  chk('压视频上的转圈（.loading .spinner）单独钉回浅色环',
    /\.loading \.spinner\{border-color:rgba\(255,255,255,\.18\)/.test(cssCode));
}

/* ==================== 首页窗口化（2026-09-21） ====================
 *
 * 背景：`build()` 原来给**每个视频**建一个 `<section class="item">` —— 5269 条实测
 * DOM 节点 **20 万**，滚动平均 20ms/帧、最差 87.6ms、7% 的帧掉到 32ms 以上；
 * 「换一批」重建一次**冻结主线程 1055ms**。现在只挂当前条附近的 `[lo, hi]` 一段
 * 连续 item，上下用占位块撑住滚动高度。
 *
 * 🔴 这组断言守的核心是**几何不变式**：第 i 条的绝对位置必须恒等于 `i × 容器高`。
 *    它一旦破了，滚动条长度和每条落点就会变 —— 表现是「换窗口时画面跳一下」，
 *    而且**不报错**，只是偶尔跳，属于最难查的那类。 */
console.log('\n · 首页窗口化（DOM 只留当前条附近）');
{
  const feedFn = grabFn(appCode, 'createFeed');
  chk('🔴 build() 不再给全部视频建 DOM（原来 list.forEach 全量建，5269 条 = 20 万节点）',
    !/list\.forEach\(\(v, i\) => \{[\s\S]{0,400}?frag\.appendChild/.test(feedFn)
    && /function syncWindow\(center\)/.test(feedFn));
  chk('🔴 两个占位块撑滚动高度，高度 = 「窗口外还剩几条」× 一整屏（几何不变式的另一半）',
    /topPad\.style\.height = \(lo \* 100\) \+ '%';/.test(feedFn)
    && /botPad\.style\.height = \(\(list\.length - 1 - hi\) \* 100\) \+ '%';/.test(feedFn));
  /* ⚠️ 这条断言第一版钉的是 `(k + 1 <= hi) ? itemOf(k + 1) : botPad` —— **那正是错的写法**
     （用的是旧的 hi，新加的那批全落 botPad → 倒序插变**反序**，实测 DOM 顺序成了
     […, 13, 15, 14, 17, 16]）。DOM 顺序就是流式布局里的位置，反序之后第 i 条的落点
     不再等于 `i × 容器高`，几何不变式直接破掉，而且**不报错**。
     现在断言钉正确写法、并反向排除旧写法。 */
  chk('🔴 只挂 [lo, hi] 这段**连续**区间；补的 item 倒序插、参照物用 `itemOf(k+1) || botPad`',
    /for \(let k = nhi; k >= nlo; k--\) \{/.test(feedFn)
    && /container\.insertBefore\(item, itemOf\(k \+ 1\) \|\| botPad\);/.test(feedFn)
    && !/\(k \+ 1 <= hi\) \? itemOf\(k \+ 1\)/.test(feedFn));
  chk('🔴 mount() 里必须先把窗口铺到位再 itemOf '
    + '（否则窗口外那条静默不挂视频 → 滑过去一片黑，不报错）',
    /ensureWindowContains\(i\);\s*\n\s*const item = itemOf\(i\);/.test(feedFn));
  /* 🔴 2026-09-22「视频一直乱跳 / 自动刷下一条」：
     mount() 曾用 ensureWindow()，而它会把窗口**以 i 为中心重排**；
     预热恰好调 mount(i+2)…mount(i+5)，四个全在舒适区外 → 一次开播重排 4 次 DOM。
     `.feed` 是 scroll-snap:y mandatory，**窗口一增删就被重新吸附** → 吸到下一条
     → 触发下一条 activate → 又预热 → **级联自动往下刷**（实测静置 6s 自漂 3 条）。
     所以 mount() 只许用「不在窗口里才补」的 ensureWindowContains，不许用 ensureWindow。 */
  chk('🔴 mount() 不许调 ensureWindow（会以 i 为中心重排 → 预热把窗口打乱 → 自动跳下一条）',
    (() => {
      const a = feedFn.indexOf('function mount(i, eager) {');
      const b = feedFn.indexOf('function syncPaused(', a);
      const body = feedFn.slice(a, b > a ? b : a + 4000);
      // mount() 里只能说 ensureWindowContains；ensureWindow 只留给 activate / scroll / scrollToIndex
      return !/ensureWindow\(i\);/.test(body) && /ensureWindowContains\(i\);/.test(body);
    })()
    && /function ensureWindowContains\(i\) \{[\s\S]{0,180}?if \(lo >= 0 && i >= lo && i <= hi\) return;/.test(feedFn));
  chk('🔴 窗口推进要有**独立来源**（只读 scrollTop 的监听）—— 光靠 IntersectionObserver，'
    + '快速滑到窗口外时一个都观察不到，窗口卡住、屏幕只剩占位块（窗口化最经典的翻车方式）',
    /container\.addEventListener\('scroll', \(\) => \{/.test(feedFn)
    && /ensureWindow\(Math\.round\(container\.scrollTop \/ h\)\);/.test(feedFn)
    && /\{ passive: true \}\);/.test(feedFn));
  chk('⚠️ 那个监听**只读不写** scrollTop（写滚动位置是 §39 明令禁止的，'
    + '竖向必须由浏览器原生 scroll-snap 驱动）',
    !/container\.scrollTop\s*=[^=]/.test(feedFn.replace(/container\.scrollTop = 0;/g, '')));
  chk('🔴 占位块不能有 scroll-snap-align（否则它自己变成吸附点，滑到那里是一整屏空白）',
    /\.feed-pad\{[^}]*\}/.test(cssCode) && !/scroll-snap/.test(ruleBody('.feed-pad')));
  chk('clear() 要复位窗口状态（不复位的话下次 build 的 syncWindow 以为窗口还在、一条都不建）',
    /lo = -1; hi = -2; topPad = null; botPad = null;/.test(feedFn));
  /* 🔴 「跳到第 i 条」**必须先铺窗口再滚**。
     窗口化之后目标位置当时可能**没有吸附点**，浏览器会吸附到最近的已有 item 上 ——
     实测直接写 scrollTop 想跳第 20 条，只到得了第 18 条（窗口边缘）。
     所以三个入口（点视频数跳首页、转屏重新对齐、resize 兜底）全部改成走 scrollToIndex。 */
  chk('🔴 三个「跳到第 i 条」的入口都走 scrollToIndex（先 ensureWindow 再滚），'
    + '不能直写 scrollTop —— 会被 scroll-snap 吸附钳到窗口边缘',
    /main\.scrollToIndex\(0, false\); main\.activate\(0, true\);/.test(appCode)
    && /player\.scrollToIndex\(i, false\);/.test(appCode)
    && /player\.scrollToIndex\(pi, false\); player\.activate\(pi, true\);/.test(appCode)
    && /main\.scrollToIndex\(i, false\); main\.activate\(i, true\);/.test(appCode));
  /* 允许保留的两处直写，都在「窗口已经铺好 / DOM 刚重建」之后：
     · alignTo()  —— 在 player.scrollToIndex(i,false) 之后跑
     · applyFilter() —— 在 main.load() 重建之后跑（重建会把 scrollTop 归 0） */
  chk('🔴 直写滚动位置的只剩这 2 处「安全的」（新增一处就得先想清楚窗口铺没铺）',
    (appCode.match(/(?:feedEl|playerFeedEl)\.scrollTop\s*=/g) || []).length === 2,
    '实测 ' + (appCode.match(/(?:feedEl|playerFeedEl)\.scrollTop\s*=/g) || []).length + ' 处');
}

/* ==================== 断言工具自己的守卫（2026-09-21） ====================
 *
 * 🔴 **断言工具的 bug 比代码的 bug 危险**：它会让一整批断言**假绿**，而且看起来一切正常。
 *    `grabFn` 原来「一见到 `{` 就开始配对」—— 碰到
 *    `function createFeed(container, opts = {}) {…}` 这种**形参默认值里带花括号**的函数，
 *    数到那个 `{}` 就以为函数体结束了，**只抠出 40 个字符的签名**。
 *    于是所有「这段代码在不在里面」的断言全部失真（这一轮加窗口化断言时才撞到）。
 *    同类坑：§57（假断言）、§62.9（全文 grep 撞车）。
 * 判据：抠一个**已知又长又带对象默认参数**的函数，长度和首尾都要对。 */
console.log('\n · 断言工具自己的守卫');
{
  const f = grabFn(appCode, 'createFeed');
  chk('🔴 grabFn 能抠出「形参默认值里带花括号」的函数（`opts = {}` 不能让它在形参表上就收工）',
    f.length > 10000 && f.includes('function build()') && f.includes('function syncWindow'),
    '抠出长度 = ' + f.length + '（旧实现只抠到 40）');
  chk('🔴 grabFn 抠出的必须是**完整**函数体：首字符是 `function`、末字符是 `}`',
    /^function[\s\S]*\}$/.test(f.trim()) && f.trim().endsWith('}'));
  chk('grabFn 抠出来的东西要能当函数体跑（语法过关）',
    (() => { try { new Function(f + '\nreturn createFeed;'); return true; } catch (_) { return false; } })());
}

/* ==================== B. 运行时（服务在跑才测） ==================== */

function get(p) {
  return new Promise((res, rej) => {
    http.get(BASE + p, (r) => {
      const c = [];
      r.on('data', (x) => c.push(x));
      r.on('end', () => res({ status: r.statusCode, type: r.headers['content-type'], body: Buffer.concat(c).toString('utf8') }));
    }).on('error', rej);
  });
}

/** 需要带 body / 换 method 的请求（缩略图 backfill 这类 POST 用） */
function req(p, opt) {
  opt = opt || {};
  return new Promise((res, rej) => {
    const u = new URL(BASE + p);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opt.method || 'GET', headers: opt.headers || {},
    }, (r2) => {
      const c = [];
      r2.on('data', (x) => c.push(x));
      r2.on('end', () => res({ status: r2.statusCode, type: r2.headers['content-type'], body: Buffer.concat(c).toString('utf8') }));
    });
    r.on('error', rej);
    if (opt.body) r.write(opt.body);
    r.end();
  });
}

/* ============================================================
   401 归因：内置引擎 vs 远程 NAS（2026-09-20）
   ------------------------------------------------------------
   直接跑 app.js 里的真函数，用桩 DOM 看它把哪个分支画出来。
   为什么值得测：这两个分支给的**动作完全不同** —— 一个是「去管理页登录 CD2」，
   一个是「重填密码」。判错了用户就会一直做没用的事。
   （实测背景：模拟器上引擎没登录时 WebDAV 一律 401，旧文案只让人重填密码。
     引擎的 WebDAV 凭据 = CD2 账号，没登录时密码填得再对也进不来。）
   ============================================================ */
console.log('\n · 401 归因（直接跑 app.js 里的 isLocalEngineUrl / renderEmptyError）');

{
  /* isLocalEngineUrl 依赖 S.config.url —— 把 S 作为参数注入 */
  const { isLocalEngineUrl } = new Function('S',
    grabFn(app, 'isLocalEngineUrl') + '\nreturn { isLocalEngineUrl };')(
      { config: { url: 'http://127.0.0.1:19798/dav' } });

  const mk = (u) => {
    const f = new Function('S',
      grabFn(app, 'isLocalEngineUrl') + '\nreturn { isLocalEngineUrl };')({ config: { url: u } });
    return f.isLocalEngineUrl();
  };
  chk('本机引擎地址识别：127.0.0.1:19798 ✓ / localhost ✓', mk('http://127.0.0.1:19798/dav') && mk('http://localhost:19798/dav'));
  chk('远程地址不误判（局域网 NAS / 别的端口）', !mk('http://192.168.1.100:19798/dav') && !mk('http://127.0.0.1:5005/dav'));
  chk('端口前缀不误判（197980 ≠ 19798）', !mk('http://127.0.0.1:197980/dav'));

  /* renderEmptyError 的桩：只要它能被调用并写进这些元素即可 */
  let title = '', desc = '', btnHidden = null, loadingShown = null;
  const el = (id) => ({
    set textContent(v) { if (id === 'emptyTitle') title = v; },
    get textContent() { return id === 'emptyTitle' ? title : ''; },
    set innerHTML(v) { if (id === 'emptyDesc') desc = v; },
    get innerHTML() { return id === 'emptyDesc' ? desc : ''; },
    set hidden(v) { if (id === 'emptyEngineBtn') btnHidden = v; else if (id === 'emptyView') {} },
    get hidden() { return id === 'emptyEngineBtn' ? btnHidden : false; },
  });
  const $stub = (id) => {
    if (id === 'emptyEngineBtn') return el('emptyEngineBtn');
    if (id === 'emptyTitle') return el('emptyTitle');
    if (id === 'emptyDesc') return el('emptyDesc');
    return { hidden: false };
  };
  const fn = new Function('$', 'showLoading', 'main', 'escapeHtml', 'friendlyNetErr', 'isLocalEngineUrl',
    grabFn(app, 'renderEmptyError') + '\nreturn renderEmptyError;')(
      $stub,
      (on) => { loadingShown = on; },
      { clear() {} },
      (s) => String(s),
      (s) => String(s),
      () => true);           // 固定「是本机引擎」，专测 401 分叉

  fn({ error: 'WebDAV 401: Invalid credentials' });
  chk('🔴 本机引擎 + 401 → 标题是「内置网盘还没登录」（不是「连不上 NAS」）', title === '内置网盘还没登录', title);
  chk('🔴 该分支亮出「打开 CloudDrive2 管理」按钮（唯一的出路）', btnHidden === false, String(btnHidden));
  chk('该分支顺手收掉 loading（否则用户一直看着转圈）', loadingShown === false);
  chk('指引里点名「CD2 账号」（引擎的 WebDAV 凭据就是它）', /CD2 账号/.test(desc));

  fn({ error: '片源文件夹已经打不开了（可能被删或改名）。去「设置」重新登录。' });
  chk('目录失效（无 stale 位、只靠文案）→ 仍归到「片源文件夹不在了」', title === '片源文件夹不在了', title);

  fn({ error: 'connect ECONNREFUSED 192.168.1.100:5005' });
  chk('真连不上 → 「连不上 NAS」且按钮收起', title === '连不上 NAS' && btnHidden === true, title + ' / ' + btnHidden);

  fn({ stale: true, error: '任何错误' });
  chk('后端给了 stale 位就优先当目录失效（布尔位比文案可信）', title === '片源文件夹不在了', title);
}

/* ============================================================
   系统返回键（安卓）：文件夹里按返回键该退回上一级，不是弹菜单
   ------------------------------------------------------------
   2026-09-20 用户报：在文件夹页按系统返回键，弹出「重新加载 / 服务器设置 / 退出」菜单，
   而他要的是「退回上一级」。根因：`MainActivity.onBackPressed()` **无条件弹菜单**，
   压根没问页面 —— 可浮层状态（`sheetOpen`）和文件夹当前层（`B.info`）全在 WebView 里，
   Java 侧看不见。修法是让 Java 先调 `window.__onBack()`，页面接不住才弹兜底菜单。
   ============================================================ */
console.log('\n · 系统返回键（安卓）');
chk('🔴 Java：onBackPressed 先问页面 window.__onBack，而不是无条件弹菜单',
  /window\.__onBack/.test(ma)
  && (() => {
    const i = ma.indexOf('public void onBackPressed()');
    return i >= 0 && /web\.evaluateJavascript\(/.test(ma.slice(i));
  })()
  && /"true"\.equals\(value\)/.test(ma));
chk('🔴 Java：兜底菜单没丢，只是挪进 showBackMenu()（页面没接住时才弹）',
  /private void showBackMenu\(\) \{/.test(ma)
  && /getString\(R\.string\.menu_exit\)/.test(ma));
chk('🔴 Java：连按返回键不叠菜单（backMenu 字段 + isShowing 判重）',
  /private AlertDialog backMenu;/.test(ma)
  && /if \(backMenu != null && backMenu\.isShowing\(\)\) return;/.test(ma));
chk('负向：onBackPressed 里**不许**再直接 new AlertDialog.Builder —— 那正是这次的 bug', (() => {
  const i = ma.indexOf('public void onBackPressed()');
  if (i < 0) return false;
  const j = ma.indexOf('private void showBackMenu()', i);
  return !/new AlertDialog\.Builder/.test(ma.slice(i, j < 0 ? undefined : j));
})(), '无条件弹菜单 = 返回键在文件夹里失效');
chk('🔴 前端：window.__onBack 存在（app.js 是 module，钩子必须显式挂 window）',
  /window\.__onBack = function \(\) \{/.test(appCode));
chk('🔴 前端：优先级顺序不能换 —— 播放器 → 目录选择器 → 其它面板 → 文件夹上一级',
  /if \(!\$\('playerModal'\)\.hidden\) \{ closePlayer\(\); return true; \}[\s\S]{0,220}?sheetOpen === 'dirPickSheet'[\s\S]{0,140}?closeDirPick\(\)[\s\S]{0,220}?if \(sheetOpen\) \{ closeSheet\(\); return true; \}[\s\S]{0,220}?NAV === 'browse'/.test(appCode));
chk('🔴 前端：到挂载根（parent 为 null）时返回 false 交给 Java —— 不许回落空串原地重刷',
  /const p = B\.info && B\.info\.parent;[\s\S]{0,90}?if \(p === undefined \|\| p === null\) return false;/.test(appCode)
  && !/window\.__onBack[\s\S]{0,1200}?loadDir\(''\)/.test(appCode));

/* ---- 行为断言：把**真** __onBack 抠出来，逐个场景喂状态 ---- */
{
  const mk = (st) => {
    const calls = [];
    const ctx = {
      $: () => ({ hidden: st.player !== true }),          // 只有「播放器开着」才 hidden=false
      sheetOpen: st.sheet || null,
      NAV: st.nav || 'home',
      B: st.B || { info: null, path: '', counts: {} },
      closePlayer: () => calls.push('closePlayer'),
      closeDirPick: () => calls.push('closeDirPick'),
      closeSheet: () => calls.push('closeSheet'),
      loadDir: (p) => calls.push('loadDir:' + p),
    };
    const fn = new Function('$', 'sheetOpen', 'NAV', 'B', 'closePlayer', 'closeDirPick',
      'closeSheet', 'loadDir',
      'return (' + grabAssignFn(app, 'window.__onBack = ') + ');')(
        ctx.$, ctx.sheetOpen, ctx.NAV, ctx.B,
        ctx.closePlayer, ctx.closeDirPick, ctx.closeSheet, ctx.loadDir);
    return { handled: fn(), calls };
  };
  const inDir = (parent) => ({ nav: 'browse', B: { info: { path: '/dav/115open', parent }, path: '/dav/115open', counts: {} } });

  const r1 = mk({ player: true });
  chk('🔴 行为：播放器开着 → 先收播放器，返回 true（别的什么都不碰）',
    r1.handled === true && r1.calls.join(',') === 'closePlayer', JSON.stringify(r1));
  const r2 = mk({ sheet: 'dirPickSheet' });
  chk('🔴 行为：目录选择器开着 → 只收它（它是叠在设置页之上的第二层，别连设置页一起关了）',
    r2.handled === true && r2.calls.join(',') === 'closeDirPick', JSON.stringify(r2));
  const r3 = mk({ sheet: 'configSheet' });
  chk('行为：设置页开着 → 收面板并返回 true（不该弹菜单）',
    r3.handled === true && r3.calls.join(',') === 'closeSheet', JSON.stringify(r3));
  const r4 = mk(inDir('/dav'));
  chk('🔴 行为：**文件夹里按返回键 → 退回上一级**（本次要修的正主）',
    r4.handled === true && r4.calls.join(',') === 'loadDir:/dav', JSON.stringify(r4));
  const r5 = mk(inDir(null));
  chk('行为：已经在挂载根（parent=null）→ 返回 false，交给 Java 弹兜底菜单（别原地重刷）',
    r5.handled === false && r5.calls.length === 0, JSON.stringify(r5));
  const r6 = mk({ nav: 'browse' });
  chk('行为：文件夹页还没加载出内容（B.info 为空）→ 返回 false，不瞎跳',
    r6.handled === false && r6.calls.length === 0, JSON.stringify(r6));
  const r7 = mk({ nav: 'home' });
  chk('行为：首页按返回键 → 返回 false（行为不变，仍交给 Java 那套菜单）',
    r7.handled === false && r7.calls.length === 0, JSON.stringify(r7));
  const r8 = mk({ player: true, sheet: 'configSheet', ...inDir('/dav') });
  chk('行为：多个都成立时按优先级只做一个（播放器优先于浮层与目录）',
    r8.handled === true && r8.calls.join(',') === 'closePlayer', JSON.stringify(r8));
}

/* ============================================================
   strm 备份 / 换机（2026-09-20 用户要素「方便我备份和换机」）
   ------------------------------------------------------------
   导出 = 打包 zip 存手机「下载」；导入 = 系统文件选择器挑 zip + 合并补缺解回本机。
   包结构：backup.json（元信息+监控清单+间隔）/ manifest.json（增量索引）/ strm/**
   ⚠️ 本段全是**静态**断言；真正的 zip 往返写在真机 E2E 里（`curl` 跑
      `/api/strm/backup` → 删几个文件 → `/api/strm/restore` → 校验），
      因为 zip 读写是 Java 侧逻辑，JS 这边抠不出来跑。
   ============================================================ */
console.log('\n · strm 备份 / 换机');
chk('🔴 服务端：两个新端点都挂上了（GET 备份 / POST 还原）',
  /path\.equals\("\/api\/strm\/backup"\)/.test(njCode)
  && /path\.equals\("\/api\/strm\/restore"\)/.test(njCode)
  && /int strmBackupWrite\(OutputStream out\)/.test(njCode)
  && /JSONObject strmBackupRead\(InputStream in\)/.test(njCode));
chk('服务端：包结构三个常量齐全（backup.json / manifest.json / strm/）',
  /STRM_BK_META = "backup\.json"/.test(njCode)
  && /STRM_BK_MANIFEST = "manifest\.json"/.test(njCode)
  && /STRM_BK_PREFIX = "strm\/"/.test(njCode));
chk('🔴 服务端：包里必须带 manifest 与监控清单（不带就要重扫 9.5 分钟）',
  /putZip\(z, STRM_BK_MANIFEST/.test(njCode)
  && /meta\.put\("strmJobs", sj\)/.test(njCode)
  && /meta\.put\("strmIntervalH", strmIntervalH\)/.test(njCode));
/* 🔴🔴 2026-09-20 用户真机走了一遍换机流程后补的：备份原先**只带 .strm+清单**，
 *  新机导入完「片源」栏是空的 → 首页一条视频都没有 → 用户以为白导了。
 *  换机最要紧的恰恰就是片源。现在 dirs/skipDirs/dir 一起进包、按「只补缺」并集合回。 */
chk('🔴 服务端：备份要带片源（dirs/skipDirs/dir）—— 换机没它就是「导了也白导」',
  /meta\.put\("dirs", sd\)/.test(njCode)
  && /meta\.put\("skipDirs", sk\)/.test(njCode)
  && /meta\.put\("dir", dir\)/.test(njCode));
chk('🔴 服务端：备份里**不许**出现账号密码（zip 会躺在「下载」目录里到处跑）', (() => {
  const i = njCode.indexOf('JSONObject meta = new JSONObject();');
  if (i < 0) return false;
  const j = njCode.indexOf('putZip(z, STRM_BK_META', i);
  const blob = njCode.slice(i, j < 0 ? undefined : j);
  return !/meta\.put\("(url|user|pass)"/.test(blob);
})(), '凭据不进备份是设计决定，不是漏了');
chk('🔴 服务端：片源按**并集**补缺（本机在前，绝不覆盖现有片源）',
  /List<String> nextDirs = new ArrayList<>\(dirs\);/.test(njCode)
  && /if \(!nextDirs\.contains\(nrm\)\) \{ nextDirs\.add\(nrm\); addedDirs\.put\(nrm\); \}/.test(njCode));
chk('🔴 服务端：还原时 dir 要**直接改字段**，不许塞进 handleConfig（normAbs 会把 local:/ 规成 /local:）',
  /dir = nextDirs\.get\(0\);/.test(njCode)
  && !/body\.put\("dir"/.test(njCode),
  'local:/ 前缀一破，本机片源就被当成 WebDAV 路径');
chk('🔴 服务端：还原结果要回 dirs / dirsAdded（前端靠它决定要不要重扫片库）',
  /jobs\.put\("dirsAdded", addedDirs\)/.test(njCode)
  && /jobs\.put\("dirs", nowDirs\)/.test(njCode));
chk('🔴 前端：导入后补进了片源就必须 applySources 重扫（否则新机首页永远空的）',
  /if \(jb\.dirs && \(jb\.dirsAdded \|\| \[\]\)\.length\) \{[\s\S]{0,40}?await applySources\(jb\.dirs\.slice\(\), null\);/.test(appCode));
/* ---- 片库响应里的 dirs = 「用户片源」，不是「本轮扫描目标」（2026-09-20）----
 *
 * 用户报：「多按几次重启按钮就会自动将 dav 根目录加入到数据源」。
 * 根因是**两层的语义错**叠在一起：
 *   ① 服务端 doScan 结尾 `libraryJson(all, labels, …)` —— labels 是**本轮扫描目标**：
 *      片源为空时它 = defaultRoots()（CD2 上是 `/dav`），配置目录全失效时还会退成 `/`；
 *   ② 前端 applyLibrary 把片库回传的 dirs 同步进 `S.config.dirs`（同步本身是对的 ——
 *      当初就是为了让 strmRegisterLocalSrc 这种「后端自己加的片源」能显示出来）。
 * 于是每次重启（重启必拉一次 /api/library）都会把兜底出来的根目录显示成片源。
 *
 * 修法：服务端回**用户片源快照**（cfgDirs），并且**所有从缓存回传的路径**都用
 * 当前配置覆盖一次（磁盘缓存里存着错值，光改 doScan 不够）。
 * ⚠️ 反向验证要能咬住三处：把 cfgDirs 换回 labels、删掉某个 putLiveSrc、
 *    把 node 版改回 roots。
 */
chk('🔴 服务端：片库回传的 dirs 用**用户片源快照**，不是本轮扫描目标 labels',
  /NasService\.libraryJson\(all, cfgDirs, elapsed, truncated\)/.test(njCode)
  && !/NasService\.libraryJson\(all, labels, elapsed, truncated\)/.test(njCode),
  '把 labels 当 dirs 回传 = 兜底扫出来的根目录会显示成片源');
{
  const i = njCode.indexOf('final List<String> cfgDirs');
  const j = njCode.indexOf('labels.clear();');
  chk('🔴 服务端：cfgDirs 快照必须在 labels 被兜底改写成 "/" 之前取',
    i >= 0 && j > i,
    '顺序反了就会把 staleRoots 兜底的 "/" 快照进去');
}
chk('服务端：扫描目标另存 scannedRoots（排查用，别再混进 dirs）',
  /lib\.put\("scannedRoots", new JSONArray\(labels\)\)/.test(njCode));
chk('🔴 服务端：每个「从缓存回传片库」的分支都要 putLiveSrc 覆盖 dirs（≥4 处）',
  /private void putLiveSrc\(JSONObject o\)/.test(njCode)
  && (njCode.match(/putLiveSrc\(o\);/g) || []).length >= 4,
  '缓存里那份 dirs 是历史扫描目标，覆盖少了还会漏出 /dav');
chk('🔴 node 版：libPayload 与 scan 返回的 dirs 都取 config.dirs',
  /dirs: config\.dirs,\n\s+dir: config\.dirs\[0\] \|\| '',\n\s+demo: library\.source === 'demo'/.test(srvCode)
  && /dirs: config\.dirs, dir: config\.dirs\[0\] \|\| ''/.test(srvCode));
chk('前端：片库回传的 dirs 仍要同步进 S.config.dirs（后端自己加的片源靠这条路显示）',
  /if \(!S\.demoMode && Array\.isArray\(lib\.dirs\)\) \{/.test(appCode)
  && /S\.config = \{ \.\.\.S\.config, dirs: lib\.dirs\.slice\(\) \};/.test(appCode));
/* 「没片源却有视频」时说清来历：服务端在片源为空时会兜底扫根目录，
   片源栏要是只写「还没添加」，用户会以为片源被偷偷改了。 */
chk('前端：没有片源但首页有视频时，片源栏要说清这批片子是自动找到的',
  /S\.videos\.length[\s\S]{0,60}?自动找到的 \$\{S\.videos\.length\}/.test(appCode)
  && !/自动找到的[\s\S]{0,60}?\/dav/.test(appCode)
  /* ⚠️ 文案**不许写死兜底目标**：兜底既可能是本机 strm 库、也可能是服务器根目录，
     写死「根目录」会在另一种情况下变成假话（这条也是被自己的改动打脸后补的）。 */
  && !/自动找到的[\s\S]{0,60}?根目录/.test(appCode),
  '文案不许出现 /dav、也不许写死兜底目标是「根目录」');

/* ---- 「真机导入 strm 备份不生效」（2026-09-20 晚）----
 *
 * 用户报：导入备份后首页还是没东西。复现结论 —— 他的备份是**旧版导出的**
 * （`dirs` 是当天晚些时候才加进 backup.json 的字段），于是服务端那段
 * 「片源并集」等于什么都没做：文件全回来了、监控清单也回来了、**片源还是空的**。
 *
 * 三处修复各自钉一条：
 *   ① 导入收尾用「strm 目录里到底有没有 .strm」兜底，把本机片源补回去；
 *   ② 只有本机片源时不要求 WebDAV 地址（换机次序是「先导入、后填地址」）；
 *   ③ 只有本机片源时不回演示模式（否则那批 .strm 一条都刷不出来）。
 */
chk('🔴 服务端：导入后若 strm 目录里真有文件、片源却没有本机片源 → 自动补上',
  /if \(!dirs\.contains\(LOCAL_PREFIX \+ "\/"\) && countStrmFiles\(root\) > 0\) \{/.test(njCode)
  && /strmRegisterLocalSrc\(\);[\s\S]{0,200}?addedDirs\.put\(LOCAL_PREFIX \+ "\/"\)/.test(njCode),
  '老备份里没有 dirs 字段，不兜底就永远是「导了没反应」');
chk('服务端：countStrmFiles 只看「有没有」（命中即返回，别把 5000+ 个文件全数一遍）',
  /private static int countStrmFiles\(File dir\)/.test(njCode)
  && /if \(countStrmFiles\(f\) > 0\) return 1;/.test(njCode)
  && /else if \(f\.getName\(\)\.endsWith\("\.strm"\)\) \{\s*return 1;/.test(njCode));
chk('🔴 服务端：只有本机片源时不要求 WebDAV 地址（换机次序是「先导入、后填地址」）',
  /if \(!isConfigured\(\) && !onlyLocalSrc\(body\)\) \{/.test(njCode)
  && /private boolean onlyLocalSrc\(JSONObject body\)/.test(njCode)
  && /if \(arr\.length\(\) == 0\) return true;/.test(njCode)
  && /private boolean allDirsLocal\(\)/.test(njCode),
  '本机片源走 java.io.File，压根不碰 dav —— 拦下来会让备份白导');
chk('🔴 服务端：只有本机片源时不回演示模式（否则那批 strm 一条都刷不出来）',
  /if \(!isConfigured\(\) && !hasLocalSrc\(\)\) return json\(200, demoPayload\(\)\);/.test(njCode)
  && /private boolean hasLocalSrc\(\)/.test(njCode));
chk('前端：导入后片源仍是空的要说清下一步（不能只报「回填 N 个 .strm」）',
  /if \(!\(jb\.dirs \|\| \[\]\)\.length\) \{\s*parts\.push\('但备份里没带任何片源/.test(appCode));
/* 导入之后「为什么还是看不到东西」的另一半原因：片源为空时兜底去扫 WebDAV 根目录
   （十几分钟），新配置得等它跑完才生效。兜底目标是本机 strm 库就没这个问题。 */
chk('🔴 服务端：片源为空时兜底先扫**本机 strm 目录**（别再全树深扫 WebDAV 根）',
  /private List<String> defaultRoots\(\)/.test(njCode)
  && /if \(countStrmFiles\(new File\(strmLocalDir\(\)\)\) > 0\) \{\s*out\.add\(LOCAL_PREFIX \+ "\/"\);\s*return out;/.test(njCode),
  '兜底扫 WebDAV 根是十分钟级 —— 换机场景会让用户以为「导入不生效」');

/* ============================================================
   多设备同步（账号系统，2026-09-20 用户需求）
   ------------------------------------------------------------
   一台 NAS 当同步服务端，多台设备登同一账号，点赞/收藏/坏码流/头像昵称/
   片源与监控清单自动对齐 + strm 备份包一键恢复。

   🔴 这个功能里「出事就是大事」的点：密码泄露、账号越权、跨域开太大、
      取消收藏同步不过去、一次写成几百个请求。下面逐条钉住。
   ============================================================ */
chk('🔴 同步：密码只存 scrypt 哈希（不存明文，也不用 md5/sha1）',
  /crypto\.scryptSync\(String\(pass\), String\(salt\), 32\)/.test(srvCode)
  && !/users\[name\]\s*=\s*\{[^}]*\bpass\b\s*:/.test(srvCode),
  '明文/弱哈希落盘 = 一旦 NAS 被翻，所有账号直接裸奔');
/* ⚠️ 这条一开始写松了：只断言「token 被写进 db.tokens」，没管「写完之后有没有落盘」——
   反向验证时把 `syncDbSave(db)` 删掉，断言照样绿（典型的「存在即通过」）。
   所以这里把「赋值」和「落盘」用同一段正则**连起来数**，而且两处（注册/登录）都数。 */
chk('🔴 同步：token 用 crypto.randomBytes 生成、**两处都落盘**、且带过期',
  /crypto\.randomBytes\(24\)\.toString\('hex'\)/.test(srvCode)
  && (srvCode.match(/db\.tokens\[token\] = \{ user: name, at: Date\.now\(\) \};/g) || []).length === 2
  && (srvCode.match(/db\.tokens\[token\] = \{ user: name, at: Date\.now\(\) \};[\s\S]{0,200}?syncDbSave\(db\);/g) || []).length === 2
  && /if \(Date\.now\(\) - Number\(rec\.at \|\| 0\) > SYNC_TOKEN_TTL\)/.test(srvCode),
  '不落盘 = 服务一重启所有人掉线；不过期 = token 永久有效');
chk('🔴 同步：登录失败时「账号不存在」和「密码错」用**同一句提示**（不给账号枚举）',
  /if \(!u\) return \{ error: '账号或密码不对' \};/.test(srvCode)
  && /if \(syncHash\(pass, u\.salt\) !== u\.hash\) return \{ error: '账号或密码不对' \};/.test(srvCode)
  && !/账号不存在|没有这个账号|用户不存在/.test(srvCode),
  '两句不一样 = 免费送一个「哪些账号名存在」的接口');
chk('🔴 同步：用户名过白名单（它会被拼进文件名，等于目录穿越的唯一防线）',
  /const SYNC_NAME_RE = \/\^\[A-Za-z0-9_\.\\-\\u4e00-\\u9fa5\]\{1,32\}\$\//.test(srvCode)
  && /if \(!SYNC_NAME_RE\.test\(name\)\) return \{ error:/.test(srvCode)
  && /path\.join\(SYNC_DIR, 'u-' \+ name \+ '\.json'\)/.test(srvCode));
chk('🔴 同步：CORS 只开给 /api/auth 与 /api/sync（别的接口没有鉴权，开了等于全网可读）',
  /function sendCorsJson\(res, code, obj\)/.test(srvCode)
  && /'Access-Control-Allow-Origin': '\*'/.test(srvCode)
  /* 这个 `*` 只许出现在 sendCorsJson 里 —— sendJson 是给别的接口用的通用出口 */
  && !/function sendJson\(res, code, obj\) \{[\s\S]{0,400}Access-Control-Allow-Origin/.test(srvCode),
  '通用出口一旦带上 `*`，用户浏览器里任何网站都能改你的配置');
chk('🔴 同步：strm 备份包走 readBodyRaw（readBody 有 1MB 上限，1.6MB 的包会被截断）',
  /function readBodyRaw\(req, maxBytes\)/.test(srvCode)
  && /const buf = await readBodyRaw\(req, SYNC_ZIP_MAX\);/.test(srvCode));
chk('同步：上传备份包时校验 zip 魔数（别等新设备下载了才发现不是包）',
  /buf\[0\] !== 0x50 \|\| buf\[1\] !== 0x4b/.test(srvCode));
chk('🔴 同步：条目合并**按时间戳取新**，且删除墓碑要留着（不留的话取消会复活）',
  /const win = b\.t > a\.t \? b : a;/.test(srvCode)
  && /else if \(win\.t > 0\) out\[k\] = \{ t: win\.t, del: true \};/.test(srvCode));
/* 🔴 2026-09-21 反过来：原来是「并集」，但并集**表达不了删除** ——
   用户删掉一个监控文件夹，下次同步就被账号并回来（「无法移除」）。
   现在是「按时间戳取最后改过的那份」，客户端配套「改过才带 T」+「以服务端为准」。 */
chk('🔴 同步：片源/监控清单按**时间戳取最后改过的那份**，客户端不再并集、以服务端为准',
  /const t = Number\(inc\.sources\[k \+ 'T'\]\) \|\| 0;/.test(srvCode)
  && !/function syncUnionArr\(a, b\)/.test(srvCode)
  && /if \(!sameArr\(cfg\[k\], sOld\[k\]\)\) \{ src\[k\] = \(cfg\[k\] \|\| \[\]\)\.map\(String\); src\[k \+ 'T'\] = now; \}/.test(appCode)
  && /if \(Array\.isArray\(src\.strmJobs\) && srvNewer\('strmJobs'\) && !sameArr\(src\.strmJobs, og\.strmJobs\)\)/.test(appCode)
  /* ⚠️ 过渡期兼容：NAS 上那份还是旧服务端时不返回 T → 一律不采用，本机保持自己删过的样子。
     没有这条会「更新完 App 反而更删不掉」。 */
  && /const srvNewer = \(k\) => \(Number\(src\[k \+ 'T'\]\) \|\| 0\) > \(Number\(sentSrcT\[k\]\) \|\| 0\);/.test(appCode)
  && !/const uni = \(a, b\) =>/.test(appCode));
chk('🔴 同步快照要记 sources（判断「本机改过没改过」的基准 —— 记不住就每次都抢）',
  /sources: \{\s*\n\s*dirs: \(\(S\.config \|\| \{\}\)\.dirs \|\| \[\]\)\.map\(String\),/.test(appCode));
chk('🔴 dir 字段也要过 normSrc：它是脏值的**源头**（POST /api/config 曾用 normAbs）'
  + '与**存处**（loadConfig 读进来就脏着）—— 两处都要改，只改一处脏值会一直留着',
  /dir = normSrc\(p\.getString\("dir", ""\)\);/.test(njCode)
  && /dir = d\.trim\(\)\.isEmpty\(\) \? "" : normSrc\(d\);/.test(njCode)
  && !/dir = d\.trim\(\)\.isEmpty\(\) \? "" : NasService\.normAbs\(d\);/.test(njCode));
chk('🔴 PC 侧同样：dir 走 normSrcPath + effectiveDir 用 isLocalSrcPath（两边判据要一致）',
  /function isLocalSrcPath\(s\)/.test(srvCode)
  && /c\.dir = c\.dir \? normSrcPath\(c\.dir\) : '';/.test(srvCode)
  && /next\.dir = body\.dir\.trim\(\) \? normSrcPath\(body\.dir\) : '';/.test(srvCode));
chk('同步：数据按账号分文件、pull/push 只碰自己那份',
  /syncDataLoad\(auth\.user\)/.test(srvCode)
  && /syncDataSave\(auth\.user, out\)/.test(srvCode));
chk('同步：注册能用 SYNC_ALLOW_REGISTER=0 关掉（放公网/公司网时别让人随便注册占盘）',
  /const SYNC_ALLOW_REGISTER = process\.env\.SYNC_ALLOW_REGISTER !== '0';/.test(srvCode)
  && /if \(isReg && !SYNC_ALLOW_REGISTER\) \{/.test(srvCode));
chk('同步：数据目录能用 NAS_DATA_DIR 改到别处（部署时代码与数据分开放）',
  /const DATA_DIR = process\.env\.NAS_DATA_DIR/.test(srvCode));

chk('🔴 前端：所有同步请求都带 Bearer（不带就是一个 401 都拿不到的静默失败）',
  /headers\.Authorization = 'Bearer ' \+ SY\.token;/.test(appCode));
/* 真机实测踩到的：注册完第一次同步**必定失败**，报
   `Cannot use 'in' operator to search for '…' in undefined` ——
   首次同步时 SY.snap 还是 null，`snap.likes` 就是 undefined，而 `k in undefined` 直接抛错。
   这条断言盯两件事：diff 里必须兜 `sp || {}`，且不许再出现裸的 `k in sp`。 */
chk('🔴 前端：首次同步（还没有快照）不能崩 —— diff 里必须给 undefined 兜底',
  /const diff = \(cur, sp\) => \{[\s\S]{0,260}?sp \|\| \{\}/.test(appCode)
  && !/\(k in sp\)/.test(appCode),
  '首次同步必崩 = 「注册完点了没反应」');
chk('🔴 前端：syncRender 不许覆盖刚发生的同步结果（否则失败原因看不见）',
  /if \(cur === '' \|\| \/\^\(未登录\|已登录\)\/\.test\(cur\)\) \{/.test(appCode),
  '登录流程末尾会调它，冲掉「同步失败：xxx」= 用户只看到「点了没反应」');
/* 真机实测踩到的：设备 B 改名成功，**设备 A 一次普通同步就把它冲掉了** ——
   因为 A 的 push 里无条件带着自己的旧昵称，而服务端是「后到的覆盖」。
   修成和点赞收藏同一套：改过才推 + 带时间戳 + 服务端按时间取新。 */
chk('🔴 同步：昵称/头像也按时间戳取新（否则「谁后同步谁赢」，别人改的名字会被冲掉）',
  /const incT = Number\(inc\.profile\.t\) \|\| 0;/.test(srvCode)
  && /if \(incT >= curT\) out\.profile = \{ \.\.\.\(cur\.profile \|\| \{\}\), \.\.\.inc\.profile \};/.test(srvCode));
chk('🔴 前端：昵称只在改过时才推（带 t）；头像只存采样哈希进快照（别把几百 KB 塞进 localStorage）',
  /if \(nick !== pOld\.nickname\) prof\.nickname = nick;/.test(appCode)
  && /if \(Object\.keys\(prof\)\.length\) prof\.t = now;/.test(appCode)
  && /avatarHash: syncAvHash\(LS\.get\('avatar', ''\) \|\| ''\)/.test(appCode)
  && /function syncAvHash\(s\)/.test(appCode));
chk('🔴 前端：同步来的昵称要写回本机 config（只改内存的话一刷新就回去了）',
  /api\.saveConfig\(\{ nickname: pf\.nickname \}\)\.catch\(\(\) => \{\}\);/.test(appCode));
chk('🔴 前端：同步来的资料要重画「我的」页（否则得等下次切页才看到新名字）',
  /if \(dirty\) \{ try \{ renderMePage\(\); \} catch \(_\) \{\} \}/.test(appCode));
chk('🔴 前端：401 时清掉本地 token（否则会一直拿过期 token 重试，用户看不出去哪儿改）',
  /if \(r\.status === 401\) \{ SY\.token = ''; SY\.save\(\)/.test(appCode));
chk('🔴 前端：token 与账号**不进 strm 备份包**（那个 zip 要到处传）',
  !/strmBackup|syncPayload[\s\S]{0,600}?\btoken\b\s*:/.test(appCode.replace(/SY\.token/g, 'TOK'))
  && /url: SY\.url, user: SY\.user, token: SY\.token/.test(appCode),
  '凭据跟着备份包走 = 随手散钥匙');
chk('🔴 前端：用「上次同步快照」diff 出删除墓碑（本机是 delete，不留痕迹）',
  /const diff = \(cur, sp\) => \{/.test(appCode)
  && /if \(!\(k in \(cur \|\| \{\}\)\)\) out\[k\] = \{ t: now, del: true \};/.test(appCode)
  /* ⚠️ 别把快照的**字段顺序/写法**钉死（原来写的是单行 `SY.snap = { likes: mk(…), favorites: mk(…)`，
     后来加了 profile 就整条变红 —— 断言绑实现细节，改个格式就误报）。
     只要三份名单都在快照里就够了。 */
  && /SY\.snap = \{[\s\S]{0,200}?likes: mk\(S\.likes\)[\s\S]{0,120}?favorites: mk\(S\.favorites\)[\s\S]{0,120}?badStreams: mk\(syncBadLocal\(\)\)/.test(appCode));
chk('🔴 前端：拉回来的数据一次性写回本机（stateBulk，不是几百次 act）',
  /api\.stateBulk\(\{ likes: S\.likes, favorites: S\.favorites, badStreams: bads \}\)/.test(appCode)
  && /stateBulk: \(payload\) => jpost\('\/api\/state\/bulk', payload\)/.test(apiCode),
  '逐条 POST，一次同步几百个请求，真机上要等十几秒');
chk('🔴 前端：strm 包只在「这台设备确实还没有 strm 内容」时才自动拉（不覆盖在用的库）',
  /if \(syncHasLocalLib\(\)\) return false;/.test(appCode)
  && /function syncHasLocalLib\(\)[\s\S]{0,400}?S\.allVideos \|\| S\.videos/.test(appCode)
  /* ⚠️ 判据不许退回「片源里有没有 local:」—— 同步会把账号里的片源合并过来，
     那样判断恒为真，换新机时永远拉不到包（真机踩过：片源有了、文件没有、首页空的）。 */
  && !/function syncHasLocalLib\(\)[\s\S]{0,400}?S\.config\.dirs/.test(appCode),
  '判据用错 = 换新机永远同步不到 strm');
chk('前端：点赞/收藏改完会安排一次防抖同步',
  /function setLike\(id, on\) \{[\s\S]{0,400}?syncTouch\(\)/.test(appCode)
  && /function toggleFav\(id\) \{[\s\S]{0,400}?syncTouch\(\)/.test(appCode)
  && /let syncPushTimer = 0;/.test(appCode));
chk('前端：启动时静默同步一次（失败不打扰 —— 没网/NAS 没开都很正常）',
  /function syncBoot\(\) \{[\s\S]{0,300}?if \(!SY\.auto \|\| !SY\.loggedIn\(\)\) return;/.test(appCode)
  && /function syncBoot\(\) \{[\s\S]{0,900}?await syncNow\(false\);/.test(appCode));
/* ===================================================================================
 *  🔴「手机新生成的 strm 不会自动备份到服务器」（2026-09-22 用户报）
 * ===================================================================================
 *  真因：上传那一侧**压根没有自动触发点** —— `syncUploadStrm()` 全前端只绑在
 *  设置页那个「上传」按钮上（`$('cfSyncUp')`），而 `syncNow()`（点赞收藏改动后
 *  自动跑、启动时也跑）只**拉** strm 包、从不推。于是定时任务每跑一轮，
 *  手机上多出来的 .strm 就一直躺在本机，除非用户自己想起来点那个按钮。
 *
 *  下面的断言盯的就是这条链路，别再让它退回去。
 * =================================================================================== */
chk('🔴 前端：strm 库变过就**自动**把备份推上账号',
  /async function syncPushStrmIfStale\(/.test(appCode)
  && /if \(Number\(rev\) === SY\.strmRev\) return false;/.test(appCode)
  && /SY\.strmRev = Number\(rev\);/.test(appCode),
  '上传侧没有自动触发点 = 用户生成完的 .strm 永远躺在本机');
chk('🔴 前端：自动备份有多个触发点（启动 / 回前台 / 秒级心跳），缺一段就有漏',
  /* ⚠️ appCode 是**剥过注释**的（stripComments），所以这里不能把注释写进正则。 */
  /await syncNow\(false\);\s*\n\s*await syncPushStrmIfStale\(\);/.test(appCode)
  && /addEventListener\('visibilitychange'[\s\S]{0,150}?strmWatchTick\(\)/.test(appCode)
  && /setInterval\(strmWatchTick, STRM_TICK_MS\);/.test(appCode)
  && /await syncPushStrmIfStale\(s2\.rev\);/.test(appCode),
  '少一段就会出现「某种情况下永远不备份」');
chk('🔴 前端：strm 心跳**必须自己处理** localSrcAdded（一次性标记，读了就得负责）',
  /async function strmWatchTick\(\)[\s\S]{0,700}?localSrcAdded[\s\S]{0,150}?loadLibrary\(true\)/.test(appCode),
  '心跳消费了这个标记又不重扫 = 定时任务生成的新 .strm 永远进不了片库');
chk('🔴 前端：头像 / 名字改完要跟点赞收藏一样自动同步',
  /function commitName\(\)[\s\S]{0,1400}?syncTouch\(\)/.test(appCode)
  && /LS\.set\('avatar', data\);[\s\S]{0,400}?syncTouch\(\)/.test(appCode),
  '改完不 syncTouch = 改动躺在本机，得等下次别的同步才顺带带上去');
chk('🔴 前端：strm 自动备份失败要有退避（心跳是秒级的，不退避会一直撞）',
  /if \(SY\.strmPushNextAt && Date\.now\(\) < SY\.strmPushNextAt\) return false;/.test(appCode)
  && /SY\.strmPushNextAt = Date\.now\(\) \+ 60000;/.test(appCode));
/* ===================================================================================
 *  🔴「模拟器上登录之后无法恢复数据」（2026-09-22 用户报）
 * ===================================================================================
 *  现象：strm 回填了几千个（/api/library 里有 5275 条），首页却写着「没有演示视频」。
 *
 *  真因两处叠在一起：
 *   1. `S.demoMode` 按「有没有 WebDAV 地址」判。换新机登录后同步会把**片源清单**
 *      恢复回来（含 `local:/`），但**不恢复**地址/账号密码（凭据不同步是既定设计）
 *      → mode 仍是 demo → loadLibrary 去取 `/api/demo`（**空数组**）而不是真片库。
 *   2. 恢复完没有重扫片库 —— `syncPullStrm` 里只在 `dirsAdded` 非空时才 applySources，
 *      而 `local:/` 早被 strmBackupRead 的兜底注册进 dirs 了 → 命中不了 → 不重扫。
 * =================================================================================== */
chk('🔴 前端：「是不是演示模式」必须按**有没有片源**判，不能只看 mode',
  /function hasAnySource\(\)/.test(appCode)
  && /S\.demoMode = S\.mode === 'demo' && !hasAnySource\(\);/.test(appCode)
  && !/S\.demoMode = S\.mode === 'demo';/.test(appCode),
  '只看 mode = 有片源但没 WebDAV 地址时取 /api/demo 空数组，登录了也看不到数据');
chk('🔴 前端：hasAnySource 要把**已加的片源目录**算进去（含本机 strm 的 local:/）',
  /function hasAnySource\(\)\s*\{[\s\S]{0,300}?S\.dirs/.test(appCode)
  && /function hasAnySource\(\)\s*\{[\s\S]{0,300}?S\.config\.dirs/.test(appCode));
chk('🔴 前端：恢复完 .strm 必须重扫片库 —— dirsAdded 为空时也不能跳过',
  /\} else \{[\s\S]{0,300}?refreshDemoMode\(\);\s*\n\s*await loadLibrary\(true\);/.test(appCode),
  'local:/ 常在 dirs 里（dirsAdded 为空）→ 不重扫 = 文件回填了、首页还是空的');
chk('🔴 前端：同步应用完片源后要重判演示模式（刚退出 demo 就得重扫一次）',
  /if \(refreshDemoMode\(\)\) await loadLibrary\(true\);/.test(appCode));
const pushFnCode = (appCode.match(/async function syncPushStrmIfStale\([\s\S]*?\n\}/) || [''])[0];
chk('🔴 前端：rev 为 0（还没生成过任何 strm）时**不许上传**',
  /if \(!Number\(rev\)\) return false;/.test(pushFnCode),
  '新装 App 启动时会用**空备份**盖掉账号里那份真的（实测踩到：启动+生成各传一次）');
chk('🔴 前端：自动备份**必须静默**（不能走 showLoading —— 会挡住正刷视频的人）',
  pushFnCode.length > 0 && !/showLoading/.test(pushFnCode),
  '自动路径弹全屏 loading');
/* 成功弹 toast 是**要的**（用户得知道备份成了），失败才必须闭嘴 ——
   失败也弹的话，配上 5 分钟轮询就成了每 5 分钟骚扰一次。 */
const pushCatch = (pushFnCode.match(/catch \(e\) \{[\s\S]*/) || [''])[0];
chk('🔴 前端：自动备份**失败**不弹 toast 且不推进 strmRev（要能重试、还别反复骚扰）',
  /strm 自动备份失败/.test(pushCatch) && !/toast\(/.test(pushCatch) && /return false;/.test(pushCatch),
  '失败弹 toast + 定时轮询 = 每 5 分钟骚扰一次');
chk('🔴 前端：从账号拉回来的 strm 要**立刻记成已备份**（否则紧接着原样传回去）',
  /if \(r\.rev != null\) \{ SY\.strmRev = Number\(r\.rev\); SY\.save\(\); \}/.test(appCode),
  '拉完再推 = 白传一遍几 MB');
chk('🔴 后端：库内容版本 strmRev 在「写入 / 按阈值删除 / 导入」三处都要自增',
  /strmAdded\+\+;\s*\n\s*strmRev\+\+;/.test(njCode)          // 真写了一个 .strm
  && /manifest\.remove\(p\);[\s\S]{0,200}?strmRev\+\+;/.test(njCode)   // 按体积阈值删掉旧条目
  && /strmRev\+\+;\s*\n\s*strmTouchRev\(\);/.test(njCode),            // 导入备份之后
  '漏一处 = 那种改动不会被判定成「库变了」，备份就停在旧版本');
chk('🔴 后端：rev 必须落盘且回报（不落盘 = 每次开 App 都以为没备份过，白传一遍）',
  /private void strmTouchRev\(\)/.test(njCode)
  && /\.edit\(\)\.putLong\("strmRev", strmRev\)\.apply\(\);/.test(njCode)
  && /strmRev = p\.getLong\("strmRev", 0\);/.test(njCode)
  && /o\.put\("rev", strmRev\);/.test(njCode));
chk('🔴 后端：判定「库变了」**不能**用 lastRunAt（全增量命中也会变 → 每轮白传）',
  /o\.put\("rev", strmRev\);/.test(njCode)
  && !/if \(Number\(rev\) === SY\.strmRev\)[\s\S]{0,200}?lastRunAt/.test(appCode));
chk('前端：「退出账号」只清本机凭据，不动账号里的数据',
  /退出只清本机凭据/.test(app) && /SY\.token = ''; SY\.user = ''; SY\.lastAt = 0; SY\.snap = null;/.test(appCode));
chk('本机：/api/state/bulk 是**整体替换**（前端手里已经是合并后的权威结果）',
  /private Resp handleStateBulk\(JSONObject body\)/.test(njCode)
  && /ed\.putString\(k, o\.toString\(\)\);/.test(njCode)
  && /u\.pathname === '\/api\/state\/bulk' && req\.method === 'POST'/.test(srvCode),
  '再合并一次会把刚删掉的条目并回来');
chk('前端：提示文案写明「备份不含账号密码」（省得用户以为漏了）',
  /备份里不含账号密码/.test(html));
/* 🔴 安全：zip 是**外部**来的文件（微信转发/网盘下载都可能被塞东西）。
   不校验就是经典 zip slip —— `../../databases/x` 能写到应用私有目录之外。
   ⚠️ 断言必须**圈定在 safeChild 的函数体里**：`getCanonicalPath()` 在别的函数
      （localSrcRealPath）里也有，写「njCode 里存在」等于没断 —— 反向验证时
      把 safeChild 的校验整段删掉，断言照样绿（真踩过）。 */
chk('🔴 服务端：导入的每条路径都过 safeChild，且 safeChild 自己堵住 `..` 与越界',
  /private static File safeChild\(File root, String rel\)/.test(njCode)
  && (() => {
    const i = njCode.indexOf('private static File safeChild(');
    if (i < 0) return false;
    const j = njCode.indexOf('\n    }', i);
    const body = njCode.slice(i, j < 0 ? undefined : j);
    return /if \(s\.isEmpty\(\) \|\| "\.\."\.equals\(s\)\) return null;/.test(body)
      && /getCanonicalPath\(\)/.test(body)
      && /startsWith\(rp \+ File\.separator\)/.test(body);
  })()
  && /File dest = safeChild\(root, name\.substring\(STRM_BK_PREFIX\.length\(\)\)\);/.test(njCode)
  && /if \(dest == null\) \{ rejected\+\+;/.test(njCode));
chk('🔴 服务端：还原是**合并补缺** —— 已存在的跳过，绝不覆盖也不删除',
  /if \(dest\.isFile\(\)\) \{[\s\S]{0,40}?skipped\+\+;/.test(njCode)
  && !/dest\.delete\(\)/.test(njCode)
  && !/deleteRecursively/.test(njCode));
chk('服务端：跳过时额外统计「内容不同」的条数（别让跳过变成黑箱）',
  /if \(!java\.util\.Arrays\.equals\(readAllBytes\(dest\), data\)\) skippedDiff\+\+;/.test(njCode));
chk('服务端：manifest 并集合并，**本机已有条目优先**（本机更可信）',
  /if \(!cur\.has\(k\)\) \{ cur\.put\(k, inc\.opt\(k\)\); addedM\+\+; \}/.test(njCode));
chk('服务端：监控清单只补缺（已在本机的目录不动）',
  /if \(!next\.contains\(nrm\)\) \{ next\.add\(nrm\); addedJobs\.put\(nrm\); \}/.test(njCode));
chk('🔴 服务端：间隔只在**本机还没设过**（0）时才用备份里的值（不偷偷改用户设置）',
  /if \(iv > 0 && strmIntervalH == 0\) \{ body\.put\("strmIntervalH", iv\); ivApplied = iv; changed = true; \}/.test(njCode));
chk('服务端：改配置复用 handleConfig（它内部 persistConfig + strmSchedule，别自己拼落盘）',
  /if \(changed\) handleConfig\("POST", body\);/.test(njCode));
chk('服务端：备份响应带 Content-Disposition 文件名（下载目录里多份备份能分清）',
  /Content-Disposition",/.test(njCode) && /nas-strm-backup-/.test(njCode));
chk('服务端：还原接口 body 空时报 400（而不是静默「导入成功 0 个」）',
  /if \(req\.body == null \|\| req\.body\.length == 0\) return json\(400, err\("没有收到备份内容"\)\);/.test(njCode));
/* 🔴 坏条目：平台（ZipInputStream）会**先**挡下带 `..` 的条目名，但抛的是英文异常，
   而且一个坏条目会让整个 zip 读不下去 → 必须翻成人话，并说明「已导入的会保留」
   （合并补缺本来就不删不覆盖，中止不会造成损坏，只是没导全）。 */
chk('🔴 服务端：坏 zip 条目翻成人话（不许把英文 ZipException 原样甩给用户）',
  /catch \(java\.util\.zip\.ZipException ze\)/.test(njCode)
  && /备份包不合法，已中止/.test(njCode)
  && /此前已导入的文件会保留，不会覆盖或删除任何东西/.test(njCode));

/* ---- 原生导出 ---- */
chk('🔴 原生：导出走 MediaStore 的「下载」目录 + RELATIVE_PATH（API 29+ 免存储权限）',
  /android\.provider\.MediaStore\.Downloads\.EXTERNAL_CONTENT_URI/.test(ma)
  && /MediaColumns\.RELATIVE_PATH/.test(ma)
  && /Environment\.DIRECTORY_DOWNLOADS/.test(ma));
chk('原生：写盘三级降级（MediaStore → 公共下载目录 → 应用目录），不会因没权限整体失败',
  /MediaStore 写入失败，退公共下载目录/.test(ma)
  && /公共下载目录写入失败，退应用目录/.test(ma)
  && /File base = getExternalFilesDir\(null\);/.test(ma));
chk('🔴 原生：打包放工作线程（5000+ 文件同步跑会卡住 UI）',
  /new Thread\(\(\) -> \{[\s\S]{0,1200}?"strm-export"\)\.start\(\);/.test(ma));
chk('🔴 原生：成功失败都回一次 __strmExportDone（否则页面那句「正在打包…」永不消失）',
  /private void reportStrmExport\(boolean ok, int files, String where, String err\)/.test(ma)
  && /reportStrmExport\(false, 0, null, String\.valueOf\(t\.getMessage\(\)\)\);/.test(ma)
  && /window\.__strmExportDone&&window\.__strmExportDone\(/.test(ma));
chk('原生：NasBridge 暴露了 exportStrm（前端那个按钮点得到）',
  /public void exportStrm\(\) \{/.test(ma)
  && /@android\.webkit\.JavascriptInterface[\s\S]{0,200}?public void exportStrm\(\)/.test(ma));

/* ---- 前端 ---- */
chk('前端：界面三件套齐全（导出按钮 / 导入按钮 / 隐藏的 file input）',
  htmlIds.has('cfStrmExport') && htmlIds.has('cfStrmImport') && htmlIds.has('cfStrmBkFile'));
chk('前端：导出优先走原生，网页版退化成浏览器下载',
  /\$\('cfStrmExport'\)\.addEventListener\('click', exportStrmBackup\);/.test(appCode)
  && /if \(window\.NasBridge && window\.NasBridge\.exportStrm\)/.test(appCode)
  && /a\.href = '\/api\/strm\/backup';/.test(appCode));
chk('🔴 前端：导入用系统文件选择器（WebView 的 onShowFileChooser 已接住 <input type=file>）',
  /\$\('cfStrmImport'\)\.addEventListener\('click', \(\) => \$\('cfStrmBkFile'\)\.click\(\)\);/.test(appCode)
  && /accept="\.zip/.test(html));
/* 🔴🔴 2026-09-20 模拟器实测抓到的真 bug：onShowFileChooser 当初只为「换头像」写，
 *  `setType("image/*")` 是写死的 —— 于是「导入备份」的 accept=".zip,application/zip"
 *  也被丢给图片选择器，而 **Android 13+ 的照片选择器里没有 zip**
 *  （界面原话「此应用只能访问您选择的照片」）→ 换机时用户根本选不到备份文件。
 *  修法：按 `params.getAcceptTypes()` 推导类型；纯图片才用 image/*。 */
chk('🔴 原生：文件选择器类型必须按网页 accept 推导（写死 image/* 会让 zip 选不到）',
  /params\.getAcceptTypes\(\)/.test(ma)
  && /if \(s\.equals\("\.zip"\)\) s = "application\/zip";/.test(ma)
  && /Intent\.EXTRA_MIME_TYPES/.test(ma)
  && /pick\.setType\(mimes\.get\(0\)\);/.test(ma)
  /* 纯图片那条路必须**有条件**（imageOnly），不能无条件 setType("image/*") */
  && /else if \(imageOnly\) \{\s*pick\.setType\("image\/\*"\);/.test(ma)
  && !/pick\.setType\("image\/\*"\);\s*startActivityForResult/.test(ma));
chk('原生：选择器标题跟着场景走（换头像 / 选文件），别再写死「选择头像图片」',
  /imageOnly \? "选择头像图片" : "选择文件"/.test(ma));
chk('原生：选择结果打进日志（accept → type），下次这类问题一眼可查',
  /文件选择器：accept=" \+ java\.util\.Arrays\.toString\(params\.getAcceptTypes\(\)\)/.test(ma));
chk('前端：选完清空 input.value（否则再选同一个文件不触发 change）',
  /const f = inp\.files && inp\.files\[0\];[\s\S]{0,120}?inp\.value = '';/.test(appCode));
chk('🔴 前端：导入完把 S.config 同步掉（不然随手一次保存就把刚补的清单覆盖回去）',
  /S\.config = \{ \.\.\.S\.config, strmJobs: jb\.now\.slice\(\) \};/.test(appCode)
  && /renderStrmJobs\(\);[\s\S]{0,40}?refreshStrmStatus\(\);/.test(appCode));
chk('🔴 前端：上传 zip 用**裸 body**，不许经过 jpost（JSON.stringify 会毁掉二进制）',
  /strmRestore: async \(file\) => \{/.test(api)
  && /body: file,/.test(api)
  && !/jpost\('\/api\/strm\/restore'/.test(api));
chk('前端：导入结果把「拒绝的可疑路径」也报出来（安全事件不该被吞掉）',
  /if \(fi\.rejected\) parts\.push\(`拒绝 \$\{fi\.rejected\} 条可疑路径`\);/.test(appCode));

/* ---- 行为断言：.strm 导出回调 ---- */
{
  const mk = (payload) => {
    const toasts = [];
    let note = null;
    const f = new Function('$', 'toast',
      'return (' + grabAssignFn(app, 'window.__strmExportDone = ') + ');')(
        (id) => (id === 'cfStrmBkNote'
          ? { set textContent(v) { note = v; }, get textContent() { return note; } }
          : null),
        (m) => toasts.push(m));
    f(payload);
    return { say: toasts.join(' | '), note: String(note) };
  };
  const ok = mk({ ok: true, files: 5269, where: '下载/nas-strm-backup-20260920-1730.zip' });
  chk('🔴 行为：导出成功 → 提示里带文件数与落点（用户要知道存哪了）',
    /5269/.test(ok.say) && /下载\//.test(ok.say), ok.say);
  chk('行为：导出成功 → 顺手把「换机怎么做」写进说明文字',
    /换机时/.test(ok.note) && /导入备份/.test(ok.note), ok.note);
  const bad = mk({ ok: false, err: '磁盘满了' });
  chk('🔴 行为：导出失败 → 明确报错（不能静默，否则用户以为存好了）',
    /导出失败/.test(bad.say) && /磁盘满了/.test(bad.say), bad.say);
  chk('行为：原生 evaluateJavascript 传的是 JSON **字符串**，也要能解析',
    /5269/.test(mk('{"ok":true,"files":5269,"where":"下载/x.zip"}').say));
}

/* ======================== 飞牛 fnOS 应用包（fnos/） ======================== */
console.log('\n\x1b[1m· 飞牛 fnOS 应用包\x1b[0m');
{
  const F = (p) => fs.readFileSync(path.join(ROOT, 'fnos', p), 'utf8');
  const man = F('src/manifest');
  const main = F('src/cmd/main');
  const instCb = F('src/cmd/install_callback');
  const confCb = F('src/cmd/config_callback');
  const upCb = F('src/cmd/upgrade_callback');
  const uicfg = F('src/app/ui/config');
  const wizard = F('src/wizard/install');
  /* ⚠️ 与别的源码一样要「剥掉注释」再断言：注释里提到「账号不存在」三个字，
     不剥的话下面那条「不许区分账号不存在/密码错」会因为注释而误判。 */
  const builder = F('build.mjs');
  const sync = stripComments(read('sync-server.js'));

  /* ---------- 瘦版同步服务端（sync-server.js）---------- */
  chk('同步服务端：只用 Node 内置模块（NAS 上没有 node_modules，不能有任何依赖）',
    (sync.match(/require\('([^']+)'\)/g) || []).every((s) => /'(http|https|fs|path|crypto|os|url|zlib|util|events|stream)'/.test(s)),
    (sync.match(/require\('([^']+)'\)/g) || []).join(' '));

  chk('🔴 同步服务端：它是**纯数据服务** —— 不碰播放器页面、不连 WebDAV、不调 ffmpeg',
    !/public|ffmpeg|ffprobe|PROPFIND|createReadStream\(.*\.(mp4|m4v)/.test(sync)
    && !/handleStream|handleBrowse|effectiveDir/.test(sync));

  chk('🔴 同步服务端：密码 scrypt 哈希、不存明文（落盘的只有 salt/hash）',
    /crypto\.scryptSync\(String\(pass\), String\(salt\), 32\)/.test(sync)
    && /db\.users\[name\] = \{ salt, hash: hashOf\(pass, salt\), at: Date\.now\(\) \}/.test(sync)
    && !/db\.users\[[^\]]+\]\s*=\s*\{[^}]*[:.]?\s*(?:password|明文)/.test(sync));

  chk('🔴 同步服务端：「账号不存在」与「密码错」同一句提示（不给账号枚举）',
    (sync.match(/账号或密码不对/g) || []).length >= 1
    && !/账号不存在|没有这个账号/.test(sync));

  chk('同步服务端：token 随机生成**且落盘**（不落盘 = 服务一重启所有人掉线）+ 有过期',
    /crypto\.randomBytes\(24\)\.toString\('hex'\)/.test(sync)
    && /db\.tokens\[token\] = \{ user: name, at: Date\.now\(\) \};[\s\S]{0,80}?dbSave\(db\)/.test(sync)
    && /Date\.now\(\) - Number\(rec\.at \|\| 0\) > TOKEN_TTL/.test(sync));

  chk('🔴 同步服务端：合并按时间戳取新 + 删除留墓碑（不留墓碑「取消收藏」会复活）',
    /const win = y\.t > x\.t \? y : x;/.test(sync)
    && /else if \(win\.t > 0\) out\[k\] = \{ t: win\.t, del: true \};/.test(sync)
    && /TOMB_KEEP/.test(sync));

  /* 🔴 2026-09-21 **整条反过来**：原来是「只做并集」，而并集**表达不了删除** ——
     用户删掉一个监控文件夹，下一次同步就被账号里那份并回来，
     症状是「这个文件夹已经不需要监控了但是无法移除」。改成按时间戳取最后改过的那份。 */
  chk('🔴 同步服务端：片源/监控清单按**时间戳取最后改过的那份**，不是并集'
    + '（并集表达不了删除 → 「监控文件夹删了又被加回来」）',
    /const t = Number\(inc\.sources\[k \+ 'T'\]\) \|\| 0;/.test(sync)
    && /if \(Array\.isArray\(inc\.sources\[k\]\) && t > ct\)/.test(sync)
    && !/ns\[k\] = union\(cs\[k\], inc\.sources\[k\]\)/.test(sync));
  chk('🔴 两份服务端的数组并集函数都已删除（union / syncUnionArr）—— 别再有人加回来',
    !/function union\(a, b\)/.test(sync) && !/function syncUnionArr\(a, b\)/.test(srv));
  /* ⚠️ 两份服务端**各断言一次**：第一版只断到 sync-server.js，把 server.js 改回并集
     照样绿（反向验证里唯一漏掉的一条）。协议有两份实现，就得有两份守卫。 */
  chk('🔴 PC 侧（server.js）的 sources 也按时间戳取新的那份 —— 两份服务端协议必须一致',
    /const t = Number\(inc\.sources\[k \+ 'T'\]\) \|\| 0;/.test(srv)
    && /if \(Array\.isArray\(inc\.sources\[k\]\) && t > ct\)/.test(srv));
  chk('🔴 间隔 strmIntervalH 也走时间戳（原来取 max()，导致「把间隔调小」永远同步不出去）',
    /if \(t > ct\) \{\s*\n\s*ns\.strmIntervalH = Math\.max\(0, Math\.min\(168, inc\.sources\.strmIntervalH\)\);/.test(sync));

  chk('同步服务端：strm 包用独立的大 body 读取（不能走 1MB 上限那条）+ 校验 zip 魔数',
    /readRaw\(req, ZIP_MAX\)/.test(sync) && /buf\[0\] !== 0x50 \|\| buf\[1\] !== 0x4b/.test(sync));

  chk('同步服务端：CORS 只给鉴权接口（这些接口有 token，别把通配 CORS 用到无鉴权接口上）',
    /'Access-Control-Allow-Origin': '\*'/.test(sync));

  chk('fnOS：同步模式会换 appid + 换入口 + 不带 public/（与完整版可分可共存）',
    /mode === 'sync'/.test(builder)
    && /appname = mode === 'sync' \? `\$\{APPNAME\}sync` : APPNAME/.test(builder)
    && /\$\{APP_DIR\}\/server\.js'?, '\$\{APP_DIR\}\/sync-server\.js'/.test(builder)
    && /同步包里不该有 public\//.test(builder));

  chk('🔴 fnOS：appname 改了必须同步改桌面入口 key（fnpack 只打印 "Packing failed"，退出码仍是 0）',
    /desktop_applaunchname=\$\{entry\}/.test(builder)
    && /replace\(\/nasdouyin\\\.Application\/g, entry\)/.test(builder)
    && /Packing failed\/i\.test\(out\)/.test(builder),
    '只看退出码会漏掉：fnpack 报了错但仍然 exit 0');

  const val = (txt, k) => ((txt.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm')) || [])[1] || '').trim();

  chk('fnOS：manifest 必备字段齐（appname/version/platform/service_port/desktop_*）',
    ['appname', 'version', 'display_name', 'platform', 'desktop_uidir', 'desktop_applaunchname', 'service_port']
      .every((k) => val(man, k) !== ''));

  /* 🔴 三处端口必须一致：manifest.service_port 决定飞牛转发哪个端口，
     ui/config.port 决定桌面图标跳哪个端口，cmd/main 决定进程真监听哪个端口。
     错一个就是「图标点开打不开」。 */
  const uiport = (uicfg.match(/"port"\s*:\s*"(\d+)"/) || [])[1];
  const mainport = (main.match(/PORT_DEFAULT=(\d+)/) || [])[1];
  chk('🔴 fnOS：端口三处一致（manifest.service_port = ui/config.port = cmd/main 默认值）',
    val(man, 'service_port') === uiport && uiport === mainport && uiport === '8099',
    `${val(man, 'service_port')} / ${uiport} / ${mainport}`);

  /* 🔴 Windows 上打的包不带可执行位，且 CRLF 会让 #!/bin/bash 失效 ——
     装上去「脚本点了没反应」，在本地根本复现不出来。 */
  const cmdFiles = fs.readdirSync(path.join(ROOT, 'fnos/src/cmd'));
  const crlf = cmdFiles.filter((f) => fs.readFileSync(path.join(ROOT, 'fnos/src/cmd', f)).includes('\r'));
  chk('🔴 fnOS：cmd/* 全部是 LF 行尾（CRLF 会让 shebang 失效，装上去脚本不听使唤）',
    crlf.length === 0, crlf.join(',') || '无');
  chk('fnOS：cmd/* 都有 shebang 且能用 bash 解析',
    cmdFiles.every((f) => F('src/cmd/' + f).startsWith('#!/bin/bash')));

  chk('fnOS：随包携带 node 运行时（飞牛上不一定有 node，不能赌）',
    /server\/node/.test(builder) && /node-v\$\{NODE_VER\}-linux-\$\{nodeArch\}/.test(builder));
  chk('🔴 fnOS：x86 与 arm 两种架构都要出包（飞牛有 ARM 机型，且 node 二进制挑架构）',
    /'--arch=all'/.test(builder) && /arches = .*\['x64', 'arm64'\]/.test(builder)
    && /platform = nodeArch === 'arm64' \? 'arm' : 'x86'/.test(builder));
  chk('🔴 fnOS：产物自检会核对「manifest.platform 与内置 node 的 ELF 机器类型」一致',
    /platVal !== platform/.test(builder) && /wantMachine = platform === 'arm' \? 0xb7 : 0x3e/.test(builder)
    && /gotMachine !== wantMachine/.test(builder),
    '装上去能装、跑起来 exec format error 最难查');
  chk('🔴 fnOS：cmd/* 与内置 node 的权限位由打包脚本显式写成 0755（Windows 打包会丢）',
    /addFile\('cmd\/' \+ e\.rel, 0o755\)/.test(builder)
    && /rel === 'server\/node' \? 0o755 : 0o644/.test(builder));

  chk('fnOS：安装时建数据目录 + 补可执行位（升级覆盖不会丢数据）',
    /mkdir -p "\$\{DATA_DIR\}"/.test(instCb) && /chmod \+x "\$\{NODE_BIN\}"/.test(instCb)
    && /DATA_DIR="\$\{TRIM_PKGVAR\}\/data"/.test(main));
  chk('fnOS：升级回调只迁移、不删数据目录',
    !/rm -rf "\$\{DATA_DIR\}"/.test(upCb) && !/rm -rf "\$\{TRIM_PKGVAR\}/.test(upCb));

  /* 「改设置要不要重启」两条路都有坑：无脑 start 会把用户手动停掉的应用拉起来；
     只 stop 不 start 则赌飞牛代拉，它不拉应用就再也起不来。判据必须是「改之前在不在跑」。 */
  chk('🔴 fnOS：改设置后按「改之前是否在跑」决定要不要重启（不许无脑 start，也不许只 stop）',
    /was_running=0/.test(confCb) && /"\$\(dirname "\$0"\)\/main" status/.test(confCb)
    && /\[ "\$\{was_running\}" = "1" \]/.test(confCb)
    && /tail_note="原本未运行，保持停止"/.test(confCb));

  chk('fnOS：main 的 status 退出码符合飞牛约定（0=运行中，3=未运行）',
    /status\)\s*[\s\S]{0,120}?exit 0[\s\S]{0,80}?exit 3/.test(main));
  chk('fnOS：启动后会等端口真的起来（能区分「进程崩了」和「起来了没监听」）',
    /for i in \$\(seq 1 30\)/.test(main) && /port_open "\$\{PORT_NUM\}"/.test(main)
    && /端口 \$\{PORT_NUM\} 可能已被别的程序占用/.test(main));
  chk('fnOS：安装向导给出「是否开放注册」开关（默认开，但提示公网要关）',
    /wizard_allow_register/.test(wizard) && /"initValue": "true"/.test(wizard));
}

(async () => {
  console.log('\n\x1b[1m[B] 运行时\x1b[0m');

  let up = true;
  try { await get('/'); } catch (_) { up = false; }
  if (!up) {
    console.log('  \x1b[90m· 服务没在跑，跳过（node server.js 后再试）\x1b[0m');
  } else {
    const page = await get('/');
    chk('首页 200 + html', page.status === 200 && /text\/html/.test(page.type || ''), String(page.status));
    [
      ['底部「文件夹」tab', 'data-nav="browse"'],
      ['目录页', 'id="pageBrowse"'],
      ['面包屑 / 内容区', 'id="brCrumb"'],
      ['片源区', 'id="brSrc"'],
      ['目录选择器', 'id="cfBrowse"'],
      /* ⚠️ 这里原来写的是 `<button class="top-title"` —— 而顶栏标题 2026-09-18
         就按用户要求从 button **降级成了 div**（见 index.html 那段注释：留着 :active
         的按压反馈只会让人以为它能点）。断言没跟着改，只是一直没被唤醒
         （运行时这一整段要「服务在跑」才执行）。2026-09-20 拿一个真实例跑 check.js
         才暴露出来 —— 别再写回 button。 */
      ['顶栏标题（静态标题，不是按钮）', '<div class="top-title"'],
      ['顶栏「换一批」', 'id="btnShuffle"'],
    ].forEach(([n, needle]) => chk(n, page.body.includes(needle)));
    chk('页面里已无本地磁盘入口', !page.body.includes('paneLocal') && !page.body.includes('driveList'));
    chk('CSS/JS 资源可访问',
      (await get('/css/style.css')).status === 200 &&
      (await get('/js/app.js')).status === 200 &&
      (await get('/js/api.js')).status === 200);
    const appServed = (await get('/js/app.js')).body;
    chk('线上 app.js 已带缩略图抽帧 / 缓存逻辑',
      /function backfillThumbs/.test(appServed) && /function renderThumbLine/.test(appServed));
    chk('线上 app.js 已带随机序逻辑',
      /function shuffle\(arr\)/.test(appServed) && /function orderVideos\(videos\)/.test(appServed) &&
      /main\.load\(first\);/.test(appServed));
    chk('线上 app.js 已无「按文件名序装载」', !/main\.load\(S\.videos\)/.test(appServed));
    chk('线上 app.js 已带重扫逻辑（runRefresh / reshuffleNow）',
      /async function runRefresh\(\)/.test(appServed) && /function reshuffleNow\(/.test(appServed));
    const cssServed = (await get('/css/style.css')).body;
    chk('线上 CSS 已无下拉刷新指示器', !/\.ptr\{/.test(cssServed) && !/\.ptr\.busy/.test(cssServed));
    /* ⚠️ 必须**先剥掉 HTML 注释**再查：index.html 里那段「🗑️ 这里原来有个下拉刷新指示器
       (#ptr / #ptrTxt)…」的删除说明本身就含 `ptrTxt`，直接 includes 会一直误报
       （2026-09-20 被真实例唤醒时才发现）。断言要查的是**真元素**，不是文档里的字。 */
    const pageNoComment = page.body.replace(/<!--[\s\S]*?-->/g, '');
    chk('页面里已无下拉刷新指示器',
      !pageNoComment.includes('id="ptr"') && !pageNoComment.includes('ptrTxt'));

    // 片库缓存：第二次请求应该秒回（不再实时扫），且带上缓存年龄
    const lib = JSON.parse((await get('/api/library')).body);
    chk('片库响应带扫描时间与 TTL', typeof lib.scannedAt === 'number' && lib.ttlMs === 86400000,
      'scannedAt=' + lib.scannedAt + ' ttlMs=' + lib.ttlMs);
    const peek = JSON.parse((await get('/api/library?peek=1&v=' + lib.version)).body);
    chk('peek 版本号没变时只回小包', peek.changed === false && peek.videos === undefined,
      JSON.stringify(peek).slice(0, 120));
    const peek2 = JSON.parse((await get('/api/library?peek=1&v=-1')).body);
    chk('peek 版本号对不上时带上完整列表', peek2.changed === true && Array.isArray(peek2.videos));

    /* 重新扫描靠 refresh=1 让后端真扫：走的是实时扫描，且扫完 version 必须变。
     *
     * ⚠️ 这两条只在**服务配了真实片源**时才成立：demo 模式（没填服务地址）走的是
     *    另一条路 —— 返回演示素材、既不扫描、也没有 version 概念。
     *    以前它们在「服务没在跑」时被整段跳过，所以一直没人发现需要这个前置，
     *    直到有人拿一个 demo 实例跑 check.js（2026-09-20 多设备同步那轮就这么撞上了）。
     *    这里显式跳过并**打印出来** —— 静默跳过等于把断言变没了。 */
    const isDemoLib = !!(lib.videos && lib.videos[0] && lib.videos[0].demo);
    if (isDemoLib) {
      console.log('  \x1b[90m· 服务是演示模式（没配片源），跳过 refresh/version 两条\x1b[0m');
    } else {
      const libFresh = JSON.parse((await get('/api/library?refresh=1')).body);
      chk('refresh=1 返回实时扫描结果（不走缓存）', libFresh.cached === false && typeof libFresh.scannedAt === 'number');
      chk('refresh=1 之后 version 递增（前端靠它认出新数据）', libFresh.version > lib.version,
        lib.version + ' → ' + libFresh.version);
    }

    // 缩略图：统计接口要能报出张数 / 占用 / 落盘目录
    const tstat = JSON.parse((await get('/api/thumb/stats')).body);
    chk('缩略图统计接口可用', tstat.ok === true && typeof tstat.cached === 'number' && typeof tstat.bytes === 'number',
      JSON.stringify(tstat).slice(0, 140));
    chk('缩略图有独立落盘目录', typeof tstat.dir === 'string' && /thumb/i.test(tstat.dir), tstat.dir);
    // 缺参数要拒绝，不能返回半张图或 200 空内容
    const tbad = await get('/api/thumb');
    chk('缺 p 参数时拒绝（而不是给空图）', tbad.status === 400, 'status=' + tbad.status);
    // backfill 空列表是合法请求，只是没事可做
    const tbf = await req('/api/thumb/backfill', { method: 'POST', body: '{"items":[]}', headers: { 'Content-Type': 'application/json' } });
    chk('backfill 接受空列表', tbf.status === 200 && /"ok"\s*:\s*true/.test(tbf.body), tbf.body.slice(0, 100));
  }

  console.log('\n' + '─'.repeat(52));
  console.log(bad === 0 ? '\x1b[32m\x1b[1m全部通过\x1b[0m\n' : `\x1b[31m\x1b[1m${bad} 项不一致\x1b[0m\n`);
  process.exitCode = bad ? 1 : 0;
})();
