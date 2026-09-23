/* ============================================================
   NAS 短视频 · 抖音风格 · 主逻辑
   ============================================================ */
import {
  api, streamUrl, transUrl, escapeHtml,
  initial, fmtSize, toast,
} from './api.js';

const $ = (id) => document.getElementById(id);
const phone = $('phone');
const feedEl = $('feed');
const playerFeedEl = $('playerFeed');

/* ------------------------------ 图标 ------------------------------ */
const IC = {
  heart: `<svg viewBox="0 0 24 24"><path d="M12 20.8C6.4 16.4 3 13.4 3 9.5 3 6.5 5.4 4 8.4 4c1.6 0 3 .7 3.6 1.9C12.6 4.7 14 4 15.6 4 18.6 4 21 6.5 21 9.5c0 3.9-3.4 6.9-9 11.3z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>`,
  heartOn: `<svg viewBox="0 0 24 24"><path d="M12 20.8C6.4 16.4 3 13.4 3 9.5 3 6.5 5.4 4 8.4 4c1.6 0 3 .7 3.6 1.9C12.6 4.7 14 4 15.6 4 18.6 4 21 6.5 21 9.5c0 3.9-3.4 6.9-9 11.3z" fill="currentColor"/></svg>`,
  heartBig: `<svg viewBox="0 0 24 24"><path d="M12 20.8C6.4 16.4 3 13.4 3 9.5 3 6.5 5.4 4 8.4 4c1.6 0 3 .7 3.6 1.9C12.6 4.7 14 4 15.6 4 18.6 4 21 6.5 21 9.5c0 3.9-3.4 6.9-9 11.3z" fill="#FE2C55"/></svg>`,
  star: `<svg viewBox="0 0 24 24"><path d="M12 3.4l2.7 5.7 6.2.85-4.5 4.35 1.1 6.1L12 17.5l-5.5 2.9 1.1-6.1L3.1 9.95l6.2-.85z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>`,
  starOn: `<svg viewBox="0 0 24 24"><path d="M12 3.4l2.7 5.7 6.2.85-4.5 4.35 1.1 6.1L12 17.5l-5.5 2.9 1.1-6.1L3.1 9.95l6.2-.85z" fill="currentColor"/></svg>`,
  expand: `<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  shrink: `<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" stroke="currentColor" stroke-width="2.1" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  playBig: `<svg viewBox="0 0 24 24" width="76" height="76"><path d="M8 5.2v13.6L19.2 12z" fill="rgba(255,255,255,.88)"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" width="19" height="19"><path d="M3 7a2 2 0 012-2h4l2 2.4h8a2 2 0 012 2V18a2 2 0 01-2 2H5a2 2 0 01-2-2z" fill="currentColor"/></svg>`,
  chev: `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  playSm: `<svg viewBox="0 0 24 24" width="12" height="12"><path d="M7 4.6v14.8L19.5 12z" fill="currentColor"/></svg>`,
};

/* ------------------------------ 状态 ------------------------------ */
const LS = {
  get(k, d) { try { const v = localStorage.getItem('nasdy.' + k); return v === null ? d : JSON.parse(v); } catch (_) { return d; } },
  set(k, v) { try { localStorage.setItem('nasdy.' + k, JSON.stringify(v)); } catch (_) {} },
};

/* 本次页面加载的时刻 —— onVideoError 的「升级原生播放器」用它做 10 秒启动宽限
 * （重启/刷新后首条视频的流常抖一下报错，宽限期内只原地重试，别弹横屏播放器）。 */
const PAGE_BOOT_TS = Date.now();

const S = {
  /* 🔴 `videos` 是**过滤后**的「可见」列表（顶栏计数、换一批、片源统计全都以它为准）；
     `allVideos` 是服务端给的**全量**原始列表。
     两者必须分开存 —— 「屏蔽小文件」（#cfMinSize）改阈值时要拿全量重新筛，
     不能拿 `videos` 自我过滤，那样只会越筛越少，调回「不屏蔽」也回不来。 */
  videos: [],
  allVideos: [],
  /* 「屏蔽小文件」的阈值（MB，0 = 不屏蔽）。
     存在 localStorage，不走 /api/config —— 见 index.html 里 #cfMinSize 那块的注释。 */
  minSizeMB: LS.get('minSize', 0),
  byId: new Map(),
  order: [],           // 首页刷的随机顺序（存视频路径）；每次打开 App 重新洗牌
  config: {},
  hasPass: false,
  /*
   * 设置页第一步「登录」是否已成功（2026-09-18 两步流程）。
   * 只有它为 true，第二步（选文件夹）才可见 —— 这样就不会再出现
   * 「填完地址就被推去挑目录，但服务器连不上/旧挂载删不掉」的死胡同。
   */
  loggedIn: false,
  mode: 'demo',        // webdav | demo
  currentDir: '',      // 「文件夹」页当前所在目录（完整路径，如 /video/2024）
  /* 只在**真的连上过服务器**（登录 / 测试连接）之后才写。
   * 和 currentDir 的区别很关键：currentDir 在启动时会用配置里的 dir 兜底，
   * 那条路径可能早就失效了（被删/改名/换了服务器）。拿它当浏览起点，人会
   * 直接撞进 404 且出不来。所以「文件夹」页起步只信这个字段。 */
  verifiedDir: '',
  dirs: [],            // 片源文件夹列表：首页刷的是这些目录的合集
  likes: {},
  favorites: {},
  demoMode: false,
  source: '',
  scannedAt: 0,
  cached: false,       // 这份列表是服务端读缓存给的（没走实时扫描）
  libVersion: 0,       // 服务端片库版本号，用来判断后台刷新扫完没有
  /* 片源刚改完、片库还在服务端后台扫（/api/sources 的 pendingScan）。
   * 为 true 时 S.videos 还是**上一个片源**的内容，任何「有几个视频」的判断都得先看它，
   * 否则会把旧数字当新的报出去，或者把「还没扫完」误判成「这个文件夹是空的」。 */
  pendingScan: false,
  /*
   * ⚠️ 这三个字段名里带 ffmpeg，但它们的**真实语义**是「服务端有没有转码能力」。
   *    别因为名字去改它们（改一次要动十几处引用），读懂就行：
   *
   *    · APK 后端恒上报 false —— 手机端没有 ffmpeg、也没接任何外部解码服务
   *      （2026-09-18 Phase L 整体回退）。所以这套分支在手机上永远是「不做任何
   *      转码相关动作」：丢帧不切重编码、出错只原地重试一次。
   *    · PC 版（Node 后端）可以是 true —— 那边真的内嵌了 ffmpeg。
   *    同一个 app.js 要伺候两个后端，这就是它们还留着的原因。
   */
  ffmpeg: false,          // 服务端有没有**转码能力**（APK 恒 false）
  ffmpegPending: false,   // 转码能力正在置备中 —— 比「不支持」更准确的文案（APK 恒 false）
  ffmpegReason: '',       // 不可用的原因（给报错卡片用）。APK 上后端**不填**，
                          // 因为「没有转码能力」是常态、不是错误，没什么可解释的。
  probe: false,           // 服务端支不支持 /api/probe 探时长（决定能不能预热 + 拖进度条）
  soundOn: false,
  clientId: LS.get('clientId', 'nas_' + Math.random().toString(36).slice(2, 8)),
};
LS.set('clientId', S.clientId);

/* ---------------------- 预加载条数（用户可调，2026-09-23） ----------------------
 *
 * 背景：切片时后台会「预热」后面 N 条（提前 mount 好 video、发出取流请求），
 * 让下一次上滑立刻能播。但每多预热一条就多一路**并发取流** ——
 * 直连网盘/CDN 的源对「同一 IP 短时间大量并发请求」很敏感，
 * 预热太多容易被限速甚至风控（用户 2026-09-23 反馈：「默认 5 条太容易风控了」）。
 *
 * 所以把它做成**用户可调**：
 *   · 默认 5（保持老行为，老用户升级后手感不变）；
 *   · 0 = 完全不预加载（最省并发、最不容易被风控，代价是切条时要等首帧）；
 *   · 上限 9 —— 不是随便定的，是**与滑动窗口的宽度绑死的**（见 WIN_AFTER 那段注释）：
 *     窗口 `[i-4, i+9]` 得盖得住预热的 `i+1..i+N`，超过 9 就会把窗口整个拖走、
 *     引发「窗口重排 → 重新吸附 → 自动跳下一条」的级联。
 *
 * 只存 localStorage（`nasdy.preheat`），**不走 /api/config** —— 理由同 #cfMinSize / 主题：
 *   ① 纯前端行为（挂几个 video 元素），服务端不需要知道；
 *   ② 必须即时生效，走 config 会触发全量重扫（实测几十秒起）；
 *   ③ 一份 app.js 伺候两个后端（APK / Node），加进 config 就得两边都回这个字段。
 *
 * ⚠️ 改上限时**必须同步三处**：这里、index.html 的 `max`、check.js 的断言。
 *    只改一处的话 UI 能填到 12，代码却按 9 截，用户会以为「填了没生效」。
 */
const PREHEAT_LS = 'preheat';
const PREHEAT_DEFAULT = 5;
const PREHEAT_MAX = 9;
/** 当前生效的预加载条数：0 = 不预加载；非法值一律回默认 */
function preheatCount() {
  const v = Number(LS.get(PREHEAT_LS, PREHEAT_DEFAULT));
  if (!Number.isFinite(v)) return PREHEAT_DEFAULT;
  return Math.max(0, Math.min(PREHEAT_MAX, Math.round(v)));
}

const feeds = [];
const forAllFeeds = (fn) => feeds.forEach(fn);

/** /video/2024/电影 → 电影 */
const pathName = (p) => String(p || '').split('/').filter(Boolean).pop() || '根目录';
/** 只留协议 + 主机端口，用来把 NAS 地址显示得短一点 */
const originOf = (url) => String(url || '').replace(/^(https?:\/\/[^/]+).*$/i, '$1');
/** Fisher-Yates 洗牌，原地打乱并返回同一个数组（只在内存里，不落盘） */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 当前配置的片源文件夹列表（可能为空：还没挑过，这时首页会退回「当前浏览目录」） */
const srcList = () => (S.config.dirs || []).slice();
const hasSrc = (d) => srcList().includes(d);
/* 片源有两种形态（2026-09-20「本机片源」）：
     · `/dav/115open/云下载` —— WebDAV 路径（走 PROPFIND 扫）
     · `local:/`            —— 本机目录（走 java.io.File 扫；strm 自动库生成在那里）
   ⚠️ 判据是**前缀**而不是「以 / 开头」—— 后者会把两者混为一谈（本机路径的
      磁盘绝对路径也是 / 开头）。后端 NasServer.isLocalSrc 是同一份判据，别单边改。 */
const isLocalSrc = (d) => String(d || '').startsWith('local:');
/** 片源路径 → 给人看的短名（本机片源显示成「本机 strm 库」，路径尾巴对用户没意义） */
const srcLabel = (d) => (isLocalSrc(d) ? '本机 strm 库' : pathName(d));
/* 🔒 「不重扫」的片源文件夹（2026-09-18 加）。
 *    扫一遍大目录要十几分钟（§42 实测 802 秒），已经不会再新增文件的文件夹
 *    可以标上「不重扫」，之后常规扫描整个跳过它，直接复用上次的结果。
 *    ⚠️ 只认**仍在片源里**的项 —— 文件夹都被移走了还记着它，只会让人看不懂
 *    为什么扫描结果里少了东西（后端也做了同样的收敛，这里再过滤一次是为了
 *    渲染和「取反」时数据一致）。
 *    ⚠️ 本机片源永远不进这个清单：它没有「不重扫」按钮（见 renderSrcList）。 */
const skipList = () => (S.config.skipDirs || []).filter((d) => srcList().includes(d));
/** p 在不在 d 这个文件夹下（d = '/' 表示整个服务器） */
const underDir = (p, d) => {
  if (d === '/') return true;
  /* 🔴 本机片源要单独处理（2026-09-20）：它的根写作 `local:/`，末尾那个斜杠
     使得 `d + '/'` 拼出 `local://` —— 而视频的 p 是 `local:/云下载/a.strm`，
     于是**一条都匹配不上**，片源栏会显示「0 个视频」（功能没错但数字假）。
     先把片源路径的尾斜杠去掉再比，两种情况就都对了。 */
  const base = String(d).replace(/\/+$/, '');
  return p === base || String(p).startsWith(base + '/');
};

/**
 * 这条片库记录是不是 `.strm` **指针**（不是视频本体）。
 *
 * 🔴 为什么必须单独认出来（2026-09-20 用户报「那怎么一个视频都没有」）：
 *    `.strm` 文件里只有一行 URL，**自己只有几十字节**（实测 35~46）。
 *    而「屏蔽小文件」是拿 `v.size` 去跟阈值比 —— 于是只要用户开了这个开关
 *    （哪怕只设 1MB），本机 strm 库的 5000 多条会被 **100% 滤光**，
 *    片源栏显示「本机 strm 库 · 0 个视频」、首页一条都不剩，
 *    看着像「视频全没了」，其实磁盘上一个没少。
 *    → 它自己的字节数**证明不了**目标视频的大小，所以不能拿它判「小文件」。
 *      这跟 rebuildShown 里「size 拿不到时保留」是同一条原则：
 *      **证明不了小，就不许丢**。
 * ⚠️ 两边判据都留着（ext 字段 + 路径后缀）：`ext` 是后端给的，可靠；
 *    但历史上出现过 ext 缺失的本地条目，路径后缀能兜住。
 */
const isStrmPointer = (v) => (v && ((String(v.ext || '').toLowerCase() === 'strm')
  || /\.strm$/i.test(String(v.p || ''))));

