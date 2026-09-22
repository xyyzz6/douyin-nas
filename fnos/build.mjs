#!/usr/bin/env node
/**
 * 飞牛 fnOS 应用包（.fpk）打包脚本
 * ---------------------------------------------------------------------------
 *   node fnos/build.mjs
 *
 * 产物：fnos/dist/nasdouyin-<version>.fpk
 *      （改名成 nasdouyin.fpk 就能放进第三方应用源仓库）
 *
 * ## 为什么要自己写 tar，而不是直接用 fnpack 的产物
 *
 * `.fpk` 就是一个 tar.gz，里面是：
 *
 *     manifest  ICON.PNG  ICON_256.PNG  cmd/**  config/**  wizard/**  app.tgz
 *
 * 官方工具 `fnpack` 能生成它，但有个**在 Windows 上会致命**的问题：
 * 它按宿主机的文件权限写 tar，而 Windows 没有 POSIX 可执行位 ——
 * 实测它把 `cmd/main` 这类脚本和内置的 `node` 二进制全打成 **0666**。
 * 于是装到飞牛上要么脚本起不来、要么 Node 执行不了。
 *
 * 所以这里的做法是：
 *   1. 用 fnpack 做一次「结构校验」（可选，失败不阻断）；
 *   2. **自己按 ustar 规范写 tar**，权限位由脚本显式指定（cmd/* → 0755，
 *      内置 node → 0755，其余 0644），与打包机的操作系统无关；
 *   3. 写完**把产物解回来自检**（权限位、必备条目、manifest 字段），
 *      免得交出去一个装不上的包。
 *
 * 内置的 Node 运行时是 **linux-x64**（飞牛是 x86_64 Debian），
 * 所以这个脚本在 Windows / macOS / Linux 上跑出来的包是一样的。
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(HERE, '..');

const SRC = path.join(HERE, 'src');
const ASSETS = path.join(HERE, 'assets');
const BUILD = path.join(HERE, 'build');
const DIST = path.join(HERE, 'dist');
const CACHE = path.join(HERE, '.cache');
const TOOLS = path.join(HERE, 'tools');

const APPNAME = 'nasdouyin';
const NODE_VER = '22.22.2';                 // 内置运行时版本（与开发用的主版本对齐）

/** 同步服务端的安装向导（比完整版少一句「填 WebDAV」，多一句「去手机 App 里填这个地址」） */
const SYNC_WIZARD = JSON.stringify([
  {
    stepTitle: '同步服务 · 安装设置',
    items: [
      {
        type: 'tips',
        helpText: '这是一个<b>只存资料</b>的小服务：替你的多台设备保存点赞、收藏、坏码流名单、'
          + '昵称头像、片源与监控清单，以及一份 strm 备份包。<br>'
          + '它<b>没有播放器界面、不连你的 WebDAV、不扫你的盘</b> —— 手机 App 只把它当个云上的抽屉。',
      },
      {
        type: 'switch',
        field: 'wizard_allow_register',
        label: '允许注册同步账号',
        initValue: 'true',
      },
      {
        type: 'tips',
        helpText: '第一台设备要注册一个账号，所以默认打开。<br>'
          + '<b>只在局域网用就保持打开。</b>如果这个端口会暴露到公网（端口映射或反代），建议关掉 —— '
          + '关掉后已有账号照常登录同步，只是不再接受新注册。装好后随时能在应用设置里改。',
      },
      {
        type: 'tips',
        helpText: '装好后：手机 App →「我的 → 数据源设置 → 多设备同步」里填 '
          + '<b>http://&lt;这台飞牛的IP&gt;:8099</b>，然后注册 / 登录即可。',
      },
    ],
  },
], null, 2) + '\n';

const FNPACK_VER = '1.2.3';

const MTIME = Math.floor(Date.now() / 1000);

const log = (...a) => console.log(...a);
const step = (n, s) => log(`\n\x1b[1m[${n}] ${s}\x1b[0m`);
const kb = (n) => (n / 1024).toFixed(0) + ' KB';
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

// ═══════════════════════════════════════════════════════════ ustar 读写

