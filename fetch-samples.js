#!/usr/bin/env node
/**
 * 可选工具：抓取几个公开的免费测试视频，放进 public/samples 作为「演示模式」素材。
 * 不连 NAS 时也能看到完整效果。用法：node fetch-samples.js
 */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'public', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const SOURCES = [
  { f: '01_sintel.mp4', u: 'https://media.w3.org/2010/05/sintel/trailer.mp4', max: 9e6 },
  { f: '02_bunny.mp4', u: 'https://media.w3.org/2010/05/bunny/trailer.mp4', max: 9e6 },
  { f: '03_movie.mp4', u: 'https://media.w3.org/2010/05/video/movie_300.mp4', max: 9e6 },
  { f: '04_flower.mp4', u: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4', max: 9e6 },
  { f: '05_bbb10s.mp4', u: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4', max: 9e6 },
  { f: '06_jelly10s.mp4', u: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4', max: 9e6 },
  { f: '07_sample5s.mp4', u: 'https://download.samplelib.com/mp4/sample-5s.mp4', max: 9e6 },
];

async function grab(it) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 75000);
  try {
    const r = await fetch(it.u, { signal: ac.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const chunks = [];
    let n = 0;
    for await (const c of r.body) {
      n += c.length;
      if (n > it.max) throw new Error('超过大小上限');
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    if (buf.length < 4096) throw new Error('内容太小，可能不是视频');
    const sig = buf.slice(4, 8).toString('latin1');
    if (!/^(ftyp|mdat|free|moov|wide|skip)/.test(sig)) throw new Error('不是有效的 MP4（sig=' + sig + '）');
    fs.writeFileSync(path.join(OUT, it.f), buf);
    return `✅ ${it.f}  ${(buf.length / 1048576).toFixed(2)} MB`;
  } catch (e) {
    return `❌ ${it.f}  ${e.name === 'AbortError' ? '超时' : e.message}`;
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  const results = await Promise.all(SOURCES.map(grab));
  results.forEach((r) => console.log(r));
  const ok = fs.readdirSync(OUT).filter((f) => /\.(mp4|webm|ogv)$/i.test(f));
  console.log(`\n可用演示素材 ${ok.length} 个：${ok.join(', ')}`);
})();