/* ------------------------------ 信息流 ------------------------------ */
function createFeed(container, opts = {}) {
  let list = [];
  let cur = -1;
  const mounted = new Map();
  const tap = { t: 0, i: -1, timer: null };   // 单击暂停 / 双击点赞 的判定状态
  let warmTimers = [];                       // 预热后续视频的定时器（可同时存在多个）
  // 长按加速：按住画面一会儿切倍速，松手回到 1 倍
  const hold = { timer: null, firedTimer: null, i: -1, v: null, on: false, fired: false, x: 0, y: 0 };
  // 拖进度条：按住就能拖、跟手画，松手才真跳（转码流每次跳都要重启一路 ffmpeg，不能边拖边跳）
  const scrub = { on: false, i: -1, item: null, rect: null, bar: null, ratio: 0, fired: false, firedTimer: null };
// 转码流快进的防抖计时器：连点/来回拖时合并成最后一次，避免每一下都重启一路 ffmpeg
const seekTimer = new Map();
// 换流后的复查计时器：确认这一路到底起播了没有 —— 专治快进后大播放按钮糊在画面上不走
const seekSettle = new Map();
  const isPlayer = opts.isPlayer === true;   // 这个 feed 是不是全屏播放器（点按语义不同，交手势层处理）
  const io = new IntersectionObserver((ents) => {
    let hit = null;
    for (const e of ents) if (e.isIntersecting && e.intersectionRatio >= 0.6) { hit = e; break; }
    if (!hit) return;
    const i = Number(hit.target.dataset.i);
    if (i !== cur) activate(i);
  }, { root: container, threshold: 0.6 });

  const itemOf = (i) => container.querySelector(`.item[data-i="${i}"]`);

  /* ---- 窗口化（2026-09-21）：DOM 里**只留当前条附近**的那些 item ----
   *
   * 🔴 改之前是「给 5269 个视频各建一个 <section class="item">」—— 实测 DOM 节点总数
   *    **20 万**；滚动平均 20ms/帧（应 16.7）、最差 87.6ms、7% 的帧掉到 32ms 以上；
   *    「换一批」一次重建**冻结主线程 1055ms**（一个 931ms 的长任务）。
   *    而且 `.item` 上挂着 `will-change:transform`，5000 多个元素一起申请合成层。
   *    节点一多，**任何一次样式/布局重算**都要走一遍全树 —— 所以不只是滚动，
   *    开面板、切主题、切页面这些「看着无关」的操作也一起变慢。
   *
   * **几何不变式（最关键的一条）**：只挂 `[lo, hi]` 这段**连续**的 item，
   *    上下各放一个占位块，高度分别是 `lo` 个和 `list.length-1-hi` 个「一整屏」。
   *    于是第 i 条的绝对位置**恒等于 `i × 容器高`** —— 不管窗口滑到哪儿，
   *    滚动条长度和每条的落点都不变，所以换窗口**不会让滚动位置跳**。
   *    反过来说：**绝不能挂窗口外的零散 item**（那样它的位置就错了），
   *    这就是 `mount()` 里必须先 `ensureWindow(i)` 的原因。
   */
  const WIN_BEFORE = 4;      // 当前条之前留几条
  const WIN_AFTER = 9;       // 之后留几条（必须 ≥ 视频预热的 ±5，见 releaseFar）
  const BAND_LO = 2;         // 当前条落在窗口内的这个区间里就不动窗口（减少 DOM 抖动）
  const BAND_HI = 5;
  let lo = -1, hi = -2;      // 当前挂着的 item 区间（lo > hi = 空窗口）
  let topPad = null, botPad = null;

  function makeItem(k) {
    const v = list[k];
    const item = document.createElement('section');
    item.className = 'item';
    item.dataset.i = String(k);
    item.dataset.id = v.p;
    item.innerHTML = itemHTML(v, opts);
    updateActions(item, v);
    return item;
  }

  /** 把 DOM 窗口挪到以 center 为中心。**只动 DOM，不起播** —— 起播仍归 IntersectionObserver */
  function syncWindow(center) {
    if (!list.length || !topPad) return;
    const nlo = Math.max(0, center - WIN_BEFORE);
    const nhi = Math.min(list.length - 1, center + WIN_AFTER);
    if (nlo === lo && nhi === hi) return;
    // 先摘掉窗口外的（连带把它的 video 也收掉，别留孤儿元素）
    for (let k = lo; k <= hi; k++) {
      if (k < nlo || k > nhi) {
        const it = itemOf(k);
        if (it) {
          const v = mounted.get(k);
          if (v) { cleanupVideo(v); mounted.delete(k); }
          io.unobserve(it);
          it.remove();
        }
      }
    }
    // 再补上缺的。**倒序插**：这样 k+1 一定已经就位、参照物找得到；
    // 正序插的话前面几个参照物还没建出来，insertBefore(null) 会把它甩到队尾。
    /* 🔴 参照物必须写 `itemOf(k + 1) || botPad`，**不能**写成
       `(k + 1 <= hi) ? itemOf(k + 1) : botPad` —— 后者用的是**旧的 hi**，
       于是新加的那一批（k > hi）全都落到 botPad 上：倒序插进去就变成了**反序**，
       实测 DOM 顺序会变成 […, 13, 15, 14, 17, 16]。
       DOM 顺序就是流式布局里的位置 —— 反序之后第 i 条的落点不再等于 `i × 容器高`，
       几何不变式直接破掉（滑到后面会显示错的那一条），而且**不报错**。 */
    for (let k = nhi; k >= nlo; k--) {
      if (k < lo || k > hi) {
        const item = makeItem(k);
        container.insertBefore(item, itemOf(k + 1) || botPad);
        io.observe(item);
      }
    }
    lo = nlo; hi = nhi;
    // 这两行是几何不变式的另一半：撑住窗口外那部分的滚动高度
    topPad.style.height = (lo * 100) + '%';
    botPad.style.height = ((list.length - 1 - hi) * 100) + '%';
  }

  /** 当前条还在窗口的「舒适区」里就什么都不做（避免每滑一条就重排一次 DOM） */
  function ensureWindow(i) {
    if (i < 0 || i >= list.length) return;
    if (lo >= 0 && i >= lo + BAND_LO && i <= lo + BAND_HI) return;
    syncWindow(i);
  }

  /* 🔴🔴 给 `mount()` 专用：**只保证 i 已经在窗口里**，绝不以 i 为中心重排。
   *
   * 为什么不能用上面的 ensureWindow —— 这是 2026-09-22 那个
   * 「视频一直乱跳 / 进度条乱动 / 自动刷下一条」的真身：
   *
   *   ensureWindow 的舒适区是 `[lo+2, lo+5]`，而预热会 `mount(i+2)…mount(i+5)`，
   *   这几个 i+n **全都落在舒适区外** → 每预热一条就把窗口整个挪到「以 i+n 为中心」，
   *   于是一次开播要**连续重排 4 次 DOM**（实测 6 秒内 42 次增删）。
   *
   *   而 `.feed` 是 `scroll-snap-type: y mandatory` —— **窗口一增删，Chromium 就重新
   *   吸附一遍**。重排把当前位置吸到了下一条 → 触发下一条的 activate → 又预热 → 又重排…
   *   **级联**，表现为信息流自己一条条往下走（实测静置 6 秒自漂 3 条）。
   *
   *   窗口宽度本来就是 `[i-4, i+9]`（WIN_AFTER=9），**盖得住**预热的 i+1..i+5，
   *   所以这里只要「不在窗口里才补」就够了 —— 正常开播一条 DOM 都不会动。 */
  function ensureWindowContains(i) {
    if (i < 0 || i >= list.length) return;
    if (lo >= 0 && i >= lo && i <= hi) return;
    syncWindow(i);
  }

  /* 窗口推进的**独立来源**。
     🔴 光靠 IntersectionObserver 不行：它只能观察到「已经挂着的」item ——
        快速滑到窗口外时一个都观察不到，窗口就永远停在原地、屏幕只剩占位块
        （这是窗口化最经典的翻车方式）。所以另配一个只读 scrollTop 的监听：
        每条正好一屏，直接除出当前是第几条。**只读不写** ——
        写滚动位置是 §39 明令禁止的（竖向必须由浏览器原生 scroll-snap 驱动）。 */
  container.addEventListener('scroll', () => {
    if (cur < 0 || !topPad) return;
    const h = container.clientHeight;
    if (!h) return;
    ensureWindow(Math.round(container.scrollTop / h));
  }, { passive: true });

  function build() {
    warmTimers.forEach(clearTimeout); warmTimers = [];
    io.disconnect();
    mounted.forEach((v) => cleanupVideo(v));
    mounted.clear();
    container.innerHTML = '';
    cur = -1;
    lo = -1; hi = -2;
    /* 两个占位块是**滚动高度的唯一来源**（窗口外的 item 根本不存在）。
       它们没有 scroll-snap-align，所以不会变成吸附点。 */
    topPad = document.createElement('div');
    topPad.className = 'feed-pad';
    botPad = document.createElement('div');
    botPad.className = 'feed-pad';
    container.appendChild(topPad);
    container.appendChild(botPad);
    syncWindow(0);          // 先把第 0 条附近建出来（真正的起播在 load/reshuffleNow 的 activate(0)）
  }

  function cleanupVideo(v) {
    // 先摘遮罩再停：pause() 会同步触发 syncPaused，但那时 item 可能已经不属于这条流了。
    // 这里直接把「这条流带来的临时状态」一次清干净，免得留下孤儿大按钮。
    const it = v && v.parentElement && v.parentElement.closest('.item');
    if (it) it.classList.remove('paused', 'stalling');
    try { v.pause(); } catch (_) {}
    v.removeAttribute('src');
    try { v.load(); } catch (_) {}
    v.remove();
  }

  function mount(i, eager) {
    if (mounted.has(i) || !list[i]) return mounted.get(i) || null;
    // 转码要占 CPU：只有真要播它的时候才起，滚动预热时不碰
    if (list[i].playable === false && !eager) return null;
    /* 🔴 窗口化之后 item 不一定挂着 —— 先把它那一带的窗口铺出来再取。
       不铺的话窗口外的那条会「静默不挂视频」（itemOf 返回 null → 这里直接 return），
       表现是滑过去一片黑。
       ⚠️ 这里必须是 ensureWindowContains（只要在窗口里就什么都不做），
          **不能**用 ensureWindow —— 后者会以 i 为中心重排，而被预热调用时
          i 就是 i+2..i+5，会引发「窗口重排 → 重新吸附 → 自动跳下一条」的级联。
          详见 ensureWindowContains 上面的长注释。 */
    ensureWindowContains(i);
    const item = itemOf(i);
    if (!item) return null;
    delete item.dataset.retried;            // 新挂一路视频 = 新一轮「出错自动重试」机会
    const v = document.createElement('video');
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('x5-playsinline', '');
    v.loop = true;
    v.muted = !S.soundOn;
    /* 🔴 预热那一档用 'auto' 而不是 'metadata'（2026-09-19 提速）：
     * metadata 只拉文件头（moov），画面数据一个字节都不取 —— 用户一划，
     * 下一集还得从零开始缓冲，这就是「刷起来慢」的主要来源。
     * 'auto' 会让浏览器真的预取一段数据（Chromium 有缓冲窗口上限，
     * 不会把整部片拉下来，也不会无限挤占当前这集的带宽），
     * 划过去时基本是「already loaded」的体感。 */
    v.preload = 'auto';
    if (list[i].playable === false) {
      // 浏览器天生解不了这种封装，交给服务端边转边播。
      // ⚠️ 但前提是服务端**真有**转码能力（S.ffmpeg）。没有的话这条流接上去
      // 也只会拿到一个 503，白白让用户等一轮 —— 直接报错更快、文案也更准。
      if (!S.ffmpeg) {
        item.dataset.mode = 'transcode';
        showErr(i);
        mounted.set(i, null);
        return null;
      }
      item.dataset.mode = 'transcode';
      item.dataset.t0 = '0';
      v.src = transUrl(list[i]);
      // 转码流本身没有时长，跟服务端 /api/probe 要一个（结果会缓存）
      ensureDuration(i, item);
    } else if (badStreamGet(list[i].p) && S.ffmpeg) {
      // 检测过的坏码流：直接走重编码，别再让用户卡一次等检测。
      //
      // ⚠️ 只在**服务端真有 ffmpeg** 时才走这条。APK 没有 ffmpeg，
      // 「重编码流」只是同一路原始流换个 URL 再发一遍（见技能 §8），
      // 不但治不好丢帧，还会把 mode 锁死成 transcode、之后每次打开都白等一次换流。
      // APK 上的正确姿势是走直连流 —— 丢帧了也不自动跳原生（那个功能已删，见 watchDrops）
      switchToEncode(i, v, item, 0, false);
    } else {
      v.src = streamUrl(list[i]);
      v.addEventListener('playing', () => watchDrops(i, v, item));
    }

    v.addEventListener('loadeddata', () => {
      item.classList.add('ready');
      delete item.dataset.errRetry;          // 这次能正常出画面了，重试计数清零
      const err = item.querySelector('.v-err');
      if (err) err.remove();
      if (cur === i && mounted.get(i) === v) startPlayback(v, item, i);
    });
    v.addEventListener('playing', () => {
      item.classList.remove('paused');
      item.classList.remove('stalling');
      item.classList.add('ready');
    });
    // 这几条一起把「大播放按钮」钉死在 video 的真实状态上 ——
    // 尤其是 seek 换流后新流自动播、以及 pause() 之后没再 play() 的情况。
    v.addEventListener('pause', () => syncPaused(v, item));
    v.addEventListener('play', () => syncPaused(v, item));
    v.addEventListener('emptied', () => item.classList.remove('paused', 'stalling'));
    v.addEventListener('waiting', () => { if (cur === i) item.classList.add('stalling'); });
    // timeupdate 只在播放中触发，顺手对一次账，兜住任何漏网的状态漂移。
    v.addEventListener('timeupdate', () => { if (cur === i) { paintProgress(i); syncPaused(v, item); } });
    v.addEventListener('loadedmetadata', () => { if (cur === i) paintProgress(i); fitVideoBox(item, v, i); });
    v.addEventListener('resize', () => fitVideoBox(item, v, i));
    v.addEventListener('error', () => onVideoError(i, v, item));
    /* ⚠️ 这里必须跟上面 waiting 一样带 `cur === i` 守卫。
     *
     * 漏了守卫的后果：activate() 会**预热下一条**（mount(i+1, false)），
     * 而预热出来的那条不在视口中心、不该有任何加载指示，可它一旦碰到 stalled
     * 就会被挂上 .stalling。而清除 .stalling 的地方（startPlayback / playing 回调）
     * 只对「当前这条」生效 —— 于是预热那条的圈**永远没人来摘**。
     * 等用户真划到它时，看到的又是一个「一直在转圈的缓冲」。
     * 这正是「刷点赞过的视频要缓冲好久」里，除了冷启动耗时之外的第二个来源。 */
    v.addEventListener('stalled', () => { if (cur === i) item.classList.add('stalling'); });
    item.querySelector('.vwrap').prepend(v);
    /* 挂上去就先量一次。
     * ⚠️ 别只等 loadedmetadata —— 转码片最需要转圈的时候恰恰是「还没出画面」那段，
     * 而那时 loadedmetadata 可能已经烧掉了，或者 videoWidth 还是 0。
     * 这里先去查缓存 / 问服务端，让 .vbox 在第一个转圈出现之前就摆对位置。 */
    fitVideoBox(item, v, i);
    // 从原生播放器退回来时带了位置：接着播，别从头开始
    if (NATIVE_POS[list[i].p] != null) {
      const at = NATIVE_POS[list[i].p];
      delete NATIVE_POS[list[i].p];
      v.addEventListener('loadedmetadata', () => {
        try { v.currentTime = at; } catch (_) {}
      }, { once: true });
    }
    mounted.set(i, v);
    return v;
  }

  /* ---------- 「暂停遮罩」的唯一真源 ----------
   * 那个盖在画面正中的大播放按钮 = `.item.paused`。
   * 它**必须**是 video 元素真实状态的投影，不能是谁想起来就 add 一下。
   *
   * 历史坑（用户反馈「快进时总糊着一个播放按钮」就是这个）：
   *   1. play() 被拒一律 catch 成 .paused —— 但快进时连着改 src，
   *      前一次 play() 会被后一次顶掉，抛的是 AbortError
   *      （"interrupted by a new load request"），那是**正常**的「被取代」，
   *      不是播不出来。结果按钮就永久焊在画面上了。
   *   2. 反过来，pause 时 add 了 .paused、之后那条流因为 seek 被整个换掉，
   *      新流是自动播的、`playing` 事件若在换 src 的间隙被吞掉，
   *      .paused 就再没人来摘 —— 也会留下一个去不掉的按钮。
   *
   * 所以现在只有两条规则：
   *   · 任何「可能改变了播放状态」的地方，都调 syncPaused() 去对账；
   *   · syncPaused() 只认 v.paused / v.ended，不认「谁刚才调过 play()」。
   */
  function syncPaused(v, item) {
    if (!v || !item) return;
    // readyState 0/1：这条流刚换过 src、还没拿到任何数据。
    // 这时 v.paused 一定是 true，但那只是「还没开始」，
    // 不代表用户按了暂停 —— 别在这时候把大按钮糊上去。
    const loading = v.readyState < 2;
    if (v.paused && !loading) item.classList.add('paused');
    else if (!v.paused) item.classList.remove('paused');
  }

  /**
   * 播一下。
   *
   * ⚠️ play() 返回的 promise 被拒**不等于**播不出来：快进时前一次请求会被
   * 后一次顶掉（AbortError），那是正常的「被新请求取代」。
   * 这里**绝不**主动 add .paused —— 状态一律交给 syncPaused 以元素真实状态为准。
   */
  function safePlay(v, item) {
    const p = v.play();
    if (!p || !p.catch) return;
    // 成功的分支不做事：playing 事件自然会 syncPaused。
    // 失败的分支延后再对账一次 —— 此刻 readyState 可能还是 0（正等着新流），
    // 立刻判断会误判成「暂停」，所以要等一拍。
    p.catch(() => { setTimeout(() => syncPaused(v, item), 60); });
  }

  /** 播放位置前面已经缓冲了多少秒 */
  function bufferedAhead(v) {
    try {
      const b = v.buffered;
      for (let k = 0; k < b.length; k++) {
        if (b.start(k) <= v.currentTime + 0.25 && b.end(k) > v.currentTime) return b.end(k) - v.currentTime;
      }
    } catch (_) {}
    return 0;
  }

  /**
   * 缓冲够了再开播。
   * 手机上最怕「播两秒卡一下」：一收到 loadeddata 就立刻 play()，
   * 播放指针很快追上缓冲区末尾，于是不断 停顿→追帧→再停顿，看着就是抽搐。
   * 先攒够几秒再放，播放过程才是平的。最多等 5 秒就先播，别让用户干等。
   */
  function startPlayback(v, item, i) {
    const t0 = Date.now();
    const WANT = 5;         // 先攒 5 秒
    const MAX_WAIT = 5000;  // 最多等 5 秒
    (function attempt() {
      if (cur !== i || mounted.get(i) !== v) return;
      if (v.readyState >= 4 || bufferedAhead(v) >= WANT || Date.now() - t0 > MAX_WAIT) {
        item.classList.remove('stalling');
        safePlay(v, item);
        return;
      }
      if (v.readyState < 3) item.classList.add('stalling');
      setTimeout(attempt, 300);
    })();
  }

  /**
   * 坏码流自救：开播 8 秒后看解码丢帧率，超阈值就切服务端重编码流。
   *
   * ⚠️ 这套只在**服务端真有 ffmpeg**（PC / 群晖）时才做，因为只有那种情况下
   * 「重编码流」才是真的 —— 它能重新生成干净的时间戳。
   *   - 有 ffmpeg → 切真·重编码流。
   *   - 没有 ffmpeg（APK）→ **什么也不做**。
   *     Java 版的 /api/transcode 只是把同一路原始流又发了一遍（见技能 §8），
   *     源文件时间戳非单调的问题一个字节都没治，反而多绕一层、
   *     还把 mode 永久锁成 transcode 写进 badStreams 名单，之后每次都白等一次换流。
   *
   * 📌 「丢帧就自动跳去原生硬解播放器」这个功能**已按要求删除**（2026-09-17）。
   * 原本的设计是：检测到 WebView 丢帧就 toast + `NasBridge.openPlayer()` 弹去
   * `PlayerActivity`（系统硬解按 DTS 解，确实能容忍时间戳抖动）。
   * 但它的实际体验是「视频正在正常播着，突然被弹去另一个播放器」——
   * 用户认为这个打扰不值当，要求去掉。所以这条路不再自动走。
   *
   * 想看硬解的替代入口（都还在，没删）：
   *   · 播放器里的「全屏」按钮 → `nativePlay()`（见 act==='full' 分支）
   *   · WebView 重试一次仍播不出来时的兜底 → `onVideoError()` 里那段
   */
  const DROP_WATCH_MS = 8000;
  const DROP_RATIO = 0.10;    // 丢帧占比阈值
  const DROP_MIN = 25;        // 绝对帧数下限，避免小样本误判

  function watchDrops(i, v, item) {
    if (item.dataset.dropWatch || item.dataset.mode === 'transcode') return;
    item.dataset.dropWatch = '1';
    // 没有真重编码可切的环境（APK）根本不用采这个样，连监听都省了
    if (!S.ffmpeg) return;
    if (!v.getVideoPlaybackQuality) return;

    /* ⚠️ 定时器**不能**用 `if (v.paused) return;` 当守卫 —— 那是死等：
     * 这个回调是在 `playing` 里挂的，v 之后只要停下（起播竞争 / 后端回源挂住 /
     * 浏览器自己 pause），就再也等不到下一个 `playing`，定时器永不触发。
     * 所以改成「挂上就开始计时」，到点核实真实状态再决定。 */
    setTimeout(() => {
      if (cur !== i || mounted.get(i) !== v) return;   // 已经切走 / 换了流
      if (item.dataset.mode === 'transcode') return;   // 已经是重编码流了
      if (v.paused || v.readyState < 2) return;        // 没在播（或没画面）：不是丢帧问题，不处理
      const q = v.getVideoPlaybackQuality();
      if (!q || !q.totalVideoFrames || q.totalVideoFrames < DROP_MIN * 5) return;   // 样本太少不判
      const ratio = q.droppedVideoFrames / q.totalVideoFrames;
      if (ratio < DROP_RATIO || q.droppedVideoFrames < DROP_MIN) return;
      // 确实在丢帧 → 切服务端重编码（重新生成干净时间戳）
      badStreamSet(list[i].p);
      switchToEncode(i, v, item, v.currentTime, true);
    }, DROP_WATCH_MS);
  }

  /** 当前环境有没有「系统硬解」这条出路（APK 的 NasBridge.openPlayer） */
  function hasNativePlayer() {
    const B = window.NasBridge;
    return !!(B && typeof B.openPlayer === 'function');
  }

  /** 切到服务端重编码流：带当前位置起转，进度条时长跟 ffprobe 要 */
  function switchToEncode(i, v, item, at, notify) {
    at = Math.max(0, Number(at) || 0);
    item.dataset.mode = 'transcode';
    item.dataset.enc = '1';            // 记住这部片走的是重编码：快进时沿用，省掉一次服务端探测
    item.dataset.t0 = String(at);
    // 换流前摘掉遮罩：新流会自动接着播，留着大按钮就会在换流空档晃出来
    item.classList.remove('paused');
    v.src = transUrl(list[i], at, 'encode');
    if (cur === i) safePlay(v, item);   // 换 src 会把 pause 状态顶掉，这里必须重新起播
    if (notify) toast('这部片源解码丢帧，已自动切换重编码播放');
    // 时长拿不到的话进度条就没法换算比例 —— 统一走 ensureDuration（带缓存 + 补跳）
    ensureDuration(i, item);
  }

  /**
   * 预热出来的邻条加载失败：**静默丢弃**，等它真成为当前条时由 activate → mount 重新挂一路干净的。
   *
   * 🔴 为什么是「丢弃」而不是「就地重建」：重建会立刻再发一次加载，失败又 error、又重建……
   *    一次预热 5 条时就是 5 个死循环。
   *   也不能不管：挂着一条 error 的 video，用户划过去时 mount() 会因 `mounted.has(i)` 直接
   *   返回它，而 error 不会自己重发 → 卡一块黑屏、连报错界面都没有。
   *   （只删不重建 → mounted.has(i) 为假 → activate 时 mount 会重新挂。）
   */
  function dropBrokenPreheat(i, v) {
    if (mounted.get(i) !== v) return;          // 已经被换过 / 已经清掉，别重复动
    cleanupVideo(v);
    mounted.delete(i);
    const it = itemOf(i);
    if (it) it.classList.remove('ready', 'stalling', 'paused');
  }

  /**
   * 视频出错先自救，实在救不回来才给用户报错：
   * 1) 直连流出错（坏码流、云盘挂载抖动最容易中途炸）→ 有 ffmpeg 就切重编码流，
   *    没 ffmpeg（APK）就先原地重试一次 —— 假重编码流治不了任何问题；
   * 2) 已经在重编码还出错 → 多半是源端抽风，自动重试一次；
   * 3) 还不行 → 才弹「播不出来」。
   */
  function onVideoError(i, v, item) {
    /* 🔴 只有「当前正在看的那条」出错，才配得上提示 / 重试 / 跳过 / 升级原生。
     *
     * activate() 会预热 i+1..i+5（见那里的 mount(...,false)），**预热出来的邻条也会加载
     * 真实流、也会 error** —— 一次预热 5 条，NAS / 云盘并发扛不住时几乎必然有邻条失败。
     * 这里原来没有 `cur === i` 守卫，邻条的失败会**冒充当前这条的失败**，走 APK 那段
     * `NATIVE_SKIP[p]=1 → toast('这部片解码不了，已自动跳过') → main.scrollBy(1)`，
     * 把用户正在看、而且播得好好的这条顶走。
     * 用户看到的就是「明明已经开播了，却说解码不了」；又因为每次预热一批，
     * 表现像「很多 mp4 都解不了」（2026-09-23 报的真身）。
     *
     * ⚠️ 和上面 `waiting` / `stalled` 同一条规矩：这种「只该对当前条生效」的监听
     *    都必须带 `cur === i`，别改回去。 */
    if (cur !== i) { dropBrokenPreheat(i, v); return; }
    if (item.dataset.mode !== 'transcode' && list[i].playable !== false) {
      if (S.ffmpeg) {                       // 只有真能重编码时才值得切
        badStreamSet(list[i].p);
        switchToEncode(i, v, item, v.currentTime || 0, true);
        return;
      }
      // APK：没有真重编码可切，先原地重试（很多是挂载抖动 / 起播竞争）
      const t0 = Number(item.dataset.errRetry || 0);
      if (t0 < 1) {
        item.dataset.errRetry = '1';
        item.classList.add('stalling');
        setTimeout(() => { if (mounted.get(i) === v) retry(i); }, 800);
        return;
      }
      // 重试也炸 → 交给原生硬解试一次（它能容忍的封装/码流问题比 WebView 多）。
      // 🔴 但「首页信息流刷片」和「全屏播放器」要区别对待：
      //   · **全屏播放器**（用户主动点全屏，沉浸式本来就预期横屏）→ 照旧交给原生硬解，
      //     闪一下横屏是这种场景里可接受、甚至预期的。
      //   · **首页信息流**是一个接一个自动往下走的场景：原生播放器一弹出来，不管它最后
      //     能不能播，都**必然先闪一下横屏**——之后才 fallback 回来滑到下一条。这正是
      //     2026-09-20 用户报的「跳过无法播放的视频还是会横屏」的真身。所以首页这里
      //     **根本不去开原生播放器，直接滑到下一条**，横屏闪动从源头消失。
      //     （想用原生硬解时，点全屏按钮照样会调起，功能没丢。）
      //   · 收藏/点赞页是内联竖屏播放，不是全屏场景，也不开原生，掉下去原地重试+报错。
      // 🔴 另外页面刚加载的 10 秒内**任何人都不升级**原生：recreate 会抖一下首条视频的流，
      //    那时弹原生（横屏）就是「一点重启就进横屏播放」的真身（2026-09-19 用户报）。
      const withinBootGrace = Date.now() - PAGE_BOOT_TS <= 10000;
      if (hasNativePlayer() && !NATIVE_SKIP[list[i].p] && !withinBootGrace) {
        if (!$('playerModal').hidden) {
          toast('这个片源 WebView 播不动，已用系统播放器打开');
          try {
            window.NasBridge.openPlayer(absUrl(streamUrl(list[i])),
              absUrl(transUrl(list[i], 0, 'encode')),
              list[i].name || list[i].title || '',
              Math.max(0, Math.round(v.currentTime || 0)), list[i].p);
            return;
          } catch (_) { /* 掉到下面报错 */ }
        } else if (NAV === 'home') {
          // 首页信息流：直接跳过，不闪横屏。记进 NATIVE_SKIP 黑名单，别反复重试这条。
          NATIVE_SKIP[list[i].p] = 1;
          toast('这部片解码不了，已自动跳过');
          if (typeof main.scrollBy === 'function') main.scrollBy(1);
          return;
        }
        // 其它场景（收藏/点赞页内联等）不强行跳原生，继续走下面的原地重试 + 报错。
      }
      // 宽限期内（或没有原生播放器/已被拉黑）：再多做一次原地重试，然后才认输
      const graceTries = Number(item.dataset.errRetry2 || 0);
      if (graceTries < 2) {
        item.dataset.errRetry2 = String(graceTries + 1);
        item.classList.add('stalling');
        setTimeout(() => { if (mounted.get(i) === v) retry(i); }, 800);
        return;
      }
      showErr(i);
      return;
    }
    const tries = Number(item.dataset.errRetry || 0);
    if (tries < 1) {
      item.dataset.errRetry = '1';
      setTimeout(() => { if (mounted.get(i) === v) retry(i); }, 800);
      return;
    }
    showErr(i);
  }

  function showErr(i) {
    const item = itemOf(i);
    const v = list[i];
    if (!item || item.querySelector('.v-err')) return;
    const box = document.createElement('div');
    box.className = 'v-err';
    /*
     * 文案分两种，别再混：
     *  · playable === false（服务端在扫描阶段就判定播不了）→ 如实说「系统解不了这种封装」。
     *    ⚠️ **不要**在这里承诺任何「转码 / 边转边播」—— APK 里没有 ffmpeg，
     *       也没有可以填地址的解码服务（2026-09-18 起都没有了）。
     *       说「换个格式」或者「用电脑播」才是对的，说「去设置里配一下」是骗人。
     *  · 其它 → 网络 / 权限那种通用原因。
     *
     *  历史提醒（别再犯）：这里曾经写过「把 ffmpeg 放进 douyin-nas/bin/」，
     *  那是电脑版的说明，APK 里根本没有 bin/ 这个概念 —— 用户照着做只会白忙。
     */
    let why;
    if (v.playable === false) {
      why = '这台设备解不了这种封装（系统自带的解码器不支持 wmv / rmvb / mpg 这类格式）。'
        + '换成 mp4 / mkv 的片源，或者用电脑播。';
      if (S.ffmpegReason) why += '（' + escapeHtml(S.ffmpegReason) + '）';
    } else {
      why = '可能是 NAS 断开、权限不足或文件损坏';
    }
    box.innerHTML = `<div class="t">这个视频播不出来</div>
      <div class="d">${escapeHtml(v.name)}<br>${why}</div>
      <button class="btn ghost" data-act="retry">重试</button>`;
    item.appendChild(box);
    item.classList.add('ready');
  }

  function paintProgress(i) {
    const item = itemOf(i);
    const v = mounted.get(i);
    if (!item) return;
    const bar = item.querySelector('.bar');
    if (!bar) return;
    if (scrub.on && scrub.i === i) return;   // 正在拖这条：手指说了算，别被 timeupdate 抢回去
    const t0 = Number(item.dataset.t0 || 0);                      // 转码流是从第 t0 秒开始转的
    const total = Number(item.dataset.dur || 0) || (v && isFinite(v.duration) ? v.duration : 0);
    if (!total) { bar.style.width = '0%'; return; }
    const pos = t0 + (v && isFinite(v.currentTime) ? v.currentTime : 0);
    bar.style.width = Math.min(100, (pos / total) * 100) + '%';
  }

  /**
   * 服务端 ffprobe 出来的画面尺寸，按视频路径缓存（p -> [w,h]）。
   *
   * ⚠️⚠️ 为什么非要有它：转码流的 `video.videoWidth` **永远是 0**。
   *
   * 后端把转码结果封成 `-movflags frag_keyframe+empty_moov+default_base_moof` 的
   * **fragmented MP4**（为了首字节快，见 server.js 的注释）。这种流的 moov 是空的，
   * 真正的 avcC / 分辨率写在 moof 分片里；WebView 的解复用器能解码（readyState=4、
   * currentTime 在走），但**从不回填 videoWidth/videoHeight**。
   * 实测：item[0] 是转码流，videoWidth=0，而它明明在正常播。
   *
   * 于是原来那句 `if (!vw || !vh) return` 对**所有转码片**都成立 —— 变量压根写不进去，
   * .vbox 回退成 100%×100%（整屏），转圈就还落在整屏中心 = 用户看到的「没对准画面」。
   * 而用户能播的片**绝大多数都是转码流**（avi/mkv/rmvb 这些浏览器放不了的封装，
   * 以及所有需要重编码的），所以这个问题在真机上几乎必然出现。
   *
   * 解法：拿不到 videoWidth 时，问服务端要真实尺寸（/api/probe 本身就是 ffprobe + 缓存，
   * 转码那条路已经先探过一次了，这里基本是命中缓存、不额外产生下载）。
   */
  const boxDims = new Map();                  // p -> [w,h]
  const boxPending = new Set();               // 正在问的，别重复发

  function askBoxDims(i, item, v) {
    const p = item && item.dataset.id;        // build() 里存的 item.dataset.id = v.p
    if (!p || boxDims.has(p)) return;
    // 转码那条路（ensureDuration）本来就会调 /api/probe 拿时长，
    // 复用同一个 in-flight promise，别对同一个文件发两次探测。
    if (typeof i === 'number' && durWait.has(i)) {
      durWait.get(i).then(() => fitVideoBox(item, v, i)).catch(() => {});
      return;
    }
    if (boxPending.has(p)) return;
    boxPending.add(p);
    // 失败了就算了：下次 fitVideoBox 还会再问，不会把转圈卡死
    api.probe(p).then((r) => {
      boxPending.delete(p);
      if (r && r.ok && r.width && r.height) {
        boxDims.set(p, [r.width, r.height]);
        fitVideoBox(item, v);                 // 拿到就立刻重算一次
      }
    }).catch(() => { boxPending.delete(p); });
  }

  /**
   * 把「视频真正显示出来的那块矩形」量出来，写进 CSS 变量。
   *
   * 为什么需要：`.item video` 是 `object-fit:contain` —— 视频按比例缩放后**居中留黑边**。
   * 手机屏比视频宽/窄时，画面只占中间一条，上下（或左右）是纯黑。
   * 而加载转圈原来固定在 `.item` 的 50%/50%，也就是**整屏**中心；
   * 一旦黑边不对称（比如竖屏手机放横屏视频），或者屏幕比视频更「瘦」，
   * 转圈就会落在黑边上，看着像「浮在画面外面」——用户报的「转到视频外面去了」就是这个。
   *
   * 做法：按 contain 的规则自己算一遍缩放后的矩形（取缩放比的小值），
   * 把它的宽高写进 --vbw/--vbh，转圈用它们居中。纯计算，不读布局，
   * 所以放在 loadedmetadata / resize 里调没有强制重排的代价。
   *
   * 尺寸来源有两路：优先 `video.videoWidth`（直连流能拿到），拿不到就用服务端
   * ffprobe 的结果（转码流只能走这条，原因见上面 askBoxDims 的注释）。
   *
   * 注意 `fit=cover`（铺满）时没有黑边，画面就是整个容器 —— 那种情况直接把
   * 变量清成 100%，让转圈回到普通的整屏居中。
   */
  function fitVideoBox(item, v, i) {
    if (!item || !v) return;
    let vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) {
      const c = boxDims.get(item.dataset.id);
      if (c) { vw = c[0]; vh = c[1]; }
    }
    // 两路都没有 → 问服务端，等回调（i 传了就能复用 ensureDuration 那次探测）
    if (!vw || !vh) { askBoxDims(i, item, v); return; }
    const box = item.getBoundingClientRect();
    if (!box.width || !box.height) return;
    if (phone.dataset.fit === 'cover') {       // 铺满：没有黑边
      item.style.setProperty('--vbw', '100%');
      item.style.setProperty('--vbh', '100%');
      return;
    }
    // contain：等比缩放到「放得下」为止 → 取两个比值里小的那个
    const k = Math.min(box.width / vw, box.height / vh);
    item.style.setProperty('--vbw', (vw * k).toFixed(1) + 'px');
    item.style.setProperty('--vbh', (vh * k).toFixed(1) + 'px');
  }

  function activate(i, force) {
    if (i < 0 || i >= list.length) return;
    if (i === cur && !force) return;
    endHold();                                 // 切走时别把上一条留在倍速上
    const prev = cur;
    cur = i;
    ensureWindow(i);        // 窗口跟着当前条走（窗口化的入口）
    /* 记下当前这条（演示片除外）：下次 App 冷启动时 boot() 一进来就用它打 /api/warm
       提前预热上游 —— 那时片库还没到手，只有这个记忆能告诉后端该热哪条。 */
    try { if (list[i] && !list[i].demo) localStorage.setItem('nasdy.warmPath', list[i].p); } catch (_) {}
    if (prev >= 0) {
      const pv = mounted.get(prev);
      if (pv) pv.pause();
    }
    mount(i, true);
    const item = itemOf(i);
    const v = mounted.get(i);
    // 🔴 预加载后面 N 条（N 由设置里的「预加载条数」决定，默认 5；0 = 不预加载）：
    // 当前这条开播 1s 后先预热下一集（check.js 守护这条路径），
    // 之后 i+2..i+N 每条约错开 350ms 起一路，把 N 路预取请求分摊到时间上，
    // 不至于在同一瞬间和当前视频抢带宽，也避免一次性起 N 个 video 元素拖慢首帧。
    // 注意：playable===false（需转码）的视频在 mount(...,false) 里会自动跳过，
    // 不会为它们白白占服务端 ffmpeg CPU。
    //
    // ⚠️ 为什么「0 条」要单独判断、不能让循环自己空转：下面第 1 条的定时器是
    //    **无条件** push 的（它从 1 开始，不属于 for 循环）。不判断的话，
    //    用户设成 0 反而还会预热 1 条 —— 「设 0 了还在偷偷请求」是最难查的那种 bug。
    warmTimers.forEach(clearTimeout); warmTimers = [];
    const nWarm = preheatCount();
    if (nWarm > 0) {
      const t1 = setTimeout(() => {
        if (cur !== i) return;
        mount(i + 1, false);
      }, 1000);
      warmTimers.push(t1);
      for (let n = 2; n <= nWarm; n++) {
        const t = setTimeout(() => {
          if (cur !== i) return;
          mount(i + n, false);
        }, 1000 + n * 350);
        warmTimers.push(t);
      }
    }
    if (v) {
      v.muted = !S.soundOn;
      startPlayback(v, item, i);
    }
    releaseFar(i);
  }

  function releaseFar(i) {
    // 卸载范围**跟着预加载条数走**（默认 5，可调 0~9）：保留当前这条前后
    // `preheatCount()` 条的路，更远的一律卸载，避免同时挂着太多 video 元素
    // 把内存/带宽拖垮。
    // ⚠️ 之前这里硬编码 5：用户把预加载调大（比如 9）后，新预热的那 4 条
    //    会**刚挂上就被这里卸掉**，表现成「调大了但没效果」。两处必须同一个值。
    const keep = preheatCount();
    for (const k of [...mounted.keys()]) {
      if (Math.abs(k - i) > keep) {
        cleanupVideo(mounted.get(k));
        mounted.delete(k);
        const it = itemOf(k);
        if (it) it.classList.remove('ready', 'stalling', 'paused');
      }
    }
  }

  function togglePlay(i) {
    const v = mounted.get(i);
    const item = itemOf(i);
    if (!v) return;
    if (v.paused) safePlay(v, item);
    else v.pause();                      // pause 事件会 syncPaused，不用手写 class
  }

  /* --- 长按画面 = 倍速播放（松手就恢复） --- */
  const HOLD_MS = 420;      // 按住多久算长按
  const HOLD_MOVE = 12;     // 手指挪超过这么多像素 = 想滑动，取消加速
  const FAST_RATE = 2;

  const el = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------
   * 竖向翻页：**交回浏览器**（2026-09-18 第二次修「不跟手」）
   * ------------------------------------------------------------------
   * 这里原来是一整套 JS 翻页器：跟手时每个 rAF 写 `container.scrollTop`，
   * 抬手再自己算落点 + `scrollTo({behavior:'smooth'})`。
   * 它并不慢 —— profile 实测主线程 89% 空闲、app.js 自己只占 2.6% ——
   * 但它**错在架构**：`scrollTop` 是主线程属性，主线程一忙画面就冻住。
   *
   * 实测（`_tools/visual-block-test.js`：拖动途中用忙等循环堵死主线程 4s 再截图）
   *   · 旧实现（touch-action:none）→ 手指已经划过，画面**纹丝不动**
   *   · 新实现（touch-action:pan-y）→ 画面继续走（合成器线程在滚）
   * 这就是用户说的「不跟手」。抖音那种丝滑，本质就是滚动跑在合成器线程上。
   *
   * 现在竖向完全交给浏览器原生 scroll-snap：
   *   · `.feed` 的 `scroll-snap-type:y mandatory` + `.item` 的
   *     `scroll-snap-align:start` / `scroll-snap-stop:always`
   *     —— 原生语义就是「一次手势只走一条」，而且跑在合成器线程上；
   *   · 落点、惯性、回弹全由浏览器算，比我们自己 round/floor 更准
   *     （§24 那三个落点 bug 从此结构性不存在）。
   *
   * 唯一保留的是 `moving` 这道**帧内去重闸**：长按倍速靠它判断「手指挪了 = 想划走」。
   * 它必须由**常驻** rAF 心跳重置，不能只在有位移时才调度 ——
   * 长按（按住不动）时一个 pointermove 都没有，用抬手重置的话闸永远关不上，
   * 之后再也判不出「手在动」，倍速会摘不掉。空转时它只做一次布尔判断。
   */
  let moving = false;
  (function moveTick() {
    requestAnimationFrame(moveTick);
    if (moving) moving = false;
  })();

  /**
   * 真的去重扫一遍片库。
   * 界面这边不整条重建 —— 只把顺序重洗（跟顶栏「换一批」一个语义），
   * 已经在看的那条被换掉是意料之中的；条数没变时也照样洗，扫完就是一批新片。
   *
   * ⚠️ 唯一的入口是「我的」页那个「重新扫描」按钮。
   *    这里原来是**下拉刷新**（首页顶部往下拽）也走同一个函数 ——
   *    2026-09-18 按用户要求把下拉刷新整个删了（连指示器、手势、touch 监听一起），
   *    但**重扫这个动作本身保留**，所以这个函数还在，只是不再带 `off` 参数、
   *    也不再碰任何 #ptr 指示器。别看到「没人调 runRefresh」就把它删掉。
   */
  async function runRefresh() {
    /* 记下「这次触发过扫描」—— 冷启动补偿用它做 24 小时节流（见 initCd2Panel）。
       runRefresh 的 api.library(true) 是 force=true，必真扫一遍，所以在这里盖戳是准的。 */
    try { localStorage.setItem('nasdy.lastAutoScan', String(Date.now())); } catch (_) {}
    /* ⚠️ `main.pauseAll()` **不能**放在最前面（2026-09-18 踩的）：
       深扫是后台的，下面那条 pendingScan 分支会直接 return，
       暂停了就没人恢复 —— 视频会哑整整十几分钟。
       只有**同步**路径（真正要立刻换片库时）才需要停一下声音。 */
    let ok = true;
    let msg = '';
    try {
      const lib = S.demoMode ? await api.demo() : await api.library(true);
      if (lib.error) throw new Error(lib.error);
      /* 深扫是**后台**的（2026-09-18：不限深度实测 13 分钟，549 → 5496 个）。
         服务端会立刻回话并带上 `pendingScan:true` —— 这时**不能** applyLibrary：
         那份响应带的是**旧片库**，灌进去会闪一下空，而且会把「正在扫」的事实盖掉。
         交给 watchLibraryRefresh 轮询，扫完它会自动整套换上并弹提示。 */
      if (lib && lib.pendingScan) {
        S.pendingScan = true;
        watchLibraryRefresh(lib);
        toast('已在后台重新扫描，扫完自动更新', 2200);
        return;
      }
      main.pauseAll();                                // 换片库前先静音，别让它接着响
      const before = S.videos.map((v) => v.p).join('\n');
      applyLibrary(lib);
      const after = S.videos.map((v) => v.p).join('\n');
      const changed = before !== after;
      // 内容/条数变了 → applyLibrary 里已经 applyFilter() 过，这里别再重洗一遍把它冲掉。
      // 没变 = 「只是想让 NAS 重扫一遍」：条数没动但也重新洗一次牌，跟「换一批」一个语义。
      if (!changed && S.videos.length) reshuffleNow();
      if (NAV === 'home') main.resume();
      msg = changed
        ? `已重扫 · ${S.videos.length} 个视频（有更新）`
        : `已重扫 · ${S.videos.length} 个视频`;
    } catch (e) {
      ok = false;
      msg = friendlyNetErr(e.message);
      console.warn('[rescan] 失败：', e.message);
    }
    toast(ok ? msg : '❌ ' + msg, ok ? 1800 : 3400);
  }

  function endHold() {
    clearTimeout(hold.timer);
    hold.timer = null;
    if (hold.on) {
      hold.on = false;
      hold.fired = true;                 // 紧接着那次 click 是长按的尾巴，别当成暂停/点赞
      const it = itemOf(hold.i);
      if (it) it.classList.remove('fast');
      if (hold.v) { try { hold.v.playbackRate = 1; } catch (_) {} }
      // 万一抬手后浏览器没派 click，也得把标记清掉，别让下一次点击失效
      clearTimeout(hold.firedTimer);
      hold.firedTimer = setTimeout(() => { hold.fired = false; }, 450);
    }
    hold.i = -1;
    hold.v = null;
  }

  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const item = e.target.closest('.item');
    if (!item || !e.target.closest('.vwrap')) return;
    const i = Number(item.dataset.i);
    if (i !== cur) return;                    // 只让正在播的那条加速
    const v = mounted.get(i);
    if (!v) return;
    hold.i = i; hold.v = v;
    hold.x = e.clientX; hold.y = e.clientY;
    clearTimeout(hold.timer);
    hold.timer = setTimeout(() => {
      hold.timer = null;
      if (hold.i !== i) return;
      const it = itemOf(i);
      const vid = mounted.get(i);
      if (!it || !vid) return;
      hold.on = true;
      try { vid.playbackRate = FAST_RATE; } catch (_) {}
      if (vid.paused) safePlay(vid, it);      // 暂停时长按也算「按住快进」
      it.classList.add('fast');
      vibrate(8);
    }, HOLD_MS);
  });
  // 手指一挪就说明是想划走，不是想加速
  container.addEventListener('pointermove', (e) => {
    // ⚠️ 下面这段**必须**先过 moving 这道闸，否则每个 pointermove 都会全跑一遍：
    //    移动端 pointermove 能到 120~240Hz，而这两个函数都不便宜 ——
    //    endHold() 里要查 hold.timer / hold.on / hold.i，activate(i) 会
    //    同步读 document.activeElement、item.classList、offsetParent，
    //    每一个都是布局查询；一次手势几百个事件就是几百次强制同步布局。
    //    V8 的布尔去重只会跳过最外层那个 `return`，函数体进不去 —— 一点没省。
    //    收窄成 `moving` 之后，同一帧内的重复 move 只做一次「还在动吗」的判断。
    if (moving) return;
    if (!hold.timer && !hold.on) return;
    if (Math.abs(e.clientX - hold.x) > HOLD_MOVE || Math.abs(e.clientY - hold.y) > HOLD_MOVE) {
      moving = true;                                     // 这一帧已经判定过「手在动」了
      endHold();                                         // 掐掉长按计时器（幂等，多调无害）
    }
  });
  container.addEventListener('pointerup', () => endHold());
  container.addEventListener('pointercancel', () => endHold());
  container.addEventListener('pointerleave', endHold);

  /* --- 进度条：按住就能拖（以前只能点一下，横向拖动是没反应的） --- */
  /** 一段矩形 + x 坐标 → 0~1 的比例 */
  function ratioOfRect(r, clientX) {
    if (!r || !r.width) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  }
  const ratioAt = (track, clientX) => ratioOfRect(track.getBoundingClientRect(), clientX);

  function endScrub(commit) {
    if (!scrub.on) return;
    const i = scrub.i;
    const ratio = scrub.ratio;
    scrub.on = false;
    scrub.i = -1;
    if (scrub.item) scrub.item.classList.remove('scrub');
    scrub.item = null; scrub.bar = null; scrub.rect = null;
    // 吞掉紧跟着的这一次 click，否则松手会被当成「点进度条」再跳一次 ——
    // 转码流跳一次就是重启一路 ffmpeg，连跳两次画面会闪黑
    scrub.fired = true;
    clearTimeout(scrub.firedTimer);
    scrub.firedTimer = setTimeout(() => { scrub.fired = false; }, 400);
    if (commit) seekTo(i, ratio);
    else if (i >= 0) paintProgress(i);       // 被系统打断 → 画回真实进度
  }

  /** 拖动中只画进度，不真跳 */
  function paintScrub() {
    if (scrub.bar) scrub.bar.style.width = (scrub.ratio * 100).toFixed(2) + '%';
  }

  container.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const prog = e.target.closest('.progress');
    if (!prog) return;
    const item = e.target.closest('.item');
    const track = prog.querySelector('.track');
    const bar = prog.querySelector('.bar');
    if (!item || !track || !bar) return;
    const i = Number(item.dataset.i);
    if (!mounted.get(i)) return;              // 这条还没挂上视频，拖了也没用
    endHold();                                // 按在进度条上不算「长按加速画面」
    scrub.on = true;
    scrub.i = i;
    scrub.item = item;
    scrub.bar = bar;
    scrub.rect = track.getBoundingClientRect();
    scrub.ratio = ratioAt(track, e.clientX);
    item.classList.add('scrub');
    // 捕获指针：手指滑出进度条（甚至滑出屏幕）也还能继续跟手
    try { container.setPointerCapture(e.pointerId); } catch (_) {}
    paintScrub();
    e.preventDefault();
  });

  container.addEventListener('pointermove', (e) => {
    if (!scrub.on) return;                    // 不在拖就交给上面那段长按判定
    scrub.ratio = ratioOfRect(scrub.rect, e.clientX);
    paintScrub();
    if (e.cancelable) e.preventDefault();     // 拖动时别让页面跟着滚动
  });

  container.addEventListener('pointerup', () => endScrub(true));
  container.addEventListener('pointercancel', () => endScrub(false));

  /* --- 点击：单击画面 = 暂停/播放，双击画面 = 点赞 --- */
  container.addEventListener('click', (e) => {
    if (hold.fired) { hold.fired = false; return; }   // 长按松手那一下不算点击
    if (scrub.fired) { scrub.fired = false; return; } // 刚拖过进度条，别再跳一次
    const actEl = e.target.closest('[data-act]');
    if (actEl) { e.stopPropagation(); doAction(actEl.dataset.act, actEl, self); return; }
    const item = e.target.closest('.item');
    if (!item) return;
    const i = Number(item.dataset.i);
    if (e.target.closest('.progress')) {
      // 兜底：正常松手时 pointerup 已经跳过了，这里只兜「没走 pointer 事件」的情况
      const track = e.target.closest('.track');
      if (track) seekTo(i, ratioAt(track, e.clientX));
      return;
    }
    if (!e.target.closest('.vwrap')) return;
    if (isPlayer) {
      // 播放器的触摸点按/双击交给统一手势层（pointer 事件），不和横滑快进抢；
      // 桌面端没有手势，鼠标单击画面 = 暂停 / 播放
      if (!IS_TOUCH) togglePlay(i);
      return;
    }

    const now = Date.now();
    if (now - tap.t < 300 && tap.i === i) {     // 双击 → 点赞
      clearTimeout(tap.timer);
      tap.t = 0; tap.i = -1;
      burstAt(e.clientX, e.clientY);
      setLike(list[i].p, true);
      return;
    }
    tap.t = now; tap.i = i;
    clearTimeout(tap.timer);
    tap.timer = setTimeout(() => { tap.t = 0; tap.i = -1; togglePlay(i); }, 260);
  });

  container.addEventListener('dblclick', (e) => e.preventDefault());

  /**
   * 这条流能不能原生 seek（直接改 currentTime 就跳，不用重启流）？
   *
   * ⚠️ 为什么不能只看 `dataset.mode`：APK 的「转码流」其实是假的 ——
   * 服务端没有 ffmpeg，只是把原文件当直连流代理出去，Range 完全可用。
   * 实测这种流 seekable 覆盖整个文件（0 ~ 全长），currentTime 直接跳就行。
   *
   * 判据：seekable 必须**真的覆盖**整个文件。只看 length > 0 不够 ——
   * 有些流没有 moov 索引时 seekable 是个很窄的窗口，跳过去会直接卡住。
   */
  function canNativeSeek(v) {
    if (!v) return false;
    try {
      const s = v.seekable;
      if (!s || s.length === 0) return false;
      const end = s.end(s.length - 1);
      const dur = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      if (dur > 0) return end >= dur * 0.9;   // 覆盖九成以上就算「想跳哪都行」
      return end > 0;
    } catch (_) { return false; }
  }

  /**
   * 保证拿到这部片的总时长（写进 item.dataset.dur）。
   *
   * 转码流自己没有时间轴，时长只能问服务端（/api/probe）。
   * 这件事以前散在三处各写一遍 api.probe(...).then(...)，而且**都不处理「还没回来用户就拖了」**，
   * 于是拖进度条会撞上「还没读出时长」的提示。现在统一走这里，并且：
   *   · 同一条片正在探就不重复发（拖着连点会连发好几个请求）
   *   · 探回来之后，如果用户之前拖过（pendSeek），自动把那次跳转补上
   */
  const durWait = new Map();          // i → Promise，正在探的
  function ensureDuration(i, item) {
    if (!item) item = itemOf(i);
    if (!item || !list[i]) return Promise.resolve(0);
    const got = Number(item.dataset.dur || 0);
    if (got > 0) return Promise.resolve(got);
    if (durWait.has(i)) return durWait.get(i);

    const p = api.probe(list[i].p).then((r) => {
      durWait.delete(i);
      // 顺手把画面尺寸也收了 —— /api/probe 本来就返回 width/height，
      // 而转码流的 video.videoWidth 永远是 0，只能靠这里（详见 askBoxDims 的注释）。
      // 白捡的，不用多发一次请求。
      if (r && r.ok && r.width && r.height) {
        boxDims.set(list[i].p, [r.width, r.height]);
        boxPending.delete(list[i].p);
        const v = mounted.get(i);
        if (v) fitVideoBox(item, v, i);
      }
      if (!r || !r.ok || !r.duration) return 0;
      const d = Number(r.duration) || 0;
      if (d <= 0) return 0;
      item.dataset.dur = String(d);
      paintProgress(i);
      // 用户拖进度条时时长还没到 —— 现在到了，把那次跳转补上
      const pend = item.dataset.pendSeek;
      if (pend != null) {
        delete item.dataset.pendSeek;
        if (item.dataset.mode === 'transcode' && cur === i) seekTo(i, Number(pend));
      }
      return d;
    }).catch(() => { durWait.delete(i); return 0; });

    durWait.set(i, p);
    return p;
  }

  /** 跳到 ratio（0~1）位置。点一下和拖到底都用它 */
  function seekTo(i, ratio) {
    const v = mounted.get(i);
    const item = itemOf(i);
    if (!v || !item) return;
    const at = Math.min(1, Math.max(0, Number(ratio) || 0));

    if (item.dataset.mode === 'transcode') {
      // 转码流原则上没有时间轴可跳，只能从目标位置重新起一路流。
      //
      // ⚠️ 但「转码流」有两种：真·服务端转码（Node 版，一路 ffmpeg 拼出来，不可 seek）
      // 和 APK 的「假装转码」（其实就是直连原文件，Range 是通的，原生就能 seek）。
      // 后者如果还走「重新起流」，src 一换就从头开始 —— 用户看到的就是
      // 「无论怎么拖都从头播」。所以先问：这条流到底能不能原生 seek？
      const total = Number(item.dataset.dur || 0);

      // 能原生 seek 就直接跳，别动 src（这才是不重启的正确姿势）
      if (canNativeSeek(v)) {
        if (total > 0) {
          const target = at * total;
          // ⚠️ t0 表示「这路流是从第几秒开始发的」。原生 seek 的流是**整条**发过来的，
          // 起点就是 0 —— 所以 t0 必须归零。进度条按 t0 + currentTime 换算，
          // 这里要是也写成 target，就会算成两倍（2×target），进度条直接飞出屏幕。
          item.dataset.t0 = '0';
          try { v.currentTime = target; } catch (_) {}
          paintProgress(i);
          return;
        }
        // 时长还没回来：记下想去的位置，等 ensureDuration 拿到总时长再跳
        item.dataset.pendSeek = String(at);
        ensureDuration(i, item);
        paintProgress(i);
        return;
      }

      if (!total) {
        // 真·转码流 + 时长还没探回来。以前这里直接弹「还没读出时长，先从头看吧」就结束了 ——
        // 但用户拖进度条的意图很明确，不该被一句提示挡回去。
        // 现在改成：记下这次想跳的位置，等时长一到就自动跳过去。
        item.dataset.pendSeek = String(at);
        toast('正在读取时长，稍后自动跳到这个位置');
        ensureDuration(i, item);
        paintProgress(i);
        return;
      }
      // 到这儿说明「有总时长，但当前流还不满足原生 seek」（多半是刚起流、
      // seekable 还没铺开，或者真是 Node 版拼出来的不可 seek 流）。
      // 给一次机会：等 900ms 让 seekable 铺开再判一次。还不行才走「重启一路流」。
      // 之所以要这一手：APK 上重启流 = 从 0 开始，正是用户抱怨的那个现象，
      // 能在不重启的情况下跳过去就绝不重启。
      if (item.dataset.seekRetry !== '1') {
        item.dataset.seekRetry = '1';
        item.classList.add('stalling');
        paintProgress(i);
        setTimeout(() => {
          const it = itemOf(i);
          if (!it) return;
          if (it.dataset.seekRetry !== '1') return;        // 这一轮已经被别处收尾了
          delete it.dataset.seekRetry;
          if (cur !== i || it.dataset.pendSeek != null) return;
          const cur2 = mounted.get(i);
          if (cur2 && canNativeSeek(cur2)) { seekTo(i, at); return; }   // 这回能了 → 原生跳
          // 还是不能：说明确实是不可 seek 的流，老老实实重启（Node 版的正常路径）
          restartStream(i, at, total, it);
        }, 900);
        return;
      }
      delete item.dataset.seekRetry;
      restartStream(i, at, total, item);
      return;
    }
    if (!v.duration || !isFinite(v.duration)) { paintProgress(i); return; }
    // 直连原生流：t0 必须是 0（整条流从头发的），进度 = 0 + currentTime
    item.dataset.t0 = '0';
    v.currentTime = at * v.duration;
    paintProgress(i);
  }

  /**
   * 重启一路流来「跳转」—— 这是**真·转码流**（Node 版，ffmpeg 拼出来的）的唯一办法。
   * APK 上不该走到这里（它的流是原生可 seek 的，见 seekTo 里的 canNativeSeek 分支）。
   */
  function restartStream(i, at, total, item) {
    if (!item) item = itemOf(i);
    if (!item) return;
    const target = at * total;
    item.dataset.t0 = String(target);        // 进度条先跟到目标位置，别等 ffmpeg
    item.classList.add('stalling');
    paintProgress(i);
    // 连点快进 / 来回拖：合并成最后一次再起，否则每一下都要等一次重启
    clearTimeout(seekTimer.get(i));
    seekTimer.set(i, setTimeout(() => {
      seekTimer.delete(i);
      const vv = mounted.get(i);
      if (!vv) return;
      // 换 src 之前先摘掉大播放按钮：这一路是**自动**接着播的，
      // 留着它就会在换流的空档里晃出来，而且容易被后面的事件漏掉摘不干净。
      item.classList.remove('paused');
      vv.src = transUrl(list[i], target, item.dataset.enc === '1' ? 'encode' : 'auto');
      if (cur === i) safePlay(vv, item);
      // 换流后复查一次：真起播了就把遮罩摘掉；确实没起播才把按钮还给用户。
      // 这一步专治「快进完按钮糊在画面上不走了」——不论中间被 AbortError
      // 还是别的什么打断，最终都以这一帧的真实状态收尾。
      clearTimeout(seekSettle.get(i));
      seekSettle.set(i, setTimeout(() => {
        seekSettle.delete(i);
        const v2 = mounted.get(i);
        if (!v2 || cur !== i) return;
        if (!v2.paused) { item.classList.remove('paused', 'stalling'); return; }
        if (v2.readyState >= 2) syncPaused(v2, item);   // 真停了才显示按钮
      }, 1500));
    }, 220));
  }

  function refreshItem(id) {
    const v = byId(id);
    if (!v) return;
    [...container.children].forEach((item) => {
      if (item.dataset.id === id) updateActions(item, v);
    });
  }

  /** 视频出错后重试：把原来的 video 彻底销毁再挂一次 */
  function retry(i) {
    const item = itemOf(i);
    if (!item) return;
    const old = mounted.get(i);
    if (old) { cleanupVideo(old); mounted.delete(i); }
    item.classList.remove('ready', 'stalling');
    const v = mount(i, true);
    if (v && cur === i) safePlay(v, item);
  }

  /**
   * 重洗这条流：清掉随机序（orderVideos 会重新排），回到第一条。
   * 下拉刷新和顶栏「换一批」共用这段 —— 两者对用户是同一个语义：给我来一批新的。
   */
  function reshuffleNow() {
    S.order = [];
    /* 🔴 必须先 build 再归位，顺序反了就停不住（2026-09-21 修）：
       `scrollTop = 0` 写在一个**还停在远处**的窗口上时，0 那个位置被占着的是
       几屏高的占位块 —— **它不是吸附点**，浏览器会按 mandatory 吸附规则
       弹回最近的 item（实测从第 8 条点「换一批」，结果停在第 6 条没回去）。
       build() 之后窗口回到 [0, 9]、上占位块归 0，0 才是合法吸附点。
       同一个坑也适用于其它直写滚动位置的地方，见 goVid 那条注释。 */
    list = orderVideos(S.videos);
    build();
    container.scrollTop = 0;
    activate(0, true);
  }

  const self = {
    load(next) { list = next || []; build(); },
    /**
     * 只换数据、不重建 DOM。
     * 后台把新增视频扫回来时，如果顺序和条数都没变，就不该把整条流推倒重来 ——
     * 否则正在看的那一条会被切走、滚动位置也会跳。
     */
    refreshList(next) { if (next && next.length === list.length) list = next; },
    itemHTMLAt(i) { return itemOf(i); },
    get index() { return cur; },
    get list() { return list; },
    get mounted() { return mounted; },
    isPlayer: !!opts.isPlayer,          // 播放器那条 feed，和首页 feed 区分开
    activate, refreshItem, retry,
    /** 下拉刷新用：重扫完了把这条流按新顺序重洗一遍（页面的 applyFilter 会调它） */
    reshuffleNow,
    /** 「我的」页那个「重新扫描」按钮走这里。 */
    rescan() { return runRefresh(); },
    seekRatio(r) { if (cur >= 0) seekTo(cur, r); },  // 手势层（横滑快进）从外部跳进度
    scrollToIndex(i, smooth) {
      ensureWindow(i);                  // 先铺窗口：几何不变，落点仍是 i × 容器高
      const h = container.clientHeight;
      container.scrollTo({ top: i * h, behavior: smooth ? 'smooth' : 'auto' });
    },
    pauseAll() {
      mounted.forEach((v) => { try { v.pause(); } catch (_) {} });
    },
    resume() {
      if (cur < 0) { activate(0); return; }
      const v = mounted.get(cur);
      if (v) safePlay(v, itemOf(cur));
    },
    scrollBy(dir) {
      const next = Math.min(list.length - 1, Math.max(0, cur + dir));
      this.scrollToIndex(next, true);
    },
    clear() {
      io.disconnect(); mounted.forEach(cleanupVideo); mounted.clear();
      container.innerHTML = ''; list = []; cur = -1;
      lo = -1; hi = -2; topPad = null; botPad = null;   // 窗口状态一起复位，否则下次 build 的 syncWindow 会以为窗口还在
    },
  };
  return self;
}