/** 八进制字段：右对齐补零，长度 len（不含结尾符） */
function octal(n, len) {
  return Math.max(0, Math.floor(n)).toString(8).padStart(len, '0').slice(-len);
}

/** 造一个 512 字节的 ustar 头 */
function tarHeader({ name, mode, size, type, linkname = '' }) {
  const buf = Buffer.alloc(512);
  let nm = name;
  let prefix = '';

  // 名字超过 100 字节就拆到 prefix 字段（ustar 规定），别让它被截断
  if (Buffer.byteLength(nm, 'utf8') > 100) {
    let cut = -1;
    for (let i = 0; i < nm.length; i++) {
      if (nm[i] === '/' && Buffer.byteLength(nm.slice(0, i), 'utf8') <= 155
          && Buffer.byteLength(nm.slice(i + 1), 'utf8') <= 100) {
        cut = i;
      }
    }
    if (cut < 0) throw new Error('路径太长，放不进 ustar：' + nm);
    prefix = nm.slice(0, cut);
    nm = nm.slice(cut + 1);
  }

  buf.write(nm, 0, 100, 'utf8');
  buf.write(octal(mode & 0o7777, 7) + '\0', 100, 8, 'ascii');   // mode
  buf.write(octal(0, 7) + '\0', 108, 8, 'ascii');                // uid
  buf.write(octal(0, 7) + '\0', 116, 8, 'ascii');                // gid
  buf.write(octal(size, 11) + '\0', 124, 12, 'ascii');           // size
  buf.write(octal(MTIME, 11) + '\0', 136, 12, 'ascii');          // mtime
  buf.write('        ', 148, 8, 'ascii');                        // 校验和先填空格
  buf.write(type, 156, 1, 'ascii');
  buf.write(linkname, 157, 100, 'utf8');
  buf.write('ustar', 257, 5, 'ascii');                           // magic
  buf.write('\0', 262, 1, 'ascii');
  buf.write('00', 263, 2, 'ascii');                              // version
  buf.write('root', 265, 32, 'ascii');                           // uname
  buf.write('root', 297, 32, 'ascii');                           // gname
  if (prefix) buf.write(prefix, 345, 155, 'utf8');

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(octal(sum, 6) + '\0 ', 148, 8, 'ascii');            // checksum

  return buf;
}

/** entries: [{ name, type: 'file'|'dir', mode, data? }] → 未压缩的 tar Buffer */
function writeTar(entries) {
  const chunks = [];
  for (const e of entries) {
    const isDir = e.type === 'dir';
    const data = isDir ? Buffer.alloc(0) : e.data;
    const name = isDir && !e.name.endsWith('/') ? e.name + '/' : e.name;
    chunks.push(tarHeader({ name, mode: e.mode, size: data.length, type: isDir ? '5' : '0' }));
    if (data.length) {
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));            // 结尾两个全零块
  return Buffer.concat(chunks);
}

/** 读 tar（仅用于自检；遇到 pax/gnu 扩展条目会原样跳过） */
function readTar(buf) {
  const out = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;

    const raw = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '');
    const num = (a, b) => parseInt(h.subarray(a, b).toString('ascii').replace(/[\0 ]/g, ''), 8) || 0;

    const name = raw(0, 100);
    const prefix = raw(345, 500);
    const type = h.subarray(156, 157).toString('ascii').trim();
    const size = num(124, 136);
    const mode = num(100, 108);
    const full = prefix ? prefix + '/' + name : name;

    out.push({ name: full, type, size, mode, off });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════ 小工具

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function walk(dir, base = dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, ent.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (ent.isDirectory()) {
      out.push({ rel, type: 'dir' });
      out.push(...walk(full, base));
    } else if (ent.isFile()) {
      out.push({ rel, type: 'file', full });
    }
  }
  return out;
}

