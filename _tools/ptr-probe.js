/* 探针：`.feed` 是 `touch-action:pan-y` 时，**竖向拖动**这一串触摸还会不会
   照常派发 pointer 事件？还是被浏览器判成滚动、发 `pointercancel` 掐断？
   顺便数一下 touch 事件收到几个（touch 永不被 cancel）。

   结论（2026-09-18 实测，列表顶部往下拽 800px）：
     touchmove    : 32 个
     pointermove  :  2 个   ← 只有 2 次机会
     pointercancel:  1 个   ← 之后 pointer 流彻底失联
   ⇒ **任何靠 pointer 认领的竖向手势都会失灵**，必须改用 touch*。
     这条结论当时是为了决定「下拉刷新怎么写」才量的；
     后来下拉刷新整个删掉了（2026-09-18 晚），但这个浏览器行为本身没变 ——
     工具留下：以后只要有人想在竖向方向上挂 pointer 手势，先跑一遍它。

   用法（两个脚本配对，cdp.js 是「一跑就退」的）：
     NODE_PATH=<node_modules> node _tools/cdp.js --file _tools/ptr-probe.js
     adb -s emulator-5554 shell "input swipe 540 700 540 1500 900"
     NODE_PATH=<node_modules> node _tools/cdp.js --file _tools/ptr-probe-read.js
   ⚠️ 读数脚本 ptr-probe-read.js 按需现写（内容就是读 window.__pp.ev），
      或者直接用 `cdp.js "return JSON.stringify(window.__pp.ev)"`。
*/
const feed = document.querySelector('.feed');
feed.scrollTop = 0;
const T = window.__pp = { ev: {}, log: [] };
['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'touchstart', 'touchmove', 'touchend', 'touchcancel'].forEach((k) => {
  feed.addEventListener(k, (e) => {
    T.ev[k] = (T.ev[k] || 0) + 1;
    if (k === 'pointercancel') T.log.push('pointercancel @y=' + Math.round(e.clientY));
  }, { capture: true, passive: true });
});
return JSON.stringify({ armed: true, scrollTop: feed.scrollTop, touchAction: getComputedStyle(feed).touchAction });