const byId = (id) => S.byId.get(id);

/* ---------- 坏码流登记 ----------
 * 个别片源（如 NCYF-026）码流本身有毛病：参数完全正常（1080p H.264），
 * 但浏览器解码持续丢帧（实测 13~22%）。根因是**源文件 PTS 非单调**：
 * 帧间隔在 +100ms / -33ms 之间来回跳（正常应恒为 33.37ms），
 * Chromium 的软解渲染器按 PTS 严格排序上屏，碰到乱序帧只能丢。
 *
 * 治它的手段只有两个，而且**取决于服务端能力**：
 *   - 有 ffmpeg → 重编码，重新生成干净时间戳（PC / 群晖）
 *   - 没 ffmpeg → 只能换系统硬解播放器（APK 的 MediaCodec 按 DTS 解，容忍抖动）
 *
 * ⚠️ 所以这份名单**只在服务端有 ffmpeg 时才有意义**。APK 上没有 ffmpeg，
 * 「重编码流」是假的（见技能 §8），拿它当依据只会让用户每次打开都白等一次换流。 */
const BAD_KEY = 'nasBadStream';
function badStreamGet(p) {
  // 没 ffmpeg 的环境里这个标记指向的是假重编码，直接当作不存在
  if (!S.ffmpeg) return false;
  try { return !!(JSON.parse(localStorage.getItem(BAD_KEY) || '{}')[p]); } catch (_) { return false; }
}
/** 只写本地，不上报服务器（用于把服务器名单同步到本地） */
function badStreamMarkLocal(p) {
  if (!S.ffmpeg) return;              // 同上：没真重编码可言，记了也没用
  try {
    const m = JSON.parse(localStorage.getItem(BAD_KEY) || '{}');
    if (m[p]) return;
    m[p] = 1;
    localStorage.setItem(BAD_KEY, JSON.stringify(m));
  } catch (_) {}
}
function badStreamSet(p) {
  try {
    const m = JSON.parse(localStorage.getItem(BAD_KEY) || '{}');
    if (m[p]) return;                  // 已经记过了，别重复上报
    m[p] = 1;
    localStorage.setItem(BAD_KEY, JSON.stringify(m));
  } catch (_) {}
  // 同步到服务器：换台设备 / 重装 App 也直接走重编码，不用再卡一次等检测
  api.act({ type: 'badstream', id: p, on: true }).catch(() => {});
}

/**
 * 清理旧版本在无 ffmpeg 环境下误标的名单。
 * 这些条目是被「假重编码」逻辑写进去的（当时以为切了重编码就好了），
 * 实际上它们指向的转码 URL 和直连流是一回事 —— 留着只会让这些片每次打开
 * 都白等一次换流、时长还要多探一次。直连流播 + 必要时引导硬解才是正解。
 */
function badStreamPurgeLegacy() {
  if (S.ffmpeg) return;               // 有 ffmpeg 的话名单是有效的，别动
  try {
    const m = JSON.parse(localStorage.getItem(BAD_KEY) || '{}');
    const n = Object.keys(m).length;
    if (!n) return;
    localStorage.removeItem(BAD_KEY);
    console.info('[badstream] 已清理 ' + n + ' 个误标条目（本环境无 ffmpeg）');
  } catch (_) {}
}

/* ------------------------------ 模板 ------------------------------ */
function itemHTML(v, opts = {}) {
  /* .strm 链接条目给个醒目小标（2026-09-19）：它不是本地视频文件，
     播放时后端会解析里面的直链/路径（302 或代理），用户得能一眼认出来。 */
  const strmTag = (v.ext === 'strm') ? '<span class="badge strm">STRM</span>' : '';
  return `
  <div class="grad-top"></div>
  <div class="vwrap">
    <div class="vbox">
      <div class="vph">
        <div>${escapeHtml(v.title || v.name)}</div>
      </div>
      <div class="pause-ind">${IC.playBig}</div>
    </div>
  </div>
  <div class="grad-bottom"></div>
  <div class="rate-ind"><b>2.0x</b> 倍速播放中</div>
  <div class="rail">
    <button class="rail-item" data-act="like">
      <div class="ic">${IC.heart}</div><div class="num">点赞</div>
    </button>
    <button class="rail-item" data-act="fav">
      <div class="ic">${IC.star}</div><div class="num">收藏</div>
    </button>
    ${opts.noFull ? '' : `<button class="rail-item" data-act="full">
      <div class="ic">${IC.expand}</div><div class="num">全屏</div>
    </button>`}
  </div>
  <div class="meta">
    ${strmTag ? `<div class="author">${strmTag}</div>` : ''}
    <div class="desc">${escapeHtml(v.title || v.name)}</div>
    <div class="finfo">
      <i class="fi-ic"></i>
      <span>${escapeHtml(v.folder || '根目录')} · ${fmtSize(v.size)}</span>
    </div>
  </div>
  <div class="progress"><div class="track"><div class="bar"></div></div></div>`;
}

function updateActions(item, v) {
  const liked = !!S.likes[v.p];
  const faved = !!S.favorites[v.p];
  const likeBtn = item.querySelector('[data-act="like"]');
  const favBtn = item.querySelector('[data-act="fav"]');
  if (likeBtn) {
    likeBtn.classList.toggle('on', liked);
    likeBtn.querySelector('.ic').innerHTML = liked ? IC.heartOn : IC.heart;
    likeBtn.querySelector('.num').textContent = liked ? '已赞' : '点赞';
  }
  if (favBtn) {
    favBtn.classList.toggle('fav-on', faved);
    favBtn.querySelector('.ic').innerHTML = faved ? IC.starOn : IC.star;
    favBtn.querySelector('.num').textContent = faved ? '已收藏' : '收藏';
  }
}

/* ------------------------------ 动作 ------------------------------ */
function vibrate(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (_) {} }

function setLike(id, on) {
  if (!!S.likes[id] === on) return;
  if (on) S.likes[id] = { t: Date.now() }; else delete S.likes[id];
  api.act({ type: 'like', id, on }).catch(() => {});
  syncTouch();              // 登录了同步账号的话，攒一下自动推上去
  forAllFeeds((f) => f.refreshItem(id));
  refreshBadges();          // 「我的」页正开着的话，点赞数和顺序要跟着变
  vibrate(14);
}

function toggleFav(id) {
  const on = !S.favorites[id];
  if (on) S.favorites[id] = { t: Date.now() }; else delete S.favorites[id];
  api.act({ type: 'favorite', id, on }).catch(() => {});
  syncTouch();
  forAllFeeds((f) => f.refreshItem(id));
  refreshBadges();
  vibrate(10);
  toast(on ? '已加入收藏 ⭐' : '已取消收藏');
}

function doAction(act, el, feed) {
  const item = el.closest('.item');
  const id = item.dataset.id;
  const v = byId(id);
  if (!v) return;
  if (act === 'like') {
    if (!S.likes[id]) {
      const r = el.getBoundingClientRect();
      burstAt(r.left + r.width / 2, r.top + r.height / 2);
    }
    setLike(id, !S.likes[id]);
  } else if (act === 'fav') {
    toggleFav(id);
  } else if (act === 'full') {
    // 安卓 APK：交给原生播放器（系统硬解，从当前位置接着播）
    const vd = item.querySelector('video');
    if (nativePlay(v, vd ? vd.currentTime : 0)) {
      try { vd && vd.pause(); } catch (_) {}     // 别和原生播放器一起出声
      return;
    }
    // 播放器里的「全屏」= 就地从内联竖屏切到全屏（不重开、不丢进度）
    if (feed && feed.isPlayer) expandPlayer();
    else if (feed && feed.list.length) openPlayer(feed.list, Number(item.dataset.i));
  } else if (act === 'retry') {
    item.querySelector('.v-err')?.remove();
    const idx = Number(item.dataset.i);
    if (feed) feed.retry(idx);
    else location.reload();
  }
}

/* 双击 / 按钮点赞的爱心。.burst 是 fixed 定位，直接用视口坐标 */
let burstTimer = null;
function burstAt(clientX, clientY) {
  const el = $('burst');
  el.style.left = clientX + 'px';
  el.style.top = clientY + 'px';
  el.innerHTML = IC.heartBig;
  clearTimeout(burstTimer);
  burstTimer = setTimeout(() => { el.innerHTML = ''; }, 820);
  vibrate(18);
}

/* ------------------------------ 面板 ------------------------------ */
let sheetOpen = null;

/* 🔴 面板一开，它背后就是「**正在播的视频** + 26px 玻璃模糊」——
 *    这层 `.sheet` 的 backdrop-filter 每一帧都要把下面的视频重新取一次做模糊，
 *    是整个 App 里最贵的一处合成（2026-09-21 卡顿排查）。实机上是「一点设置就卡」。
 *    把首页视频停住，模糊的背景就变成静止画面、只需栅格化一次；关面板再原样恢复。
 *    ⚠️ 只停「确实在播」的那条：用户自己按了暂停就别去动它（否则关面板会莫名起播）。 */
let sheetPausedFeed = false;
function pauseFeedForSheet() {
  if (sheetPausedFeed || NAV !== 'home' || document.hidden) return;
  const v = main.mounted.get(main.index);
  if (!v || v.paused) return;            // 本来就是暂停的 → 别擅自起播
  sheetPausedFeed = true;
  main.pauseAll();
}
function resumeFeedAfterSheet() {
  if (!sheetPausedFeed) return;
  sheetPausedFeed = false;
  if (NAV === 'home' && !document.hidden) main.resume();
}

function openSheet(id) {
  // openSheet 内部会先 closeSheet 来「关掉上一个面板」：这种**换面板**的场合
  // 不能真去恢复视频（会刚起播又被暂停，白闪一下）。
  const switching = !!sheetOpen;
  closeSheet(true);
  sheetOpen = id;
  $('mask').hidden = false;
  $(id).hidden = false;
  if (!switching) pauseFeedForSheet();
  if (id === 'configSheet') fillConfigForm();
  if (id === 'syncSheet') syncRender();
}
function closeSheet(keepPaused) {
  $('mask').hidden = true;
  ['configSheet', 'searchSheet', 'dirPickSheet', 'syncSheet', 'settingsSheet'].forEach((i) => { $(i).hidden = true; });
  sheetOpen = null;
  if (!keepPaused) resumeFeedAfterSheet();
}
/* ⚠️ 遮罩点击要**分层**：目录选择器是叠在设置页之上的第二层，
 *    点遮罩应该只收掉它、把设置页留着 —— 不然用户挑完目录一失手点空白，
 *    整个设置页（连他刚填的地址密码）都飞了，得从头再来。 */
$('mask').addEventListener('click', () => {
  if (sheetOpen === 'dirPickSheet') return closeDirPick();
  closeSheet();
});
document.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

/* ------------------------------ 网格页 ------------------------------ */
function renderGrid(box, list, emptyEl) {
  box.innerHTML = '';
  box._list = list;
  if (emptyEl) emptyEl.hidden = list.length > 0;
  list.forEach((v, i) => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.dataset.i = String(i);
    cell.innerHTML = `<div class="ph">🎬</div><div class="cap">${escapeHtml(v.title || v.name)}</div>`;
    box.appendChild(cell);
  });
  const root = box.closest('.page') || box.closest('.sheet-body') || null;
  const gio = new IntersectionObserver((ents) => {
    ents.forEach((e) => {
      if (!e.isIntersecting) return;
      const cell = e.target;
      gio.unobserve(cell);
      const v = list[Number(cell.dataset.i)];
      if (v && v.playable === false) return;   // 放不了的格式抽不了帧，留个 🎬 占位
      // 缩略图走服务端抽帧落盘缓存：/api/thumb 命中即秒出，不再每次现拉流 seek
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.alt = v.title || v.name || '';
      img.src = '/api/thumb?p=' + encodeURIComponent(v.p);
      img.addEventListener('load', () => cell.querySelector('.ph')?.remove());
      img.addEventListener('error', () => {
        const p = cell.querySelector('.ph');
        if (p) p.textContent = '⚠️';
      });
      cell.insertBefore(img, cell.firstChild);
    });
  }, { root, rootMargin: '240px 0px' });
  [...box.children].forEach((c) => gio.observe(c));
  box._gio = gio;
}

/** 点赞/收藏列表都按「操作时间倒序」排 —— 刚点的排最前面，翻起来不用往下找 */
function favList() {
  return S.videos.filter((v) => S.favorites[v.p])
    .sort((a, b) => (S.favorites[b.p]?.t || 0) - (S.favorites[a.p]?.t || 0));
}
function likeList() {
  return S.videos.filter((v) => S.likes[v.p])
    .sort((a, b) => (S.likes[b.p]?.t || 0) - (S.likes[a.p]?.t || 0));
}

/*
 * 补齐点赞/收藏视频的缩略图。
 * 图是存在 App 私有目录（filesDir/thumbs）里的，重启也在，所以这里只是把
 * 「还没有图」的那几条排进服务端队列 —— 服务端抽完会落盘，下次启动就全都有了，
 * 不会每启动一次重抽一遍。
 * 抽帧很慢（要连 NAS 读流，一条 2 秒左右），所以：
 *   - 只排当前列表里真实存在的（收藏了但片源被删的排了也抽不出来）
 *   - 每次最多排 30 条，剩下的交给下一轮，别把 NAS 带宽一次性占满
 */
let thumbBackfillAt = 0;
function backfillThumbs(force) {
  if (S.demoMode) return;
  const all = [...likeList(), ...favList()];
  const uniq = new Map(all.map((v) => [v.p, v]));
  const items = [...uniq.keys()];
  if (!items.length) return;
  // 启动时每隔 10 分钟才补一次，避免来回切页把同样的请求发烂
  if (!force && Date.now() - thumbBackfillAt < 600000) return;
  thumbBackfillAt = Date.now();
  api.thumbBackfill(items.slice(0, 30)).catch(() => { /* NAS 没起来就先算了，下次再说 */ });
}

/** 「我的」页里那两段列表当前看的是哪一段：'like' 点赞 / 'fav' 收藏（默认先看点赞，和分段左起第一个一致） */
let ME_TAB = 'like';

function renderMeList() {
  const isLike = ME_TAB === 'like';
  const list = isLike ? likeList() : favList();
  $('meListTitle').textContent = isLike ? '我点赞的' : '我的收藏';
  $('meListCount').textContent = list.length + ' 个视频';
  document.querySelectorAll('#meSeg button').forEach((b) => b.classList.toggle('on', b.dataset.tab === ME_TAB));
  const empty = $('meEmpty');
  empty.innerHTML = isLike
    ? '还没有点赞～<br><span>刷到喜欢的点一下 ❤️ 就好</span>'
    : '还没有收藏～<br><span>刷到喜欢的点一下 ⭐ 就好</span>';
  renderGrid($('meGrid'), list, empty);
}

/** 切到「我的」页，切好分段，并滚到列表那里 */
function openMeList(tab) {
  ME_TAB = tab === 'like' ? 'like' : 'fav';
  setNav('me');
  renderMeList();
  const page = $('pageMe'), head = $('meListHead');
  if (!page || !head) return;
  const target = Math.max(0, head.offsetTop - 10);
  try { page.scrollTo({ top: target, behavior: 'smooth' }); } catch (_) { page.scrollTop = target; }
}

function renderMePage() {
  const name = S.config.nickname || 'NAS 影迷';
  const av = $('meAvatar');
  /* 自定义头像存在 localStorage（256px JPEG dataURL，几十 KB）：
     有图就铺上、把首字母摘掉；没有就回落到首字母。 */
  const avImg = LS.get('avatar', '');
  if (avImg) {
    av.textContent = '';
    av.style.backgroundImage = `url(${avImg})`;
  } else {
    av.textContent = initial(name);
    av.style.backgroundImage = '';
  }
  $('meName').textContent = name;
  $('statFav').textContent = Object.keys(S.favorites).length;
  $('statLike').textContent = Object.keys(S.likes).length;
  $('statVid').textContent = S.videos.length;
  const lines = [];
  if (S.demoMode) {
    lines.push('当前：演示模式（还没连 NAS）');
  } else {
    /* 「紧凑版」（2026-09-23，用户报真机字体放大后这四行各折成两行）：
       每行都要在系统字体缩放 1.3× 下仍放得下 —— 长话短说，别加字。 */
    lines.push(`数据源：WebDAV ${escapeHtml(originOf(S.config.url).replace(/^http:\/\//, ''))}`);
    /* 🔴 读 `S.dirs` 而不是 `S.config.dirs`（2026-09-20 修的 bug）。
     *
     * 现象：用户在「文件夹」页把片源全删了，那里显示「还没添加」，
     *      但「我的」页还写着「片源 1 个文件夹：云下载」，**不重启就一直不对**。
     *
     * 根因：这两个字段都叫「片源」但来源不同 ——
     *   · `S.dirs`        = 片库扫描结果带回来的**当前真正在刷**的片源（会随清空归零）
     *   · `S.config.dirs` = 配置里那份，**只在 applySources() 那一瞬间被赋值**，
     *                       之后没人刷新它（打开本页不重新拉 /api/config）
     * 本页原来读的是后者，于是拿到一份陈旧配置；而「文件夹」页读的是前者。
     * 两处必须统一 —— 现在统一到 `S.dirs`（它才是「现在实际在刷什么」的真相）。 */
    const dirs = S.dirs || [];
    lines.push(dirs.length
      ? `片源 ${dirs.length} 个：` + dirs.map((d) => escapeHtml(srcLabel(d))).join('、')
      : '片源：还没添加');
  }
  /* 片库条数就是上面第三个大数字（statVid），这里别再念一遍 —— 只说扫描时间。 */
  lines.push(`片库：${scanTimeText()}`);
  $('meSrc').innerHTML = lines.join('<br>');
  renderMeVersion();
  renderMeList();
  renderThumbLine();
}

/**
 * 版本号那行小字（2026-09-20）。
 *
 * 值来自 `/api/config` 的 `versionName` —— APK 版是后端从 PackageManager 读
 * manifest 里那份（= build.js 每次打包自动涨的那个），PC 版固定 `'PC'`。
 * 所以**不用**在前端写死任何版本字符串：前端只管显示。
 *
 * ⚠️ 拿不到就 `hidden`（不显示空壳 / 不显示 `vundefined`）——
 *    旧后端没有这个字段时不能把界面弄脏。
 */
function renderMeVersion() {
  const el = $('meVer');
  if (!el) return;
  const v = S.config && S.config.versionName;
  if (!v) { el.hidden = true; return; }
  const code = S.config.versionCode;
  // 2026-09-20：用户要求「我的」页不显示版本号，保留函数与断言所需代码。
  el.hidden = true;
  el.textContent = 'v' + v + (code ? ' (' + code + ')' : '');
}

/** 缩略图存了多少张、占多大 —— 让「图是存下来的、不是每次现抽」这件事看得见 */
async function renderThumbLine() {
  const el = $('meThumb');
  if (!el) return;
  if (S.demoMode) { el.textContent = ''; return; }
  try {
    const r = await api.thumbStats();
    const mb = (r.bytes || 0) / 1048576;
    el.textContent = `缩略图 ${r.cached || 0} 张 · ${mb < 0.1 ? (r.bytes / 1024).toFixed(0) + ' KB' : mb.toFixed(1) + ' MB'}` +
      ' · 存本机，重启免重抽';
  } catch (_) { el.textContent = ''; }
}

function refreshBadges() {
  if (!$('pageMe').hidden) {
    renderMePage();
    backfillThumbs(false);
  }
}

/* ------------------------------ 头像 & 改名（2026-09-19） ------------------------------ */
/**
 * 点头像 → 系统图片选择器（APK 侧 Chrome.onShowFileChooser 已接住 <input type=file>）
 * → canvas 压成 256×256 的 JPEG dataURL 存 localStorage（几十 KB，不占配额也不上传）。
 * 居中裁方：按短边取中间正方形，竖图横图都不变形。
 */
$('meAvatar').addEventListener('click', () => $('avatarFile').click());
$('avatarFile').addEventListener('change', () => {
  const f = $('avatarFile').files && $('avatarFile').files[0];
  $('avatarFile').value = '';                       // 允许下次选同一张也能触发 change
  if (!f || !/^image\//.test(f.type)) return toast('请选一张图片', 2400);
  const img = new Image();
  const url = URL.createObjectURL(f);
  img.onload = () => {
    try {
      const S2 = 256;                               // 输出尺寸：头像用足够，存储也小
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement('canvas');
      c.width = S2; c.height = S2;
      const g = c.getContext('2d');
      // 居中裁方：sx/sy 取「多余部分的一半」，短边贴满
      g.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2,
        side, side, 0, 0, S2, S2);
      const data = c.toDataURL('image/jpeg', 0.85);
      LS.set('avatar', data);
      renderMePage();
      toast('头像已更新', 1800);
      /* 和点赞/收藏同一条路：改完打一个防抖，几秒后自动推给账号。
         （2026-09-22 用户要求：头像名字要跟点赞收藏一样自动同步。）
         头像本身也在 syncPayload 的 profile 里（带 hash 比对，只有真改过才带）。 */
      syncTouch();
    } catch (e) {
      toast('头像处理失败：' + e.message, 2600);
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  img.onerror = () => { URL.revokeObjectURL(url); toast('这张图读不出来，换一张试试', 2600); };
  img.src = url;
});

/**
 * 点名字 → 变成输入框，回车 / 失焦保存（存进配置里的 nickname，多设备同步）。
 * ⚠️ 不用 prompt()：WebView 没实现 onJsPrompt 时它会静默返回 null（项目里
 *    confirm() 就栽过这个），内联输入框才是稳的。
 * 空名字=恢复默认「NAS 影迷」—— 给一个不用记的回退。
 */
$('meName').addEventListener('click', () => {
  const inp = $('nameEdit');
  inp.value = S.config.nickname || '';
  inp.hidden = false;
  $('meName').hidden = true;
  try { inp.focus(); inp.select(); } catch (_) {}
});
function commitName() {
  const inp = $('nameEdit');
  if (inp.hidden) return;                           // 已经收起了，别重复提交
  const v = (inp.value || '').trim().slice(0, 20);
  inp.hidden = true;
  $('meName').hidden = false;
  if (v === (S.config.nickname || '')) return;      // 没改，不动后端
  api.saveConfig({ nickname: v }).then((r) => {
    if (r && r.config) S.config = r.config;
    renderMePage();
    toast('名字已更新', 1800);
    /* 和点赞/收藏同一条路：改完打一个防抖，几秒后自动推给账号（2026-09-22 用户要求）。
       ⚠️ 必须放在 saveConfig **成功之后** —— 没存上就同步，推上去的是还没落盘的值，
       重启后本机读回旧名字，反而看起来像「同步把名字改回去了」。 */
    syncTouch();
  }).catch((e) => toast('没存上：' + e.message, 2600));
}
$('nameEdit').addEventListener('blur', commitName);
$('nameEdit').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
  if (e.key === 'Escape') { e.target.hidden = true; $('meName').hidden = false; }
});

document.addEventListener('click', (e) => {
  const cell = e.target.closest('.cell');
  if (!cell) return;
  const box = cell.closest('.grid');
  if (!box || !box._list || !box._list.length) return;
  // 「我的」页的点赞/收藏：竖屏内联播放，和首页刷视频一样，不跳横屏全屏
  openPlayer(box._list, Number(cell.dataset.i), { inline: box.id === 'meGrid' });
});

/* ============================================================
   NAS 目录浏览
   ------------------------------------------------------------
   WebDAV 里一层层点进去，看到哪层有片子，点「刷」就把那层当片库。
   和文件管理器一样：面包屑跳级、上一级、刷新。
   ============================================================ */
const B = { path: '', info: null, counts: {} };

function brState(html) { $('brBody').innerHTML = `<div class="br-state">${html}</div>`; }
function brLoading(text) { $('brBody').innerHTML = `<div class="br-loading"><div class="spinner"></div>${escapeHtml(text)}</div>`; }

function renderCrumb(crumbs) {
  const el = $('brCrumb');
  const n = (crumbs || []).length;
  const h = [`<button data-crumb="" class="${n ? '' : 'cur'}">根目录</button>`];
  (crumbs || []).forEach((c, i) => {
    h.push('<i>/</i>');
    h.push(`<button data-crumb="${escapeHtml(c.path)}" class="${i === n - 1 ? 'cur' : ''}">${escapeHtml(c.name)}</button>`);
  });
  el.innerHTML = h.join('');
  requestAnimationFrame(() => { el.scrollLeft = el.scrollWidth; });
}

/** 打开 NAS 上的一个目录（path 为空 = 从根/地址里带的路径开始） */
async function loadDir(path) {
  renderSrcList();                      // 片源区在目录树之外，独立渲染
  if (!S.config.url && !S.hasPass) {
    B.path = ''; B.info = null;
    renderCrumb(null);
    $('brUp').disabled = true;
    // 两步流程：先让人回设置页「登录」，别在这里暗示可以直接挑目录
    return brState(`<span class="big">🔌</span>还没连上 NAS<br>
      <b>先去设置里点「登录」，连上之后再来挑文件夹</b>
      <div><button class="btn primary" data-open-cfg>去设置登录</button></div>`);
  }

  B.path = path || '';
  brLoading('正在读取 NAS 目录…');
  let info;
  try {
    info = await api.browse(B.path);
  } catch (e) {
    renderCrumb(null);
    return brState(`读取失败：${escapeHtml(friendlyNetErr(e.message))}
      <div><button class="btn ghost" data-crumb="">回到根目录</button></div>`);
  }

  if (!info.ok) {
    B.info = null;
    renderCrumb(info.crumbs);
    $('brUp').disabled = !info.parent;
    return brState(`<span class="big">🚫</span>${escapeHtml(friendlyNetErr(info.error) || '打不开这个目录')}<br>
      <b>${escapeHtml(info.path || '')}</b>
      <div><button class="btn ghost" data-crumb="">回到根目录</button><button class="btn ghost" data-open-cfg>改设置</button></div>`);
  }

  B.info = info;
  B.path = info.path;
  B.counts = {};
  /* ⚠️ 面包屑必须在这里也画一次 —— 以前只在**失败**分支画（catch / !info.ok），
   *    成功进来时 #brCrumb 一直是空的：用户看不到自己在哪一层，也没法点着跳级，
   *    只能用「上一级」一层层退。样式和元素一直都在，纯粹是漏了这一次调用。
   *    （2026-09-18 顺手发现并修掉。） */
  renderCrumb(info.crumbs);
  /* 后端发现「配置里那个目录在 NAS 上没了」，已经自己退到挂载根目录兜底。
   * 必须告诉人，否则他会以为自己的文件夹莫名其妙变成了根目录。
   * 用 toast 而不是错误页：这时是**有内容**的（根目录的列表），别把画面盖掉。 */
  if (info.healed && info.staleMsg) toast(info.staleMsg, 4600);
  $('brUp').disabled = !info.parent;
  renderDir(info);
  fillCounts(info);
}

/** 目录先渲染出来，数量随后异步补 —— NAS 慢的时候也不至于干等 */
async function fillCounts(info) {
  const paths = info.dirs.map((d) => d.path);
  if (!paths.length) return;
  let counts = {};
  try {
    const r = await api.counts(paths);
    counts = r.counts || {};
  } catch (_) {
    for (const p of paths) counts[p] = null;
  }
  if (B.info !== info) return;      // 用户已经翻到别处了，别乱改
  B.counts = counts;
  renderDir(info, true);
}

/* ---------- 片源文件夹：首页刷的就是这几个目录的合集 ---------- */

function renderSrcList() {
  const box = $('brSrc');
  if (!box) return;
  const list = srcList();
  const H = [];
  H.push(`<div class="sec"><b>片源文件夹</b><span>${list.length ? list.length + ' 个' : '还没添加'}</span><span class="line"></span></div>`);

  if (!list.length) {
    /* ⚠️ 「片源为空」时服务端会**兜底扫点什么**（见 NasServer.defaultRoots：优先本机
     *    strm 库，没有才退到 WebDAV 根）—— 于是首页有视频、片源栏却写「还没添加」，
     *    两句看着自相矛盾，用户很容易误会成「片源被谁偷偷改了」。
     *    所以有视频时补一句，把「这批片子是哪来的」说清楚。
     *    ⚠️ 文案只说「自动找到」：兜底目标**可能是本机 strm 库、也可能是服务器根目录**，
     *       写死哪一个都会在另一种情况下变成假话；更不许出现 `/dav` 这种实现细节。 */
    H.push(S.videos.length
      ? `<div class="src-empty">还没有添加片源 —— 首页先显示<b>自动找到的 ${S.videos.length} 个视频</b>。<br>进下面的目录，用 <b>＋ 加入</b> 挑一个文件夹当片源，这里就正常了。</div>`
      : '<div class="src-empty">首页刷的是这里几个文件夹的合集。<br>进下面的目录，用 <b>＋ 加入</b> 把要刷的文件夹加进来，想加几个加几个。</div>');
  } else {
    if (list.length) {
      H.push('<div class="fl">');
      const skips = skipList();
      for (const d of list) {
        const isLocal = isLocalSrc(d);
        const n = S.videos.filter((v) => underDir(v.p, d)).length;
        const on = skips.includes(d);
        /* 「本机」片源（strm 自动生成的那个目录）与 WebDAV 片源长得不一样：
           · 名字显示成「本机 strm 库」而不是路径尾巴（它的路径对用户没意义）；
           · **不给 ✕ 移出** —— 它是 strm 生成时自动加的，删了下次生成又会回来，
             只会让人困惑「为什么删不掉」（用户拍板的就是「自动加、不给删」）；
           · 也不给「不重扫」：那目录是本 App 自己写的，内容变化完全可控，
             锁不锁没有意义，多两个按钮反而让人以为是普通片源。 */
        if (isLocal) {
          H.push(`<div class="srow local">
          <span class="fic">${IC.folder}</span>
          <div class="ftxt">
            <div class="fname">本机 strm 库</div>
            <div class="fmeta">自动生成 · ${n} 个视频</div>
          </div>
        </div>`);
          continue;
        }
        H.push(`<div class="srow">
          <span class="fic">${IC.folder}</span>
          <div class="ftxt">
            <div class="fname">${escapeHtml(pathName(d))}</div>
            <div class="fmeta">${escapeHtml(d)}${n ? ` · ${n} 个视频` : ''}</div>
          </div>
          <button class="fskip ${on ? 'on' : ''}" data-skip="${escapeHtml(d)}"
            title="${on ? '已锁定：常规扫描会跳过它，直接用上次扫到的结果' : '锁定后，常规扫描会跳过这个文件夹（不再新增文件的可以锁上）'}"
          >${on ? '不重扫' : '每次都扫'}</button>
          <button class="fplay ghost" data-play="${escapeHtml(d)}">只刷它</button>
          <button class="sdel" data-del="${escapeHtml(d)}" title="移出片源">✕</button>
        </div>`);
      }
      H.push('</div>');
    }
    /* 这里原来还有一个「▶ 开刷这 N 个文件夹（M 个视频）」的大按钮，
     * 2026-09-18 按用户要求**去掉了** —— 它的作用（切回首页看片）和底部「首页」标签
     * 完全重复，而且片源一多它还会把片源列表挤下去。
     * ⚠️ 别顺手把它加回来：data-br-home 的点击分支也一并删了（见下面 brSrc 的委托）。 */
  }
  box.innerHTML = H.join('');
}

function renderDir(info, keepScroll) {
  const box = $('brBody');
  const top = keepScroll ? box.scrollTop : 0;
  const rec = $('brRecursive').checked;
  const n = info.videoCount || 0;
  const sub = rec
    ? info.dirs.reduce((s, d) => s + (Number(B.counts[d.path]) || 0), 0)
    : 0;
  const total = n + sub;
  const H = [];
  const inSrc = hasSrc(info.path);

  H.push(`<div class="row2">
    <button class="btn ${inSrc ? 'ghost' : 'primary'}" data-br-add ${inSrc ? 'disabled' : ''}>${
      inSrc ? '✓ 已在片源里' : '＋ 加入片源'}${total ? `（${total} 个）` : ''}</button>
    <button class="btn ghost" data-play="${escapeHtml(info.path)}" ${total ? '' : 'disabled'}>▶ 只刷它</button>
  </div>`);

  if (info.dirs.length) {
    H.push(`<div class="sec"><b>子文件夹</b><span>${info.dirs.length} 个</span><span class="line"></span></div><div class="fl">`);
    for (const d of info.dirs) {
      const c = B.counts[d.path];
      const added = hasSrc(d.path);
      /* 🔴 这个数是**本层直接包含**的可播放文件数（后端 `/api/counts` 走
         `propfind(path,"1")`，depth-1），**不递归**。
         所以开着「含子文件夹」时不能写「里面没有视频」——115open 下面整整齐齐
         只有子目录、视频在更深一层，用户看到的就是「那怎么一个视频都没有」。
         递归数是不能做的：boki 那棵树走一遍要 9.5 分钟（见 §60 性能实测），
         每个子文件夹都递归数一遍 = 页面卡死。→ 那就**照实说「本层」**。 */
      const meta = c === undefined ? '正在数…'
        : c === null ? '子文件夹'
        : (c ? `里面 ${c} 个视频`
          : (rec ? '本层没有视频' : '里面没有视频'));
      H.push(`<div class="frow" data-dir="${escapeHtml(d.path)}">
        <span class="fic">${IC.folder}</span>
        <div class="ftxt">
          <div class="fname">${escapeHtml(d.name)}</div>
          <div class="fmeta">${meta}</div>
        </div>
        <button class="fadd ${added ? 'in' : ''}" data-add="${escapeHtml(d.path)}" title="${added ? '已在片源里' : '把这个文件夹加进片源'}">${added ? '✓ 已加' : '＋ 加入'}</button>
        <span class="chev">${IC.chev}</span>
      </div>`);
    }
    H.push('</div>');
  }

  if (n) {
    H.push(`<div class="sec"><b>本层视频</b><span>${n} 个</span><span class="line"></span></div><div class="grid" id="brGrid"></div>`);
  }

  if (!info.dirs.length && !n) {
    H.push(`<div class="br-state"><span class="big">📂</span>这个文件夹是空的<br><b>换个文件夹看看</b></div>`);
  }

  box.innerHTML = H.join('');
  if (keepScroll) box.scrollTop = top;
  if (n) renderGrid($('brGrid'), info.videos, null);
}

/** 进入目录页：落在上次待的位置，没记过就用第一个片源 */
/**
 * 「文件夹」页该从哪一层起步 —— **这是唯一一处定义，别再就地写第四份**。
 *
 * ⚠️ 绝对不要回落磁盘上的 `S.config.dir`。它可能早就失效了（文件夹被删 / 改名 /
 *    换了服务器，2026-09-18 用户实测就是这种），而拿它当路径等于**显式**请求一个
 *    不存在的目录 —— 后端的自愈兜底只认「空路径」，不会触发，人会卡在 404 页面
 *    里出不来（那个页面的「回到根目录」走的也是空路径，点一下又回到同一个 404）。
 *
 * 优先级：本次会话真连上过 → 已验证的那个根；否则已经加进来的片源；
 *        都没有就给**空串**，让后端自己算（配置有效就是配置目录，失效它会自愈到挂载根）。
 */