async function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  log(`   下载 ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}：${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf;
}

/** 内置 Node：先在 .cache 里找，没有就下载官方 linux 包并解出 bin/node
 *  🔴 飞牛有 x86 机型也有 ARM 机型（N1 / H6 / RK3399 都是 arm64），
 *     而 node 二进制是**挑架构**的 —— 所以两种架构各打一个包，
 *     manifest 的 platform 分别为 x86 / arm（官方取值只有这三个：x86|arm|all）。
 *     打包机是什么系统无所谓：node 是 linux 版，跟宿主系统无关。 */
async function ensureNodeRuntime(nodeArch) {
  const cached = path.join(CACHE, `node-v${NODE_VER}-linux-${nodeArch}`);
  if (fs.existsSync(cached)) {
    log(`   复用缓存 ${path.relative(PROJECT, cached)}（${mb(fs.statSync(cached).size)}）`);
    return cached;
  }

  const tgz = path.join(CACHE, `node-v${NODE_VER}-linux-${nodeArch}.tar.gz`);
  if (!fs.existsSync(tgz)) {
    // 用 .tar.gz 而不是 .tar.xz：Node 自带 zlib 能解 gzip，xz 得另装依赖
    await download(`https://nodejs.org/dist/v${NODE_VER}/node-v${NODE_VER}-linux-${nodeArch}.tar.gz`, tgz);
  }

  const tar = zlib.gunzipSync(fs.readFileSync(tgz));
  const want = `node-v${NODE_VER}-linux-${nodeArch}/bin/node`;
  const ent = readTar(tar).find((e) => e.name === want);
  if (!ent) throw new Error(`官方包里找不到 ${want}`);

  const data = tar.subarray(ent.off + 512, ent.off + 512 + ent.size);
  if (data.subarray(0, 4).toString('hex') !== '7f454c46') {
    throw new Error('解出来的不是 ELF 可执行文件，包可能下坏了');
  }
  // ARM 版 node 的 ELF 机器类型要真的是 AArch64（e_machine = 0xB7），别下错包
  const eMachine = data.readUInt16LE(18);
  const wantMachine = nodeArch === 'arm64' ? 0xb7 : 0x3e;    // 0x3e = x86-64
  if (eMachine !== wantMachine) {
    throw new Error(`node 的 ELF 机器类型是 0x${eMachine.toString(16)}，与 ${nodeArch} 不符`);
  }
  fs.writeFileSync(cached, data);
  log(`   已解出 ${path.relative(PROJECT, cached)}（${mb(data.length)}，e_machine=0x${eMachine.toString(16)}）`);
  return cached;
}

