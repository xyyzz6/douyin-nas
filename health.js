/**
 * 健康检查：静态资源 + 视频库 + 配置 + 拉流 Range + 点赞/收藏持久化
 * 用法：node health.js      （需先 node server.js）
 *
 * NAS 连不上时不会中断：会自动回退用演示视频测拉流与持久化，
 * 因为那属于「配置问题」，不该和「服务不健康」混为一谈。
 */
const BASE = 'http://127.0.0.1:8080';
let bad = 0;
const line = (ok, msg) => { if (!ok) bad++; console.log((ok ? 'OK  ' : 'BAD ') + msg); };

(async () => {
  console.log('=== 静态资源 ===');
  for (const s of ['/', '/css/style.css', '/js/app.js', '/js/api.js', '/manifest.webmanifest']) {
    try {
      const r = await fetch(BASE + s);
      line(r.ok, `${s.padEnd(24)} ${r.status}  ${r.headers.get('content-type') || ''}`);
    } catch (e) {
      line(false, `${s.padEnd(24)} ${e.message}`);
    }
  }

  console.log('\n=== 视频库 ===');
  let videos = [];
  let source = '未知';
  const libRes = await fetch(BASE + '/api/library');
  const libText = await libRes.text();
  let lib = null;
  try { lib = JSON.parse(libText); } catch (_) {}
  if (!lib) {
    line(false, `/api/library 返回的不是 JSON（HTTP ${libRes.status}）：${libText.slice(0, 140)}`);
  } else if (lib.error) {
    line(false, `扫描 NAS 失败：${lib.error}`);
    console.log('      ↑ 属于配置问题（地址 / 端口 / 账号），服务本身正常；下面回退用演示视频继续测。');
  } else {
    videos = lib.videos || [];
    source = lib.source;
    console.log(`source=${source}  数量=${videos.length}`);
    videos.forEach((v, i) => console.log(`  ${i + 1}. ${v.p}  |  ${v.title}  |  ${v.author}`));
  }
  if (!videos.length) {
    const d = await (await fetch(BASE + '/api/demo')).json();
    videos = d.videos || [];
    source = 'demo（回退）';
  }
  console.log(`拉流 / 持久化测试使用：${source}，共 ${videos.length} 个视频`);

  console.log('\n=== 配置 ===');
  const cfg = await (await fetch(BASE + '/api/config')).json();
  console.log(`WebDAV 地址="${cfg.config.url || '(空 → 演示模式)'}"  fit=${cfg.config.fit}  昵称=${cfg.config.nickname}`);

  console.log('\n=== 拉流（拖动进度依赖的 Range） ===');
  const p = encodeURIComponent(videos[0].p);
  const r = await fetch(BASE + '/api/stream?p=' + p, { headers: { Range: 'bytes=0-499' } });
  const buf = await r.arrayBuffer();
  line(r.status === 206 && buf.byteLength === 500,
    `status=${r.status}  content-range=${r.headers.get('content-range')}  收到=${buf.byteLength} 字节`);

  console.log('\n=== 点赞 / 收藏 持久化 ===');
  const id = videos[0].p;
  const post = (body) => fetch(BASE + '/api/state', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((x) => x.json());
  const get = () => fetch(BASE + '/api/state').then((x) => x.json());

  await post({ type: 'like', id, on: true });
  const likeAdd = !!(await get()).likes[id];
  await post({ type: 'like', id, on: false });
  const likeDel = !(await get()).likes[id];
  line(likeAdd && likeDel, `点赞  写入=${likeAdd}  取消=${likeDel}`);

  await post({ type: 'favorite', id, on: true });
  const favAdd = !!(await get()).favorites[id];
  await post({ type: 'favorite', id, on: false });
  const favDel = !(await get()).favorites[id];
  line(favAdd && favDel, `收藏  写入=${favAdd}  取消=${favDel}`);

  const st = await get();
  console.log('\n状态文件字段: ' + Object.keys(st).join(', '));

  console.log(`\n结果：${bad === 0 ? '全部通过 ✅' : bad + ' 项异常 ❌'}`);
})();