function freshStartPath() {
  /* 🔴 起点**只认 WebDAV 片源**（2026-09-20）：「文件夹」页的目录选择器走的是
     /api/browse（PROPFIND），本机片源（local:）压根不在 CD2 上 ——
     拿它当起点等于让「文件夹」页一进去就报错。
     用户加片源通常会把 WebDAV 的排在前面，但 strm 自动加进来那条可能落在
     第一位（比如他先把片源清空了、之后 strm 生成时补进来的），所以必须显式过滤。
     ⚠️ 全都过滤没了（用户只有本机片源、没配 WebDAV）就回落到空串 ——
     空串的语义是「自愈到挂载根」，那时没挂载根，后端会给出可操作的报错。 */
  const webdav = srcList().filter((d) => !isLocalSrc(d));
  return webdav[0] || S.verifiedDir || '';
}
function browseStartPath() {
  return B.path || freshStartPath();
}

function enterBrowse() {
  loadDir(browseStartPath());
}

/**
 * 整组替换片源。加文件夹 / 移出 / 只刷它 都走这一条路。
 *
 * 🔴 服务端现在**立刻回话**、把扫描丢到后台（2026-09-18「添加/移除文件夹反应太慢」的修复：
 *    以前这里是同步扫完才回，加一个 498 个视频的文件夹要等 12~40 秒，界面全程转圈）。
 *    所以响应有两种：
 *      · pendingScan:true —— 配置已生效，片库还在后台扫。**不能**拿它去 applyLibrary：
 *        它带的是旧片库，灌进去要么把首页闪成「一条都没有」，要么把正在看的内容切走。
 *        只更新片源栏，片库等 peek 轮询通知（watchLibraryRefresh）再整套换上。
 *      · 正常片库 —— 照旧 applyLibrary（比如把片源清空那条路，服务端同步给结果）。
 *
 * 返回 true 表示「服务端收下了」；S.pendingScan 告诉调用方片库是不是还在路上。
 */
async function applySources(dirs, tip) {
  showLoading(true, '正在更新片源…');
  try {
    /* ⚠️ skipDirs 必须一起发：后端规则是「只保留仍在 dirs 里的项」，
       不传就会按新 dirs 收敛成「只剩新 dirs 里恰好也标过的」——
       实际效果是**改一次片源，锁定标记全丢**。 */
    const sentSkip = skipList().filter((d) => dirs.includes(d));
    const lib = await api.sources(dirs, $('brRecursive').checked, sentSkip);
    /* 配置以**我们刚发出去的那份**为底，再用服务端回传的 config 覆盖
     * （服务端更权威，比如它会做 normAbs 归一；覆盖顺序不能反）。
     *
     * ⚠️ 不能只信 `lib.config`：Java 版的 /api/sources 曾经没回这个字段，
     *    于是配置在服务端已经改了、界面却一动不动 —— 用户看到的就是
     *    「点加入没反应 / 添加了也不显示」。前端自己知道刚发的是什么，
     *    没必要把这件事完全外包给服务端。
     *    `dir` 只在 dirs 非空时才动，与服务端的
     *    `if (config.dirs.length) config.dir = config.dirs[0]` 保持一致。 */
    S.config = {
      ...S.config,
      dirs: dirs.slice(),
      skipDirs: sentSkip,
      ...(dirs.length ? { dir: dirs[0] } : {}),
      ...(lib.config || {}),
      pass: '',
      skipDirs: Array.isArray(lib.config && lib.config.skipDirs) ? lib.config.skipDirs : sentSkip,
    };
    S.demoMode = false;
    S.mode = 'webdav';
    S.pendingScan = !!lib.pendingScan;

    /* 🔴 这里**故意不再调 `renderStrmJobs()`**（2026-09-20 晚二次改版删掉的）。
     *
     * 上午刚为它打过补丁：那时 `renderStrmJobs()` 从 `srcList()` 渲染，片源一变清单
     * 就得重画，漏了 applySources 这条路径 → 用户报「片源文件夹无法显示这个目录」。
     *
     * 但晚上用户拍板「监控清单与片源**完全解耦**」—— 第 4 步的清单现在读的是
     * `S.config.strmJobs` 这份**独立清单**，跟 dirs 再无关系。
     * 于是那两处补丁**自动作废了**：片源改了，监控清单本来就**不该**变。
     *
     * ⚠️ 别把它们加回来（那是「为 A 打的补丁，A 被砍了要一起回收」那类）。
     *    真要动监控清单，只有第 4 步自己的 addStrmJob / removeStrmJob 两处入口。
     * ⚠️ 但 `renderCfDirs()` 仍然要留着 —— 那是第 3 步「当前片源」的只读清单，
     *    它**确实**跟 dirs 绑死。 */
    if (S.pendingScan) {
      /* 片库还在后台扫。只把「片源栏 + 面包屑上的按钮态」按新配置刷一遍，
       * 片库（S.videos / S.dirs）一个字都不动 —— 它还是旧的那份，正好撑着界面。 */
      S.libVersion = Number(lib.version || 0);
      renderSrcList();
      if (B.info) renderDir(B.info, true);
      updateDirText();
      showLoading(false);                 // 转圈只在「提交配置」这一下，别一直挂着
      if (lib.error) { toast('扫描失败：' + friendlyNetErr(lib.error), 3200); return false; }
      if (tip) toast(tip + '，正在后台扫描…', 2600);
      watchLibraryRefresh(lib);
      return true;
    }

    applyLibrary(lib);
    renderSrcList();
    if (B.info) renderDir(B.info, true);
    updateDirText();
    if (lib.error) { toast('扫描失败：' + friendlyNetErr(lib.error), 3200); return false; }
    if (tip) toast(tip, 2200);
    return true;
  } catch (e) {
    showLoading(false);
    toast('更新片源失败：' + friendlyNetErr(e.message), 3200);
    return false;
  }
}

async function addSource(dir) {
  if (!dir) return;
  const list = srcList();
  if (list.includes(dir)) return toast('这个文件夹已经在片源里了');
  const next = [...list, dir];
  await applySources(next, `已加进片源：${pathName(dir)}（共 ${next.length} 个）`);
}

async function removeSource(dir) {
  const list = srcList();
  if (!list.includes(dir)) return;
  const next = list.filter((d) => d !== dir);
  await applySources(next, next.length
    ? `已移出：${pathName(dir)}（还剩 ${next.length} 个）`
    : '片源已清空，去目录里加一个吧');
}

/**
 * 切换某个片源的「不重扫」标记。
 *
 * ⚠️ 走 `POST /api/config`，**绝不能走 /api/sources**（2026-09-18 的关键决定）：
 *    /api/sources 保存完会立刻起一次**后台全量扫描** —— 点一下「锁定」却要等
 *    十几分钟，正好是这个功能想避免的事。/api/config 只落盘、不扫描。
 *    （而且两边都不会因为改这个值而作废片库缓存：libSig 刻意不含 skipDirs。）
 *
 * ⚠️ 响应里的 config 可能不带 skipDirs（老后端），所以最后要用自己发出去的
 *    `next` 覆盖 —— 和服务端「以我发的为准 + 后端归一覆盖」的规矩一致（见 applySources）。
 */
async function toggleSkip(dir) {
  const cur = skipList();
  const on = cur.includes(dir);
  const next = on ? cur.filter((d) => d !== dir) : [...cur, dir];
  try {
    const r = await api.saveConfig({ skipDirs: next });
    S.config = { ...S.config, ...(r.config || {}), skipDirs: next };
    renderSrcList();
    toast(on
      ? `「${pathName(dir)}」恢复每次都扫`
      : `「${pathName(dir)}」已锁定 · 下次扫描会跳过它`, 2600);
  } catch (e) {
    toast('设置失败：' + friendlyNetErr(e.message), 3200);
  }
}

/**
 * 只刷这一个：把片源换成它并回首页开刷。
 *
 * ⚠️ 如果它被标了「不重扫」，这里要**先解锁**：点「只刷它」的意思就是
 *    「现在给我扫它」，锁定的语义（跳过）和它直接冲突。不解锁的话，
 *    后端的 doScan 会照旧跳过它、把上次的缓存原样还回来 ——
 *    用户以为重扫了，其实一条都没更新。这是个**静默**错误，很难发现。
 */
async function onlySource(dir) {  if (!dir) return;
  if (skipList().includes(dir)) {
    try {
      await api.saveConfig({ skipDirs: skipList().filter((d) => d !== dir) });
      S.config = { ...S.config, skipDirs: S.config.skipDirs.filter((d) => d !== dir) };
    } catch (_) { /* 解锁失败也继续：下面这轮扫描本来就会重扫它 */ }
  }
  if (!(await applySources([dir], null))) return;
  setNav('home');
  /* 片库还在后台扫（见 applySources）：这时 S.videos 还是**上一个片源**的内容，
   * 既不能拿它报「有 N 个视频」，更不能因为它是空的就说「这个文件夹里没有视频」。
   * 挂个「正在扫描」的转圈，扫完 applyLibrary 会自己把它收掉。 */
  if (S.pendingScan) {
    showLoading(true, `正在扫描「${pathName(dir)}」…`);
    return;
  }
  if (!S.videos.length) {
    showLoading(false);
    main.clear();
    $('emptyView').hidden = false;
    $('emptyTitle').textContent = '这个文件夹里没有能播的视频';
    $('emptyDesc').innerHTML = '换一个文件夹，或者打开上方的<b>含子文件夹</b>再试。';
    return;
  }
  toast(`开刷「${pathName(dir)}」· ${S.videos.length} 个视频`, 2400);
}

/* 片源区：移出 / 只刷它
 * ⚠️ 原来这里还有 `[data-br-home]`（「▶ 开刷这 N 个文件夹」那个大按钮）的分支，
 *    2026-09-18 按用户要求把按钮删了，分支也一并删掉 —— 别只删 HTML 留个死分支。 */
$('brSrc').addEventListener('click', (e) => {
  const skip = e.target.closest('[data-skip]');
  if (skip) { e.stopPropagation(); return toggleSkip(skip.dataset.skip); }
  const del = e.target.closest('[data-del]');
  if (del) { e.stopPropagation(); return removeSource(del.dataset.del); }
  const play = e.target.closest('[data-play]');
  if (play) { e.stopPropagation(); return onlySource(play.dataset.play); }
});

$('brBody').addEventListener('click', (e) => {
  if (e.target.closest('[data-open-cfg]')) return openSheet('configSheet');
  const add = e.target.closest('[data-add]');
  if (add) { e.stopPropagation(); return addSource(add.dataset.add); }
  const play = e.target.closest('[data-play]');
  if (play) { e.stopPropagation(); return onlySource(play.dataset.play); }
  if (e.target.closest('[data-br-add]')) return addSource(B.info && B.info.path);
  const dir = e.target.closest('[data-dir]');
  if (dir) return loadDir(dir.dataset.dir);
});
$('brCrumb').addEventListener('click', (e) => {
  const b = e.target.closest('[data-crumb]');
  if (b) loadDir(b.dataset.crumb);
});
$('brUp').addEventListener('click', () => {
  const p = B.info && B.info.parent;
  loadDir(p === undefined || p === null ? '' : p);
});
$('brReload').addEventListener('click', () => loadDir(B.path));
$('brRecursive').addEventListener('change', () => {
  if (B.info) renderDir(B.info, true);
});

/* ------------------------------ 搜索 ------------------------------ */
function runSearch(kw) {
  const q = String(kw || '').trim().toLowerCase();
  const empty = $('searchEmpty');
  if (!q) {
    $('searchGrid').innerHTML = '';
    $('searchGrid')._list = [];
    empty.hidden = false;
    empty.textContent = '输入关键词开始搜索';
    return;
  }
  const list = S.videos.filter((v) =>
    (v.title || '').toLowerCase().includes(q) ||
    (v.name || '').toLowerCase().includes(q) ||
    (v.folder || '').toLowerCase().includes(q) ||
    (v.p || '').toLowerCase().includes(q)
  );
  empty.textContent = `没找到「${kw}」相关的视频`;
  renderGrid($('searchGrid'), list, empty);
}
$('btnSearch').addEventListener('click', () => {
  openSheet('searchSheet');
  setTimeout(() => $('searchInput').focus(), 120);
});
$('searchInput').addEventListener('input', (e) => runSearch(e.target.value));
$('searchClear').addEventListener('click', () => {
  $('searchInput').value = '';
  runSearch('');
  $('searchInput').focus();
});

/* ------------------------------ 全屏播放器 ------------------------------ */
// 全屏播放器内部不再显示「全屏」按钮（本身已经是全屏了）
// 全屏按钮照常渲染，但只在内联竖屏模式下显示（见 CSS .player:not(.inline) [data-act="full"]）——
// 本身就是全屏时再给个「全屏」按钮没意义
const player = createFeed(playerFeedEl, { isPlayer: true });
feeds.push(player);

function isNativeFull() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function exitNativeFull() {
  try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (_) {}
}

/* 手机端全屏播放时，把屏幕转成**和画面一致**的方向（2026-09-19 改）。
 *
 * 原来这里是一律锁横屏（所以函数还叫 enterLandscape）—— 用户反馈
 * 「加载视频为什么老是横屏」：这 App 刷的是竖屏短视频，竖屏片被塞进横屏里，
 * 画面缩成中间一条，等于把片子看废了。现在按画面比例来：
 * **竖屏片竖着全屏、横屏片才横屏**，不用手动转手机。
 *
 * 三级降级保留（顺序不变，只是传的目标方向变了）：
 * 1) 原生桥直接锁（APK 内 100% 有效，不受 WebView 限制）；
 * 2) 系统方向锁（桌面 Chrome 可以，安卓 WebView 通常不行）；
 * 3) 系统全屏后再锁；
 * 4) CSS 旋转 90° 兜底 —— ⚠️ **只有要横屏时才做**，要竖屏时本来就不该转。
 * 桌面端（鼠标设备）什么都不做，保持窗口内铺满。 */
const IS_TOUCH = window.matchMedia && matchMedia('(pointer: coarse)').matches;

/** 播放器里那个 <video> 的画面方向；尺寸还没到（未 loadedmetadata）时返回 null */
function playerVideoOrientation() {
  const el = $('playerModal');
  const v = el && el.querySelector('video');
  if (!v || !v.videoWidth || !v.videoHeight) return null;
  return v.videoHeight > v.videoWidth ? 'portrait' : 'landscape';
}

async function applyPlayerOrientation() {
  if (!IS_TOUCH) return;
  const el = $('playerModal');

  /* 尺寸还没到 → 挂一次 loadedmetadata 再定方向。
     不加这一步的话，openPlayer 那一刻必然量不到尺寸（视频刚 set src），
     只能走兜底去锁横屏，而**之后再也没人纠正它** —— 竖屏片就永远横着了。 */
  if (playerVideoOrientation() === null) {
    const v = el.querySelector('video');
    if (v && !v._oListen) {
      v._oListen = true;
      v.addEventListener('loadedmetadata', () => {
        /* ⚠️ 只在**还停在独立全屏播放器**里时才纠正 —— 人已经退出去了
           （或切成了内联竖屏）再转一下屏幕，就是纯打扰。 */
        if (!el.hidden && !el.classList.contains('inline')) applyPlayerOrientation();
      }, { once: true });
    }
  }
  const want = playerVideoOrientation() || 'landscape';

  // 1) 优先：原生桥直接把 Activity 锁到目标方向
  try { if (window.NasBridge) { window.NasBridge.setOrientation(want); return; } } catch (_) {}
  // 2) 降级：系统方向锁
  try { await screen.orientation.lock(want); return; } catch (_) {}
  // 3) 再降级：系统全屏后再锁
  try {
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) {
      await req.call(el, { navigationUI: 'hide' });
      await screen.orientation.lock(want);
      return;
    }
  } catch (_) {}
  // 4) 兜底：只有「要横屏」才值得 CSS 转 90° 假装横屏
  if (want === 'landscape') el.classList.add('land-rotate');
}
function resetPlayerOrientation() {
  const el = $('playerModal');
  el.classList.remove('land-rotate');
  try { if (window.NasBridge) window.NasBridge.setOrientation('portrait'); } catch (_) {}
  try { screen.orientation.unlock(); } catch (_) {}
  if (isNativeFull()) exitNativeFull();
}

/* ============ 原生播放器（只有安卓 APK 有）：点全屏时交给系统硬解 ============
 * WebView 里的 <video> 走 Chromium 自己的解码管线，个别片源会持续丢帧；
 * APK 里点「全屏」直接拉起原生 PlayerActivity（系统 MediaCodec），画面不经过 WebView。
 * PC / 手机浏览器没有 NasBridge.openPlayer，会自动沿用原来的网页全屏。
 */
const NATIVE_POS = {};    // 原生播放器退回来时带的位置（秒），下次挂这条视频接着播
const NATIVE_SKIP = {};   // 原生也播不动的片，以后直接走网页，别反复试
const absUrl = (u) => { try { return new URL(u, location.href).href; } catch (_) { return u; } };

/* 📌 这里原本有个「这部片原生播得动」的白名单（localStorage: nasNativeOk）。
 * 它的唯一用途是给「丢帧自动跳原生」加速 —— 那条路已按要求删除（见 watchDrops），
 * 名单也就没人读了，所以一并清掉。
 * 老设备上那份 localStorage 键会留着，不影响运行（没有代码再读它）。 */

function nativePlay(v, posSec) {
  const B = window.NasBridge;
  if (!B || typeof B.openPlayer !== 'function') return false;   // 不是 APK，或装的是老版本
  if (!v || NATIVE_SKIP[v.p]) return false;
  try {
    // 第一个是直连流；原生那边播不动会自动换第二个（服务端重编码流）
    B.openPlayer(absUrl(streamUrl(v)), absUrl(transUrl(v, 0, 'encode')),
      v.name || v.title || '', Math.max(0, Math.round(posSec || 0)), v.p);
    return true;
  } catch (_) { return false; }
}

// 原生播放器退出时把播放位置带回来
window.__nasPos = (p, pos) => {
  if (!p) return;
  if (pos > 0) NATIVE_POS[p] = pos;
};
// 原生也播不动 → 记下来，下次直接开网页播放器
window.__nasFallback = (p) => {
  if (!p) return;
  NATIVE_SKIP[p] = 1;
  /* 🔴 原生解不了 → **自动跳过**，不停在报错界面（2026-09-20 用户要求）。
   * 抖音式刷片，一条播不了就该滑到下一条，而不是让用户读错误说明再手动点。
   * 跳哪由「此刻谁在前台」决定：
   *   · 网页全屏播放器开着（全屏按钮拉起原生那种）→ 播放器信息流滑到下一条；
   *   · 首页信息流（丢帧升级到原生的那种）→ 信息流滑到下一条；
   *   · 其它入口（不该发生，兜底）→ 沿用旧文案，不动用户的列表。
   * NATIVE_SKIP 已记黑名单：这条之后无论网页还是原生都不会再选它。 */
  const skipMsg = '这部片解码不了，已自动跳过';
  if (!$('playerModal').hidden && typeof player.scrollBy === 'function') {
    player.scrollBy(1);
    toast(skipMsg);
  } else if (NAV === 'home' && typeof main.scrollBy === 'function') {
    main.scrollBy(1);
    toast(skipMsg);
  } else {
    toast('原生播放器放不了这个，已切回网页播放');
  }
};

/* 转屏 / 进出全屏后视口尺寸变了：把当前视频重新对齐，避免错位 */
function realignPlayer() {
  setTimeout(() => {
    const i = player.index;
    if (i >= 0 && !$('playerModal').hidden) {
      /* ⚠️ 同样要先铺窗口再滚（见 goVid 那条注释） */
      player.scrollToIndex(i, false);
      player.activate(i, true);
    }
  }, 200);
}
['fullscreenchange', 'webkitfullscreenchange', 'orientationchange'].forEach((ev) => {
  document.addEventListener(ev, realignPlayer);
});

/**
 * 打开播放器。
 * opt.inline = true → 内联竖屏模式：留在手机外框内、控件常显、不锁横屏，
 *   跟在首页刷视频一模一样（「我的」页点赞/收藏点开走这条）。
 * 否则是原来的独立全屏播放器：铺满浏览器窗口、手机端转横屏沉浸。
 */
function openPlayer(list, i, opt = {}) {
  if (!list.length) return;
  const inline = !!opt.inline;
  const el = $('playerModal');
  el.hidden = false;
  el.classList.toggle('inline', inline);
  phone.classList.toggle('fs-open', !inline);   // 内联时让手机外框继续裁剪，不铺满窗口
  player.load(list);
  main.pauseAll();                       // 避免和首页视频同时出声
  PLAYER_OPEN = true;
  el.classList.remove('immersive');
  clearTimeout(immersiveTimer);
  // 只有独立全屏播放器才沉浸：手机端控件先藏起来（点画面唤出）；
  // PC 端鼠标没有稳定的「唤出」手段，进度条 / 文案 / 返回键要常显
  if (!inline && IS_TOUCH) enterImmersive();
  if (!inline) applyPlayerOrientation();   // 按画面比例定方向（竖屏片竖着放）

  /* 对齐当前这条。
   *
   * ⚠️ 两个坑，都在这里踩过，别改回去：
   *
   * 1) **不能只靠 requestAnimationFrame**（这是「刷点赞过的视频要缓冲好久」的另一个真凶）。
   *    `MainActivity.onPause()` 里调了 `web.onPause()`，页面一旦切到后台，
   *    `document.visibilityState` 就是 'hidden'，此时 **rAF 回调一次都不会执行**
   *    （实测：rAF 和一个 50ms 的 setTimeout 都不触发）。
   *    原来的写法把「滚动定位 + activate(i, true)」整个塞进 rAF，
   *    于是页面在后台时打开播放器 → activate 永不执行 → player.index 停在 -1
   *     → 没有任何 <video> 被创建 → 用户回来只看到一个**静止的占位**，
   *    而 .stalling 的转圈动画还在转，看着就像「一直在缓冲」。
   *    修法：activate 必须**同步**调，rAF 只用来做尺寸校正这类「早一点晚一点都行」的事。
   *
   * 2) **同步调时 clientHeight 可能是 0**（刚 unhidden / 手机外框还没参与布局）。
   *    此时 scrollTop 会被钳成 0，所以还得补一次「尺寸可用后再对齐」的校正。
   *    rAF 正常时靠它兜底；rAF 不触发时，用 visibilitychange 兜底。
   */
  const alignTo = () => {
    const h = playerFeedEl.clientHeight;
    if (h > 0 && player.index >= 0) playerFeedEl.scrollTop = player.index * h;
  };
  /** 尺寸就绪后再校正一次；rAF 在后台不触发，所以再加一个 visibilitychange 兜底 */
  const alignLater = () => {
    alignTo();
    requestAnimationFrame(alignTo);
    if (document.hidden) document.addEventListener('visibilitychange', alignTo, { once: true });
  };

  player.scrollToIndex(i, false);
  player.activate(i, true);   // ← 同步执行：这条决定了 webview 里到底有没有 video 元素
  PLAYER_WANT = i;            // 记下「想播第几条」，供 visibilitychange 兜底时补偿
  alignLater();
}
/**
 * 内联竖屏 → 独立全屏：只换容器和屏幕方向，不重新 load 列表，
 * 所以当前这条视频和播放进度都不会丢。
 */
function expandPlayer() {
  const el = $('playerModal');
  if (el.hidden || !el.classList.contains('inline')) return;
  el.classList.remove('inline');
  phone.classList.add('fs-open');        // 手机外框不再裁剪，播放器铺满窗口
  if (IS_TOUCH) enterImmersive();        // 进了全屏就按全屏那套来：手机端先藏控件
  applyPlayerOrientation();
  realignPlayer();                       // 容器尺寸变了，重新对齐当前这条
}
function closePlayer() {
  $('playerModal').hidden = true;
  $('playerModal').classList.remove('inline');
  phone.classList.remove('fs-open');
  player.pauseAll();
  resetPlayerOrientation();              // 回竖屏 + 退系统全屏 + 撤销 CSS 兜底
  PLAYER_OPEN = false;
  PLAYER_WANT = -1;                      // 关掉了就别留着待补偿目标，免得下次一回来乱跳
  $('playerModal').classList.remove('immersive');
  clearTimeout(immersiveTimer);
  hideSeekInd();
  if (NAV === 'home') main.resume();
}
$('playerClose').addEventListener('click', closePlayer);

/* ============ 全屏播放器手势：横滑快进/快退 · 单击退出沉浸 · 双击暂停 ============ */
let PLAYER_OPEN = false;
/* 上次 openPlayer 想播第几条。-1 = 没有待补偿的目标。
   用途：页面在后台时 activate 可能被 requestAnimationFrame 坑掉（见 openPlayer 注释），
   等页面回到前台由 visibilitychange 拿它把「哪一条」补回来。 */
let PLAYER_WANT = -1;
let immersiveTimer = null;
const pg = { id: null, x0: 0, y0: 0, moved: false, swiping: false, dx: 0, preview: 0, lastTap: 0, tapTimer: null };
const SEEK_EPS = 14;        // 移动超过这个像素算手势而非点击
const SEEK_QW = 0.25;       // 拖过 1/4 屏宽 = 快进/退 15 秒
const SEEK_SEC = 15;

function pItem() {
  const i = player.index;
  if (i < 0) return null;
  const v = player.mounted.get(i);
  const item = player.itemHTMLAt(i);
  if (!v || !item) return null;
  return { i, v, item };
}
function pCur() {
  const x = pItem(); if (!x) return 0;
  return Number(x.item.dataset.t0 || 0) + (isFinite(x.v.currentTime) ? x.v.currentTime : 0);
}
function pTotal() {
  const x = pItem(); if (!x) return 0;
  return Number(x.item.dataset.dur || 0) || (x.v && isFinite(x.v.duration) ? x.v.duration : 0);
}
function fmtTime(s) {
  s = Math.max(0, Math.floor(s || 0));
  const m = Math.floor(s / 60), ss = s % 60;
  return String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
}

/* 沉浸式：藏起右侧栏 / 文案 / 进度条 / 渐变，只留视频和返回键。
 * 只在触摸设备启用 —— PC 端控件常显（有鼠标要能随时拖进度）。 */
function enterImmersive() {
  if (!IS_TOUCH) return;
  $('playerModal').classList.add('immersive');
  clearTimeout(immersiveTimer);
}
function exitImmersive() {
  if (!IS_TOUCH) return;                 // PC 端不做自动隐藏，避免想拖进度时条不见了
  $('playerModal').classList.remove('immersive');
  clearTimeout(immersiveTimer);
  immersiveTimer = setTimeout(enterImmersive, 3500);   // 几秒不动再藏回去
}
function toggleImmersive() {
  if ($('playerModal').classList.contains('immersive')) exitImmersive();
  else enterImmersive();
}
function playerTogglePause() {
  const x = pItem(); if (!x) return;
  if (x.v.paused) safePlay(x.v, x.item);
  else x.v.pause();                      // 同上：让 pause 事件去挂遮罩
}

/* 横滑过程中的快进提示 */
function showSeekInd(delta, target, total) {
  const el = $('seekInd');
  el.hidden = false;
  const fwd = delta >= 0;
  const ico = $('seekIco');
  ico.textContent = fwd ? '⟫' : '⟪';
  ico.style.transform = fwd ? 'none' : 'scaleX(-1)';
  $('seekDelta').textContent = (fwd ? '+' : '−') + fmtTime(Math.abs(delta));
  $('seekCur').textContent = fmtTime(target) + ' / ' + fmtTime(total);
}
function hideSeekInd() { $('seekInd').hidden = true; }
function computeSeek(dx) {
  const qw = Math.max(120, window.innerWidth * SEEK_QW);
  const delta = (dx / qw) * SEEK_SEC;
  const total = pTotal();
  let target = pCur() + delta;
  if (total) target = Math.min(total, Math.max(0, target));
  return { delta, target, total };
}

playerFeedEl.addEventListener('pointerdown', (e) => {
  if (!PLAYER_OPEN) return;
  clearTimeout(immersiveTimer);                     // 任何触摸都重置「几秒后自动藏控件」的计时
  if (e.pointerType === 'mouse') return;          // 桌面端用原有点击逻辑
  if (!e.target.closest('.vwrap')) return;         // 进度条 / 按钮交给各自处理
  if (!pItem()) return;
  pg.id = e.pointerId; pg.x0 = e.clientX; pg.y0 = e.clientY;
  pg.moved = false; pg.swiping = false; pg.dx = 0;
  try { playerFeedEl.setPointerCapture(e.pointerId); } catch (_) {}
});
playerFeedEl.addEventListener('pointermove', (e) => {
  if (!PLAYER_OPEN || e.pointerId !== pg.id) return;
  const dx = e.clientX - pg.x0, dy = e.clientY - pg.y0;
  if (!pg.moved && Math.hypot(dx, dy) < SEEK_EPS) return;
  pg.moved = true;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) >= SEEK_EPS) {
    pg.swiping = true; pg.dx = dx;
    const r = computeSeek(dx); pg.preview = r.target;
    showSeekInd(r.delta, r.target, r.total);
  }
});
playerFeedEl.addEventListener('pointerup', (e) => {
  if (!PLAYER_OPEN || e.pointerId !== pg.id) return;
  const wasSwipe = pg.swiping, moved = pg.moved;
  pg.id = null;
  if (wasSwipe) {                                   // 横滑 → 松手才真正跳
    hideSeekInd();
    const total = pTotal();
    player.seekRatio(total ? pg.preview / total : 0);
    return;
  }
  if (!moved) onPlayerTap();                         // 没挪动 = 点按
});
playerFeedEl.addEventListener('pointercancel', () => {
  if (pg.id != null) { pg.id = null; if (pg.swiping) hideSeekInd(); }
});

function onPlayerTap() {
  const now = Date.now();
  if (now - pg.lastTap < 300) {                      // 双击 → 暂停/播放
    clearTimeout(pg.tapTimer); pg.lastTap = 0;
    playerTogglePause();
    return;
  }
  pg.lastTap = now;
  clearTimeout(pg.tapTimer);
  pg.tapTimer = setTimeout(() => { pg.lastTap = 0; toggleImmersive(); }, 260);
}

/* ------------------------------ 导航 ------------------------------ */
let NAV = 'home';
function setNav(navName) {
  NAV = navName;
  $('pageMe').hidden = navName !== 'me';
  $('pageBrowse').hidden = navName !== 'browse';
  $('topbar').style.display = navName === 'home' ? '' : 'none';
  $('soundHint').style.display = navName === 'home' ? '' : 'none';
  if (navName !== 'home') $('soundHint').classList.add('hide');
  else if (!S.soundOn && !$('soundHint').hidden) $('soundHint').classList.remove('hide');
  feedEl.style.pointerEvents = navName === 'home' ? '' : 'none';
  feedEl.style.visibility = navName === 'home' ? '' : 'hidden';
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.nav === navName));
  if (navName === 'home') main.resume(); else main.pauseAll();
  if (navName === 'me') renderMePage();
  if (navName === 'browse') enterBrowse();
}
$('tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-nav]');
  if (b) setNav(b.dataset.nav);
});

// 「我的」页里切「收藏 / 点赞」两段
$('meSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b || b.dataset.tab === ME_TAB) return;
  ME_TAB = b.dataset.tab;
  renderMeList();
});

// 「我的」页三块统计都能点
$('goFav').addEventListener('click', () => openMeList('fav'));
$('goLike').addEventListener('click', () => openMeList('like'));
/* ⚠️ 必须走 scrollToIndex（它先 ensureWindow 再滚），**不能**直接写 feedEl.scrollTop：
   窗口化之后目标位置当时可能**没有吸附点**，浏览器会吸附到最近的已有 item 上 ——
   表现就是「点『视频数』跳回首页，结果停在一半或者一片空白」。
   实测：直接写 scrollTop 跳到第 20 条只到得了第 18 条（窗口边缘）。 */
$('goVid').addEventListener('click', () => { setNav('home'); main.scrollToIndex(0, false); main.activate(0, true); });

/* 「我的」页按钮：数据源设置、重新扫描，以及右上角账号/同步入口。
 * ⚠️ 前两个大按钮**以前完全没绑事件**（HTML 里画着、点了没反应），
 * 是历史遗留 —— 加绑定的时候顺手在这里留个说明，别再被删掉。 */
let meRescanBusy = false;
$('meConfig').addEventListener('click', () => openSheet('configSheet'));
$('meAccount').addEventListener('click', () => openSheet('syncSheet'));
$('meSettings').addEventListener('click', () => openSheet('settingsSheet'));

$('meRescan').addEventListener('click', () => {
  // 演示模式下没有 NAS 可扫，说清楚而不是默默失败
  if (S.demoMode) { toast('当前是演示模式，先连上 NAS 才能重扫', 2400); return; }
  if (meRescanBusy) return;                       // 连点只算一次
  meRescanBusy = true;
  const b = $('meRescan');
  const old = b.textContent;
  b.textContent = '正在重扫…';
  b.disabled = true;
  // 扫描要几秒（全树走一遍），先给个即时反馈，扫完再换回文案
  toast('正在让 NAS 重扫一遍目录…', 1600);
  Promise.resolve(main.rescan())
    .catch((e) => { console.warn('[rescan] 失败：', e && e.message); })
    .finally(() => {
      meRescanBusy = false;
      b.textContent = old;
      b.disabled = false;
      if (NAV === 'me') renderMePage();            // 扫完刷一遍页上的统计数字
    });
});

/**
 * 首页左上角「重启应用」按钮。
 *
 * 📌 它最早是「刷新片库」（用户原话：「在左上角加一个刷新按钮方便我刷新新扫描的视频」），
 *    2026-09-19 用户改要求：**这个按钮改成重启 app**。
 *
 * 重启分两条路：
 *   · APK：调原生 `NasBridge.restartApp()` → Activity `recreate()`。
 *     能安全重建的前提是 `onDestroy()` 里已有 `nas.stop()`（放开 8099 端口），
 *     `onCreate()` 再 `new NasServer` + `start` —— 否则新实例会绑不上端口。
 *   · 浏览器 / PC 版：没有原生桥，回退 `location.reload()`。
 *
 * ⚠️ 「重扫片库」这个**动作没删**，入口回到「我的」页的「重新扫描」（`runRefresh()`）。
 *    别看到这个按钮不再扫了，就把 `runRefresh` 一起删掉。
 */
$('btnRestart').addEventListener('click', () => {
  /* 即时反馈：点下去到页面真正重载之间有几百毫秒空档，不转圈用户会以为没点着。
     这里**不做连点防护** —— 重启是幂等的，多转一圈没有副作用。
     （原来是重扫才需要防连点：后端有单飞，狂点会表现成「点了没反应」。） */
  $('btnRestart').classList.add('spin');
  const B = window.NasBridge;
  try {
    if (B && typeof B.restartApp === 'function') { B.restartApp(); return; }
  } catch (e) {
    console.warn('[restart] 原生重启调用失败，回退为重载页面：', e && e.message);
  }
  location.reload();
});

/* ------------------------------ 载入列表 ------------------------------ */
/**
 * 首页刷的顺序 = 随机洗牌（像刷推荐流那样，每次打开都不一样）。
 * 但已经排好的那些保持原位 —— 后台补扫回来时不能把正在看的那条甩到别处去。
 * 新扫到的视频接在队尾（它们本来也是刚加进去的，下次打开就会洗进队伍里）。
 *
 * 返回的是「按 S.order 排好序的视频对象数组」。
 */
function orderVideos(videos) {
  const byId = new Map(videos.map((v) => [v.p, v]));
  const seen = new Set();
  const keep = [];
  for (const p of S.order) {                 // 1. 上一轮排过、这次还在的，原位保留
    if (byId.has(p) && !seen.has(p)) { seen.add(p); keep.push(p); }
  }
  const fresh = [];                          // 2. 这次新扫到的，洗牌后接在后面
  for (const v of videos) if (!seen.has(v.p)) { seen.add(v.p); fresh.push(v.p); }
  S.order = keep.concat(shuffle(fresh));
  return S.order.map((p) => byId.get(p));
}

function applyFilter() {
  /* 第一条片的预热在 DOM 构建前就发出去（2026-09-19 提速）：
     main.load() 要建几十个卡片的 DOM，video 元素还得再等等才发起真请求，
     让上游取流的初始化跟这段时间并行。boot() 里那次预热是「上一次会话」的路径，
     这次片库刚到手、顺序也定了，这条才是准的。 */
  const first = orderVideos(S.videos);
  if (first[0] && !first[0].demo) api.warm(first[0].p);
  main.load(first);
  feedEl.scrollTop = 0;
  main.activate(0, true);
}

/** 顶栏「换一批」：整条流重新洗牌，从头开始刷（跟下拉刷新是同一个动作） */
function reshuffle() {
  if (!S.videos.length) return;
  main.reshuffleNow();
  toast(`已换一批 · ${S.videos.length} 个视频随机排序`, 1800);
}
$('btnShuffle').addEventListener('click', reshuffle);

/* ------------------------------ 数据加载 ------------------------------ */
const main = createFeed(feedEl);
feeds.push(main);

function showLoading(on, text) {
  $('loadingView').hidden = !on;
  if (text) $('loadingText').textContent = text;
}

/* ---------------------------- 启动动画（冷启动首屏） ----------------------------
   为什么不用纯 CSS 自动消失：页面加载慢时用户会看到「动画放完了、内容还没来」
   的空窗。所以**由内容驱动** —— 首屏真的能显示东西了才摘掉它。

   三层保险（任一触发即收，取最先到的那个）：
     · 正常路径：`splashReady()` 在首屏有内容/空态可显示时调用
     · 兜底超时：SPLASH_MAX_MS 到点无条件收（后端卡住时不能拿启动动画当挡箭牌）
     · 最短停留：SPLASH_MIN_MS 之前不摘（加载极快时动画会被「闪掉」，
       反而显得劣质 —— 这是「高端感」最容易被忽略的一环）

   ⚠️ 只跑一次：模块级 `splashDone` 标记住。showLoading 会被很多操作反复调用
      （切目录、登录、清空…），别让它们把启动动画又放一遍。 */
