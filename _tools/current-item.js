/* 取「视口正中间那一条」——⚠️ 不能用 .item.ready：多条 item 可以同时带 ready
   （它表示「挂过视频」，不是「这是当前条」），querySelector 会永远返回第一条。 */
const feed = document.querySelector('.feed');
const items = [...document.querySelectorAll('.item')];
let it = null;
for (const x of items) { const r = x.getBoundingClientRect(); if (r.top <= 0 && r.bottom > 0) { it = x; break; } }
if (!it) return '找不到视口里的 item';
const v = it.querySelector('video');
return JSON.stringify({
  第几条: it.dataset.i,
  cls: it.className,
  有video: !!v,
  paused: v ? v.paused : null,
  rate: v ? v.playbackRate : null,
  t: v ? +v.currentTime.toFixed(1) : null,
  带ready的item数: items.filter((x) => x.classList.contains('ready')).length,
});