/** fnpack 官方校验工具（可选） */
async function ensureFnpack() {
  const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const name = `fnpack-${FNPACK_VER}-${plat}-${arch}${plat === 'windows' ? '.exe' : ''}`;
  const bin = path.join(TOOLS, name);
  if (fs.existsSync(bin)) return bin;
  try {
    await download(`https://static2.fnnas.com/fnpack/fnpack-${FNPACK_VER}-${plat}-${arch}`, bin);
    if (plat !== 'windows') fs.chmodSync(bin, 0o755);
    return bin;
  } catch (e) {
    log(`   ⚠️ 拿不到 fnpack（${e.message}），跳过官方校验，不影响产物`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════ 主流程

async function main() {
  log('\x1b[1m飞牛 fnOS 应用包打包\x1b[0m');
  log(`   工程：${PROJECT}`);

  if (!fs.existsSync(path.join(SRC, 'manifest'))) {
    throw new Error(`找不到 ${SRC}/manifest，工程结构不对`);
  }

  // --arch=x64 | arm64 | all（默认 all：两种都打，用户按机型挑）
  const argArch = (process.argv.find((a) => a.startsWith('--arch=')) || '--arch=all').slice(7);
  const arches = argArch === 'all' ? ['x64', 'arm64'] : [argArch];
  if (!arches.every((a) => a === 'x64' || a === 'arm64')) {
    throw new Error('--arch 只能是 x64 / arm64 / all');
  }

  // --mode=full | sync | all
  //   full = 完整版（播放器 + WebDAV 代理 + 同步服务端，就是一个网页版 App）
  //   sync = 只做同步服务端（存点赞/收藏/strm 备份，没有播放器、不连 WebDAV）
  const argMode = (process.argv.find((a) => a.startsWith('--mode=')) || '--mode=all').slice(7);
  const modes = argMode === 'all' ? ['full', 'sync'] : [argMode];
  if (!modes.every((m) => m === 'full' || m === 'sync')) {
    throw new Error('--mode 只能是 full / sync / all');
  }

  const made = [];
  for (const mode of modes) {
    for (const nodeArch of arches) {
      made.push(await buildOne(mode, nodeArch));
    }
  }

  log('\n\x1b[32m✅ 全部完成\x1b[0m');
  for (const m of made) log(`   ${path.relative(PROJECT, m.path)}  ${mb(m.size)}  ${m.platform}`);
  log(`\n   装到飞牛：桌面 →「应用中心」→ 右上角设置 →「手动安装应用」→ 选上面这个文件`);
  log(`   ⚠️ 按机型选：x86 机型用 -x86 那个，ARM 机型（N1 / H6 / RK3399）用 -arm 那个`);
  log(`   ⚠️ 按用途选：只想要「存点赞收藏」的服务端 → -sync 那个；要网页版播放器 → -full 那个`);
}

async function buildOne(mode, nodeArch) {
  const platform = nodeArch === 'arm64' ? 'arm' : 'x86';
  const appname = mode === 'sync' ? `${APPNAME}sync` : APPNAME;
  const label = mode === 'sync' ? '同步服务端（只存用户资料）' : '完整版（播放器 + 同步）';
  log(`\n\x1b[1m━━━ ${label} · ${platform} 架构（内置 node: linux-${nodeArch}）━━━\x1b[0m`);

  // ── 1. 组装 build/
  step(1, '组装构建目录');
  rmrf(BUILD);
  fs.cpSync(SRC, BUILD, { recursive: true });

  // 版本号以 manifest 为唯一来源；platform 按本次架构改写（官方取值 x86|arm|all）
  let manifest = fs.readFileSync(path.join(BUILD, 'manifest'), 'utf8');
  const version = (manifest.match(/^version\s*=\s*(.+)$/m) || [])[1]?.trim();
  if (!version) throw new Error('manifest 里没有 version');
  manifest = manifest.replace(/^platform\s*=.*$/m, `platform=${platform}`);
  if (!/^platform=/m.test(manifest)) manifest += `\nplatform=${platform}\n`;
  manifest = manifest.replace(/^appname\s*=.*$/m, `appname=${appname}`);

  if (mode === 'sync') {
    /* 🔴 appname 改了，**桌面入口的 key 也必须跟着改**（官方要求它必须以 appname 开头，
       fnpack 会报 `The entry name "x.Application" in "app/ui/config" should start with <appname>`；
       fnpack 只是把这句话打印出来、退出码仍是 0，所以下面那条「看输出」的检查不能少）。 */
    const entry = `${appname}.Application`;
    manifest = manifest.replace(/^desktop_applaunchname\s*=.*$/m, `desktop_applaunchname=${entry}`);
    const uicfgPath = path.join(BUILD, 'app', 'ui', 'config');
    fs.writeFileSync(uicfgPath, fs.readFileSync(uicfgPath, 'utf8').replace(/nasdouyin\.Application/g, entry));
    manifest = manifest.replace(/^display_name\s*=.*$/m, 'display_name=NAS 短视频 · 同步服务');
    manifest = manifest.replace(/^desc\s*=.*$/m,
      'desc=<p>给你的多台设备存<b>点赞 / 收藏 / 坏码流名单 / 昵称头像 / 片源与监控清单</b>，'
      + '以及一份 strm 备份包；新设备登录账号即可自动恢复。</p>'
      + '<p><b>它只是一个数据抽屉</b>：没有播放器界面、不连你的 WebDAV、不扫你的盘。</p>'
      + '<p>装好后手机 App 的「多设备同步」里填 <b>http://&lt;这台机器的IP&gt;:8099</b>。</p>');
  }
  fs.writeFileSync(path.join(BUILD, 'manifest'), manifest);
  log(`   appname=${appname}  version=${version}  platform=${platform}`);

  // 图标：assets 里的一份，铺到四个位置（根目录 2 个 + 桌面入口 2 个）
  const icondir = path.join(BUILD, 'app', 'ui', 'images');
  fs.mkdirSync(icondir, { recursive: true });
  const iconPairs = [
    ['icon-64.png', ['ICON.PNG', path.join('app', 'ui', 'images', 'icon_64.png')]],
    ['icon-256.png', ['ICON_256.PNG', path.join('app', 'ui', 'images', 'icon_256.png')]],
  ];
  for (const [from, tos] of iconPairs) {
    const data = fs.readFileSync(path.join(ASSETS, from));
    for (const to of tos) fs.writeFileSync(path.join(BUILD, to), data);
  }
  log(`   图标已铺开：ICON.PNG / ICON_256.PNG / app/ui/images/icon_{64,256}.png`);

  // ── 2. 填应用本体
  step(2, '填充应用本体（app/）');
  const appServer = path.join(BUILD, 'app', 'server');
  fs.mkdirSync(appServer, { recursive: true });

  if (mode === 'sync') {
    /* 🔴 同步服务端**不带**播放器那套：不放 server.js / public/（8.7MB 静态页 + 演示视频），
       只放 sync-server.js 一个文件。用户要的就是「只存资料的服务端」。 */
    fs.copyFileSync(path.join(PROJECT, 'sync-server.js'), path.join(appServer, 'sync-server.js'));
    log(`   sync-server.js  ${kb(fs.statSync(path.join(PROJECT, 'sync-server.js')).size)}`);
    /* cmd/main 的入口要跟着换（注意锚点是模板里的 `${APP_DIR}/server.js`） */
    const mainPath = path.join(BUILD, 'cmd', 'main');
    const mainTxt0 = fs.readFileSync(mainPath, 'utf8');
    const mainTxt = mainTxt0.replace('${APP_DIR}/server.js', '${APP_DIR}/sync-server.js');
    if (mainTxt === mainTxt0) throw new Error('cmd/main 里没找到入口 ${APP_DIR}/server.js，无法切成同步模式');
    fs.writeFileSync(mainPath, mainTxt);
    /* 安装向导也换成同步版文案 */
    fs.writeFileSync(path.join(BUILD, 'wizard', 'install'), SYNC_WIZARD);
    log('   已切成同步服务端模式（无播放器 / 无 public / 无 WebDAV）');
  } else {
    fs.copyFileSync(path.join(PROJECT, 'server.js'), path.join(appServer, 'server.js'));
    log(`   server.js  ${kb(fs.statSync(path.join(PROJECT, 'server.js')).size)}`);

    fs.cpSync(path.join(PROJECT, 'public'), path.join(appServer, 'public'), { recursive: true });
    log(`   public/    ${mb(dirSize(path.join(appServer, 'public')))}（含演示用 samples）`);
  }

  const nodeSrc = await ensureNodeRuntime(nodeArch);
  fs.copyFileSync(nodeSrc, path.join(appServer, 'node'));
  log(`   node       ${mb(fs.statSync(path.join(appServer, 'node')).size)}（linux-${nodeArch}，随包携带）`);

  // fnpack 会把顶层 config/ 也塞进 app.tgz，跟着做（安装后落在 TRIM_APPDEST/config）
  fs.cpSync(path.join(BUILD, 'config'), path.join(BUILD, 'app', 'config'), { recursive: true });

  // ── 3. 官方工具做一次结构校验（可选）
  step(3, '官方 fnpack 结构校验（可选）');
  const fnpack = await ensureFnpack();
  if (fnpack) {
    try {
      const out = execFileSync(fnpack, ['build', '--directory', BUILD], {
        cwd: BUILD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
      /* 🔴 fnpack 把「Packing failed」只是**打印**出来，退出码仍然是 0 ——
         只看退出码的话，上面那种「桌面入口 key 与 appname 不匹配」就悄悄溜过去了。 */
      if (/Packing failed/i.test(out)) throw new Error('fnpack 校验不通过：\n' + out);
      log('   ' + out.trim().split('\n').slice(-1)[0]);
    } catch (e) {
      if (e && /fnpack 校验不通过/.test(e.message)) throw e;
      throw new Error('fnpack 校验不通过，工程有问题：\n' + (e.stdout || '') + (e.stderr || e.message));
    }
    // fnpack 的产物权限位是错的（Windows 上全是 0666），别留在 build 里混淆
    rmrf(path.join(BUILD, `${APPNAME}.fpk`));
  }
  selfCheckJson(BUILD);

  // ── 4. 打 app.tgz（内层）
  step(4, '打包内层 app.tgz');
  const APP_MODE = (rel) => (rel === 'server/node' ? 0o755 : 0o644);
  const appEntries = walk(path.join(BUILD, 'app')).map((e) => ({
    name: e.rel,
    type: e.type,
    mode: e.type === 'dir' ? 0o755 : APP_MODE(e.rel),
    data: e.type === 'file' ? fs.readFileSync(e.full) : undefined,
  }));
  const appTgz = zlib.gzipSync(writeTar(appEntries), { level: 9 });
  log(`   ${appEntries.length} 个条目 → ${mb(appTgz.length)}`);

  // ── 5. 打外层 fpk
  step(5, '打包 .fpk');
  const outer = [];
  const addFile = (rel, mode) => outer.push({ name: rel, type: 'file', mode, data: fs.readFileSync(path.join(BUILD, rel)) });
  const addDir = (rel) => outer.push({ name: rel, type: 'dir', mode: 0o755 });

  addFile('ICON.PNG', 0o644);
  addFile('ICON_256.PNG', 0o644);
  outer.push({ name: 'app.tgz', type: 'file', mode: 0o644, data: appTgz });

  // 🔴 cmd/ 下的脚本必须是 0755 —— 飞牛要直接执行它们
  addDir('cmd');
  for (const e of walk(path.join(BUILD, 'cmd'))) {
    if (e.type === 'file') addFile('cmd/' + e.rel, 0o755);
  }
  addDir('config');
  for (const e of walk(path.join(BUILD, 'config'))) {
    if (e.type === 'file') addFile('config/' + e.rel, 0o644);
  }
  addFile('manifest', 0o644);
  addDir('wizard');
  for (const e of walk(path.join(BUILD, 'wizard'))) {
    if (e.type === 'file') addFile('wizard/' + e.rel, 0o644);
  }

  const fpk = zlib.gzipSync(writeTar(outer), { level: 9 });
  fs.mkdirSync(DIST, { recursive: true });
  const outPath = path.join(DIST, `${appname}-${version}-${platform}.fpk`);
  fs.writeFileSync(outPath, fpk);

  // ── 6. 自检：把产物解回来验一遍
  step(6, '产物自检');
  verify(outPath, platform, mode);

  log(`\n   \x1b[32m✅ ${path.relative(PROJECT, outPath)}\x1b[0m`);
  log(`   ${mb(fpk.length)}   sha256 ${crypto.createHash('sha256').update(fpk).digest('hex').slice(0, 16)}…`);
  return { path: outPath, size: fpk.length, platform };
}

function dirSize(p) {
  let n = 0;
  for (const e of walk(p)) if (e.type === 'file') n += fs.statSync(e.full).size;
  return n;
}

function selfCheckJson(dir) {
  for (const rel of ['config/privilege', 'config/resource', 'wizard/install', 'wizard/config', 'app/ui/config']) {
    const p = path.join(dir, rel);
    if (!fs.existsSync(p)) throw new Error(`缺少 ${rel}`);
    try {
      JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      throw new Error(`${rel} 不是合法 JSON：${e.message}`);
    }
  }
  log('   JSON 配置全部合法');
}

function verify(fpkPath, platform, mode) {
  const raw = fs.readFileSync(fpkPath);
  if (raw.subarray(0, 2).toString('hex') !== '1f8b') throw new Error('产物不是 gzip');

  const inner = zlib.gunzipSync(raw);
  const entries = readTar(inner);
  /* ⚠️ 目录条目在 tar 里带尾斜杠（cmd/），比对前先统一剥掉 ——
     否则「产物里缺少 cmd」这种报错其实是自检自己写错了，不是产物有问题。 */
  const byName = new Map(entries.map((e) => [e.name.replace(/\/+$/, ''), e]));

  const need = ['manifest', 'ICON.PNG', 'ICON_256.PNG', 'app.tgz', 'cmd', 'cmd/main', 'config', 'wizard'];
  for (const n of need) {
    if (!byName.has(n)) throw new Error(`产物里缺少 ${n}`);
  }

  // 权限位：这是 Windows 打包最容易出事的地方，必须钉死
  const bad = entries.filter((e) => e.name.startsWith('cmd/') && e.type !== '5' && e.mode !== 0o755);
  if (bad.length) throw new Error('cmd/ 下脚本权限不是 0755：' + bad.map((b) => b.name).join(', '));

  const appTgzEntry = byName.get('app.tgz');
  const appTar = zlib.gunzipSync(inner.subarray(appTgzEntry.off + 512, appTgzEntry.off + 512 + appTgzEntry.size));
  const appEntries = readTar(appTar);
  const nodeEnt = appEntries.find((e) => e.name === 'server/node');
  if (!nodeEnt) throw new Error('内层 app.tgz 里没有 server/node');
  if (nodeEnt.mode !== 0o755) throw new Error(`内置 node 权限是 ${octal(nodeEnt.mode, 4)}，应为 0755`);
  /* 🔴 同步包不许夹带播放器那套（server.js / public/）——
     那是用户明确不要的东西，混进去就白瘦了。 */
  const names = appEntries.map((e) => e.name);
  if (mode === 'sync') {
    if (!names.includes('server/sync-server.js')) throw new Error('同步包里缺少 server/sync-server.js');
    if (names.includes('server/server.js')) throw new Error('同步包里不该有 server/server.js（播放器服务端）');
    if (names.some((n) => n.startsWith('server/public/'))) throw new Error('同步包里不该有 public/（播放器页面）');
  } else {
    for (const n of ['server/server.js', 'ui/config', 'ui/images/icon_64.png', 'ui/images/icon_256.png']) {
      if (!names.includes(n)) throw new Error(`内层缺少 ${n}`);
    }
  }

  const manifest = inner.subarray(
    byName.get('manifest').off + 512,
    byName.get('manifest').off + 512 + byName.get('manifest').size,
  ).toString('utf8');
  for (const k of ['appname', 'version', 'display_name', 'platform', 'desktop_uidir', 'desktop_applaunchname', 'service_port']) {
    if (!new RegExp(`^${k}\\s*=`, 'm').test(manifest)) throw new Error(`manifest 缺少字段 ${k}`);
  }

  // 🔴 架构必须自洽：manifest 说 arm 就不能塞 x86_64 的 node ——
  //    装上去能装，跑起来就 exec format error，最难查。
  const platVal = (manifest.match(/^platform\s*=\s*(.+)$/m) || [])[1].trim();
  if (platVal !== platform) throw new Error(`manifest platform=${platVal}，与本次构建的 ${platform} 不符`);
  const wantMachine = platform === 'arm' ? 0xb7 : 0x3e;
  const nodeHead = appTar.subarray(nodeEnt.off + 512, nodeEnt.off + 512 + 64);
  const gotMachine = nodeHead.readUInt16LE(18);
  if (gotMachine !== wantMachine) {
    throw new Error(`内置 node 的 ELF 机器类型 0x${gotMachine.toString(16)} 与 platform=${platform} 不符`);
  }

  const pubCount = appEntries.filter((e) => e.name.startsWith('server/public/')).length;
  log(`   外层 ${entries.length} 个条目 / 内层 ${appEntries.length} 个（其中 public/ ${pubCount} 个）`);
  log(`   cmd/* 权限 0755 ✓   内置 node 权限 0755 ✓   manifest 字段齐 ✓`);
  log(`   platform=${platVal} 与内置 node 架构自洽 ✓（e_machine=0x${gotMachine.toString(16)}）`);
}

main().catch((e) => {
  console.error('\n\x1b[31m❌ 打包失败\x1b[0m\n' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