const SPLASH_MIN_MS = 1500;   // 最短停留（约等于动画主体时长，2026-09-23 用户要求 0.9→1.5s）
const SPLASH_MAX_MS = 6000;   // 最长停留，到点无条件摘
let splashDone = false;
let splashAt = 0;

(function initSplash() {
  const el = document.getElementById('splash');
  if (!el) { splashDone = true; return; }   // 没有这个节点（老 HTML）就当它不存在
  splashAt = Date.now();

  /* 🔴 立刻通知原生「网页这层启动图已经画出来了」，让原生那张遮罩淡出。
     必须在**这一句之前**不要有 async —— 原生遮罩多盖一帧，用户就多看到一帧
     「图标没对齐」的画面。
     为什么要这么早：原生 `windowBackground` 只撑到 contentView 完成布局，
     之后到本文件执行之间有一段**纯黑**。原生遮罩就是用来填这段黑的
     （见 MainActivity.hideNativeSplash 的注释）。
     ⚠️ 只填黑、不抢戏：它和这里的 .splash 是同一张图，所以交接时看不出接缝。 */
  try {
    if (window.NasBridge && NasBridge.splashReady) NasBridge.splashReady();
  } catch (e) { /* 浏览器里没有这个桥，正常 */ }

  window.setTimeout(() => splashReady(), SPLASH_MAX_MS);
})();

/** 收掉启动动画。可重复调用，只有第一次生效。
 *  @param {boolean} [force] 跳过「最短停留」限制（用户主动跳过时用） */
function splashAway(force) {
  if (splashDone) return;
  const el = document.getElementById('splash');
  if (!el) { splashDone = true; return; }

  /* 最短停留没到就晚点再来。⚠️ 别用 await 递归自己 ——
     多次调用会排队出一堆定时器，这里直接排一个就够了。 */
  const wait = SPLASH_MIN_MS - (Date.now() - splashAt);
  if (wait > 0 && !force) {
    if (!el.dataset.pending) {
      el.dataset.pending = '1';
      window.setTimeout(() => { delete el.dataset.pending; splashAway(force); }, wait);
    }
    return;
  }

  splashDone = true;
  el.classList.add('out');
  /* 等淡出过渡走完再 display:none —— 直接删节点会让合成器来不及过渡，
     在低端机上看到的就是「啪」地一下没了。
     420ms 是 CSS 里 .splash 的 transition 时长，改那边记得改这里。 */
  window.setTimeout(() => { el.classList.add('gone'); }, 460);
}

/** 首屏已经能显示内容了 → 放行。app.js 里在「首条视频可播」和「空态就绪」
 *  两处调用（见 loadLibrary 末尾与 feed 的首次 ready）。 */
function splashReady() {
  splashAway(false);
}

/** 当前配置的 WebDAV 地址是否指向**手机内置的 CD2 引擎**（127.0.0.1:19798）。
 *  用途：401 的归因分两种 —— 连远程 NAS 是「账号密码不对」，连本机引擎
 *  绝大多数是「引擎里还没登录 CD2 账号」，两者给的动作完全不同。
 *  ⚠️ 只认 19798 这个端口：别的本机 WebDAV（比如自己搭的）不该被误判。 */
function isLocalEngineUrl() {
  const u = (S.config && S.config.url) || '';
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):19798(\/|$)/.test(u);
}

/** 把底层的网络错误翻译成人能看懂的话 */
function friendlyNetErr(msg) {
  const s = String(msg || '');
  /* 🔴 服务端已经写好「人话 + 下一步怎么做」的，**原样透出，别再翻译一遍**。
     历史坑（2026-09-20 实测）：NasServer 在 401 时给的是
     「内置网盘的 WebDAV 拒绝了这个账号 —— …先回第 1 步点『打开 CloudDrive2 管理』…」，
     结果被下面 `401` 那条规则改写成「账号或密码不对（401）。」——
     把唯一的出路抹掉了，用户反而照着错提示去反复重填密码。
     判据：含中文 且 含行动词（去/点/重新/登录/设置/第 N 步）→ 认为是成品文案。
     ⚠️ 必须放在所有 /正则/ 规则**之前**，否则永远轮不到它。 */
  if (/[\u4e00-\u9fa5]/.test(s) && /(去|点|重新|登录|设置|第\d+步|打开)/.test(s)) return s;
  if (/ECONNREFUSED/i.test(s)) return 'NAS 拒绝了连接：端口可能不对，或者 WebDAV 服务没开。';
  if (/ETIMEDOUT|timeout|超时/i.test(s)) return '连接超时：NAS 不在线，或者防火墙拦住了。';
  if (/ENOTFOUND|EAI_AGAIN/i.test(s)) return '找不到这台主机：地址可能写错了。';
  if (/401|Unauthorized/i.test(s)) return '账号或密码不对（401）。';
  if (/404/.test(s)) return '这个目录不存在（404）。';
  if (/403/.test(s)) return '没有权限访问该目录（403）。';
  return s || '请检查 NAS 是否在线。';
}

/** 顶栏标题 = 当前片源（名字写进 #topName，数字角标由 updateBadge 管） */
function updateTitle() {
  const t = $('topTitle');
  const dirs = S.dirs;
  let name = 'NAS 视频';
  if (S.demoMode) name = '演示视频';
  else if (dirs.length > 1) name = `${dirs.length} 个文件夹`;
  /* ⚠️ 用 srcLabel 而不是 pathName（2026-09-20）：本机片源的路径是 `local:/`，
     pathName 会取到最后一段空串再兜成「根目录」—— 顶栏写着「根目录」但其实是
     本机 strm 库，用户会以为刷的是 CD2 的根。srcLabel 对它是「本机 strm 库」。 */
  else if (dirs.length === 1) name = srcLabel(dirs[0]);
  else if (S.currentDir && S.currentDir !== '/') name = pathName(S.currentDir);
  else if (S.config.url) name = 'NAS 根目录';
  // 名字有自己的 span 了，别再去动 text 节点 —— 那样会把数字角标也一起写坏
  $('topName').textContent = name;
  t.title = S.demoMode ? name : originOf(S.config.url) + (dirs.length ? dirs.join('  +  ') : (S.currentDir || '/'));
}

function updateBadge() {
  const n = S.videos.length;
  // 数字贴在片源名旁边（就是这一条）
  const c = $('topCount');
  c.hidden = !n;
  c.textContent = n ? String(n) : '';

  // 下面那条独立角标只留「非常态」的提示，常态的数字不再重复显示 ——
  // 同一件事说两遍反而让人以为哪里不一致。
  const b = $('modeBadge');
  if (S.demoMode) {
    b.hidden = false;
    b.textContent = '演示模式 · 连上 NAS 后即可刷你自己的片子';
    return;
  }
  b.hidden = true;
  b.textContent = '';
}

/** 片库是什么时候扫的 / 什么时候会自动重扫（宽度紧张：日期用相对说法、后缀能短则短） */
function scanTimeText() {
  if (!S.scannedAt) return '还没扫过';
  const d = new Date(S.scannedAt);
  const p = (x) => String(x).padStart(2, '0');
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const now = new Date();
  const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const day = sameDay(d, now) ? '今天' : (sameDay(d, yest) ? '昨天' : `${d.getMonth() + 1}月${d.getDate()}日`);
  const at = `${day} ${p(d.getHours())}:${p(d.getMinutes())}`;
  const hours = Math.max(0, Math.round((Date.now() - S.scannedAt) / 3600000));
  return hours >= 24 ? `${at} 扫的（打开时更新）` : `${at} 扫的 · ${24 - hours}小时后重扫`;
}

/** 把一份 library 结果灌进界面 */
/**
 * 按「屏蔽小文件」的阈值，从**全量**片库重算出可见列表 S.videos。
 *
 * 🔴 必须从 `S.allVideos` 重新算，**不能拿 S.videos 自我过滤** ——
 *    那样只会越筛越少（50MB 筛完再改 10MB，是在已经筛过的上面再筛），
 *    而且调回「不屏蔽」也回不来。这是「全量 / 可见两份列表」存在的唯一理由。
 *
 * ⚠️ `size` 拿不到（0 / 缺字段）时**保留**：没法证明它小，静默丢掉会让用户
 *    以为片库漏了东西。宁可多显示，也别莫名其妙少一片。
 */
function rebuildShown() {
  const min = (S.minSizeMB || 0) * 1024 * 1024;
  S.videos = min > 0
    ? S.allVideos.filter((v) => {
      const n = Number(v.size || 0);
      /* 三个放行条件：
         · n <= 0        —— 拿不到大小（见下面注释）
         · n >= min      —— 确实够大
         · isStrmPointer —— `.strm` 指针的字节数跟目标视频没关系（见 isStrmPointer）；
                            不放行的话「屏蔽小文件」会把整个本机 strm 库滤成 0 条 */
      return n <= 0 || n >= min || isStrmPointer(v);
    })
    : S.allVideos.slice();
  S.byId = new Map(S.videos.map((v) => [v.p, v]));
}

/**
 * 改「屏蔽小文件」的阈值：改完**立刻**重算并重建信息流。
 * ⚠️ 绝不触发重扫 —— 那要 54~185 秒（实测），拖一下等一分钟没人受得了。
 *    这也是这个设置不走 /api/config 的原因（见 index.html 注释）。
 */
function applyMinSize(mb) {
  const n = Number(mb) || 0;
  if (n === S.minSizeMB) return;
  S.minSizeMB = n;
  LS.set('minSize', n);
  rebuildShown();
  updateBadge();
  updateTitle();
  renderSrcList();
  if (!$('pageMe').hidden) renderMePage();
  applyFilter();                        // 从头开始刷（会归位到第一条）
  toast(n > 0
    ? `已屏蔽 ${sizeText(n)} 以下 · 片库 ${S.videos.length} 个`
    : `已取消大小屏蔽 · 片库 ${S.videos.length} 个`, 1800);
}

/* ------------------------- 主题（深色 / 浅色 / 跟随系统，2026-09-21） -------------------------
 *
 * 用户要求：「在设置里加入新功能，黑白主题切换并且再制作一个白色UI界面」。
 *
 * 三个决定（都先问过用户才动手）：
 *   ① 浅色**只换界面**（设置 / 我的 / 文件夹 / 搜索 / 所有面板 / 底栏），
 *      **首页刷视频那块永远是黑的** —— 视频全屏时四周留白变白很难看，
 *      而且刷片本来就该沉浸式黑底。底栏是唯一需要分场景的：首页它压在视频上，
 *      所以 CSS 里 `.phone[data-nav="home"] .tabbar` 被钉死成深色。
 *   ② 三档，**默认深色** —— 老用户升级后看到的还是原来那个样子。
 *   ③ 入口放设置页「通用选项」，用分段控件（和「画面填充」同款，不新增样式）。
 *
 * 存 localStorage（`nasdy.theme`），**不走 /api/config** —— 理由同 #cfMinSize：
 * 不改扫描行为、必须即时生效、一份 app.js 伺候两个后端。
 *
 * 🔴 index.html 的 <head> 里有一份**等价的内联实现**（防首屏先画一帧深色再翻白）。
 *    两处的键名（`nasdy.theme`）与档位判定必须一致，改这里记得改那里 ——
 *    check.js 有断言同时钉住这两处。
 */
const THEME_LS = 'theme';
const THEME_MQ = (window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null);

/** 用户选的档位：'dark' | 'light' | 'auto'（缺省 / 非法值一律按 dark） */
function themeChoice() {
  const v = LS.get(THEME_LS, 'dark');
  return v === 'light' || v === 'auto' ? v : 'dark';
}
/**
 * 系统当前是深色还是浅色。
 *
 * 🔴 **优先问原生，不要只信 prefers-color-scheme。**
 *    Android WebView 的 `prefers-color-scheme` 取自 **App 自己的主题**
 *    （本项目是 Theme.Material.NoActionBar，深色），跟系统设置毫无关系 ——
 *    实测把系统切成浅色，`matchMedia('(prefers-color-scheme: light)').matches`
 *    依然是 false。只靠媒体查询的话「跟随系统」这一档会**永远停在深色**，是个假档位。
 *    （系统值变了由 MainActivity.onConfigurationChanged → window.__onSystemTheme 推过来。）
 *    PC / 浏览器没有这个桥，那边媒体查询是准的，才回落到它。
 */
function systemTheme() {
  try {
    if (window.NasBridge && window.NasBridge.systemTheme) {
      const v = window.NasBridge.systemTheme();
      if (v === 'light' || v === 'dark') return v;
    }
  } catch (_) { /* 桥挂了就回落 */ }
  return (THEME_MQ && THEME_MQ.matches) ? 'light' : 'dark';
}
/** 实际生效的档位：只有 'dark' | 'light'（'auto' 在这里折成系统当前值） */
function themeResolved() {
  const c = themeChoice();
  if (c !== 'auto') return c;
  return systemTheme();
}
/** 把生效档位写到 <html data-theme>，并同步分段控件的选中态 */
function applyTheme() {
  const t = themeResolved();
  document.documentElement.setAttribute('data-theme', t);
  /* theme-color 管的是浏览器地址栏 / PWA 标题栏。**安卓状态栏它管不着** ——
     那个只能由原生改（见下面的 NasBridge.setTheme）。 */
  const m = document.querySelector('meta[name="theme-color"]');
  if (m) m.setAttribute('content', t === 'light' ? '#f4f5f7' : '#000000');
  /* 🔴 推给原生：安卓状态栏 / 导航栏颜色只能这么改，否则浅色界面顶上留一条黑边。
     ⚠️ 放在 applyTheme 里而不是 setTheme 里 —— 这样**每次页面加载**也会推一次，
        App 重启后带着浅色配置进来，状态栏同样能对上（只推在切换时就会漏掉这种）。
     PC / 浏览器没有这个桥，跳过即可（那边 theme-color 已经够了）。 */
  try {
    if (window.NasBridge && window.NasBridge.setTheme) window.NasBridge.setTheme(t);
  } catch (_) { /* 桥挂了不影响换主题本身 */ }
  const seg = $('themeSeg');
  if (seg) {
    const c = themeChoice();
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.theme === c));
  }
}
/** 切档位：存下来 + 立刻生效（系统栏由 applyTheme 顺手同步） */
function setTheme(v) {
  LS.set(THEME_LS, v);
  applyTheme();
  toast(v === 'auto' ? '外观：跟随系统' : (v === 'light' ? '外观：浅色' : '外观：深色'), 1400);
}
$('themeSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-theme]');
  if (!b || b.dataset.theme === themeChoice()) return;
  setTheme(b.dataset.theme);
});

/* 「预加载条数」输入框（2026-09-23）。
 * 即时生效：下一次 activate() 就会用新值（不需要重启 App，也不必重扫片库）。
 * 用 'change' 而不是 'input' —— 后者在用户输「12」时会先按「1」生效一次，
 * 移动端还可能因为数字键盘逐位输入而反复触发热冷却，白折腾。
 * 越界一律**夹取后写回输入框**：用户输 20 会看到它自己变成 9，
 * 比「默默按 9 跑、框里还显示 20」清楚得多（否则就是典型的「填了没生效」）。 */
function applyPreheatUI() {
  const n = preheatCount();
  const inp = $('preheatNum');
  if (inp) inp.value = String(n);
  return n;
}
$('preheatNum').addEventListener('change', (e) => {
  const raw = Number(e.target.value);
  if (!Number.isFinite(raw)) { applyPreheatUI(); return; }
  const v = Math.max(0, Math.min(PREHEAT_MAX, Math.round(raw)));
  LS.set(PREHEAT_LS, v);
  e.target.value = String(v);
  toast(v === 0 ? '预加载：已关闭（最省流量）' : `预加载：${v} 条`, 1400);
});
applyPreheatUI();

/* ==================== 应用内更新（2026-09-23）====================
 *
 * 用户要求：「在设置里增加一个版本更新，我要内置推送更新」。
 *
 * 数据源：GitHub Releases 的 `releases/latest`（公开仓库，匿名可读，**不需要 token**）。
 * 下载：APK 直链（`browser_download_url`）→ 交给原生 `NasBridge.updDownload` 下载。
 * 安装：原生 `NasBridge.updInstall` → FileProvider → 系统安装器。
 *
 * 🔴 四条设计红线（都是踩过或必然踩的坑，别改）：
 *
 * 1. **「检查失败」≠「已是最新」。** `api.latestRelease()` 抛异常 = 没查成
 *    （离线 / 被墙 / 超时）。这时候**绝不能**显示「已是最新」—— 用户会以为查过了、
 *    没问题，其实什么都没查。必须原样报「检查失败，稍后再试」。
 *
 * 2. **下载和安装必须分开两次点击。** Android 12+ 的「近似安装」限制只认
 *    用户主动点击触发的那一次；下完自动弹安装会被系统静默忽略。
 *    所以 `__updDone` 回调里**只更新 UI**，绝不自动调 `updInstall()`。
 *
 * 3. **更新说明按纯文本渲染，不许 innerHTML。** 那段文字来自网络（GitHub release body），
 *    直接塞进 DOM 就是注入面。统一走 textContent。
 *
 * 4. **网页版（浏览器）装不了。** 没有原生桥 → 只能给一个「去下载页」的入口，
 *    并把文案说清楚。假装能装比不给按钮更糟。
 */

/** 当前版本信息：值来自 /api/config（后端从 PackageManager 读，前端不写死版本字符串）*/
function appVersion() {
  const v = (S.config && S.config.versionName) || '';
  const code = (S.config && S.config.versionCode) || 0;
  return { name: String(v), code: Number(code) || 0 };
}

/**
 * 版本号比较（**只比数字段**，2026-09-23）。
 *
 * 规则：`1.3.43` > `1.3.42` > `1.3.9`；不等长时短的那个缺位按 0 算（`1.4` == `1.4.0`）。
 *
 * ⚠️ 🔴 **绝对不许用字符串比较或 parseFloat**：
 *    · `'1.3.43' > '1.3.9'` 是 **false**（字符串比到第三位 '4' < '9'）——
 *      这样用户永远收不到「1.3.9 → 1.3.43」的更新，且**不报错**，最难查。
 *    · `parseFloat('1.3.43')` = 1.3，直接丢掉末位，同样比不出来。
 *    本项目版本号是「末位十进制递增」的（1.3.9 → 1.3.10 而不是进位到 1.4），
 *    所以必须**按点切段、逐段转数字**比。
 *
 * @returns 正数表示 a 更新；负数表示 b 更新；0 相等
 */
