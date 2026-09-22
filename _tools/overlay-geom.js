/* 验收「快进转圈居中」：
   思路 —— 伪元素 ::after 的 getBoundingClientRect 拿不到，但它的定位规则是
   `grid-area:1/1` + `.vbox` 的 `place-items:center`。所以往同一个 .vbox 里塞一个
   同样带 `grid-area:1/1` 的 34x34 真元素，它的 rect 就等于 ::after 被画在哪。
   再和 .vbox（画面矩形）的中心比，差值应该 ≈ 0。 */
const items = [...document.querySelectorAll('.item')];
const vh = innerHeight;

// 找出「当前占据视口」的那条
let cur = -1;
items.forEach((it, i) => {
  const r = it.getBoundingClientRect();
  if (r.top <= vh / 2 && r.bottom >= vh / 2) cur = i;
});
if (cur < 0) return '当前没有 item 占据视口中心，先让首页停下来';

const item = items[cur];
const v = item.querySelector('video');
const vbox = item.querySelector('.vbox');
const p = item.querySelector('.pause-ind');
const R = (el) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), cy: Math.round(r.y + r.height / 2), cx: Math.round(r.x + r.width / 2) };
};

// 让它处于「缓冲中」状态（.ready 才轮到 .vbox::after 出场）
item.classList.add('ready', 'stalling');
await new Promise((r) => setTimeout(r, 60));

const cs = getComputedStyle(vbox);
const after = getComputedStyle(vbox, '::after');

// 塞一个同样 grid-area:1/1 的替身来量 ::after 的实际落点
const probe = document.createElement('i');
probe.id = 'probe-ring';
probe.style.cssText = 'grid-area:1/1;width:34px;height:34px;border-radius:50%;';
vbox.appendChild(probe);
await new Promise((r) => setTimeout(r, 60));
const pr = R(probe);
const vr = R(vbox);
probe.remove();

const out = {
  第几条: cur,
  已就绪: item.classList.contains('ready'),
  画面矩形vbox: vr,
  vbox中心y: vr.cy,
  vbox的grid: {
    模板行: cs.gridTemplateRows,
    行数: cs.gridTemplateRows.trim().split(/\s+/).length,
    列数: cs.gridTemplateColumns.trim().split(/\s+/).length,
    placeItems: cs.placeItems,
  },
  转圈after: {
    gridRowStart: after.gridRowStart,
    gridColumnStart: after.gridColumnStart,
    width: after.width,
    height: after.height,
    内容: after.content,
  },
  转圈落点中心y: pr.cy,
  偏差px_转圈减画面中心: pr.cy - vr.cy,
  暂停按钮: R(p),
  boxSizing: cs.boxSizing,
  videoReadyState: v ? v.readyState : null,
};
return JSON.stringify(out, null, 1);
