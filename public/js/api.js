/* ---------- 后端接口封装 & 小工具 ---------- */

async function jget(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function jpost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

export const api = {
  config: () => jget('/api/config'),
  saveConfig: (cfg) => jpost('/api/config', cfg),
  test: (cfg) => jpost('/api/test', cfg),
  library: (refresh) => jget('/api/library' + (refresh ? '?refresh=1' : '')),
  /**
   * 片源文件夹：传整个数组就是「整组替换」。
   * 首页刷的是这些文件夹的合集，加/删/换片源都走这里，返回扫好的新片库。
   *
   * @param skipDirs 「不重扫」的文件夹（2026-09-18 加）。必须一并传 ——
   *    后端的规则是「只保留仍在 dirs 里的项」，不传它后端就会按新 dirs 收敛，
   *    结果是「改一次片源，所有锁定标记全没了」，用户会以为设置丢了。
   */
  sources: (dirs, recursive, skipDirs) =>
    jpost('/api/sources', { dirs, recursive, skipDirs: skipDirs || [] }),
  /** 轻量轮询：片库版本没变就只回一个小包，变了才带上完整列表 */
  libPeek: (v) => jget('/api/library?peek=1&v=' + Number(v == null ? -1 : v)),
  /**
   * 浏览 NAS 上的一个目录。
   * 传 cred 就用这份「临时凭据」去连（设置页还没保存时也能先逛），
   * 不传就用后端已保存的配置。
   */
  browse: (path, cred) => cred
    ? jpost('/api/browse', { ...cred, path: path || '' })
    : jget('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : '')),
  /** 问每个子文件夹里有多少视频（列表先渲染，数量后补） */
  counts: (paths, cred) => cred
    ? jpost('/api/counts', { ...cred, paths })
    : jpost('/api/counts', { paths }),
  /*
   * 已删除：decodeCaps()（2026-09-18 Phase L 回退）
   *
   * 它原来是 `decodeCaps: () => jget('/api/caps')` —— 探测 NAS 上那个 Docker
   * 解码服务的能力，好让设置页的「测试解码服务」按钮绕过 CORS 问出对面能不能转码。
   *
   * 为什么**不能**简单地把 URL 改回去：后端的 /api/caps 路由也删了（见 NasServer.java
   * 里 handleCaps 的墓碑注释）。调它只会拿到 404，而 404 在 jget 里会被当成网络错误，
   * 于是前端会显示「连不上」而不是「这个功能不存在」—— 更糟的是会让人以为
   * 只是地址填错了，然后去折腾一个根本不存在的服务。
   *
   * 要恢复转码能力，请当成一个新决策来做（后端加路由 + 前端加 UI），
   * 不要把这一行单独放回来。
   */
  probe: (p, fresh) => jget('/api/probe?p=' + encodeURIComponent(p) + (fresh ? '&fresh=1' : '')),
  /**
   * 预热上游（2026-09-19 提速）：让后端立刻去跟 CD2/115 建立取流并拉头 1MB。
   * fire-and-forget：调用方**不要 await**，失败也无所谓（真播放走 /api/stream 的重试）。
   * 典型用法：App 冷启动时用「上次播放的那条」先打一发，
   * 把 115 取流初始化（1~3 秒）藏进 WebView 启动 + 片库加载的时间里。
   */
  warm: (p) => fetch('/api/warm?p=' + encodeURIComponent(p), { cache: 'no-store' }).catch(() => {}),
  demo: () => jget('/api/demo'),
  state: () => jget('/api/state'),
  act: (payload) => jpost('/api/state', payload),
  /**
   * 一次性把三份名单整体写回本机（多设备同步专用）。
   * ⚠️ 别用 act() 循环来代替：一次同步可能带来几百条差异，逐条 POST 就是几百个请求，
   *    在真机上要等十几秒。
   */
  stateBulk: (payload) => jpost('/api/state/bulk', payload),
  /** 缩略图缓存统计（张数 / 占用 / 目录） */
  thumbStats: () => jget('/api/thumb/stats'),
  /** 把一批视频排进缩略图生成队列（后台慢慢抽，不阻塞） */
  thumbBackfill: (items) => jpost('/api/thumb/backfill', { items }),
  /**
   * .strm 自动库（2026-09-20）：run=true 手动触发一轮生成；不带参查状态。
   * 状态含 running/done/total/added/skipped/failed/lastRunAt/lastError/stale。
   */
  strmJob: (run) => (run ? jpost('/api/strmjob', { run: true }) : jget('/api/strmjob')),

  /**
   * 备份 / 换机（2026-09-20）：把一份备份 zip 上传给后端还原（合并补缺）。
   * ⚠️ body 就是 zip 的**字节**，不能走 jpost —— 那个会 JSON.stringify 把二进制毁掉。
   * ⚠️ Content-Type 也别写 application/json，否则后端会先按 JSON 解析一遍（无害但误导）。
   */
  /**
   * 清空本机 strm 库（2026-09-22）：删掉本机所有 .strm + 增量索引，并摘掉 `local:/` 片源。
   * ⚠️ **只动本机**，账号里的备份包不动 —— 那是另一台设备换机恢复用的。
   * 返回 { files, srcRemoved, rev }。
   */
  strmClear: () => jpost('/api/strm/clear', {}),

  strmRestore: async (file) => {
    const r = await fetch('/api/strm/restore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/zip' },
      body: file,
    });
    const j = await r.json().catch(() => ({ ok: false, error: 'HTTP ' + r.status }));
    if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  },

  /**
   * 取最新 Release（应用内更新用，2026-09-23）。
   *
   * 🔴 **为什么不走后端代理、直接从网页请求 api.github.com**：
   *    · 网页跑在 WebView 里，跨域请求 GitHub 是允许的 —— api.github.com 对匿名
   *      请求返回 `Access-Control-Allow-Origin: *`（实测），所以不需要后端搭桥。
   *    · 走后端反而更麻烦：APK 后端是**内嵌在手机里**的，它请求 GitHub 跟网页直接请求
   *      是同一条网络路径，没有任何收益，却要多写一个接口 + 多一处要维护的 CORS。
   *
   * ⚠️ 失败**必须**能区分「网络不通」和「不是更新」：
   *    这里抛异常 = 没查成（离线、被墙、超时），调用方**不许**把它当成「已是最新」——
   *    否则用户会以为「检查过了，没问题」，其实压根没查。
   */
  latestRelease: async () => {
    const r = await fetch('https://api.github.com/repos/xyyzz6/douyin-nas/releases/latest', {
      cache: 'no-store',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  },

};

export function streamUrl(v) {
  return v.stream || '/api/stream?p=' + encodeURIComponent(v.p);
}

/**
 * 浏览器放不了的封装（avi / wmv / mkv / flv / rmvb…）走服务端转码流。
 * t = 从第几秒开始转 —— 转码流是「拼接」出来的，不能直接 currentTime 跳，
 * 拖动时就从目标位置重新起一路 ffmpeg。
 * mode='encode' 强制重编码（不是换封装）：个别片源码流本身有毛病，浏览器解码持续丢帧，
 * 只有重新编码才治得好 —— 前端检测到丢帧率超标时自动切过来。
 */
export function transUrl(v, t, mode) {
  return '/api/transcode?p=' + encodeURIComponent(v.p) + (t ? '&t=' + Number(t).toFixed(2) : '') + (mode ? '&mode=' + mode : '');
}

/* ---------- 文本 ---------- */

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function fmtSize(b) {
  if (!b) return '';
  if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
}

export function initial(s) {
  const t = String(s || 'N').trim();
  return t ? t[0].toUpperCase() : 'N';
}

export function toast(msg, ms) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms || 1600);
}