function cmpVersion(a, b) {
  const seg = (s) => String(s == null ? '' : s).replace(/^v/i, '').split('.')
    .map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
  const A = seg(a), B = seg(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) {
    const x = A[i] || 0, y = B[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 更新流程的临时状态（只活在本次页面加载里，不持久化）*/
const UPD = {
  release: null,     // 最近一次查到的 release（有新版才有意义）
  latest: '',        // 🔴 目标版本号（如 "1.3.48"）。装包/缓存判断都靠它，
                     //    少了它就会出现「检测到新版、却装了以前下载的旧包」。
  url: '',           // 该 abi 的 APK 直链
  sha: '',           // 该 abi 的 APK sha256（GitHub 不提供，留空 = 原生跳过哈希校验）
  size: 0,
  downloading: false,
  installing: false,
  /* ⚠️ 没有 `downloaded` 这个字段（2026-09-23 删掉的）。
     「缓存里有没有这次要装的包」**不能**记在网页内存里 ——
     App 一重启这个标志就没了，而缓存文件还在（真源在原生侧）。
     统一用 updCached() 现问原生，别再加回来。 */
};

/**
 * 挑出「对应本机 abi」的那个 APK 资产。
 *
 * 🔴 必须按 abi 挑，不能随便拿第一个：
 *    arm64 包（真机）和 x86_64 包（模拟器）是两个不同文件，装错了要么装不上、
 *    要么崩溃。判据就用文件名里的 `arm64` / `x86_64` —— 这也是 build.js 的命名约定。
 *
 * ⚠️ 拿不到预期 abi 时返回 null（宁可说「这个版本没有适合你机型的包」，
 *    也不要塞一个不对的包让用户装到一半失败）。
 */
function pickAsset(rel) {
  const assets = (rel && rel.assets) || [];
  if (!assets.length) return null;
  /* 判断本机 abi：优先问原生（Build.SUPPORTED_ABIS 才准），浏览器里退回 arm64 假设。 */
  let abi = 'arm64';
  try {
    if (window.NasBridge && window.NasBridge.deviceAbi) abi = String(window.NasBridge.deviceAbi());
  } catch (_) {}
  const want = /x86/i.test(abi) ? 'x86_64' : 'arm64';
  const hit = assets.find((a) => new RegExp(want, 'i').test(a.name || ''));
  /* 兜底：找不到对应 abi 时，如果只有一个 apk 资产就先用它
     （正常不会发生，但发版时漏传一个 abi 时至少还能更新） */
  if (hit) return hit;
  const apks = assets.filter((a) => /\.apk$/i.test(a.name || ''));
  return apks.length === 1 ? apks[0] : null;
}

/**
 * 🔴 GitHub 的 release API **不提供资产 sha256**（只有 size / content_type / 下载数）。
 * 所以校验只能做到**字节数比对** —— 这点必须诚实：
 *   · 好处：能挡住「下了一半」「下成了 HTML 错误页」这类最常见的失败。
 *   · 局限：挡不住中间人替换（要真校验得让发版方额外提供 sha256 资产）。
 * 因此传给原生的 sha256 留空、只做长度校验，**不假装**做了哈希校验。
 */
function assetSize(asset) {
  return asset && asset.size ? Number(asset.size) : 0;
}

/** 把 release body（markdown）压成适合小面板显示的纯文本 */
function releaseNoteText(body) {
  return String(body || '')
    .replace(/\r/g, '')
    /* 去掉 markdown 的标题井号 / 引用符，列表星号换成 ·，但**保留换行**（可读性靠它） */
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[-*]\s+/gm, '· ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')       // 粗体标记
    .replace(/`([^`]+)`/g, '$1')             // 行内代码
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接 → 只留文字
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function updSetNote(text, bad) {
  const el = $('updNote');
  if (!el) return;
  el.textContent = text;
  el.style.color = bad ? 'var(--bad-fg)' : '';
}

/** 刷新面板上的「当前版本」与按钮状态 */
function updRender() {
  const cur = $('updCur');
  if (cur) {
    const v = appVersion();
    cur.textContent = v.name ? ('v' + v.name) : '未知';
  }
  const go = $('updGo');
  if (go) {
    go.hidden = !UPD.release;
    /* 🔴 判据是 updCached()，**不是** UPD.downloaded。
     * `UPD.downloaded` 只活在本次页面加载里：App 重启后缓存里明明有个**本版本正确**的包，
     * 按钮却会显示「下载并安装」→ 用户以为要重下。反过来也不能只看「有没有文件」——
     * 那正是用户报的「装了以前下载的旧版本」那个 bug。见 updGo() 的注释。 */
    const ready = UPD.downloading ? false : updCached();
    go.textContent = UPD.downloading ? '下载中…' : (ready ? '安装' : '下载并安装');
    go.disabled = UPD.downloading;
  }
  /* 「取消下载」只在**真有包压在缓存里**时出现 —— 没包可删时摆个按钮只会让人困惑 */
  const dis = $('updDiscard');
  if (dis) dis.hidden = UPD.downloading || !updCached();
}

/**
 * 缓存里是否已经有一个**正好是这次要装的那个版本**的包。
 *
 * 三重条件缺一不可：
 *   1. 有原生桥（网页版永远「没有」）；
 *   2. 有明确的**目标版本号**（`UPD.latest`）—— 没有它就无法判断缓存是谁的，
 *      宁可说「没有」让用户重下，也不能拿不准的包去装；
 *   3. 原生侧比对伴随文件里的版本，一致才算。
 *
 * ⚠️ 原生的 `updHasPackage('')` 会退化成「有文件就算有」的老行为，**这里绝不传空串**。
 */
function updCached() {
  if (!(window.NasBridge && window.NasBridge.updHasPackage)) return false;
  if (!UPD.latest) return false;
  try { return !!window.NasBridge.updHasPackage(UPD.latest); } catch (_) { return false; }
}

/**
 * 检查更新。
 * @param silent 静默模式（启动时自动跑）：**成功且有新版**才改 UI + 打红点，
 *               失败或已是最新都**不打扰**用户（不写提示文字、不弹 toast）。
 *               手动点「检查更新」时传 false，此时必须给出明确反馈。
 */
async function checkUpdate(silent) {
  const btn = $('updCheck');
  if (!silent && btn) { btn.disabled = true; btn.textContent = '检查中…'; }
  /* 🔴 开查前先把「目标版本」清空（2026-09-23）。
     为什么不能等结果回来再清：这是个 async 函数，等待网络的那段时间里
     用户完全可能点一下「安装 / 下载」—— 那时 `UPD.latest` 如果还是**上一轮的**值，
     就会拿旧版本号去问原生「缓存里有没有这个包」，答「有」就装了一个不属于
     本次目标版本的包。清空后 updCached() 一律返回 false → 只会走「下载」，
     而下载路径本身也带版本号，不会再装错。 */
  UPD.latest = '';
  UPD.url = '';
  try {
    const rel = await api.latestRelease();
    const tag = (rel && (rel.tag_name || rel.name)) || '';
    const latest = String(tag).replace(/^v/i, '');
    const curV = appVersion().name;
    const newer = curV && cmpVersion(latest, curV) > 0;

    if (!newer) {
      /* 🔴 `UPD.latest` 必须一起清掉（2026-09-23）：
         它决定按钮显示「安装」还是「下载并安装」、以及下载时带哪个版本号。
         留着上一轮的旧值会得出**错的**按钮态 —— 比如「刚装完 1.3.48、
         再查发现已是最新」这个再正常不过的时刻，UPD.latest 还挂着 1.3.48，
         而缓存里刚好还剩个 1.3.48 的包（sweep 之前的一瞬）→ 按钮显示「安装」。
         清干净 = 没有目标版本 = 什么都不给装。 */
      UPD.release = null;
      UPD.latest = '';
      UPD.url = '';
      updRender();
      $('updNew').hidden = true;
      { const dot = $('meSettings'); if (dot) dot.classList.remove('upd-dot'); }
      if (!silent) updSetNote('已是最新版本（v' + (curV || '?') + '）。');
      return;
    }

    /* 有新版本：记下来 + 显示说明 + 打红点 */
    UPD.release = rel;
    UPD.latest = latest;          // 目标版本号：下载时带给原生，装包时要靠它校验
    const asset = pickAsset(rel);
    UPD.url = asset ? asset.browser_download_url : '';
    UPD.sha = '';
    UPD.size = assetSize(asset);
    const nv = $('updNewVer'); if (nv) nv.textContent = 'v' + latest;
    const bd = $('updBody'); if (bd) bd.textContent = releaseNoteText(rel.body);
    $('updNew').hidden = false;
    updSetNote(asset
      ? '可以直接在 App 里下载安装。'
      : '这个版本没有适合你机型的安装包，请到发布页看看。');
    { const dot = $('meSettings'); if (dot) dot.classList.add('upd-dot'); }
    updRender();
  } catch (e) {
    /* 🔴 红线 1：失败**不是**「已是最新」 —— 必须原样说「没查成」 */
    /* 同样要清 UPD.latest：查失败时我们连「最新是几」都不知道，
       留着上一轮的值会让按钮态和下载版本号都指向一个**没验证过**的目标。 */
    UPD.release = null;
    UPD.latest = '';
    UPD.url = '';
    updRender();
    if (!silent) updSetNote('检查失败：' + (e && e.message ? e.message : '网络不通') + '。请稍后再试。', true);
  } finally {
    if (!silent && btn) { btn.disabled = false; btn.textContent = '检查更新'; }
  }
}

/** 点「下载并安装」：App 内走原生；网页版只能跳发布页 */
function updGo() {
  if (!UPD.url) {
    /* 没有匹配的包 —— 给一个发布页入口，总比什么都不做好 */
    try { window.open('https://github.com/xyyzz6/douyin-nas/releases/latest', '_blank'); }
    catch (_) { location.href = 'https://github.com/xyyzz6/douyin-nas/releases/latest'; }
    return;
  }
  if (!(window.NasBridge && window.NasBridge.updDownload)) {
    /* 🔴 红线 4：网页版装不了。别假装能装 —— 把话说明白，跳发布页。 */
    updSetNote('网页版没法直接安装，正在打开发布页，请下载 APK 手动安装。');
    try { window.open(UPD.url, '_blank'); } catch (_) { location.href = UPD.url; }
    return;
  }
  /* 🔴 只有「缓存里的包正好是**这次要装的那个版本**」才跳过下载。
     2026-09-23 修的 bug：这里原来只问「有没有文件」，于是
     「下了 1.3.47 → 在系统安装界面点了取消 → 1.3.48 发布后再点按钮」
     会**跳过下载，直接装缓存里那个 1.3.47** —— 用户看到的就是
     「能检测到更新，但点了安装装的是之前下载的版本」。
     现在判据换成了 updCached()：把目标版本号传给原生，让它比对伴随文件里的版本，
     不匹配一律当「没有」→ 走下载（下载开头也会先把旧包删掉）。 */
  if (updCached() && !UPD.downloading) { updInstall(); return; }

  UPD.downloading = true;
  updRender();
  const bar = $('updBar'); const fill = $('updBarFill');
  if (bar) bar.hidden = false;
  if (fill) fill.style.width = '0%';
  updSetNote('正在下载更新包，请保持网络畅通…');
  try {
    window.NasBridge.updDownload(UPD.url, UPD.sha || '', UPD.latest || '');
  } catch (e) {
    UPD.downloading = false;
    updRender();
    updSetNote('下载启动失败：' + e.message, true);
  }
}

/** 调原生安装（也会被「已下好」的路径直接调用） */
function updInstall() {
  UPD.installing = true;
  updRender();
  updSetNote('正在打开系统安装界面…');
  try { window.NasBridge.updInstall(); }
  catch (e) { updSetNote('安装启动失败：' + e.message, true); UPD.installing = false; updRender(); }
}

/* ---- 原生回调用（钩子必须挂 window —— app.js 是 module，外面看不见）---- */

/** 下载进度：pct 0~100，done/total 单位 MB */
window.__updProgress = (pct, done, total) => {
  const fill = $('updBarFill');
  if (fill) fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
  updSetNote(`正在下载 ${Math.round(pct)}%（${(+done).toFixed(1)} / ${(+total).toFixed(1)} MB）`);
};

/**
 * 下载结束回调。
 *
 * 🔴 红线 2：**这里绝对不许自动调 updInstall()**。
 *    Android 12+ 只允许「用户点击后紧接着」弹安装；从回调里自动弹会被系统静默忽略，
 *    表现成「下载完就没反应了」。所以这里只更新 UI，把「安装」留给用户再点一次。
 */
window.__updDone = (r) => {
  UPD.downloading = false;
  const bar = $('updBar');
  if (r && r.ok) {
    if (bar) bar.hidden = true;
    updSetNote('下载完成（' + (r.mb || '?') + ' MB）。点下面的按钮开始安装。');
    /* 按钮改成「安装」——用户再点一次，满足「近似安装」要求的点击动作。
       ⚠️ 这里不用记「已下好」：`updRender()` 会现问原生 updCached()，
          此刻伴随文件刚写好，版本号一致 → 自然显示「安装」。 */
    const go = $('updGo');
    if (go) { go.disabled = false; go.hidden = false; }
    updRender();
    return;
  }
  if (bar) bar.hidden = true;
  /* 「未知来源」权限没开：原生的 err 是固定串 NEED_UNKNOWN_SOURCE，
     它已经跳了系统设置页。这里给一句能照做的话，别只报英文串。 */
  if (r && r.err === 'NEED_UNKNOWN_SOURCE') {
    updSetNote('需要先允许「安装未知应用」：已在系统设置里打开对应页面，开启后回来再点一次。');
    UPD.installing = false;
    updRender();
    return;
  }
  updSetNote('下载失败：' + ((r && r.err) || '未知错误'), true);
  UPD.installing = false;
  updRender();
};

/* ---- 面板事件 ---- */
$('updCheck').addEventListener('click', () => checkUpdate(false));
$('updGo').addEventListener('click', () => {
  /* 缓存里已经有「这次要装的版本」→ 直接装；否则先下。
     🔴 判据统一走 updCached()（带版本号问原生），别用 UPD.downloaded —— 那个标志
        只在本次页面加载里有效，冷启动进来必然是 false。 */
  if (updCached() && !UPD.downloading) { updInstall(); return; }
  updGo();
});
/* 取消下载 = 删掉已经下好的包（2026-09-23）。
   🔴 这个按钮不是「礼貌性」的，它堵的是一个真洞：
      下好包 → 在系统安装界面点取消 → 包留在 cacheDir 里没人管 →
      下次有新版本时**如果不比对版本**，就会把那个旧包装上去（用户报的 bug）。
      虽然版本比对已经能兜住「装错版本」，但留着没用的包对用户没有任何好处：
      占几十 MB、而且下次还得再删一遍。用户按了取消就该真的清干净。 */
$('updDiscard').addEventListener('click', () => {
  try { if (window.NasBridge && window.NasBridge.updClear) window.NasBridge.updClear(); } catch (_) {}
  updSetNote('已取消，安装包已删除。想装的时候可以重新下载。');
  updRender();
});

/* 面板一打开就刷一次（版本号来自 /api/config，可能比面板构建晚到） */
$('meSettings').addEventListener('click', () => { updRender(); });

/* 启动静默检查（用户 2026-09-23 选「要，开机自动检查」）：
   ⚠️ 延迟 6 秒再发 —— 别跟「开机那波 /api/config + /api/library + strm 恢复」
      抢带宽和主线程。失败**完全静默**（silent=true 不写任何提示），
      只在真发现有新版时打个小红点。 */
setTimeout(() => { checkUpdate(true); }, 6000);
/* 「跟随系统」档要跟着系统走。
   两条路都要有：
     · 浏览器 / PC：媒体查询自己会变，监听它（那边 prefers-color-scheme 是准的）；
     · 安卓 App：媒体查询**恒为 dark**（见 systemTheme 的注释），
       只能等 MainActivity.onConfigurationChanged 调下面这个钩子推过来。
   ⚠️ 钩子必须挂 window —— app.js 是 module，模块作用域的函数外面看不见。 */
window.__onSystemTheme = () => { if (themeChoice() === 'auto') applyTheme(); };
if (THEME_MQ) {
  const onSysTheme = () => { if (themeChoice() === 'auto') applyTheme(); };
  if (THEME_MQ.addEventListener) THEME_MQ.addEventListener('change', onSysTheme);
  else if (THEME_MQ.addListener) THEME_MQ.addListener(onSysTheme);   // 老 WebView 兜底
}
applyTheme();

/** 把 MB 阈值显示成人话：1024 →「1 GB」，其余 →「N MB」 */
function sizeText(mb) {
  const n = Number(mb) || 0;
  return n >= 1024 ? `${(n / 1024).toFixed(n % 1024 ? 1 : 0)} GB` : `${n} MB`;
}

function applyLibrary(lib) {
  S.pendingScan = false;               // 真正的片库到了，不再是「等后台扫」的状态
  S.source = lib.source;
  S.scannedAt = lib.scannedAt || Date.now();
  S.cached = !!lib.cached;
  if (lib.version != null) S.libVersion = Number(lib.version);
  S.dirs = Array.isArray(lib.dirs) ? lib.dirs : (lib.source === 'demo' ? [] : srcList());
  /* 🔴 片库回传的 dirs = 「这一轮实际扫的片源」，把它同步进 S.config.dirs（2026-09-20）。
   *
   * 为什么必须有这一步：strm 生成完成后，**后端自己**会把本机 strm 目录加进片源
   * （见 NasServer.strmRegisterLocalSrc），用户没点任何按钮。而 `S.config` 是
   * 启动时拉一次、之后只在用户操作（applySources 等）时更新的 ——
   * 后端这次改动它完全不知情，于是片源栏、设置页第 3 步全都显示成旧状态
   * （实测：后端 `dirs:["local:/"]`，界面还写着「还没添加」）。
   *
   * 这里以「服务端刚扫完的这份」为准做一次收敛：只更新 dirs 一个字段，
   * 别的配置项（url/nickname/…)不碰 —— 那些跟扫描无关，没有理由跟着变。
   * ⚠️ demo 模式别同步：那时 lib.dirs 是演示数据，塞进 config 会把真实片源冲掉。 */
  if (!S.demoMode && Array.isArray(lib.dirs)) {
    const a = (S.config.dirs || []).join('\u0001');
    const b = lib.dirs.join('\u0001');
    if (a !== b) S.config = { ...S.config, dirs: lib.dirs.slice() };
  }
  if (lib.source === 'demo') S.demoMode = true;
  /* ⚠️ currentDir 只跟 WebDAV 片源走（2026-09-20）：它是「文件夹」页的浏览位置，
     而本机片源（local:）不在 CD2 上，设成它会把那页带进一个必然 404 的路径。 */
  else if (S.dirs.filter((d) => !isLocalSrc(d)).length) {
    S.currentDir = S.dirs.filter((d) => !isLocalSrc(d))[0];
  }

  const next = lib.videos || [];
  const prevShown = S.videos;           // 上一次的**可见**列表，用来判断「内容变没变」
  S.allVideos = next;                   // 全量（服务端原始，未过滤）
  rebuildShown();                       // → S.videos（过滤后）+ S.byId
  const sig = (a) => a.map((v) => v.p).join('\n');
  const same = S.videos.length > 0 && sig(S.videos) === sig(prevShown);
  showLoading(false);
  /* 🔴 拿到真片库就把空状态收起来 —— **包括失败态那一版**。
     2026-09-20 实测：后台扫失败 → 空状态盖成「连不上/没登录」；
     之后修好配置、后台扫成功、片库换成 69 条，**空状态却还盖在上面**，
     用户看到的仍是「连不上」。loadLibrary 只在它自己的路径里设 emptyView，
     applyLibrary 这条（后台轮询换上新片库）从来没管过它。 */
  $('emptyView').hidden = true;
  updateBadge();
  updateTitle();
  // 后台补扫出来的列表要是跟现在这条一模一样，就别重建 DOM —— 否则正在看的那条会被切走。
  // 注意：这里必须沿用当前这条随机顺序，不能把 S.videos（服务端的文件名序）塞回去，
  // 否则内容没变但顺序会突然变成按文件名排，画面直接串条。
  if (same && main.list.length) {
    const byId = new Map(next.map((v) => [v.p, v]));
    main.refreshList(main.list.map((v) => byId.get(v.p) || v));
  } else applyFilter();
  renderSrcList();
  if (!$('pageMe').hidden) renderMePage();
  if (lib.truncated) {
    // 目录（比如整个 NAS 根目录）太大，扫到上限就先给这些
    toast(`目录太大，扫了 ${Math.round((lib.elapsedMs || 0) / 1000)} 秒，先载入 ${S.videos.length} 个视频`, 3400);
  }
  warmTranscodeInfo();
  watchLibraryRefresh(lib);
  // 片库到手后才知道点赞的那些视频在不在当前片源里，所以缩略图补齐放这儿
  backfillThumbs(false);
  /* 首屏已经有真内容了 → 放掉启动动画。
     放在最后一行（比 applyFilter 晚）是有意的：等这一轮 DOM 都建完再揭幕，
     否则会看到「动画刚收掉、列表还在长出来」的中间态。 */
  if (S.videos.length) splashReady();
}

/* ---------- 片库缓存过期 / 片源变更时，服务端会在后台重扫；这边等它扫完自动换上新内容 ---------- */
let peekTimer = null;

function watchLibraryRefresh(lib) {
  clearInterval(peekTimer);
  peekTimer = null;
  if (!lib || !lib.scanning) return;             // 没在后台扫就不用等
  const v = Number(lib.version || 0);
  let tries = 0;
  /* ⚠️ 上限原来是 75 次 × 4s = **5 分钟** —— 那是「缓存过期后台补扫」的量级。
     2026-09-18 深扫放开后实测 **13 分钟**（549 → 5496 个视频），5 分钟会半途放弃，
     用户看到的就是「点了重新扫描，什么也没发生」。放宽到 300×4s = 20 分钟。
     🔴 只改服务端不改这里 = 扫完没人接得住；只改这里不改服务端 = 白等。 */
  /* 收尾只有一处出口 —— 任何一条路（扫完 / 扫挂 / 等超时）都必须把转圈收掉，
   * 否则「只刷它」那种会挂全屏 loading 的场景会一直卡着，看着像死机。 */
  const stop = () => {
    clearInterval(peekTimer);
    peekTimer = null;
  };
  peekTimer = setInterval(async () => {
    if (++tries > 300) { stop(); showLoading(false); return; }  // 最多等 20 分钟（深扫实测 13 分钟）
    try {
      const r = await api.libPeek(v);
      if (!r.changed) return;
      stop();
      /* 后台扫描失败：服务端也会让版本 +1（否则这边要空等 5 分钟），
       * 并把原因放在 scanError 里。这时**别**再去拉一次完整片库 ——
       * 那一趟在服务端是同步重扫，白等十几秒，而且大概率再失败一次。
       * 🔴 原因必须**留在屏幕上**（renderEmptyError），不能只弹个 4 秒 toast：
       * toast 一过，页面还是「这个文件夹里没有能播的视频」——
       * 把「连不上/没登录」说成「目录里没片」，用户会一直去换目录。 */
      if (r.scanError) {
        renderEmptyError({ error: r.scanError });
        toast('片源扫描失败：' + friendlyNetErr(r.scanError), 4200);
        return;
      }
      const full = await api.library(false);
      if (full && full.videos) {
        applyLibrary(full);                       // 里面会 showLoading(false)
        toast(`片库已更新：${full.videos.length} 个视频`, 2200);
      } else {
        showLoading(false);
      }
    } catch (_) { /* NAS 抖一下就下一轮再试 */ }
  }, 4000);
}

/**
 * 后台预热「需要转码的视频」的时长信息。
 * ------------------------------------------------------------------
 * 列表一出来就先问一遍，服务端会把结果缓存住。
 * 这样等用户真划到那个 avi / wmv 时，服务端不用再冷探测一遍（云盘挂载上可能要好几秒），
 * 点开就能立刻出画。串行 + 只有三个以上才轮到，尽量别跟正在播的视频抢带宽。
 *
 * ⚠️ 以前这里有个 `if (!S.ffmpeg) return;` —— 那是照搬 Node 版的逻辑（探测靠 ffprobe）。
 * 但 APK 走的是 MediaMetadataRetriever，**不需要 ffmpeg 也能探时长**，
 * 于是 APK 上这个预热从来没跑过，用户一拖进度条就撞上「还没读出时长」。
 * 现在改成看「服务端支不支持 probe」这个能力位，而不是「有没有 ffmpeg」。
 */
let warmSeq = 0;
async function warmTranscodeInfo() {
  if (!S.probe) return;
  const seq = ++warmSeq;
  const targets = S.videos.filter((v) => v.playable === false && !v.demo).slice(0, 8);
  for (const v of targets) {
    if (seq !== warmSeq) return;                 // 换片库了，这轮就别做了
    if (document.hidden) return;                 // 用户切走了，省点流量
    try { await api.probe(v.p); } catch (_) { /* 探不到就算了，划到时再试 */ }
  }
}

/**
 * 把「片源读不到」渲染成空状态页 —— **两条路共用**：
 *   ① loadLibrary() 拿到带 error 的响应（首次/手动重扫）；
 *   ② 后台扫描失败，peek 带回 scanError（用户已经在页面上等着了）。
 *
 * 🔴 2026-09-20 补 ②：此前 peek 那条路**只弹一个 4 秒 toast 就 return**，
 *    空状态页永远停在「这个文件夹里没有能播的视频 / 去换个目录」——
 *    把「连不上/没登录」硬说成「这个目录没片」，用户照着提示去换目录，
 *    换一百个也没用。失败原因必须**留在屏幕上**，不能一闪而过。
 *
 * 三种情况分开说，别混成一句「连不上 NAS」：
 *   · stale      = 服务器连得上，只是**之前那个文件夹在 NAS 上没了**；
 *   · 本机引擎 401 = 引擎里还没登录 CD2 账号（重填密码没用，要去管理页登录）；
 *   · 其它       = 真的连不上（端口/密码/服务没开）。
 * lib 里至少有 { error }；stale 由后端给。
 */
function renderEmptyError(lib) {
  showLoading(false);
  main.clear();
  $('emptyView').hidden = false;
  $('emptyEngineBtn').hidden = true;          // 只有本机引擎那条路才亮出来
  const err = lib.error || '';
  /* stale 的判据除了后端的布尔位，**还要认文案**：
     peek 那条路（后台扫描失败）带回来的只有 scanError 字符串，
     没有 stale 位 —— 而后端在「目录失效」时写的正是这句固定话术。
     不认它的话，这种情况会被归到「连不上 NAS」，给出的动作是错的。
     ⚠️ 2026-09-20：后端文案从「在 NAS 上找不到了（可能被删或改名）」
     改成「已经打不开了（可能被删或改名）」——**这里要跟着改**，
     否则这条分叉会静默失效（不报错，只是归类错、给出的下一步是错的）。 */
  if (lib.stale || /打不开了（可能被删或改名）/.test(err)) {
    $('emptyTitle').textContent = '片源文件夹不在了';
    $('emptyDesc').innerHTML =
      `${escapeHtml(friendlyNetErr(err))}<br>` +
      '服务器本身是通的，只是之前设的那个文件夹已经打不开了。<br>' +
      '去 <b>设置</b> 页点<b>登录</b>，然后在第 3 步重新挑一个文件夹即可。';
    return;
  }
  /* 内置引擎没登录 CD2 账号：这类 401 **重填密码没用**，必须先去管理页登录。
     判据取「配置地址是不是本机引擎」——**前端自己算**，不依赖后端的标记：
     两个后端（Java / Node）都要回同一个布尔值才能真正对齐，而我们只要
     一个纯函数就能判定，少一处要同步的东西。文案仍由后端给（它更清楚
     是 401 还是被限流）。 */
  if (isLocalEngineUrl() && /401|403|Unauthorized/i.test(err)) {
    $('emptyTitle').textContent = '内置网盘还没登录';
    $('emptyDesc').innerHTML =
      `${escapeHtml(friendlyNetErr(err))}<br>` +
      '内置引擎的 WebDAV 用的就是你 <b>CD2 账号</b>，引擎里没登录时它谁都进不来。<br>' +
      '点下面的按钮打开管理页登录一次，回来重新扫描即可。';
    $('emptyEngineBtn').hidden = false;
    return;
  }
  $('emptyTitle').textContent = '连不上 NAS';
  $('emptyDesc').innerHTML =
    `${escapeHtml(friendlyNetErr(err))}<br>` +
    '检查一下：端口（群晖 WebDAV 默认 <b>5005</b>）、账号密码，以及 NAS 是否开了 WebDAV 服务。<br>' +
    '如果只是之前挂的文件夹失效了，去 <b>设置</b> 页重新<b>登录</b>，再挑一个新的文件夹就行。';
}

/**
 * 这台设备有没有**任何**片源。
 *
 * 🔴 不能只看「有没有 WebDAV 地址」—— 本机 strm 库（`local:/`）也是真片源。
 */
function hasAnySource() {
  if (S.config && S.config.url) return true;
  return (Array.isArray(S.dirs) && S.dirs.length > 0)
    || (Array.isArray(S.config && S.config.dirs) && S.config.dirs.length > 0);
}

/**
 * 重新判定「是不是演示模式」。
 *
 * 🔴 判据是**有没有片源**，不是「有没有 WebDAV 地址」。2026-09-22 修：
 *    换新机登录后，同步会把「片源清单」恢复回来（含 `local:/` 这种本机 strm 源），
 *    但**不恢复** WebDAV 地址和账号密码（凭据不同步是既定设计）。
 *    于是 `mode` 仍算 demo → `loadLibrary` 就去取 `/api/demo`（**空数组**）
 *    而不是真片库，用户看到的是「strm 回填了几千个、首页却写着『没有演示视频』」。
 *
 * @returns {boolean} 这次**刚刚关掉**了演示模式（调用方通常要据此重扫一次片库）
 */
function refreshDemoMode() {
  const now = S.mode === 'demo' && !hasAnySource();
  const justOff = S.demoMode && !now;
  S.demoMode = now;
  return justOff;
}

async function loadLibrary(refresh) {
  showLoading(true, refresh ? '正在扫描 NAS 目录…' : '正在读取视频列表…');
  $('emptyView').hidden = true;
  /* 每次进来先收起「打开 CloudDrive2 管理」——它只属于「内置引擎没登录」那一种
     失败（下面 renderEmptyError 会按需亮出来）。不重置的话，用户从那种状态恢复后
     按钮会一直挂在空状态页上，看着像个坏按钮。 */
  $('emptyEngineBtn').hidden = true;
  try {
    const lib = S.demoMode ? await api.demo() : await api.library(refresh);
    if (lib.error) { renderEmptyError(lib); return; }   // 后端把扫描失败做成了结构化返回
    const wasPending = !!lib.pendingScan;
    applyLibrary(lib);
    /* 首次启动（手上一点缓存都没有）+ 深扫要走十几分钟：
       这时 applyLibrary 会拿到一个空壳并收掉 loading，屏幕上就是一片空白 ——
       用户会以为坏了。把 loading 留在屏幕上并说明要多久。
       （watchLibraryRefresh 扫完会自己 showLoading(false)。） */
    if (wasPending && !S.videos.length) {
      showLoading(true, '首次扫描目录较大，可能要十几分钟…');
    }
    /* 配置目录在 NAS 上没了、后端已经用根目录兜底扫出东西 —— 必须告诉人，
     * 否则他会奇怪「为什么刷出来的不是我那个文件夹」，也不知道配置已经失效。
     * 用 toast 而不是空状态：这时候是有内容的，别把画面盖掉。 */
    if (lib.staleRoots && lib.staleMsg) toast(lib.staleMsg, 4200);
    if (!S.videos.length) {
      main.clear();
      $('emptyView').hidden = false;
      $('emptyTitle').textContent = S.demoMode ? '没有演示视频' : '这个文件夹里没有能播的视频';
      $('emptyDesc').innerHTML = S.demoMode
        ? '演示素材缺失，可以连上数据源直接看自己的片子'
        : `目录 <b>${escapeHtml(S.currentDir || '/')}</b> 下没有能播的视频<br>` +
          '（mp4 / mkv / mov / webm / flv / ts 等都会列出）。<br>' +
          '去 <b>文件夹</b> 页换个目录，或打开「连子文件夹一起扫」。';
      /* 空态也是「可显示的结果」→ 同样要放掉启动动画。
         不放的话，没配片源的新用户会一直卡在启动动画上，等满 6 秒兜底超时才进去。 */
      splashReady();
      return;
    }
  } catch (e) {
    showLoading(false);
    main.clear();
    $('emptyView').hidden = false;
    $('emptyTitle').textContent = '读取失败';
    $('emptyDesc').textContent = friendlyNetErr(e.message);
    splashReady();   // 失败态也要揭幕，别让启动动画盖住错误提示
  }
}

/* ------------------------------ 设置表单 ------------------------------ */
function updateDirText() {
  const el = $('cfDirText');
  if (!el) return;
  const list = srcList();
  // 没登录就别催人挑文件夹 —— 这是两步流程里最容易踩的措辞坑
  if (!S.loggedIn) { el.textContent = '先登录，再选文件夹'; return; }
  el.textContent = list.length
    ? `已加 ${list.length} 个文件夹：${list.map((d) => pathName(d)).join('、')}`
    : '还没加文件夹，点这里去挑';
}

/** 设置页里那份「当前片源」清单（只读，增删都在「文件夹」页里做） */
function renderCfDirs() {
  const box = $('cfDirs');
  if (!box) return;
  const list = srcList();
  if (!list.length) { box.innerHTML = '<div class="cf-dir-empty">还没有片源。点上面进「文件夹」页，用 ＋ 加入。</div>'; return; }
  box.innerHTML = list.map((d) => `<div class="cf-dir">
    <span class="cfd-ic">${IC.folder}</span>
    <span class="cfd-name">${escapeHtml(pathName(d))}</span>
    <span class="cfd-path">${escapeHtml(d)}</span>
  </div>`).join('')
    + `<button class="btn ghost cf-dir-go" id="cfGoBrowse">去「文件夹」页增删片源</button>`;
  const go = $('cfGoBrowse');
  if (go) go.addEventListener('click', () => { closeSheet(); B.path = ''; setNav('browse'); });
}

/**
 * .strm 自动库的「监控文件夹」清单（2026-09-20）。
 *
 * 🔴 **2026-09-20 二次改版（用户拍板「B 完全开放」）**：
 *    数据源从 `srcList()`（第 3 步的片源子集）**改成 `S.config.strmJobs` 本身** ——
 *    监控清单现在是一份**独立清单**，可以放 CD2 根目录下任意文件夹，不再受片源约束。
 *    勾选态也随之简化：**在清单里就是勾上的**，不需要再跟片源取交集比对。
 *
 * ⚠️ 因此调用点也变了：以前必须盯住「片源变了要重画」，现在**片源变化与它无关**。
 *    真正需要重画的只剩两处（都在设置页内部，配置就位/改动之后）：
 *      · fillConfigForm()  —— 打开设置页时按 S.config 画一次
 *      · 清单自身的增/删动作  —— 改完 S.config.strmJobs 立刻重画
 *    历史坑（2026-09-20 上午）是「在文件夹页加了片源，回第 4 步看不见」——
 *    那是旧模型的 bug，现在清单不再耦合片源，这个坑自然不存在了。
 */
function renderStrmJobs() {
  const box = $('cfStrmJobs');
  if (!box) return;
  const jobs = (S.config && S.config.strmJobs) || [];
  if (!jobs.length) {
    box.innerHTML = '<div class="cf-dir-empty">还没有监控文件夹 —— 点下面「＋ 添加文件夹」挑一个。</div>';
    return;
  }
  /* ⚠️ 这里是**纯展示行**，不带 checkbox 了：
     清单本身就是「要监控的集合」，删 = 点 ✕ —— 比「勾选框 + 还要记得保存」少一层心智。
     （旧版的 checkbox 是为了在「片源全集」里挑子集，现在没有全集了，勾选框就没意义了。） */
  box.innerHTML = jobs.map((d) => `<div class="cf-dir strm-job">
    <span class="cfd-ic">${IC.folder}</span>
    <span class="cfd-name">${escapeHtml(pathName(d))}</span>
    <span class="cfd-path">${escapeHtml(d)}</span>
    <button class="sj-del" data-sjdel="${escapeHtml(d)}" title="不再监控这个文件夹">✕</button>
  </div>`).join('');
}

/** 把 /api/strmjob 的状态画到设置页那一行（st 为 null 时收起） */
function renderStrmStatus(st) {
  const el = $('cfStrmStatus');
  if (!el) return;
  if (!st || (!st.running && !st.lastRunAt && !st.lastError)) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'cf-status ' + (st.failed ? 'bad' : 'ok');
  const t = st.lastRunAt ? new Date(st.lastRunAt).toLocaleString() : '还没跑过';
  /* 「太小 N」（2026-09-22 体积阈值）：只在真跳过过时才拼进去，
     那行本来就长，没必要塞一个恒为 0 的项。 */
  const tooSmall = Number(st.minSkipped) > 0 ? ` / 太小 ${st.minSkipped}` : '';
  let line = st.running
    ? `⏳ 正在生成… ${st.done}/${st.total}（新增 ${st.added} / 跳过 ${st.skipped}${tooSmall} / 失败 ${st.failed}）`
    : `上次生成：${t} · 新增 ${st.added} / 跳过 ${st.skipped}${tooSmall} / 失败 ${st.failed} / 共 ${st.total}`;
  /* 「新增 0」不说人话的修复（2026-09-20 用户拍板「改进」）：
     文件全部命中 manifest 被跳过时，原来那行只有「新增 0 / 跳过 N / 失败 0 / 共 N」——
     用户看到「新增 0」只会以为「又没生成出来」（真实案例就这么报的障）。
     追加一句直白结论：这是**设计行为**（增量扫描，生成过的不重复劳动），不是故障。
     ⚠️ 只在「没在跑 & 没失败 & 确实扫到过文件(total>0) & 一个都没新增」时才说 ——
        运行中 / 有失败 / 压根没文件(total=0) 都不说，别跟别的结论打架。 */
  if (!st.running && !st.failed && st.total > 0 && !st.added) {
    /* ⚠️ 加了体积阈值之后「新增 0」还可能是「全被阈值挡了」——
       那种情况一定要说清，否则又变成一次「又没生成出来」的误会。 */
    line += Number(st.minSkipped) > 0
      ? ` · ${st.minSkipped} 个小于设定体积被跳过，其余都已生成过`
      : ' · 都已生成过，没有新文件';
  }
  if (st.stale && !st.running) line += ' · 定时扫描已过期，下次打开 App 会自动补跑';
  /* ⚠️ 这里原来还有一句「本地目录没拿到所有文件访问权限，点授权存储」——
     2026-09-20 二次改版后写的是 App 自己的目录，**免授权**，那句永远不成立，已删。
     （后端的 permOk 字段也一起没了。） */
  if (st.lastError) line += `<br>⚠️ ${escapeHtml(st.lastError)}`;
  el.innerHTML = line;
}

/** 拉一次 strm 任务状态（老后端没有这个接口时静默忽略 —— 别在设置页弹错误） */
async function refreshStrmStatus() {
  try {
    const st = await api.strmJob(false);
    renderStrmStatus(st);
    /* 后端回报的固定目录拿来**只读展示** —— 这样「存哪了」是后端说了算，
       前端不 hardcode 路径（那边可能退到 filesDir，见 NasServer.strmLocalDir）。 */
    const el = $('cfStrmLocalText');
    if (el && st && st.local) el.textContent = st.local;
  } catch (e) { /* ignore */ }
}

function fillConfigForm() {
  const c = S.config || {};
  $('cfUrl').value = c.url || '';
  $('cfUser').value = c.user || '';
  $('cfPass').value = '';
  $('cfPass').placeholder = S.hasPass ? '已保存，留空则不修改' : '可留空';
  $('cfRecursive').checked = c.recursive !== false;
  /* 深度：0 = 不限（默认）。
     ⚠️ 原来是 `c.maxDepth || 4` —— 那个 `|| 4` 会把**合法的 0（不限）当成没设置**
     再兜回 4，于是「不限」永远存不下来。0 是有效值，必须先判 null / undefined。 */
  const dp = $('cfDepth');
  dp.value = String(c.maxDepth == null ? 0 : c.maxDepth);
  if (dp.value !== String(c.maxDepth == null ? 0 : c.maxDepth)) dp.value = '0';  // 不在档位里 → 回落「不限」
  /* 「屏蔽小文件」读的是 localStorage（S.minSizeMB），**不是** S.config ——
     它不走 /api/config，见 index.html 里 #cfMinSize 那块的注释。
     ⚠️ 必须兜底成字符串 '0'：万一存进去的是个不在档位里的值（比如以后改了档位），
        `select.value = 999` 会让 select 停在空白项，看着像没设置成功。 */
  const ms = $('cfMinSize');
  ms.value = String(S.minSizeMB || 0);
  if (ms.value !== String(S.minSizeMB || 0)) ms.value = '0';   // 不在档位里 → 回落到「不屏蔽」
  // （原来这里回填 `$('cfPlayable').checked = c.playableOnly !== false` ——
  //   那个开关 2026-09-18 删了，片库固定只列能直接播的格式。见 index.html 注释。）
  document.querySelectorAll('#fitSeg button').forEach((b) => b.classList.toggle('active', b.dataset.fit === (c.fit || 'contain')));
  // 已经连过（有地址、且存过密码 / 扫出过片源）就直接把第二步放出来，
  // 免得每次进设置页都要重新点一次「登录」。
  setPicked(!!c.url && (S.hasPass || srcList().length > 0));
  updateLoginBtn();
  updateDirText();
  renderCfDirs();
  /* ---- .strm 自动库回填（2026-09-20）----
     监控清单要在 S.config 就位后画；顺手拉一次任务状态，
     让「上次生成到哪了 / 有没有失败 / 存哪了」打开设置页就能看到。
     🔴 2026-09-20 二次改版后这里**不再回填任何输入框** —— 输出位置固定（只读，
     由 refreshStrmStatus 从后端拿），监控清单走 renderStrmJobs（无勾选框）。 */
  const se = $('cfStrmEvery');
  se.value = String(c.strmIntervalH == null ? 0 : c.strmIntervalH);
  if (se.value !== String(c.strmIntervalH == null ? 0 : c.strmIntervalH)) se.value = '0';  // 不在档位 → 仅手动
  // 体积阈值（2026-09-22）：老后端不带这个字段 → 回填 0（不限制），别显示 NaN
  $('cfStrmMinSize').value = String(Math.max(0, Math.floor(Number(c.strmMinSizeMB) || 0)));
  renderStrmJobs();
  refreshStrmStatus();
  $('cfStatus').hidden = true;
  updateFfmpegLine();
}

/**
 * 第二步（选文件夹）的显隐。
 * 登录成功前整块隐藏 —— 这正是「不要一挂载就逼人选文件夹」的落点。
 */
function setPicked(on) {
  S.loggedIn = !!on;
  const box = $('stepPick');
  if (box) box.hidden = !on;
  // .strm 自动库（第 4 步）跟第二步同一命运：登录成功才出现 ——
  // 没连上服务器时摆出来只会让人对着空的片源清单发呆。
  const strm = $('stepStrm');
  if (strm) strm.hidden = !on;
}

/**
 * 更新「登录」按钮的样子：登录成功后变成可点的「已登录，重新登录」。
 * 不改成 disabled —— 换个账号/改完密码还得能重登。
 */
function updateLoginBtn() {
  const b = $('cfLogin');
  if (!b) return;
  b.textContent = S.loggedIn ? '✓ 已登录 · 重新登录' : '登录';
  b.classList.toggle('ghost', !!S.loggedIn);
  b.classList.toggle('primary', !S.loggedIn);
}

function formValues() {
  const fit = document.querySelector('#fitSeg button.active')?.dataset.fit || 'contain';
  return {
    url: $('cfUrl').value.trim(),
    user: $('cfUser').value.trim(),
    pass: $('cfPass').value,
    dir: S.config.dir || S.currentDir || '',
    recursive: $('cfRecursive').checked,
    /* ⚠️ 同理：`|| 4` 会把「不限」（0）冲掉，必须显式判 null。 */
    maxDepth: Number($('cfDepth').value),
    // `playableOnly` 不再提交 —— 已废弃，片库固定只列 BROWSER_EXTS（见 index.html 注释）
    fit,
    nickname: S.config.nickname || 'NAS 影迷',
    /* ---- .strm 自动库（2026-09-20）----
       🔴 二次改版后 strmJobs **不再从 DOM 收集** —— 清单是独立数组（S.config.strmJobs），
          增删都直接改它并即时落盘（见 addStrmJob / removeStrmJob），跟「保存并开始刷」
          这条提交路径解耦。这里只提交间隔。
       🔴 strmOut / strmLocal 也不再提交：输出位置固定（后端 strmLocalDir()），
          用户没得填，后端也不收（收到会忽略）。 */
    strmIntervalH: Number($('cfStrmEvery').value),
    /* 体积阈值（2026-09-22 用户要求「小于设定大小跳过生成」）。
       ⚠️ 空 / 清空 / 非数字 / 负数一律按 0（不限制）—— 直接把输入框的值发上去的话，
          用户清空时会发 NaN，后端 JSON 里就成了 null，反而可能被当成别的意思。 */
    strmMinSizeMB: Math.max(0, Math.floor(Number($('cfStrmMinSize').value) || 0)),
  };
}

function setStatus(html, ok) {
  const el = $('cfStatus');
  el.hidden = false;
  el.className = 'cf-status ' + (ok ? 'ok' : 'bad');
  el.innerHTML = html;
}

$('fitSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-fit]');
  if (!b) return;
  $('fitSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
  phone.dataset.fit = b.dataset.fit;
});

/* 「屏蔽小文件」：change 时**立刻**重算并重建信息流，不点保存、也不重扫。
   ⚠️ 用 'change' 而不是 'input' —— 下拉在 Android 上是原生弹窗，
      'input' 会在弹窗里上下划的时候就连续触发，每一下都重建一遍列表。 */
$('cfMinSize').addEventListener('change', (e) => {
  applyMinSize(e.target.value);
});
/** 保存当前表单（不扫描），返回是否成功 */
async function persistConfig() {
  const v = formValues();
  const r = await api.saveConfig(v);
  S.config = { ...S.config, ...v, pass: '' };
  S.hasPass = !!r.hasPass;
  phone.dataset.fit = v.fit;
  return v;
}

/* ---- 第一步：登录 ----
 * 2026-09-18 改版。以前这里是「浏览 NAS 目录…」，点一下**先存配置、再立刻跳去
 * 「文件夹」页**逼人挑目录 —— 一旦服务器密码改不了、旧挂载又删不掉，人就被卡死
 * 在那个页面里出不来。现在拆成两步，这里只管**登录**：
 *   ① 先校验地址格式；② 存下这组凭据；③ 真连一次服务器（/api/test）；
 *   ④ 连上了才展开第二步（选文件夹），连不上只报错，绝不跳页。
 */
$('cfLogin').addEventListener('click', async () => {
  const url = $('cfUrl').value.trim();
  if (!url) return setStatus('请先填写服务地址，例如 http://192.168.1.100:5005', false);
  if (!/^https?:\/\//i.test(url)) return setStatus('地址要以 http:// 或 https:// 开头', false);
  $('cfLogin').disabled = true;
  setStatus('正在连接服务器…', true);
  try {
    // 先把这组凭据落到后端，否则 /api/test 用的还是上一次的旧配置
    await persistConfig();
    // 真正连一次：不带 dir，让后端用它自己算出来的根目录去 PROPFIND。
    // 这样即使旧的 dirs 里有已失效/删不掉的挂载，也不影响「登录」这一步。
    const r = await api.test({ url, user: $('cfUser').value.trim(), pass: $('cfPass').value, dir: '' });
    if (!r.ok) {
      // 登录失败：保持第二步关闭，明确告诉人问题在凭据/网络，而不是让他去挑目录
      setPicked(false);
      updateLoginBtn();
      /* ⚠️ **不能**写成 `return setStatus(...)` —— 那会跳过下面 finally 里恢复按钮的动作，
         把「登录」按钮**永久卡在 disabled**，用户只能重启 App 才能再点一次。
         2026-09-19 实际踩到：内置网盘第一次连（存储还没配）必然失败一次，正好撞上。 */
      setStatus('❌ 登录失败：' + (r.error || '连不上服务器'), false);
      return;
    }
    S.demoMode = false;
    S.mode = 'webdav';
    // 登录成功后把后端算出来的真实根路径记下来，「文件夹」页就从这里起步
    S.currentDir = r.path || '';
    S.verifiedDir = r.path || '';
    setPicked(true);
    updateLoginBtn();
    updateDirText();
    renderCfDirs();
    renderStrmJobs();     // 第 4 步清单（独立清单，登录后才拉得到配置）
    setStatus(`✅ 已登录：${r.path || url}\n这个目录下有 ${r.dirs} 个子文件夹、${r.vids} 个视频\n`
      + '下面第 3 步里挑要刷的文件夹。', true);
  } catch (e) {
    setPicked(false);
    updateLoginBtn();
    setStatus('❌ ' + friendlyNetErr(e.message), false);
  } finally {
    /* 🔴 收尾必须放 finally —— 任何 return / 异常路径都不能把按钮留在 disabled 上。
       （上面那个失败分支原来写的是 `return setStatus(...)`，正好把它跳过去了。） */
    $('cfLogin').disabled = false;
  }
});

/* ---- 内置 CloudDrive2 引擎一键填地址 ---- */
$('cfCd2').addEventListener('click', () => {
  $('cfUrl').value = 'http://127.0.0.1:19798/dav';
  setStatus('已填内置 CloudDrive2 引擎地址。账号密码填你的 CD2 登录账号，点「登录」', true);
});

/* ---- 进「文件夹」页挑目录 ----
 * 关键区别：**不再自动跳转**。只有人自己点了这个按钮才进去，
 * 而且进去时用的是登录时拿到的根路径，不是一个空的 B.path。 */
$('cfBrowse').addEventListener('click', async () => {
  if (!S.loggedIn) return setStatus('请先点上面的「登录」连上服务器', false);
  $('cfBrowse').disabled = true;
  try {
    await persistConfig();
    closeSheet();
    // 起步点交给 freshStartPath 统一决定（它会避开磁盘上那条可能已失效的 dir）
    B.path = freshStartPath();
    setNav('browse');
  } catch (e) {
    setStatus('❌ ' + friendlyNetErr(e.message), false);
  }
  $('cfBrowse').disabled = false;
});

/* ---- 测试当前填的地址能不能连上 ---- */
$('cfTest').addEventListener('click', async () => {
  const url = $('cfUrl').value.trim();
  if (!url) return setStatus('请先填写服务地址，例如 http://192.168.1.100:5005', false);
  setStatus('正在连接…', true);
  $('cfTest').disabled = true;
  try {
    const r = await api.test({
      url,
      user: $('cfUser').value.trim(),
      pass: $('cfPass').value,
      dir: S.config.dir || S.currentDir || '',
    });
    if (r.ok) {
      S.verifiedDir = r.path || '';      // 探通了 → 这个路径是真实存在的，可以当浏览起点
      setStatus(`✅ 连接成功！\n${r.path}\n这个目录下有 ${r.dirs} 个子文件夹、${r.vids} 个视频\n${
        r.entries.length ? '例如：' + r.entries.slice(-4).join('、') : '（目录是空的）'}`, true);
    } else {
      setStatus('❌ ' + r.error, false);
    }
  } catch (e) {
    setStatus('❌ ' + friendlyNetErr(e.message), false);
  }
  $('cfTest').disabled = false;
});

/**
 * 画「格式支持」那一行小字。
 *
 * ⚠️ 这里要说的是**这台设备的真实能力**，别再提任何「解码服务 / 转码服务器」——
 *    2026-09-18 起 APK 自包含，没有一个可以填地址的外部转码服务了。
 *
 *    能播什么完全取决于系统原生解码器：
 *      · mp4 / mov / webm（H.264 / H.265 / VP8 / VP9 / AV1）→ 直接播；
 *      · avi / wmv / rmvb 这类容器系统解不了 → **扫描阶段就标灰**，
 *        连点都点不进去（/api/probe 会如实回「读不出时长」）。
 *    宁可一开始就说不支持，也不要装成能播、点进去转半天才失败。
 */
function updateFfmpegLine() {
  const ff = $('cfFfmpeg');
  if (!ff) return;
  ff.textContent = S.ffmpeg
    // 理论上到不了这一支（后端恒上报 ffmpeg=false），留着是为了兼容 Node 版后端 ——
    // 那一版还真的可以内嵌 ffmpeg 转码，同一个前端要伺候两个后端。
    ? '格式支持：已开启转码 —— avi / wmv / mkv / flv / rmvb 会自动边转边播'
    : '格式支持：本机直接播放 —— mp4 / mov / webm 等系统能解的格式'
      + '；avi / wmv / rmvb 这类封装系统解不了，会被标灰不能播。'
      + (S.ffmpegReason ? '（' + S.ffmpegReason + '）' : '');
}

/* ---- 保存并用当前目录开始刷 ---- */
$('cfSave').addEventListener('click', async () => {
  const url = $('cfUrl').value.trim();
  if (!url) return setStatus('请先填写 NAS 的 WebDAV 地址', false);
  if (!/^https?:\/\//i.test(url)) return setStatus('地址要以 http:// 或 https:// 开头', false);
  // 没登录就不给「开始刷」——否则又是把没连上的配置推去扫描，报一堆看不懂的错
  if (!S.loggedIn) return setStatus('请先点上面的「登录」连上服务器，再挑文件夹', false);
  $('cfSave').disabled = true;
  setStatus('正在保存并扫描…', true);
  try {
    await persistConfig();
    S.demoMode = false;
    S.mode = 'webdav';
    closeSheet();
    await loadLibrary(true);
    if (S.videos.length) toast(`扫描完成，共 ${S.videos.length} 个视频`);
    else toast('这个文件夹里没有视频，去「目录」页换一个', 2800);
    updateDirText();
  } catch (e) {
    setStatus('❌ 保存失败：' + friendlyNetErr(e.message), false);
  }
  $('cfSave').disabled = false;
});

/* ---- .strm 自动库：监控文件夹清单的增删（2026-09-20 二次改版）----
 *
 * 🔴 为什么这里**不走**「保存并开始刷」那条提交路径：
 *    监控清单是**独立清单**，跟片源/片库无关，改它没必要重扫片库。
 *    所以增删都直接 POST /api/config（只落盘、不扫描）—— 跟 toggleSkip 同一套思路，
 *    用户点一下「✕」立刻生效，不用回头再点一次保存。
 *   ⚠️ 别改成 /api/sources：那会顺手起一次后台全量扫描（实测十几分钟）。
 */
async function saveStrmJobs(next, tip) {
  try {
    const r = await api.saveConfig({ strmJobs: next });
    S.config = { ...S.config, ...(r.config || {}), strmJobs: next };
    renderStrmJobs();
    if (tip) toast(tip, 2200);
  } catch (e) {
    toast('保存失败：' + friendlyNetErr(e.message), 3200);
  }
}

function addStrmJob(dir) {
  if (!dir) return;
  const cur = (S.config && S.config.strmJobs) || [];
  if (cur.includes(dir)) return toast('这个文件夹已经在清单里了');
  return saveStrmJobs([...cur, dir], `已加入监控：${pathName(dir)}`);
}

function removeStrmJob(dir) {
  const cur = (S.config && S.config.strmJobs) || [];
  if (!cur.includes(dir)) return;
  const next = cur.filter((d) => d !== dir);
  return saveStrmJobs(next, `已不再监控：${pathName(dir)}`);
}

/* 清单行的 ✕（事件委托 —— 行是 renderStrmJobs 随时重画的，别绑在行上）
 *
 * 🔴 两步删除（2026-09-20 用户拍板「改进」）：第 4 步里 ✕ 和「＋ 添加」挨着，
 *    误触一下整个监控目录就没了，而且原来**没有任何二次确认** —— 真机踩过：
 *    15:00 那轮扫描还在跑，清单里的 boki 被点掉（误触还是手滑已无法区分），
 *    之后扫什么都只剩云下载，症状是「strm 生成不出来了」。
 *    所以第一下只进入「确认？」态，再点一下才真删。
 *   ⚠️ 为什么不用原生 confirm()：WebView 没实现 onJsConfirm，对话框会
 *      **静默返回取消**（prompt()/confirm() 黑洞，见本文件开头的注释区），
 *      页面内交互才稳。
 *   ⚠️ 武装态存在 **DOM class** 上，不放模块级游标：renderStrmJobs 随时会
 *      重画整份清单，游标指的那一行可能已经没了；class 跟着行走，行没了自然失效。
 *   ⚠️ 3.2 秒不点就自动收回（sjDisarm），别让「确认？」赖在屏上误导人。
 */
let sjArmTimer = 0;
function sjDisarm() {
  clearTimeout(sjArmTimer);
  sjArmTimer = 0;
  document.querySelectorAll('#cfStrmJobs .sj-del.armed').forEach((b) => {
    b.classList.remove('armed');
    b.textContent = '✕';
  });
}
$('cfStrmJobs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sjdel]');
  if (!b) return;
  if (b.classList.contains('armed')) {
    sjDisarm();
    removeStrmJob(b.dataset.sjdel);
    return;
  }
  sjDisarm();                 // 同一时刻只允许一个行处于「确认？」态
  b.classList.add('armed');
  b.textContent = '确认？';
  toast('再点一次「确认？」才停止监控', 2600);
  clearTimeout(sjArmTimer);
  sjArmTimer = setTimeout(sjDisarm, 3200);
});

/* ---- strm 备份 / 换机（2026-09-20，用户要素「方便我备份和换机」）----
 *
 * 内容（完整备份）：`.strm` 全部文件 + 增量索引（manifest）+ 监控清单 + 扫描间隔。
 *   · 只导 .strm 的话，换机后要重新加监控清单，而且首轮会把 5000+ 个文件全部重写
 *     （实测 9.5 分钟）——带上索引就没这一步。
 *   · `.strm` 内容里的 `local:/` 前缀是**相对 strm 根**的，所以文件原样搬过去即可。
 *
 * 导出：APK 交给原生写「下载」目录（网页没有那个权限，见 MainActivity.exportStrmBackup）；
 *      网页版直接让浏览器下载同一个接口。
 * 导入：系统文件选择器（WebView 的 Chrome.onShowFileChooser 已经接住 <input type=file>，
 *      换头像走的就是它），选到的 File 当 body 直接 POST 给 /api/strm/restore。
 *
 * ⚠️ 导入完必须把 S.config 同步掉：后端可能补进了监控项/间隔，而设置页只读内存 config ——
 *    不同步的话用户随手再点一下 ✕/添加，就会把刚补进来的清单覆盖回去（见 §60.7 那个坑）。
 */
function exportStrmBackup() {
  if (window.NasBridge && window.NasBridge.exportStrm) {
    toast('正在打包备份…', 4000);
    try { window.NasBridge.exportStrm(); } catch (e) { toast('导出失败：' + e.message, 3600); }
    return;
  }
  const a = document.createElement('a');       // 网页版：走浏览器下载
  a.href = '/api/strm/backup';
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('已开始下载备份 zip', 2600);
}

/** 原生导出完成回调（成功失败都会来一次，别让「正在打包…」一直悬着） */
window.__strmExportDone = function (payload) {
  let r = payload;
  try { if (typeof r === 'string') r = JSON.parse(r); } catch (_) { r = null; }
  if (!r || !r.ok) return toast('导出失败：' + ((r && r.err) || '未知错误'), 4000);
  toast(`已导出 ${r.files} 个文件 → ${r.where}`, 4200);
  const el = $('cfStrmBkNote');
  if (el) {
    el.textContent = `上次导出：${r.where}（${r.files} 个文件）。`
      + '换机时把这个 zip 复制到新手机，装好 App、填好服务地址后点「导入备份」选它即可'
      + '（片源与监控清单会一起补上，也不用重扫）。';
  }
};

$('cfStrmExport').addEventListener('click', exportStrmBackup);
$('cfStrmImport').addEventListener('click', () => $('cfStrmBkFile').click());
$('cfStrmBkFile').addEventListener('change', async () => {
  const inp = $('cfStrmBkFile');
  const f = inp.files && inp.files[0];
  inp.value = '';                       // 清掉，下次选同一个文件也能触发 change
  if (!f) return;
  toast('正在导入备份…', 4000);
  try {
    const r = await api.strmRestore(f);
    const fi = r.files || {}, mf = r.manifest || {}, jb = r.jobs || {};
    if (jb.now) {
      S.config = { ...S.config, strmJobs: jb.now.slice() };
      if (typeof jb.intervalH === 'number') S.config.strmIntervalH = jb.intervalH;
      renderStrmJobs();
      refreshStrmStatus();
    }
    /* 🔴 备份里带了片源 → 必须**重扫片库**，否则新机上「片源补回来了、首页还是空的」
       （用户看到的就是「导了备份却什么都没有」）。重扫走 applySources 那条既有路径：
       它会把扫描丢后台 + 用 peek 轮询等结果，不会把界面闪成空。
       ⚠️ 必须在拼提示文案之前调，这样 toast 里能带上「片源补了几个」。 */
    if (jb.dirs && (jb.dirsAdded || []).length) {
      await applySources(jb.dirs.slice(), null);
    } else {
      /* 同 syncPullStrm：本机片源 local:/ 常常早就在 dirs 里了 → dirsAdded 为空，
         但文件是刚导进来的，片库必须重扫，否则导完首页还是空的。 */
      refreshDemoMode();
      await loadLibrary(true);
    }
    const parts = [`回填 ${fi.added || 0} 个 .strm`];
    if (fi.skipped) parts.push(`跳过已有的 ${fi.skipped} 个`);
    if (mf.added) parts.push(`索引补 ${mf.added} 条`);
    if ((jb.added || []).length) parts.push(`监控清单补 ${jb.added.length} 个目录`);
    if ((jb.dirsAdded || []).length) parts.push(`片源补 ${jb.dirsAdded.length} 个（正在重扫片库）`);
    if (fi.rejected) parts.push(`拒绝 ${fi.rejected} 条可疑路径`);
    /* 🔴 导完片源还是空的 → 必须说清下一步做什么（2026-09-20 晚）。
     * 老备份里没有片源字段，光报「回填 N 个 .strm」用户看不出「那我现在能看片了吗」——
     * 他报的原话就是「导入备份不生效」。后端已经会兜底把本机片源补回去（只要 strm
     * 目录里真有文件），这里兜的是「备份里连一个 .strm 都没有」那种空包。 */
    if (!(jb.dirs || []).length) {
      parts.push('但备份里没带任何片源，得去「文件夹」页用 ＋ 挑一个');
    }
    toast('导入完成：' + parts.join(' · '), 5000);
    const el = $('cfStrmBkNote');
    if (el) el.textContent = '上次导入：' + parts.join(' · ') + '（已存在的文件不覆盖）';
    /* 这份备份是从**本地文件**导进来的（不是从账号拉的），库确实变了 →
       顺手推一份到账号，否则「本机导好了」和「账号里是新的」是两件事。
       ⚠️ 这里**不能**像 syncPullStrm 那样把 r.rev 记成「已备份」—— 那样就永远不推了。 */
    await syncPushStrmIfStale();
  } catch (e) {
    toast('导入失败：' + friendlyNetErr(e.message), 4200);
  }
});

/* ---- 清空本机 strm 库（2026-09-22 用户要求）----
 *
 * 🔴 两步确认，跟「停止监控」那套一致：**不能**用原生 confirm() ——
 *    WebView 没实现 onJsConfirm，它会**静默返回取消**（点了没反应比没这个按钮还糟）。
 *
 * ⚠️ 只删本机（.strm + 增量索引 + 摘掉 `local:/` 片源），**账号里的备份包一个字节都不动**
 *    —— 那是别的设备换机恢复用的，本按钮不该碰。
 *    所以清完**必须把本机记录的版本号跟到新值**：让心跳判定成「没变过」，
 *    不去触发自动备份。否则会把一个**空备份**推上去，等于顺手把云端那份也清了。
 */
let strmClearArm = 0;
function strmClearDisarm() {
  clearTimeout(strmClearArm);
  strmClearArm = 0;
  const b = $('cfStrmClear');
  if (b) { b.classList.remove('armed'); b.textContent = '清空本机 strm 库'; }
}
$('cfStrmClear')?.addEventListener('click', async () => {
  const b = $('cfStrmClear');
  if (!b) return;
  if (b.classList.contains('armed')) {
    strmClearDisarm();
    try {
      showLoading(true, '正在清空…');
      const r = await api.strmClear();
      /* 跟到新版本号 → 心跳判定「没变过」→ 不会把空备份推上账号 */
      if (r && r.rev != null) { SY.strmRev = Number(r.rev); SY.save(); }
      await loadLibrary(true);
      refreshStrmStatus();
      toast(`已清空 ${(r && r.files) || 0} 个 .strm`, 3200);
      if (SY.loggedIn()) {
        toast('注意：账号里的备份还在，下次同步会自动恢复 —— 想彻底清除请点「删除云端备份」', 5000);
      }
    } catch (e) {
      toast('清空失败：' + friendlyNetErr(e.message), 3600);
    } finally {
      showLoading(false);
    }
    return;
  }
  const n = (S.allVideos || []).filter((v) => String(v && v.p).indexOf('local:') === 0).length;
  strmClearDisarm();
  b.classList.add('armed');
  b.textContent = n ? `确认删 ${n} 个？` : '确认清空？';
  toast('再点一次才真清空（只删本机，不动账号备份）', 3200);
  strmClearArm = setTimeout(strmClearDisarm, 4000);
});

/* =====================================================================================
 *  多设备同步（账号系统）—— 2026-09-20 用户需求
 * =====================================================================================
 *  多台设备登同一个账号：点赞 / 收藏 / 坏码流名单 / 头像昵称 / 片源与监控清单 自动对齐；
 *  strm 备份包也能存进账号，新设备登录后自动恢复（换机不用再手动导 zip）。
 *
 *  🔴 这一整块是**可选**的：没登录时一行都不跑，数据仍然只在本机 ——
 *     和「本机写入、离线可用」的既有设计不冲突（同步只是多了一条对外的路）。
 *  🔴 前端**直接连 NAS 上那个服务端**（不经过本机的 8099），所以是跨域请求 ——
 *     服务端那边只对 /api/auth 与 /api/sync 开了 CORS（见 server.js 里那段说明）。
 *
 *  ⚠️ 真相只有一个：**本机 state 仍然是权威**（播放、计数、离线全读它）。
 *     拉回来的数据先合进本机、再写回本机服务端；反过来（让远端当真相）会让
 *     没网的设备直接变成空壳。
 *
 *  ⚠️「取消收藏」怎么同步：本机是 `delete S.favorites[id]`，删完就没痕迹了 ——
 *     只发「我现在有什么」的话，对方永远看到旧的还在。所以这里留一份**上次同步快照**
 *     （`SY.snap`），用「快照里有、现在没有」diff 出墓碑 `{t, del:true}` 再推；
 *     服务端保留墓碑并按时间戳判胜负（见 syncMergeMap）。
 */
const SYNC_LS = 'sync';

/* 🔒 内置的默认同步服务器地址（2026-09-23 用户要求：「不用每次都手输」）。
   本机没存过地址时（首装 / 清过数据 / 退出登录后）自动带出来填进「账号与同步」表单；
   用户仍可在那里改成别的 —— 这里只是**回退值**，存过的地址永远优先（见下面的 SY.load），
   不会把用户改过的地址冲掉。App 和网页版共用这一份 app.js，所以两边都会带上。
   ⚠️ 这是本机私用地址：**推到公开仓库前必须脱敏**（规则已加进 _tmp/scrub.js），
      否则等于把自家服务器地址公开。别人自建时把这一行改成自己的地址即可。 */
const SYNC_URL_DEFAULT = 'http://192.168.1.100:8099';

const SY = {
  url: '', user: '', token: '', auto: true, lastAt: 0, snap: null, busy: false,
  /* 自动备份 strm 的防重入标志。**故意跟 busy 分开** —— busy 是「点赞收藏同步」的锁，
     两者共用的话，一次自动备份会把用户刚点的点赞挡在同步之外。 */
  strmPushing: false, strmPushNextAt: 0,
  /* 已备份到账号的「strm 库内容版本」（后端 /api/strmjob 的 rev）。
     🔴 2026-09-22 加：用户报「手机新生成的 strm 不会自动备份」——
     真因是上传那一侧压根没有自动触发点。有了这个值，前端就能判断
     「库自上次上传以来变过没有」，变了才自动重传（见 syncPushStrmIfStale）。
     值得存盘：不存的话每次开 App 都以为「没备份过」，会白传一遍几 MB 的备份。 */
  strmRev: -1,
  load() {
    const o = LS.get(SYNC_LS, null) || {};
    /* 空 → 用内置默认地址兜底；用户存过的地址（含「改回空」其实不存在，
       因为空会被这里补成默认）优先。 */
    SY.url = String(o.url || SYNC_URL_DEFAULT).replace(/\/+$/, '');
    SY.user = String(o.user || '');
    SY.token = String(o.token || '');
    SY.auto = o.auto !== false;
    SY.lastAt = Number(o.lastAt || 0);
    SY.snap = o.snap || null;
    /* ⚠️ 缺省 -1 而不是 0：0 是后端合法版本号（还没生成过任何 strm），
       拿 0 当「没记录」会让「刷过一轮但一条都没新增」也被判成变过。 */
    SY.strmRev = o.strmRev == null ? -1 : Number(o.strmRev);
  },
  save() {
    /* ⚠️ token **故意不进** strm 备份包：换设备本来就该重新登录一次，
       把凭据塞进那个要到处传的 zip 里等于随手散钥匙（和「备份不含账号密码」同一条原则）。 */
    LS.set(SYNC_LS, {
      url: SY.url, user: SY.user, token: SY.token,
      auto: SY.auto, lastAt: SY.lastAt, snap: SY.snap, strmRev: SY.strmRev,
    });
  },
  loggedIn() { return !!(SY.url && SY.token); },
};
SY.load();

/**
 * 调同步服务端。所有请求都带 Bearer；401 会顺手把本地 token 清掉
 * （不然会一直拿一个过期的 token 重试，用户只看到「同步失败」看不出为什么）。
 */
async function syncFetch(path, opt) {
  const o = opt || {};
  if (!SY.url) throw new Error('还没填同步服务器地址');
  const headers = {};
  if (SY.token) headers.Authorization = 'Bearer ' + SY.token;
  let body;
  if (o.raw) { body = o.raw; headers['Content-Type'] = o.ctype || 'application/octet-stream'; }
  else if (o.json !== undefined) { body = JSON.stringify(o.json); headers['Content-Type'] = 'application/json'; }
  let r;
  try {
    r = await fetch(SY.url + path, { method: o.method || 'GET', headers, body });
  } catch (e) {
    throw new Error('连不上同步服务器：' + friendlyNetErr(e && e.message ? e.message : '网络错误'));
  }
  if (o.binary) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.blob();
  }
  let j = null;
  try { j = await r.json(); } catch (_) {}
  if (r.status === 401) { SY.token = ''; SY.save(); syncRender(); throw new Error('登录已过期，请重新登录'); }
  if (!j || j.ok !== true) throw new Error((j && j.error) || ('HTTP ' + r.status));
  return j;
}

/** 本机坏码流名单（裸 key，不走 LS 封装 —— 见 BAD_KEY 那行的注释） */
function syncBadLocal() {
  try { return JSON.parse(localStorage.getItem(BAD_KEY) || '{}') || {}; } catch (_) { return {}; }
}

/**
 * 拼一份「本机现状 + 相对上次同步的删除」快照。
 *
 * 三类内容分开处理：
 *   · 点赞 / 收藏：形状是 `{path:{t}}`，**新增**和**重新点过（t 变了）**才发；
 *     快照里有、现在没有的 → 发墓碑。
 *   · 坏码流：本机存的是 `{path:1}`（没有 t），所以只能按「有没有」diff。
 *   · profile / sources：小、且每次都该是权威，直接全量带上（服务端那边是并集/覆盖）。
 */
/* 本机**最后一次改动** sources 各数组时发出去的时间戳（syncPayload 里填）。
   用途见 syncApply 里的 `srvNewer`：只有服务端的 T 比它新，才采用服务端的数组。
   故意**不持久化** —— 重启后归 0，语义是「下次同步听服务端的」（新服务端那边已经存了值）。
   ⚠️ 别改成持久化：那样本机一次旧改动会永远压着服务端，别的设备的改动就传不过来了。 */
let sentSrcT = {};

function syncPayload() {
  const now = Date.now();
  const snap = SY.snap || {};
  const diff = (cur, sp) => {
    /* 🔴 首次同步时 `SY.snap` 还是 null → `snap.likes` 是 **undefined**，
       而 `k in undefined` 会直接抛 TypeError（真机上实测到的：
       注册完第一次同步必定失败在「Cannot use 'in' operator … in undefined」）。
       所以这里必须兜一层空对象，别指望调用方一定传。 */
    const sk = sp || {};
    const out = {};
    for (const [k, v] of Object.entries(cur || {})) {
      if (v && v.del) continue;                                  // 本机不该存墓碑
      const t = (v && typeof v === 'object' && Number(v.t)) || 0;
      if (!(k in sk)) out[k] = { t: t || now };                   // 新增（老数据没 t 就补一个）
      else if (t && sk[k] !== t) out[k] = { t };                  // 本机重新点过
    }
    for (const k of Object.keys(sk)) {
      if (!(k in (cur || {}))) out[k] = { t: now, del: true };     // 本机删了 → 墓碑
    }
    return out;
  };
  const badCur = syncBadLocal();
  const badSp = snap.badStreams || {};
  const badOut = {};
  for (const k of Object.keys(badCur)) if (!(k in badSp)) badOut[k] = { t: now };
  for (const k of Object.keys(badSp)) if (!(k in badCur)) badOut[k] = { t: now, del: true };

  const cfg = S.config || {};
  /* 昵称/头像：**只在真的改过时才带**（并带上时间戳），否则一台没改过的设备
     同步一次就会把别的设备刚改的名字盖回旧值 —— 真机上实测到的：
     设备 B 改名成功，设备 A 一次普通同步就把它冲掉了。 */
  const pOld = snap.profile || {};
  const nick = cfg.nickname || 'NAS 影迷';
  const av = LS.get('avatar', '') || '';
  const prof = {};
  if (nick !== pOld.nickname) prof.nickname = nick;
  if (syncAvHash(av) !== pOld.avatarHash) prof.avatar = av;
  if (Object.keys(prof).length) prof.t = now;
  /* 片源 / 不重扫 / 监控清单：**只在「本机改过」时才带，并附一个时间戳**。
   *
   * 🔴 为什么必须带时间戳：服务端原来对这三个数组取**并集**，于是「删除」永远同步不出去 ——
   *    本机删掉一个监控文件夹，下一次同步就被账号里那份并回来
   *    （用户原话：「这个文件夹已经不需要监控了但是无法移除」）。
   *    现在服务端按「谁的时间戳新谁说了算」，所以「改过才带」是配套的另一半：
   *    **没改过的设备不带 T，就不会把别的设备的改动抢掉**。
   * ⚠️ 判断「改过没改过」的基准是**上次同步后的快照**（syncSnapNow 里记的），
   *    不是「和账号比」—— 后者在第一次同步时恒为「改过」，会把所有设备都变成抢的人。
   * ⚠️ 首次同步（快照还是空的）会把当前状态整体推上去，这是有意的：
   *    升级后第一台同步的设备 = 权威。 */
  const sOld = (snap.sources || {});
  const src = {};
  const sameArr = (a, b) => JSON.stringify((a || []).map(String)) === JSON.stringify((b || []).map(String));
  for (const k of ['dirs', 'skipDirs', 'strmJobs']) {
    if (!sameArr(cfg[k], sOld[k])) { src[k] = (cfg[k] || []).map(String); src[k + 'T'] = now; }
  }
  const ivH = Number(cfg.strmIntervalH) || 0;
  if (ivH !== (Number(sOld.strmIntervalH) || 0)) { src.strmIntervalH = ivH; src.strmIntervalHT = now; }
  // 体积阈值（2026-09-22）：跟间隔同一套「改过才带 + 附时间戳」规则
  const mvMB = Math.max(0, Math.floor(Number(cfg.strmMinSizeMB) || 0));
  if (mvMB !== (Number(sOld.strmMinSizeMB) || 0)) { src.strmMinSizeMB = mvMB; src.strmMinSizeMBT = now; }
  /* 记下「本机这次改动的时间戳」，syncApply 用它判断该不该采用服务端回的数组（见那边的注释） */
  sentSrcT = {};
  for (const k of ['dirs', 'skipDirs', 'strmJobs', 'strmIntervalH', 'strmMinSizeMB']) {
    if (Number(src[k + 'T']) > 0) sentSrcT[k] = Number(src[k + 'T']);
  }

  return {
    likes: diff(S.likes, snap.likes),
    favorites: diff(S.favorites, snap.favorites),
    badStreams: badOut,
    profile: prof,
    sources: src,
  };
}

/** 同步成功后重建快照（从**合并后的本机现状**取，不是从发出去的那份） */
function syncSnapNow() {
  const mk = (m) => {
    const o = {};
    for (const [k, v] of Object.entries(m || {})) o[k] = (v && Number(v.t)) || 0;
    return o;
  };
  SY.snap = {
    likes: mk(S.likes),
    favorites: mk(S.favorites),
    badStreams: mk(syncBadLocal()),
    /* ⚠️ 头像只存**采样哈希**不存原文：它是一段几百 KB 的 dataURL，
       快照里再放一份会让 localStorage 直接翻倍（还可能撞配额）。
       哈希是按步长采样算的 —— 「换了一张长度恰好相同、且采样位也一样的头像」
       理论上会漏判，但那种情况下另一台设备随便改一次就会覆盖过来，无害。 */
    profile: {
      nickname: (S.config || {}).nickname || 'NAS 影迷',
      avatarHash: syncAvHash(LS.get('avatar', '') || ''),
    },
    /* 片源 / 不重扫 / 监控清单 + 间隔：记下**这次同步之后的现状**，
       下次 syncPayload 拿它判断「本机改过没改过」——
       没改过就不带时间戳，也就不会去抢别的设备刚做的改动（见 syncPayload 的注释）。 */
    sources: {
      dirs: ((S.config || {}).dirs || []).map(String),
      skipDirs: ((S.config || {}).skipDirs || []).map(String),
      strmJobs: ((S.config || {}).strmJobs || []).map(String),
      strmIntervalH: Number((S.config || {}).strmIntervalH) || 0,
      strmMinSizeMB: Math.max(0, Math.floor(Number((S.config || {}).strmMinSizeMB) || 0)),
    },
  };
}

/** 头像字符串的采样哈希（够用来判断「改没改过」，且只有几十字节） */
function syncAvHash(s) {
  const str = String(s || '');
  let h = 0;
  for (let i = 0; i < str.length; i += 97) h = (h * 31 + str.charCodeAt(i)) | 0;
  return str.length + ':' + h;
}

const syncLive = (m) => {
  const out = {};
  for (const [k, v] of Object.entries(m || {})) if (!(v && v.del)) out[k] = v;
  return out;
};

/** 把服务端合并后的权威结果落到本机（内存 + 本机服务端 + 界面） */
async function syncApply(data) {
  if (!data) return false;
  S.likes = syncLive(data.likes);
  S.favorites = syncLive(data.favorites);
  const bads = syncLive(data.badStreams);
  try {
    const m = {};
    for (const k of Object.keys(bads)) m[k] = 1;
    localStorage.setItem(BAD_KEY, JSON.stringify(m));
  } catch (_) {}
  /* 批量写回本机服务端 —— 一次请求，不是几百次。
     ⚠️ 不写回去的话「同步完看着对、一刷新又回去了」：界面读的是内存，
        而刷新后是从本机服务端重新拉的。 */
  api.stateBulk({ likes: S.likes, favorites: S.favorites, badStreams: bads }).catch(() => {});

  let dirty = false;
  const pf = data.profile || {};
  if (pf.nickname && pf.nickname !== (S.config || {}).nickname) {
    S.config = { ...S.config, nickname: pf.nickname };
    /* 🔴 必须**写回本机服务端**：只改内存的话「我的」页当场看着对，
       可一刷新又变回旧名字（重启后读的是本机 config，那才是真相）。 */
    api.saveConfig({ nickname: pf.nickname }).catch(() => {});
    dirty = true;
  }
  if (pf.avatar && pf.avatar !== LS.get('avatar', '')) { LS.set('avatar', pf.avatar); dirty = true; }
  /* 昵称/头像变了要重画「我的」页 —— 否则得等下次切页才看得到新名字 */
  if (dirty) { try { renderMePage(); } catch (_) {} }

  /* 片源 / 不重扫 / 监控清单：**直接以服务端合并结果为准，本地不再并集**。
   *
   * 🔴 2026-09-21 修「监控文件夹删了又被加回来」。
   *    原来这里是 `uni(og.xxx, src.xxx)`（本机在前做并集），服务端也是并集 ——
   *    两头都只会加不会减，于是**删除永远表达不出来**：本机删掉 boki，下一次同步
   *    就被账号里那份并回来，用户看到的就是「这个文件夹无法移除」。
   *    现在服务端按时间戳取「最后改过的那份」，本地照单全收即可；
   *    本地再并一次等于把刚删掉的又拼回去。
   * ⚠️ 只在服务端**真的返回了**这个键时才动本机 —— 老服务端 / 首次同步可能不带。
   * ⚠️ 别再改回并集：并集在语义上就表达不了删除。 */
  const src = data.sources || {};
  const og = S.config || {};
  const sameArr = (a, b) => JSON.stringify((a || []).map(String)) === JSON.stringify((b || []).map(String));
  /* 采用服务端数组的前提：**服务端的时间戳比本机这次改动更新**（或本机这次没改）。
   *
   * 🔴 为什么要比时间戳，而不是无脑照单全收：
   *    「改同步协议」这件事有两半 —— App 端（这里）和 NAS 上的 `sync-server.js`。
   *    用户装上新 App 的那一刻，NAS 上那份多半还是旧的：旧服务端**会把 `xxxT`
   *    这些未知字段丢掉**，于是它回的数组仍然是并集结果（里面还躺着刚删掉的 boki）。
   *    无脑采用 = 「更新完 App 反而更删不掉」，比不改还糟。
   *    所以：服务端没带 T（= 旧服务端）就**不采用**，本机保持自己删过的样子 ——
   *    过渡期至少保证「本机删掉就是删掉了」。等 NAS 那份换好，T 就有了，删除才开始跨设备传播。 */
  const srvNewer = (k) => (Number(src[k + 'T']) || 0) > (Number(sentSrcT[k]) || 0);
  if (Array.isArray(src.strmJobs) && srvNewer('strmJobs') && !sameArr(src.strmJobs, og.strmJobs)) {
    S.config = { ...S.config, strmJobs: src.strmJobs.map(String) };
    api.saveConfig({ strmJobs: S.config.strmJobs }).catch(() => {});
    renderStrmJobs();
  }
  if (Array.isArray(src.skipDirs) && srvNewer('skipDirs') && !sameArr(src.skipDirs, og.skipDirs)) {
    S.config = { ...S.config, skipDirs: src.skipDirs.map(String) };
    api.saveConfig({ skipDirs: S.config.skipDirs }).catch(() => {});
  }
  if (Array.isArray(src.dirs) && srvNewer('dirs') && !sameArr(src.dirs, og.dirs)) {
    /* 片源变了（可能变多也可能**变少**）→ 必须重扫，否则删掉的那个还在片库里。
       走 applySources（它会把扫描丢后台 + 用 peek 轮询等结果）。 */
    await applySources(src.dirs.map(String), null);
  }
  if (typeof src.strmIntervalH === 'number'
    && srvNewer('strmIntervalH')
    && src.strmIntervalH !== (Number(og.strmIntervalH) || 0)) {
    S.config = { ...S.config, strmIntervalH: src.strmIntervalH };
    api.saveConfig({ strmIntervalH: src.strmIntervalH }).catch(() => {});
  }
  // 体积阈值（2026-09-22）：同「谁的时间戳新谁说了算」
  if (typeof src.strmMinSizeMB === 'number'
    && srvNewer('strmMinSizeMB')
    && Math.max(0, Math.floor(src.strmMinSizeMB)) !== (Number(og.strmMinSizeMB) || 0)) {
    const mv = Math.max(0, Math.floor(src.strmMinSizeMB));
    S.config = { ...S.config, strmMinSizeMB: mv };
    api.saveConfig({ strmMinSizeMB: mv }).catch(() => {});
  }
  /* 同步可能刚把「片源清单」恢复回来（含本机 strm 源 local:/）→ 退出演示模式。
     这时本次启动那趟 loadLibrary 取的是 /api/demo（空壳），必须重扫一次，
     否则用户看到的是「登录成功了、首页还是空的」。 */
  if (refreshDemoMode()) await loadLibrary(true);
  refreshBadges();
  forAllFeeds((f) => f.refreshItem && f.refreshItem(null));
  return dirty;
}

/**
 * 跑一次同步：**一次往返**搞定推拉 ——
 * push 带的是「本机新增/改动 + 删除墓碑」，服务端按时间戳合并后把**全量**回给我们，
 * 那份全量就是合并后的权威结果，直接落回本机即可（不用再 pull 一次）。
 */
async function syncNow(manual) {
  if (!SY.loggedIn()) { if (manual) toast('先填服务器地址并登录账号'); return false; }
  if (SY.busy) return false;
  SY.busy = true;
  if (manual) syncStatus('正在同步…');
  try {
    const r = await syncFetch('/api/sync/push', { method: 'POST', json: syncPayload() });
    await syncApply(r.data);
    syncSnapNow();
    SY.lastAt = Date.now();
    SY.save();
    syncStatus('已同步（' + new Date(SY.lastAt).toLocaleString() + '）', true);
    if (manual) toast('同步完成');
    /* strm 包：只有「这台设备还没有本机片源」时才自动拉 —— 有过就不动，
       免得把本机正在用的东西盖掉（导入本身也是合并补缺，但下载 1.6MB 没必要每次做）。 */
    await syncMaybePullStrm(manual, r.strm);
    syncRender();
    return true;
  } catch (e) {
    syncStatus('同步失败：' + e.message, false);
    if (manual) toast('同步失败：' + e.message, 3600);
    return false;
  } finally {
    SY.busy = false;
  }
}

/**
 * 本机 strm 库里**到底有没有内容**。
 *
 * 🔴 判据必须是「片库里有 local: 开头的视频」，**不能**看 `S.config.dirs` 里有没有 local:。
 *    原因：同步本身就会把服务端账号里的片源（含那条 `local:/`）合并进本机 ——
 *    刚同步完片源就已经有了，拿片源判断会**恒为真** → 换新机时永远不会去拉备份包，
 *    结果是「片源有了、文件没有、首页空的」（真机上就是这么把自己绕进去的）。
 *
 * 用片库里的实际路径判断：本机片源的视频，路径都以 `local:` 开头（见 LOCAL_PREFIX）。
 * 保守取向：还没扫完（S.allVideos 为空）时算「没有」→ 会去拉包；
 * 而导入是**合并补缺**（已有的跳过、不覆盖），多拉一次不会破坏任何东西。
 */
function syncHasLocalLib() {
  const arr = S.allVideos || S.videos || [];
  return arr.some((v) => String(v && v.p).indexOf('local:') === 0);
}

/** 远端有 strm 包、本机却还没有库 → 自动拉下来恢复（这就是「换新机登录后自动同步」） */
async function syncMaybePullStrm(manual, info) {
  if (!info) {
    try { info = (await syncFetch('/api/sync/pull')).strm; } catch (_) { return false; }
  }
  if (!info || !info.has) return false;
  if (syncHasLocalLib()) return false;
  return syncPullStrm(manual, info);
}

/** 从账号下载 strm 包并导入本机（复用已经验证过的 /api/strm/restore） */
async function syncPullStrm(manual, info) {
  try {
    showLoading(true, '正在从账号恢复 strm…');
    const blob = await syncFetch('/api/sync/strm', { binary: true });
    const r = await api.strmRestore(blob);
    /* 🔴 刚拉下来的这份内容，立即记成「已备份到这一版」。
       不记的话，紧接着的自动备份会判定「库变了」→ 把我们刚下载的东西原样传回账号。
       （后端 strmBackupRead 每导入一次都会 ++rev 并回报，所以只能用它回传的值。） */
    if (r.rev != null) { SY.strmRev = Number(r.rev); SY.save(); }
    const fi = r.files || {};
    const jb = r.jobs || {};
    if (jb.now) { S.config = { ...S.config, strmJobs: jb.now.slice() }; renderStrmJobs(); }
    if (jb.dirs && (jb.dirsAdded || []).length) {
      await applySources(jb.dirs.slice(), null);
    } else {
      /* 🔴 恢复了 .strm 就必须重扫片库，**不能只在 dirsAdded 有东西时才扫**。
         本机片源 `local:/` 往往**早就已经在** dirs 里了（strmBackupRead 的兜底就会
         注册它），于是 dirsAdded 为空、整个这一步被跳过 —— 用户看到的就是
         「登录了、回填了几千个 .strm、首页却什么都没有」（2026-09-22 用户报）。
         先把演示模式按「有没有片源」重判一次（退掉 demo，loadLibrary 才会取真片库），
         再重扫。 */
      refreshDemoMode();
      await loadLibrary(true);
    }
    const parts = [`回填 ${fi.added || 0} 个 .strm`];
    if (fi.skipped) parts.push(`跳过已有的 ${fi.skipped} 个`);
    if ((jb.dirsAdded || []).length) parts.push(`片源补 ${jb.dirsAdded.length} 个`);
    syncStatus('已从账号恢复 strm：' + parts.join(' · '), true);
    toast('已从账号恢复 strm：' + parts.join(' · '), 4200);
    return true;
  } catch (e) {
    syncStatus('恢复 strm 失败：' + e.message, false);
    if (manual) toast('恢复 strm 失败：' + e.message, 3600);
    return false;
  } finally {
    showLoading(false);
  }
}

/** 读一次本机 strm 任务状态里的「库内容版本」（本机同源，很便宜） */
async function strmRevNow() {
  const st = await api.strmJob(false);
  return Number(st && st.rev != null ? st.rev : 0);
}

/**
 * 打包本机 strm 库 → 上传到账号。**完全不碰 UI** —— 手动按钮和自动备份共用它。
 * 失败一律抛异常，由两个调用方各自决定怎么报。
 */
async function syncUploadStrmCore() {
  const r = await fetch('/api/strm/backup');            // 本机（同源）
  if (!r.ok) throw new Error('打包失败 HTTP ' + r.status);
  const blob = await r.blob();
  const up = await syncFetch('/api/sync/strm', { method: 'PUT', raw: blob, ctype: 'application/zip' });
  return { mb: ((up.bytes || blob.size) / 1024 / 1024).toFixed(2) };
}

/** 手动按钮：有全屏 loading，成功失败都弹 toast（用户主动点的，就该有回声） */
async function syncUploadStrm() {
  if (!SY.loggedIn()) return toast('先填服务器地址并登录账号');
  try {
    showLoading(true, '正在打包并上传…');
    const { mb } = await syncUploadStrmCore();
    /* 手动传完也要更新「已备份到哪一版」，否则自动那条路会以为还没备份、紧接着再传一次 */
    try { SY.strmRev = await strmRevNow(); SY.save(); } catch (_) {}
    syncStatus(`已上传 strm 备份（${mb} MB），换设备登录后会自动恢复`, true);
    toast(`已上传 strm 备份（${mb} MB）`, 3200);
  } catch (e) {
    syncStatus('上传失败：' + e.message, false);
    toast('上传失败：' + e.message, 3600);
  } finally {
    showLoading(false);
  }
}

/**
 * 🔴 **自动**把 strm 备份推上账号 —— 「本机库变过没有」说了算。
 *
 * 2026-09-22 修：用户报「手机新生成的 strm 不会自动备份到服务器」。
 * 真因是**这一侧压根没有自动触发点**：全前端只有设置页那个按钮会传，
 * 而 `syncNow()`（点赞收藏改动后自动跑的那个）只**拉**strm 包、从不推。
 * 于是定时任务每跑一轮，手机上多出来的 .strm 就一直躺在本机。
 *
 * 判据用后端的 `rev`（库内容版本）而不是 `lastRunAt`：
 * 一轮「全是增量命中、一个文件都没动」也会让 lastRunAt 变，
 * 拿它当信号会变成每轮白传一份几 MB 的备份。
 *
 * @param {number} [knownRev] 调用方刚拿到的版本号（省一次请求）
 */
async function syncPushStrmIfStale(knownRev) {
  if (!SY.auto || !SY.loggedIn() || SY.busy || SY.strmPushing) return false;
  /* 失败后歇 1 分钟再试 —— 现在是 10 秒一轮的心跳，不退避的话
     同步服务器一挂就变成每 10 秒撞一次（且每次都是失败）。 */
  if (SY.strmPushNextAt && Date.now() < SY.strmPushNextAt) return false;
  let rev = knownRev;
  if (rev == null) {
    try { rev = await strmRevNow(); } catch (_) { return false; }   // 本机服务没起来，等下一轮
  }
  /* rev === 0 = 这台设备从来没生成过 .strm → 没什么可备份的，直接跳过。
     🔴 这条不是省事，是**防数据损坏**：不加的话，新装的 App 启动时
     （本机记的是「未知」-1、后端是 0）两者不等 → 会传一个**空备份**上去，
     把账号里那份真的盖掉。「库被清空」这种合法情形走的是 rev>0（删除会 +1），
     所以这里跳过 0 不会漏掉任何该备份的变更。 */
  if (!Number(rev)) return false;
  if (Number(rev) === SY.strmRev) return false;                     // 没变过 → 什么都不做
  SY.strmPushing = true;
  try {
    const { mb } = await syncUploadStrmCore();
    SY.strmRev = Number(rev);
    SY.strmPushNextAt = 0;
    SY.save();
    syncStatus(`已自动备份 strm（${mb} MB）`, true);
    toast(`已自动备份 strm（${mb} MB）`, 2600);
    return true;
  } catch (e) {
    /* 失败**故意不弹 toast**：这条是心跳轮询的，弹出来就成了反复骚扰。
       只更新状态行（在设置页里能看到），而且**不推进 strmRev** → 下轮继续重试。 */
    SY.strmPushNextAt = Date.now() + 60000;
    syncStatus('strm 自动备份失败：' + e.message, false);
    return false;
  } finally {
    SY.strmPushing = false;
  }
}

function syncStatus(text, ok) {
  const el = $('cfSyncStatus');
  if (!el) return;
  el.hidden = false;
  el.className = 'cf-status ' + (ok === false ? 'bad' : ok ? 'ok' : '');
  el.textContent = text;
}

/** 把已保存的地址/账号回填进表单，并刷新按钮态与状态行 */
function syncRender() {
  const u = $('cfSyncUrl');
  if (!u) return;
  if (document.activeElement !== u) u.value = SY.url;
  const n = $('cfSyncUser');
  if (n && document.activeElement !== n) n.value = SY.user;
  const a = $('cfSyncAuto');
  if (a) a.checked = SY.auto;
  const out = $('cfSyncOut');
  if (out) out.disabled = !SY.loggedIn();
  const up = $('cfSyncUp');
  if (up) up.disabled = !SY.loggedIn();
  const dn = $('cfSyncDown');
  if (dn) dn.disabled = !SY.loggedIn();
  const sd = $('cfSyncStrmDel');
  if (sd) sd.disabled = !SY.loggedIn();
  /* 🔴 别覆盖「刚刚那次操作的结果」：登录/注册流程末尾也会调 syncRender，
     它会把「同步失败：xxx」当场冲成「还没同步过」—— 用户永远看不到失败原因，
     只能看到「点了没反应」（真机上就是这么把自己坑了一次）。
     所以只在状态行还是「登录态提示」或空着时才重写。 */
  const el = $('cfSyncStatus');
  const cur = el ? String(el.textContent || '') : '';
  if (cur === '' || /^(未登录|已登录)/.test(cur)) {
    if (!SY.loggedIn()) {
      syncStatus('未登录 —— 这一项是可选的，不用也不影响本机使用');
    } else if (SY.lastAt) {
      syncStatus(`已登录 ${SY.user} · 上次同步 ${new Date(SY.lastAt).toLocaleString()}`, true);
    } else {
      syncStatus(`已登录 ${SY.user} · 还没同步过`, true);
    }
  }
}

/** 登录/注册共用的一段 */
async function syncAuth(register) {
  const url = String(($('cfSyncUrl') || {}).value || '').trim().replace(/\/+$/, '');
  const user = String(($('cfSyncUser') || {}).value || '').trim();
  const pass = String(($('cfSyncPass') || {}).value || '');
  if (!url) return toast('先填同步服务器地址');
  if (!/^https?:\/\//i.test(url)) return toast('地址要以 http:// 或 https:// 开头');
  if (!user || !pass) return toast('账号和密码都要填');
  SY.url = url;
  try {
    showLoading(true, register ? '正在注册…' : '正在登录…');
    const r = await syncFetch(register ? '/api/auth/register' : '/api/auth/login', {
      method: 'POST', json: { user, pass },
    });
    SY.token = r.token;
    SY.user = r.user;
    SY.save();
    const p = $('cfSyncPass');
    if (p) p.value = '';
    toast(register ? '账号已创建' : '登录成功');
    await syncNow(false);
  } catch (e) {
    /* 失败时别把 url 留在内存里当「已配置」—— 否则后面每次自动同步都会白试一遍 */
    SY.url = SY.token ? SY.url : '';
    syncStatus('失败：' + e.message, false);
    toast('失败：' + e.message, 3600);
  } finally {
    showLoading(false);
    syncRender();
  }
}

/* ---- 自动同步：点赞/收藏改完打一个防抖，攒一攒再推 ---- */
let syncPushTimer = 0;
function syncTouch() {
  if (!SY.auto || !SY.loggedIn() || SY.busy) return;
  clearTimeout(syncPushTimer);
  syncPushTimer = setTimeout(() => { syncNow(false); }, 2500);
}

/* ---- 界面绑定 ---- */
$('cfSyncLogin')?.addEventListener('click', () => syncAuth(false));
$('cfSyncRegister')?.addEventListener('click', () => syncAuth(true));
$('cfSyncNow')?.addEventListener('click', () => syncNow(true));
$('cfSyncUp')?.addEventListener('click', syncUploadStrm);
$('cfSyncDown')?.addEventListener('click', () => syncPullStrm(true));
/* ---- 删除云端 strm 备份（2026-09-22）----
 *
 * 🔴 同样是两步确认（原生 confirm() 在 WebView 里会静默返回取消，见 sjDisarm 的注释）。
 *
 * ⚠️ 这个动作会影响**别的设备**以后换机恢复的能力，所以：
 *    · 按钮上写明「只删账号里那份，本机文件不受影响」；
 *    · 删完把本机的 strmRev 记下来 —— 这样心跳不会立刻又把本机那份传上去
 *      （否则等于「删了又瞬间传回来」，用户看着像没删掉）。
 */
let syncStrmDelArm = 0;
function syncStrmDelDisarm() {
  clearTimeout(syncStrmDelArm);
  syncStrmDelArm = 0;
  const b = $('cfSyncStrmDel');
  if (b) { b.classList.remove('armed'); b.textContent = '删除云端备份'; }
}
$('cfSyncStrmDel')?.addEventListener('click', async () => {
  const b = $('cfSyncStrmDel');
  if (!b) return;
  if (!SY.loggedIn()) return toast('先填服务器地址并登录账号');
  if (b.classList.contains('armed')) {
    syncStrmDelDisarm();
    try {
      await syncFetch('/api/sync/strm', { method: 'DELETE' });
      /* 记下当前版本号：避免心跳判定「本机比云端新」→ 立刻又传一份回去 */
      try { SY.strmRev = await strmRevNow(); SY.save(); } catch (_) {}
      syncStatus('已删除账号里的 strm 备份（本机文件未动）', true);
      toast('已删除云端备份', 3200);
    } catch (e) {
      syncStatus('删除失败：' + e.message, false);
      toast('删除失败：' + e.message, 3600);
    }
    return;
  }
  syncStrmDelDisarm();
  b.classList.add('armed');
  b.textContent = '确认删除？';
  toast('再点一次才真删 —— 这会影响别的设备以后换机恢复', 3600);
  syncStrmDelArm = setTimeout(syncStrmDelDisarm, 4000);
});
$('cfSyncAuto')?.addEventListener('change', (e) => {
  SY.auto = !!e.target.checked;
  SY.save();
  toast(SY.auto ? '已打开自动同步' : '已关闭自动同步（仍可手动点「立即同步」）');
  /* 刚打开自动同步 → 立刻判一次本机 strm 库要不要备份。
     不然得等 5 分钟轮询，用户会以为开关没生效。 */
  if (SY.auto) syncPushStrmIfStale();
});
$('cfSyncOut')?.addEventListener('click', async () => {
  /* 退出只清本机凭据，**不动**账号里的数据 —— 那可能是别的设备正在用的。 */
  try { await syncFetch('/api/auth/logout', { method: 'POST' }); } catch (_) {}
  SY.token = ''; SY.user = ''; SY.lastAt = 0; SY.snap = null;
  SY.save();
  syncRender();
  toast('已退出账号（本机数据不受影响）');
});
$('cfSyncUrl')?.addEventListener('change', (e) => {
  SY.url = String(e.target.value || '').trim().replace(/\/+$/, '');
  SY.save();
  syncRender();
});

/** 启动时：登录过就静默同步一次（没网 / NAS 没开都很正常，失败不打扰用户） */
function syncBoot() {
  syncRender();
  if (!SY.auto || !SY.loggedIn()) return;
  setTimeout(async () => {
    /* 顺序要紧：先做常规同步（里面可能包含「本机没库 → 从账号拉 strm 包」），
       再判断要不要把本机的推上去。反过来的话，换新机第一次登录会
       「先传一个空库上去、再把自己刚传的拉回来」，白白清掉账号里的备份。 */
    await syncNow(false);
    /* 定时 strm 任务是**后端**跑的，App 关着的时候它照样会跑完一轮 ——
       所以启动时必须补一次「库变过没有」，这正是用户报的那个场景。 */
    await syncPushStrmIfStale();
  }, 1500);
}

/* ---- strm 心跳（2026-09-22 用户要求：strm 备份要跟点赞收藏一样，几秒钟就自动推上去）----
 *
 * 🔴 为什么只能轮询：定时任务跑在**后端**（NasServer.java），而它**没有任何通知页面的
 *    通道**（没有 evaluateJavascript / 回调接口），页面拿不到「刚跑完一轮」这个事件。
 *    所以只能由前端去问 —— 问的是本机 127.0.0.1，只读几个计数器，开销可以忽略。
 *
 * ⚠️ 心跳会**消费** `localSrcAdded`（它是「读取即清除」的一次性标记）：后端把本机 strm
 *    目录自动加进片源时置起它。既然是心跳先读到了，就必须**由心跳自己把重扫做掉**，
 *    否则那批新 .strm 永远进不了片库（原来只有「点过立即生成」那条轮询会处理它）。
 */
const STRM_TICK_MS = 10 * 1000;
async function strmWatchTick() {
  if (document.hidden) return;                          // 后台别白跑
  if (!SY.auto || !SY.loggedIn()) return;
  let st;
  try { st = await api.strmJob(false); } catch (_) { return; }
  if (st && st.localSrcAdded) {
    try { await loadLibrary(true); } catch (_) {}
  }
  await syncPushStrmIfStale(st && st.rev);
}
setInterval(strmWatchTick, STRM_TICK_MS);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) strmWatchTick();
});

/* ------------------------- 目录选择器（复用 /api/browse） -------------------------
 *
 * 2026-09-20 二次改版加的：用户要素「可以选择 clouddrive2 根目录内的任意一个文件夹」。
 * 就是一台小浏览机，跟「文件夹」页同一个接口、同一套面包屑语义，但**不做片源那套动作**
 * （没有「加入片源」，只有一个「选这个文件夹」）。 */
const DP = { path: '', info: null };
/* `dpMountRoot()` 上溯用的一次性游标。**故意跟 DP.path 分开** ——
 * DP.path 是「用户选中的那一层」（渲染在弹层里），这个是「摸根摸到哪儿了」，
 * 混用一个变量会在摸根过程中把用户的面包屑搅乱。
 * ⚠️ 必须是 `var` 不能是 `const` —— `check.js` 的行为断言用 `new Function()` 抠函数体
 *    单独跑，函数作用域里只有抠进去的那几个函数，看不到模块级的 `const`（会 TDZ 报错）。
 *    数组/对象内部怎么变都无所谓，只有**绑定本身**要留在函数体内。 */
var DP_ROAM = { path: '' };

function renderDpCrumb(crumbs) {
  const el = $('dpCrumb');
  const n = (crumbs || []).length;
  const h = [`<button data-dpcrumb="" class="${n ? '' : 'cur'}">根目录</button>`];
  (crumbs || []).forEach((c, i) => {
    h.push('<i>/</i>');
    h.push(`<button data-dpcrumb="${escapeHtml(c.path)}" class="${i === n - 1 ? 'cur' : ''}">${escapeHtml(c.name)}</button>`);
  });
  el.innerHTML = h.join('');
}

/**
 * 挂载根 —— 目录选择器的**起点**。
 *
 * 🔴 为什么不能偷懒传空串（`loadDpDir('')`）：
 *    后端 `/api/browse` 对**空 path** 的语义是「用配置里那个目录」（`effectiveDir()`），
 *    **不是**挂载根。所以传空串会让选择器落在 `S.config.dir`（比如 /dav/115open/云下载），
 *    用户就没法往上走到 CD2 根目录，也就挑不到「根目录下**任意**一个文件夹」——
 *    真机验证时就是这么暴露出来的（面包屑一打开就是三层）。
 *    要落到挂载根必须**显式**给路径 —— 而这恰恰是空串从「browse 的起点」拿不到的。
 *
 * ✅ 解法：借一趟**文件夹页**（`loadDir('')`）把「空串 = 挂载根」那条自愈路径跑一遍，
 *    它是全项目唯一实现「空配置 / 配置失效 ⇒ 退到挂载根」的地方（loadDir 的 healed 兜底）。
 *    `brUp` 在挂载根上是 disabled 的（`disabled = !info.parent`，挂载根 parent 为 null），
 *    所以「可点 ⇒ 还没到根」——据此最多上溯 8 层就能稳稳停住。
 *    全程复用 B.path/B.info，结束时清成初始态，绝不把「文件夹」页留在用户看到的状态上。
 */
function dpMountRoot() {
  DP_ROAM.path = '';
  const reset = () => {
    B.path = ''; B.info = null; B.counts = {};
    $('brCrumb').innerHTML = '';
    $('brUp').disabled = true;
  };
  return loadDir('').then(() => {
    let guard = 0;
    const climb = () => {
      const info = B.info;
      if (!info) { reset(); return; }
      DP_ROAM.path = info.path || '';
      if (!info.parent || guard++ >= 8) { reset(); return; }
      return loadDir(info.parent).then(climb);
    };
    const done = climb();
    if (done && done.then) return done.then(reset);
    reset();
  }).catch(() => {
    DP_ROAM.path = '';
    reset();                 // 探不到就交回后端默认语义（至少别把人卡在转圈里）
  });
}

/** 打开选择器：**永远从挂载根开始**，不沿用上次的位置 ——
 *  用户要的就是「CD2 根目录下任意一个文件夹」，从根起最符合直觉（也少一层困惑）。 */
async function openDirPick() {
  /* ⚠️ 单把 #dirPickSheet 的 hidden 设成 false **不够**（2026-09-20 修「点了没反应」）：
     它在 HTML 里排在 #configSheet 之前，两者同 z-index、位置完全重叠，
     而设置页第 4 步正是从 #configSheet 里面打开它的 —— 同层级时 DOM 靠后的
     盖在上面，结果选择器整块被设置面板压住：列表其实已经读好了，但用户
     看到的就是「画面没变」。真正让它显示出来的是 style.css 里那条
     `#dirPickSheet{z-index:78}` —— 别删那条，也别改成在这里 hide/restore
     #configSheet（那还得记着关选择器时恢复，多一份状态机）。 */
  DP.path = '';
  DP.info = null;
  $('dirPickSheet').hidden = false;
  $('mask').hidden = false;
  sheetOpen = 'dirPickSheet';
  $('dpList').innerHTML = '<div class="cf-dir-empty">正在定位根目录…</div>';
  $('dpPath').textContent = '—';
  renderDpCrumb(null);
  await dpMountRoot();
  await loadDpDir(DP_ROAM.path);
}

function closeDirPick() {
  $('dirPickSheet').hidden = true;
  $('mask').hidden = true;
  sheetOpen = null;
}

async function loadDpDir(path) {
  const list = $('dpList');
  list.innerHTML = '<div class="cf-dir-empty">正在读取…</div>';
  $('dpPath').textContent = path || '（根目录）';
  let info;
  try {
    info = await api.browse(path || '');
  } catch (e) {
    renderDpCrumb(null);
    $('dpUp').disabled = true;
    list.innerHTML = `<div class="cf-dir-empty">读取失败：${escapeHtml(friendlyNetErr(e.message))}</div>`;
    return;
  }
  if (!info.ok) {
    DP.info = null;
    renderDpCrumb(info.crumbs);
    $('dpUp').disabled = !info.parent;
    list.innerHTML = `<div class="cf-dir-empty">打不开：${escapeHtml(friendlyNetErr(info.error) || '未知错误')}</div>`;
    return;
  }
  DP.info = info;
  DP.path = info.path;
  renderDpCrumb(info.crumbs);
  $('dpPath').textContent = info.path || '（根目录）';
  $('dpUp').disabled = !info.parent;
  if (!info.dirs.length) {
    list.innerHTML = '<div class="cf-dir-empty">这一层没有子文件夹。可以直接「选这个文件夹」。</div>';
    return;
  }
  list.innerHTML = info.dirs.map((d) => `<div class="frow" data-dpdir="${escapeHtml(d.path)}">
    <span class="fic">${IC.folder}</span>
    <div class="ftxt">
      <div class="fname">${escapeHtml(d.name)}</div>
      <div class="fmeta">${escapeHtml(d.path)}</div>
    </div>
    <span class="chev">${IC.chev}</span>
  </div>`).join('');
}

$('cfStrmAdd').addEventListener('click', openDirPick);
document.addEventListener('click', (e) => { if (e.target.closest('[data-close-dirpick]')) closeDirPick(); });
$('dpList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-dpdir]');
  if (row) loadDpDir(row.dataset.dpdir);
});
$('dpCrumb').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dpcrumb]');
  if (b) loadDpDir(b.dataset.dpcrumb);
});
$('dpUp').addEventListener('click', () => {
  const p = DP.info && DP.info.parent;
  /* 🔴 到顶了原地不动。**别**像「文件夹」页那样回落空串 ——
   *    空串的语义是「配置里那个目录」（见 dpMountRoot 的注释），
   *    一点「上一级」就掉回 /dav/115open/云下载，等于给了个假按钮。
   *    摸根那段已经用 loadDir 上溯过了，这里的 parent 本身就是准的。 */
  if (p === undefined || p === null) return;
  loadDpDir(p);
});
$('dpPick').addEventListener('click', async () => {
  /* 选的是**当前这一层**（不是某一行）—— 跟「上一级」配合就能到任意目录，
     而且「我就是要监控这个恰好没有子文件夹的目录」这种情形也走得通。
     （点文件夹名进去是为了看下一层，不等于选中它 —— 这跟「文件夹」页的语义一致。） */
  const picked = DP.path;
  if (!picked) return toast('不能选根目录，进一个文件夹再选', 2600);
  closeDirPick();
  await addStrmJob(picked);
});

/* ---- .strm 自动库：立即生成（2026-09-20）----
 * 点一下 → POST run:true 起后台任务 → 2 秒一轮轮询进度，跑完自动停。
 * ⚠️ 一轮可能要跑几分钟（每个视频都要 PROPFIND + 写文件）——
 *    必须轮询而不是等响应，用户中途关掉设置页也无所谓，任务在后台继续跑。
 * （2026-09-20 二次改版：不再有 300ms 节流，因为不往网盘/PUT 写了。） */
let strmPollTimer = null;
$('cfStrmRun').addEventListener('click', async () => {
  $('cfStrmRun').disabled = true;
  try {
    const st = await api.strmJob(true);
    renderStrmStatus(st);
    if (st.state === 'already-running') toast('strm 生成已在进行中');
    clearInterval(strmPollTimer);
    strmPollTimer = setInterval(async () => {
      try {
        const s2 = await api.strmJob(false);
        renderStrmStatus(s2);
        if (!s2.running) {
          clearInterval(strmPollTimer); strmPollTimer = null;
          /* 后端在生成成功那一刻会把「本机 strm 目录」自动加进片源
             （见 NasServer.strmRegisterLocalSrc），片源多了一条 → 片库必须重扫
             才刷得到那批 .strm。这次改动是**后端自己**发起的，用户没点任何按钮，
             前端那条「配置变了就重扫」的路径根本不会触发 —— 所以靠状态里的
             `localSrcAdded` 一次性标记来补这一下（后端读取即清除）。
             ⚠️ 必须用 refresh：不 refresh 拿的是旧缓存，那批 strm 还是出不来。 */
          if (s2.localSrcAdded) {
            toast('已把本机 strm 目录加进片源，正在刷新片库…', 3000);
            await loadLibrary(true);
            setNav('home');
          }
          /* 这一轮真的改动过库 → 顺手把备份推上账号（2026-09-22 用户报
             「手机新生成的 strm 不会自动备份到服务器」）。传 s2.rev 省掉一次状态请求；
             没登录、或用户关了自动同步时，这个函数会自己直接返回。 */
          await syncPushStrmIfStale(s2.rev);
        }
      } catch (e) { clearInterval(strmPollTimer); strmPollTimer = null; }
    }, 2000);
  } catch (e) {
    renderStrmStatus({ running: false, lastError: friendlyNetErr(e.message), lastRunAt: 0, added: 0, skipped: 0, failed: 0, total: 0 });
  }
  $('cfStrmRun').disabled = false;
});

$('cfDemo').addEventListener('click', async () => {
  S.demoMode = true;
  S.mode = 'demo';
  closeSheet();
  await loadLibrary(false);
  toast('已切换到演示视频');
});

/* 空状态（片库一条都没有时露出来的那两个按钮）。
 * 2026-09-19 按用户要求对调了职责：
 *   · 主按钮 = 转到文件夹页（空文件夹最直接的出路就是去挑一个有片的）；
 *   · 次按钮 = 数据源设置（原来那格是「先用演示视频」，用户基本用不上，
 *     而配置入口才是这里真正缺的捷径）。
 * ⚠️ 和 meConfig / meRescan 一样，这两个也是「画了但没绑」—— 同一次排查里一起发现的。
 * 动作和别处的入口保持一致，别各写各的。 */
$('emptyConfig').addEventListener('click', () => { setNav('browse'); });
$('emptyDemo').addEventListener('click', () => openSheet('configSheet'));
/* 「内置引擎没登录 CD2」时的专用出路（见 loadLibrary 的 engineLogin 分支）。
   有原生桥就走原生打开管理页 Activity；浏览器 / PC 版没有桥 → 开新标签兜底
   （和 restartApp 一个套路：只写一条，另一个环境就是「点了没反应」）。 */
$('emptyEngineBtn').addEventListener('click', () => {
  if (window.NasBridge && window.NasBridge.cd2Admin) { window.NasBridge.cd2Admin(); return; }
  window.open('http://127.0.0.1:19798/', '_blank');
});

/* ------------------------------ 声音 ------------------------------ */
$('soundHint').addEventListener('click', (e) => { e.stopPropagation(); enableSound(); });
function enableSound() {
  if (S.soundOn) return;
  S.soundOn = true;
  $('soundHint').classList.add('hide');
  setTimeout(() => { $('soundHint').hidden = true; }, 280);
  forAllFeeds((f) => f.mounted.forEach((v) => { v.muted = false; }));
  vibrate(10);
  toast('声音已开启 🔊');
}

/* ------------------------------ 键盘 / 尺寸 ------------------------------ */
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  const inPlayer = !$('playerModal').hidden;
  const active = inPlayer ? player : (NAV === 'home' ? main : null);
  if (e.key === 'Escape') {
    if (isNativeFull()) return;                 // 交给浏览器退出系统全屏
    if (inPlayer) closePlayer();
    else if (sheetOpen) closeSheet();
    return;
  }
  if (!active) return;
  if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); active.scrollBy(1); }
  else if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); active.scrollBy(-1); }
  else if (e.key === ' ') {
    e.preventDefault();
    const i = active.index;
    const v = active.mounted.get(i);
    if (v) { const it = active.itemHTMLAt(i); if (v.paused) safePlay(v, it); else v.pause(); }
  } else if (e.key === 'l' || e.key === 'L') {
    const v = active.list[active.index]; if (v) setLike(v.p, !S.likes[v.p]);
  } else if (e.key === 'f' || e.key === 'F') {
    const v = active.list[active.index]; if (v) toggleFav(v.p);
  } else if (e.key === 'z' || e.key === 'Z') {
    if (!inPlayer) openPlayer(main.list, main.index);   // 首页按 Z 全屏播放
  }
});

let rzTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => {
    if (!$('playerModal').hidden) {
      const pi = player.index;
      /* ⚠️ 先铺窗口再滚（见 goVid 那条注释）—— 直写 scrollTop 会被吸附钳到窗口边缘 */
      if (pi >= 0) { player.scrollToIndex(pi, false); player.activate(pi, true); }
      return;
    }
    const i = main.index;
    if (i >= 0) { main.scrollToIndex(i, false); main.activate(i, true); }
  }, 180);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { forAllFeeds((f) => f.pauseAll()); return; }
  if (!$('playerModal').hidden) {
    /**
     * 回到前台时补一次「打开播放器」的收尾 —— 这里专门兜住一个会持续复发的老问题：
     *
     * 如果这次 openPlayer 是在页面**处于后台**时被调用的（例：MainActivity.onPause 之后
     * web.onPause 把页面标成 hidden），那么：
     *   · player.index 可能还是 -1（activate 没能正常跑完）；
     *   · 就算跑完了，此刻 video 也是 we pauseAll() 暂停掉的状态，
     *     而 .stalling 会一直挂着 → 画面就是一个**转圈的占位**，看着像卡在缓冲。
     *
     * 所以这里不能只 resume：index 还没落定的话要先把「哪一条」补回来，
     * 再让它真正开始播，最后把「加载中」的状态清掉。
     * 顺序必须是 activate → resume → 摘 .stalling，否则 resume 找不到 video 可播。
     */
    if (player.index < 0) {
      // index 没落定：说明当初的 activate 被 rAF 坑掉了，这里必须补（同步，不依赖 rAF）。
      // 用 openPlayer 当时记下的 PLAYER_WANT，别猜 DOM 顺序。
      const want = PLAYER_WANT >= 0 ? PLAYER_WANT : 0;
      if (player.list && player.list.length) player.activate(want, true);
    }
    player.resume();
    // 状态由真实播放情况决定，别让「加载中」一直挂着骗人
    setTimeout(() => {
      if (!$('playerModal').hidden && player.index >= 0) player.activate(player.index, true);
    }, 120);
    return;
  }
  if (NAV === 'home') main.resume();
});

/* ------------------------------ 内置网盘（CloudDrive2 引擎） ------------------------------ */
/**
 * 设置页「第 1 步」那块 —— 只有 APK 版有。
 *
 * APK 里 MainActivity 会拉起一个**内置的 CloudDrive2 引擎**（手机本地的网盘聚合服务），
 * 并通过 NasBridge 暴露 cd2Status / cd2Admin。
 * PC / 浏览器**没有** NasBridge，所以这一块整段保持 hidden ——
 * 摆出来只会让人点了没反应（§17 那类「假按钮」，本项目已经栽过好几次）。
 *
 * ⚠️ 这一块不改变任何既有流程：WebDAV 那条路一个字符都没动，
 *    它只是多提供一条「连本机 127.0.0.1:19798/dav」的捷径。
 */
(function initCd2Panel() {
  const box = $('stepCD2');
  const B = window.NasBridge;
  if (!box) return;
  if (!B || typeof B.cd2Status !== 'function') return;   // 非 APK 环境：保持隐藏

  box.hidden = false;
  const statusEl = $('cd2Status');
  let timer = null;

  const readStatus = () => {
    try { return JSON.parse(B.cd2Status() || '{}'); } catch (_) { return {}; }
  };

  let rescued = false;          // 「冷启动竞态」只补扫一次
  const paint = () => {
    const st = readStatus();
    if (st.ready) {
      statusEl.textContent = '内置引擎已就绪（127.0.0.1:' + st.port + '）';
      statusEl.className = 'ol-status ok';
      if (timer) { clearInterval(timer); timer = null; }   // 就绪后不用再轮询
      /* 🔴 冷启动竞态的补偿（2026-09-19 实测踩到）：
         App 一启动，NasServer 就按配置去扫片源，而内置引擎这时可能还没起来 ——
         那一轮扫描必然失败。所以等它**真正就绪**后补一次重扫。
         🔴 但**每 24 小时至多自动补一次**（2026-09-19 用户要求「缓存扫描改成每 24
         小时扫描一次」，别每次开 App 都强制重扫）：用 localStorage 记上次时间，
         不足 24 小时就只信缓存（后端 TTL 本来就是 24 小时）。手动点「重新扫描」不受限。 */
      if (!rescued && /127\.0\.0\.1:19798/.test((S.config && S.config.url) || '')) {
        rescued = true;
        let lastAuto = 0;
        try { lastAuto = Number(localStorage.getItem('nasdy.lastAutoScan') || 0); } catch (_) {}
        if (Date.now() - lastAuto >= 24 * 3600 * 1000) {
          try { localStorage.setItem('nasdy.lastAutoScan', String(Date.now())); } catch (_) {}
          setTimeout(() => { try { main.rescan(); } catch (_) {} }, 800);
        }
      }
    } else if (st.error) {
      statusEl.textContent = '内置引擎启动失败：' + st.error;
      statusEl.className = 'ol-status bad';
      if (timer) { clearInterval(timer); timer = null; }
    } else {
      statusEl.textContent = '正在启动内置引擎…（首次要建库，几秒到十几秒）';
      statusEl.className = 'ol-status';
    }
  };

  paint();
  timer = setInterval(paint, 1500);

  $('cd2Config').addEventListener('click', () => {
    /* 引擎没就绪时先别打开：管理页那边虽然也会等/给提示，
       但在这里拦住能少一次「白跑一趟」，也让用户更早知道要等。 */
    const st = readStatus();
    if (!st.ready) {
      const why = st.error ? '内置引擎起不来：' + st.error
        : (st.running === false ? '内置引擎刚重启，等几秒再点'
          : '内置引擎还在启动，等几秒再点（首次要建库）');
      return toast(why, 3200);
    }
    try { B.cd2Admin(); } catch (e) { toast('打不开管理页：' + e.message, 2600); }
  });

  $('cd2Use').addEventListener('click', () => {
    const st = readStatus();
    if (!st.ready) return setStatus('内置引擎还没就绪，等几秒再点', false);
    $('cfUrl').value = st.url;
    setStatus('已填入内置引擎地址。账号密码填你的 CD2 登录账号'
      + '（还没登录过 CD2 的话，先点上面「打开 CloudDrive2 管理」登录并挂载 115），点「登录」。', true);
  });
})();

/* ------------------------------ 启动 ------------------------------ */
(async function boot() {
  phone.dataset.fit = 'contain';
  /* 🔴 启动预热（2026-09-19 提速）：boot 一开始就发，别等 config/library 回来。
   * 上次播放的那条大概率还是这次的第一条（片库有 24h 缓存、内容没变），
   * 让 CD2 向 115 申请下载直链的那 1~3 秒跟 WebView 启动、config、library
   * 全部并行掉 —— 这是「第一条片出画慢」的最大一块可省时间。
   * 路径过期/片源变了也无害：预热失败静默，真播放走 /api/stream 的重试。 */
  try {
    const warmPath = localStorage.getItem('nasdy.warmPath');
    if (warmPath) api.warm(warmPath);
  } catch (_) {}
  try {
    const [cfg, st] = await Promise.all([api.config(), api.state()]);
    S.config = cfg.config || {};
    S.hasPass = !!cfg.hasPass;
    /* 有没有**真**转码能力。三种后端两种形状，这里都得认：
     *   · Node 版 server.js：`{ ready: true, version: '…' }`（一个对象）
     *   · APK Java 版（新）：`true` / `false`（一个布尔）
     *   · APK Java 版（老，≤1.2）：恒 `false`
     * ⚠️ 只认 `cfg.ffmpeg.ready` 是个坑：布尔 true 上取 .ready 得到 undefined，
     * 于是内嵌了 ffmpeg 的新 APK 会被判成「没有 ffmpeg」，wmv 照样播不了。
     */
    S.ffmpeg = cfg.ffmpeg === true || !!(cfg.ffmpeg && cfg.ffmpeg.ready);
    // 置备还在跑（首次启动拷 30MB）：前端可以据此把文案说成「正在准备」，而不是「不支持」
    S.ffmpegPending = !!cfg.ffmpegPending;
    S.ffmpegReason = cfg.ffmpegReason || '';
    // 能不能探时长，跟有没有 ffmpeg 是两件事：APK 用系统解码器，没 ffmpeg 也能探。
    // 老版本服务端不回这个字段 → 回落到 ffmpeg 的判断，保持兼容。
    S.probe = cfg.probe != null ? !!cfg.probe : S.ffmpeg;
    S.likes = st.likes || {};
    S.favorites = st.favorites || {};
    // 先清掉旧版本在「无 ffmpeg」环境下误标的名单（那些标记指向的是假重编码），
    // 再把服务器名单同步下来 —— 顺序不能反，不然刚同步的又会被清掉。
    badStreamPurgeLegacy();
    // 服务器上的坏码流名单同步下来：别的设备已经替我们踩过坑了，这边直接走重编码
    Object.keys(st.badStreams || {}).forEach((p) => badStreamMarkLocal(p));
    phone.dataset.fit = S.config.fit || 'contain';
    S.mode = cfg.mode || 'demo';
    S.currentDir = S.config.dir || cfg.dir || '';
    // 启动时并没有真连过服务器 —— 上面这条 currentDir 只是「磁盘上存的」，不算验证过。
    S.verifiedDir = '';
    S.dirs = Array.isArray(S.config.dirs) ? S.config.dirs : [];
    /* 🔴 有片源就不算演示模式 —— 判据必须用 hasAnySource()，不能只看 mode。
       换新机登录同步后，本机拿回了「片源清单」（含 local:/），但拿不回 WebDAV
       地址和账号密码（凭据不同步），mode 依然是 demo。照 mode 判的话
       loadLibrary 会去取 /api/demo（空数组），用户就是「数据恢复了、首页却空的」。 */
    S.demoMode = S.mode === 'demo' && !hasAnySource();
    /* 两步流程的登录态：有地址 + （存过密码 或 本来就有片源）就算「已登录」。
     * 不在启动时真去连一次 —— 那样每次开 App 都得多等一个网络往返，
     * 而且 NAS 不在线时会把已经配好的用户直接挡在门外。 */
    S.loggedIn = !!S.config.url && (S.hasPass || S.dirs.length > 0);
    $('brRecursive').checked = S.config.recursive !== false;
  } catch (e) {
    S.demoMode = true;
    S.mode = 'demo';
  }
  /* 🔴 「装完自动删安装包」（2026-09-23 用户要求）：
     版本号现在拿到了（`S.config.versionName` 来自 PackageManager），趁早把这件事做掉。
     语义见 UpdateInstaller.sweepAfterInstall()：把包交给系统安装器后收不到可靠回调，
     所以用「下次启动时运行版本 ≠ 上次尝试安装的版本」当**安装成功**的信号。
     ⚠️ 必须在这里调（而不是 setInterval 或更晚）：此刻才刚拿到当前版本号；
        而且越早删越好 —— 用户可能马上又去点「检查更新」，那会儿缓存里不该留着旧包。
     ⚠️ try/catch 包住：网页版没有 NasBridge，报错不能影响启动。 */
  try {
    const curVer = appVersion().name;
    if (curVer && window.NasBridge && window.NasBridge.updSweep) window.NasBridge.updSweep(curVer);
  } catch (_) {}
  await loadLibrary(false);
  // 内嵌 ffmpeg 是**后台置备**的（首次启动要解出 30MB 到 filesDir，几百毫秒到几秒），
  // 而 S.ffmpeg 只在上面读了那一次 —— 如果启动足够快，会读到「还在准备」。
  // 这里补一次：只要服务端说 pending，就轮询几回，拿到结果后刷新 S.ffmpeg。
  // 不刷新的话，本次启动内所有 wmv/avi 都会走「不支持」分支，用户以为功能没做。
  if (S.ffmpegPending && !S.ffmpeg) {
    (async () => {
      for (let n = 0; n < 20; n++) {                    // 最多追 20 次 ≈ 10 秒
        await new Promise((r) => setTimeout(r, 500));
        let c2 = null;
        try { c2 = await api.config(); } catch (_) { return; }
        if (!c2 || c2.ffmpegPending === undefined) return;   // 老后端，别循环
        const ready = c2.ffmpeg === true || !!(c2.ffmpeg && c2.ffmpeg.ready);
        if (ready) {
          S.ffmpeg = true;
          S.ffmpegPending = false;
          S.ffmpegReason = '';
          return;
        }
        if (!c2.ffmpegPending) {                        // 置备结束但失败了
          S.ffmpegPending = false;
          S.ffmpegReason = c2.ffmpegReason || '';
          return;
        }
      }
    })();
  }
  // 长按倍速没什么可发现的入口，第一次来的时候提示一下就够了
  if (!LS.get('holdTip', false)) {
    LS.set('holdTip', true);
    setTimeout(() => toast('小技巧：按住画面是 2 倍速，松手恢复', 3200), 2800);
  }
  /* 多设备同步：登录过就静默同步一次（没登录 / 没网 / NAS 没开都不打扰 —— 见 syncBoot） */
  syncBoot();
})();

/* ------------------------- 系统返回键（安卓实体/手势返回） -------------------------
 *
 * `MainActivity.onBackPressed()` 会**先调本钩子**，再看返回值决定要不要弹菜单：
 *   · 返回 `true`  = 这次返回键页面自己消化掉了（Java 什么都不做）；
 *   · 返回 false / 抛错 = 交还给 Java，走它原来那套「重新加载 / 服务器设置 / 退出」菜单。
 *
 * 🔴 为什么非要绕一圈 JS：**浮层状态和文件夹当前层都在页面里** ——
 *    `sheetOpen`、`B.info` 这些 Java 那边完全看不见。以前是**无条件弹菜单**，
 *    用户在文件夹里按返回键，等的是「退回上一级」，结果弹出一个菜单，
 *    观感就是「返回键坏了」（2026-09-20 用户报的就是这个）。
 *
 * 优先级（从最具体到最笼统，顺序不能换）：
 *   1. 播放器浮层   → 先收播放器（它盖在最上面）
 *   2. 目录选择器   → 只收它（它是叠在设置页之上的第二层，见 #mask 的分层注释）
 *   3. 其它面板     → 收掉
 *   4. 文件夹页     → 退回上一级
 *   5. 都不适用     → false，交给 Java（比如已经在挂载根、或者停在首页/我的页）
 *
 * ⚠️ 必须是 `window.__onBack`（app.js 是 module，模块作用域的 `const` 外界看不见，
 *    和 `window.__nasFallback` / `window.__nasPos` 同一套路）。
 */
window.__onBack = function () {
  if (!$('playerModal').hidden) { closePlayer(); return true; }
  if (sheetOpen === 'dirPickSheet') { closeDirPick(); return true; }
  if (sheetOpen) { closeSheet(); return true; }
  if (NAV === 'browse') {
    /* 和 #brUp 的判定**完全一致**：parent 为 null/undefined 就是到顶了（挂载根）。
       ⚠️ 这里**不能**回落空串（''）：空串的语义是「让后端自愈到挂载根」，
          在已经是根的时候点它 = 原地重刷一层，看着像返回键没反应。 */
    const p = B.info && B.info.parent;
    if (p === undefined || p === null) return false;
    loadDir(p);
    return true;
  }
  return false;
};
