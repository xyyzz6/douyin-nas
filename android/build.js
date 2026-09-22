#!/usr/bin/env node
'use strict';
/**
 * 把网页版 douyin-nas 打包成 Android APK —— 不需要 Gradle，也不需要 Android Studio。
 *
 *   node android/build.js
 *   node android/build.js --default-url=http://192.168.1.7:9000
 *   node android/build.js --out=D:/douyin-nas.apk --clean
 *
 * 流程：aapt2 compile → aapt2 link → javac → d8 → 拼 zip → zipalign → apksigner
 * 产物：仓库根目录的 douyin-nas.apk（默认）
 *
 * 依赖：JDK 17（javac/keytool）+ Android SDK（build-tools / platforms）。
 * 打包用的两个小工具（lib/zip.js、lib/png.js）都是零依赖的，只用 Node 自带模块。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const zip = require('./lib/zip.js');
const png = require('./lib/png.js');

const HERE = __dirname;                                  // douyin-nas/android
const ROOT = path.dirname(HERE);                          // douyin-nas
const BUILD = path.join(HERE, 'build');
const GEN_RES = path.join(BUILD, 'gen-res');              // 生成的图标 + 默认地址
const GEN_JAVA = path.join(BUILD, 'gen-java');            // aapt2 生成的 R.java
const OBJ = path.join(BUILD, 'obj');                      // .class
const DEX = path.join(BUILD, 'dex');                      // .dex

const APP = {
  // 28（不是 24）：**历史原因，现在其实可以降了**。
  //   当初钉 28 是因为内嵌的 ffmpeg/ffprobe 是 NDK r28 为 Android 9 / API 28 构建的，
  //   低于 28 的系统缺它链接的 libc/libm 符号，装上会 dlopen 失败。
  //   2026-09-18 内嵌 ffmpeg 整个删掉、转码改成走 NAS 的 Docker 解码服务之后，
  //   这条约束就已经不存在了 —— 想支持 Android 7.x 的话把这里和
  //   AndroidManifest.xml 的 minSdkVersion 一起改成 24 即可（没有其它依赖）。
  //   暂时保持 28 不动，避免这次改造混进「降 minSdk」这个独立变更（要重新回归测试）。
  minApi: 28,
  targetApi: 34,
  // ---------------------------------------------------------------- 版本号
  // 🔴 **每次打包自动涨**（2026-09-20 用户要求：「以后每次打包都更新版本号」）。
  //    versionName 涨**末位**（1.3 → 1.3.1 → 1.3.2 …），versionCode 每次 +1。
  //    ⚠️ 下面这两个值是**上次打包留下的**，不是手写的常量 —— 每次跑 build.js 都会
  //       把涨完的新值**写回这个文件**（见 bumpVersion / writeBackVersion）。
  //       想手写一个新基线（比如发 1.4）就自己改这儿，下一轮从 1.4.1 接着涨。
  //    改大版本号时**别改 versionCode 之外的东西**：它是 Android 判断「谁更新」的唯一依据，
  //    只允许单调递增，绝不能因为改 versionName 而变小（否则装机时系统拒装 / 用户降级）。
  versionCode: 45,
  versionName: '1.3.41',
  keystore: path.join(HERE, 'debug.keystore'),
  ksPass: 'android',
  ksAlias: 'androiddebugkey',
};

const DENSITIES = [
  ['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192],
];

/**
 * 版本号：`1.3` → `1.3.1` → `1.3.2` …（只涨**末位**）
 *
 * 规则（2026-09-20 用户拍板「以后每次打包都更新版本号」）：
 *   · `1.3`    → `1.3.1`   （两段变三段，补出末位）
 *   · `1.3.1`  → `1.3.2`
 *   · `1.3.9`  → `1.3.10`  （末位是**十进制数**，不是单个字符，不会进位到 1.4）
 *   · `1.2.99` → `1.2.100`
 *
 * 想手动起一个新基线（比如发 1.4），直接改 APP.versionName 就行，下一轮从 1.4.1 接着涨。
 */
function bumpVersionName(v) {
  const parts = String(v).trim().split('.');
  if (parts.length < 2) fatal('versionName 至少要有两位（如 1.3），拿到 ' + JSON.stringify(v));
  for (const p of parts) {
    if (!/^\d+$/.test(p)) fatal('versionName 每段只能是数字，拿到 ' + JSON.stringify(v));
  }
  // 两段（1.3）→ 补出末位再涨，即 1.3 → 1.3.1
  if (parts.length === 2) return parts[0] + '.' + parts[1] + '.1';
  const last = parts.length - 1;
  parts[last] = String(parseInt(parts[last], 10) + 1);
  return parts.join('.');
}

/**
 * 把涨完的新版本号**写回 build.js 自己**。
 *
 * 🔴 为什么必须落盘：不写回去的话下次跑又从 APP 字面量那个旧值起涨，
 *    结果**每次打出来的都是同一个版本号** —— 看着「自动了」，其实永远 1.3.1。
 *    （这是这类自增最容易踩的坑：自增的是内存里的副本，不是源头。）
 *
 * 只替换 `versionCode: N,` / `versionName: '...'` 这两行的字面量，
 * 其它一个字符都不碰 —— 手写正则去改自己的源码本来就危险，范围越小越好。
 *
 * ✅ `self` 是**可注入**的（默认 `__filename`）：`check.js` 会拿一份 build.js 的临时副本
 *    当靶子跑这个函数，验证「真的改了文件里的字面量」——
 *    光断言「函数存在 / 调用了」是假断言（§57）：把 `fs.writeFileSync` 注释掉照样绿。
 */
function writeBackVersion(code, name, self) {
  const target = self || __filename;
  let src = fs.readFileSync(target, 'utf8');
  const before = src;
  src = src.replace(/(\n\s*versionCode:\s*)\d+(,)/, '$1' + code + '$2');
  src = src.replace(/(\n\s*versionName:\s*)'[^']*'(,)/, "$1'" + name + "'$2");
  if (src === before) {
    fatal('版本号没写回 build.js（正则没匹配上）—— 下次打包会重复用同一个版本号。\n'
      + '      检查 APP 里 versionCode / versionName 两行是不是被改过格式。');
  }
  fs.writeFileSync(target, src);
  ok('版本号已写回 build.js：versionCode ' + code + ' / versionName ' + name);
}

/**
 * 每次打包涨版本号（`--no-bump` 跳过，`--version-name=` / `--version-code=` 手动覆盖）。
 *
 * 三者优先级（高 → 低）：
 *   ① 命令行显式指定（`--version-name=1.4`）→ **跳过自增**，用指定的值（此时也写回）
 *   ② `--no-bump`            → 原样用当前值，**不写回**（调试用：反复打同一版本）
 *   ③ 默认                    → 末位 +1、versionCode +1，并写回
 */
function bumpVersion(o) {
  if (o.versionPinned) {
    log('  版本       ' + APP.versionName + ' (' + APP.versionCode + ')  \x1b[90m命令行指定\x1b[0m');
    writeBackVersion(APP.versionCode, APP.versionName);
    return;
  }
  if (o.noBump) {
    log('  版本       ' + APP.versionName + ' (' + APP.versionCode + ')  \x1b[90m--no-bump 保持\x1b[0m');
    return;
  }
  const oldName = APP.versionName;
  const oldCode = APP.versionCode;
  const newName = bumpVersionName(oldName);
  APP.versionName = newName;
  APP.versionCode = oldCode + 1;
  log('  版本       \x1b[1m' + oldName + ' → ' + newName + '\x1b[0m'
    + '  (versionCode ' + oldCode + ' → ' + APP.versionCode + ')');
  writeBackVersion(APP.versionCode, APP.versionName);
}

/**
 * ⚠️ AndroidManifest.xml 里的 minSdkVersion 必须和 APP.minApi 一致。
 *
 * 踩过的坑（两层，都要记住）：
 *  1) manifest 里那份 `<uses-sdk>` 会赢过 aapt2 的 min-sdk-version 参数。
 *     只改 build.js 的话，装机 `dumpsys` 看到的还是老值。
 *  2) **XML 注释里不能出现连续两个减号**。当时这条注释里写了 aapt2 的参数名
 *     （那名字本身含两个减号），直接把 manifest 弄成 "not well-formed"。
 *     aapt2 解析失败后**不报错、直接退回默认 minSdk**，构建脚本一路绿、
 *     装机也成功 —— 只有拿 `aapt2 dump badging` 才看得出 minSdk 是错的。
 *     这个坑极隐蔽，所以下面除了比对数值，还专门校验「注释里没有双减号」。
 *
 * 不一致就 fail，绝不静默放过。
 */
function checkManifestMinSdk() {
  const mf = path.join(HERE, 'AndroidManifest.xml');
  const xml = fs.readFileSync(mf, 'utf8');

  // (a) 注释里不能有连续减号 —— 会让整个 manifest 解析失败（而且不报错！）
  for (const m of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
    if (m[1].includes('--')) {
      fatal('AndroidManifest.xml 的注释里出现了连续两个减号（XML 不允许）。\n'
        + '      这会让 aapt2 解析失败并**静默退回默认 minSdk**，构建却不会报错。\n'
        + '      出问题的注释开头：' + JSON.stringify(m[1].trim().slice(0, 60)));
    }
  }

  // (b) minSdk 数值必须两处一致
  const m = xml.match(/android:minSdkVersion\s*=\s*"(\d+)"/);
  if (!m) fatal('AndroidManifest.xml 里没写 android:minSdkVersion');
  const inManifest = parseInt(m[1], 10);
  if (inManifest !== APP.minApi) {
    fatal('minSdk 不一致：AndroidManifest.xml 是 ' + inManifest
      + '，build.js 的 APP.minApi 是 ' + APP.minApi
      + '。\n      manifest 里那份会赢，装上后 dumpsys 会看到 ' + inManifest
      + '。两处必须同时改。');
  }
  log('      minSdk ' + inManifest + '（manifest 与 build.js 一致 ✓）');
}

/**
 * ⚠️ 这里原来钉着内嵌 ffmpeg/ffprobe 的精确字节数 + sha256（FFMPEG_BIN 表），
 * 配合 `collectFfmpegAssets()` 把它们以 STORED 方式打进 APK。
 *
 * 2026-09-18 已整体移除：转码搬到 NAS 上的 Docker 解码服务（见仓库 `decode-server/`），
 * APK 不再携带任何可执行二进制。删除的东西：
 *   · android/assets/ffmpeg/{ffmpeg,ffprobe}（共 30MB）
 *   · android/src/com/nas/douyin/Ffmpeg.java（解包 + chmod + 版本标记）
 *   · collectFfmpegAssets() 与它的 STORED/ELF 校验
 *   · APK 体积断言里那 30MB 的预期值
 *
 * 留这段注释是为了让后来的人知道：**如果哪天又看到「APK 只有 11MB」别以为是构建漏了**，
 * 那是正常的 —— 30MB 的 ffmpeg 是真被删了，不是没打进去。
 */

// ------------------------------------------------------------------ 工具

/**
 * 跑 d8 / apksigner 时的 JVM 参数。
 * 这两个工具默认会去申请 1G 以上的连续虚拟内存（G1 会先 mmap 500MB 的 heap 保留区），
 * 在内存受限的进程里会直接 "Could not reserve enough space for object heap" 崩掉。
 * 我们只有十几个类 / 一个几十 KB 的 APK，256m + SerialGC 绰绰有余。
 */
const JVM_SMALL = ['-Xmx256m', '-XX:+UseSerialGC'];

const log = (...a) => console.log(...a);
const step = (n, t) => console.log('\n\x1b[36m[' + n + ']\x1b[0m ' + t);
const ok = (t) => console.log('    \x1b[32m✓\x1b[0m ' + t);

function fatal(msg) {
  console.error('\n\x1b[31m打包失败：\x1b[0m ' + msg + '\n');
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (opts.capture) {
      if (e.stdout) console.error(e.stdout);
      if (e.stderr) console.error(e.stderr);
    }
    fatal('命令失败：' + path.basename(cmd) + ' ' + args.join(' '));
  }
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function walk(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// ------------------------------------------------- AAR 依赖（没有 Gradle 时的替代）
/**
 * 我们不用 Gradle，所以第三方库要自己铺开。一个 .aar 其实就是个 zip：
 *
 *   classes.jar        → 编译期 join classpath + 运行期丢给 d8
 *   res/               → 用 aapt2 compile 一起编进去
 *   AndroidManifest.xml→ 权限 / uses-sdk，人工核对后写进我们自己的 manifest（不自动合并）
 *   jni/               → 有 .so 的话得塞进 APK 的 lib/<abi>/（本项目用到的几个都没有）
 *
 * 这里只做前两步；manifest 合并太容易出错，宁可少一个权限也别搞乱现有配置。
 */
const LIBS = path.join(HERE, 'libs');

/**
 * 「瘦身」白名单：aar 文件名**前缀** → 要保留的 class 前缀。没命中任何前缀的 aar 原样全量引入。
 * ⚠️ 用前缀而不是全名，是因为 aar 文件名带版本号（media3-ui-1.4.1），
 *    按全名写的话升个版本这条规则就静默失效了 —— 而它失效的表现是「包突然大了几十 KB」，
 *    不会报错，很容易一直没人发现。
 * ⚠️ 加进来之前先想清楚：这个 aar 是不是真的只用到那一小块。
 *    漏了内部类/匿名类会在运行期以 NoClassDefFoundError 出现（编译期看不出来），
 *    所以这里用 startsWith 前缀匹配，把 $ 开头的内部类一并捞进来。
 */
const SLIM = {
  // 只用 AspectRatioFrameLayout（三种缩放模式）；其余 PlayerView/SubtitleView/DefaultTimeBar 等一概不要。
  'media3-ui': ['androidx/media3/ui/AspectRatioFrameLayout'],
};

/** 按前缀在 SLIM 里找规则 */
function slimRule(aarName) {
  for (const k of Object.keys(SLIM)) if (aarName.startsWith(k)) return SLIM[k];
  return null;
}

function collectAars() {
  const aars = fs.existsSync(LIBS)
    ? fs.readdirSync(LIBS).filter((f) => f.endsWith('.aar')).sort()
    : [];
  const jars = fs.existsSync(LIBS)
    ? fs.readdirSync(LIBS).filter((f) => f.endsWith('.jar')).sort()
    : [];
  return { aars: aars.map((f) => path.join(LIBS, f)), jars: jars.map((f) => path.join(LIBS, f)) };
}

/** 把 aar 里的 classes.jar 抽到 build/aar-classes/<name>.jar */
function extractAarClasses(aars, outDir) {
  rmrf(outDir); mkdirp(outDir);
  const jars = [];
  for (const aar of aars) {
    const name = path.basename(aar, '.aar');
    const dest = path.join(outDir, name + '.jar');
    // 注意用 readFile：read() 给的是原始 deflate 数据，直接写出去会是个坏 jar
    const data = zip.readFile(aar, 'classes.jar');
    if (!data) { log('      ' + name + ' 没有 classes.jar，跳过'); continue; }

    // 「瘦身」：SLIM 里的 aar 只保留白名单前缀的 class，其余丢掉。
    // 起因是 media3-ui：我们只用它一个 AspectRatioFrameLayout，
    // 但它那 440KB / 89 个 class 里还带着 PlayerView、SubtitleView、一堆 View 和
    // recyclerview 依赖 —— 全塞进 dex 纯属浪费，而且会把 dex 撑大、方法数也无谓增加。
    // 所以只捞需要的那个类（连它的内部类 / 匿名类一起，按前缀匹配）。
    const slim = slimRule(name);
    // jni/*.so 有的话要单独收集（本项目目前的依赖都没有）
    const sos = zip.readAll(aar).filter((e) => /^jni\/[^/]+\/.+\.so$/.test(e.name));
    if (sos.length) {
      for (const s of sos) {
        const abi = s.name.split('/')[1];
        const p = path.join(outDir, '..', 'jni', abi, path.basename(s.name));
        mkdirp(path.dirname(p));
        fs.writeFileSync(p, s.data);
      }
      log('      ' + name + '：抽出 ' + sos.length + ' 个 .so');
    }

    if (!slim) { fs.writeFileSync(dest, data); jars.push(dest); continue; }

    // 嵌套 jar 要先落盘：zip.readAll 收的是**文件路径**，不是内存 Buffer
    const tmpJar = path.join(outDir, name + '.src.jar');
    fs.writeFileSync(tmpJar, data);
    const all = zip.readAll(tmpJar);
    const keep = all.filter((e) => e.data != null && slim.some((p) => e.name.startsWith(p)));
    if (!keep.length) fatal('瘦身白名单一个都没匹配上：' + name + '\n        ' + slim.join(', '));
    // 必须用 deflated()：readAll 给的条目没有 crc/usize，直接喂给 write() 会写出坏 jar。
    // 注意 zip.write(dest, entries) 是**自己写盘**的，不返回 Buffer。
    zip.write(dest, keep.map((e) => zip.deflated(e.name, e.data)));
    fs.unlinkSync(tmpJar);
    jars.push(dest);
    log('      ' + name + '：瘦身 ' + all.length + ' → ' + keep.length + ' 个 class');
  }
  return jars;
}

/** 把 aar 里的 res/ 解到 build/aar-res/<name>/，交给 aapt2 compile */
function extractAarRes(aars, outDir) {
  rmrf(outDir); mkdirp(outDir);
  let n = 0;
  for (const aar of aars) {
    const name = path.basename(aar, '.aar');
    // 瘦身过的 aar 资源也一并跳过：media3-ui 的 layout/ 里全是 PlayerView 之类用不到的布局，
    // 还有几十个 values-xx 语言目录，编进去只是白占体积。它需要的 resize_mode 属性
    // 已在 res/values/attrs.xml 里自己声明了。
    if (slimRule(name)) { log('      ' + name + '：资源跳过（已瘦身）'); continue; }
    for (const e of zip.readAll(aar)) {
      if (!e.name.startsWith('res/') || e.name.endsWith('/') || e.data == null) continue;
      const p = path.join(outDir, name, e.name);
      mkdirp(path.dirname(p));
      fs.writeFileSync(p, e.data);
      n++;
    }
  }
  return n;
}

/** Windows 下工具都带 .exe */
const exe = (p) => (process.platform === 'win32' && fs.existsSync(p + '.exe') ? p + '.exe' : p);

// --------------------------------------------------- 找 JDK / Android SDK

function findJavaHome() {
  const home = process.env.JAVA_HOME;
  if (home && fs.existsSync(path.join(home, 'bin', exeName()))) return home;

  const bases = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs'),
    'C:/Program Files/Java',
    'C:/Program Files/Eclipse Adoptium',
    'C:/Program Files/Microsoft',
    'C:/Program Files/Android/Android Studio',
  ];
  const found = [];
  for (const b of bases) {
    if (!b || !fs.existsSync(b)) continue;
    for (const name of fs.readdirSync(b)) {
      const p = path.join(b, name);
      const bin = fs.existsSync(path.join(p, 'bin', exeName()))
        ? path.join(p, 'bin')
        : fs.existsSync(path.join(p, 'jbr', 'bin', exeName())) ? path.join(p, 'jbr', 'bin') : null;
      if (bin) {
        // Android Studio 的 jbr 排后面，优先用正规 JDK
        found.push({ home: path.dirname(bin), rank: /jbr/i.test(bin) ? 1 : 0 });
      }
    }
  }
  found.sort((a, b) => a.rank - b.rank);
  if (found.length) return found[0].home;
  fatal('找不到 JDK。装一个 JDK 17 并设好 JAVA_HOME（或放在 %LOCALAPPDATA%\\Programs 下）。');
}

function exeName() {
  return process.platform === 'win32' ? 'java.exe' : 'java';
}

function findSdk() {
  const cands = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null,
    'C:/Android/Sdk',
    process.env.HOME ? path.join(process.env.HOME, 'Android', 'Sdk') : null,
  ];
  for (const c of cands) {
    if (c && fs.existsSync(path.join(c, 'build-tools')) && fs.existsSync(path.join(c, 'platforms'))) return c;
  }
  fatal('找不到 Android SDK。装好 SDK 后设 ANDROID_HOME 指向它。');
}

const verNum = (v) => v.split('.').map(Number).reduce((a, b) => a * 1000 + b, 0);

function pickBuildTools(sdk) {
  const dir = path.join(sdk, 'build-tools');
  const vs = fs.readdirSync(dir).filter((v) => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => verNum(a) - verNum(b));
  if (!vs.length) fatal('build-tools 目录是空的，用 sdkmanager 装一个（如 build-tools;34.0.0）。');
  const v = vs[vs.length - 1];
  return path.join(dir, v);
}

function pickAndroidJar(sdk, wantApi) {
  const dir = path.join(sdk, 'platforms');
  const vs = fs.readdirSync(dir).filter((v) => /^android-\d+$/.test(v))
    .map((v) => ({ v, n: parseInt(v.slice(8), 10) })).sort((a, b) => a.n - b.n);
  if (!vs.length) fatal('platforms 目录是空的，用 sdkmanager 装一个（如 platforms;android-34）。');
  const exact = vs.find((x) => x.n === wantApi);
  const pick = exact || vs[vs.length - 1];
  const jar = path.join(dir, pick.v, 'android.jar');
  if (!fs.existsSync(jar)) fatal('android.jar 不存在：' + jar);
  return { jar, api: pick.n };
}

/** 猜一个局域网地址当默认值，猜不到就让用户在 App 里填 */
function guessLanUrl(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (/virtual|vmware|vbox|hyper|loopback|docker|tailscale|zerotier|wsl|bluetooth/i.test(name)) continue;
      out.push(a.address);
    }
  }
  const priv = out.find((ip) => /^192\.168\./.test(ip)) || out.find((ip) => /^10\./.test(ip))
    || out.find((ip) => /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) || out[0];
  return priv ? 'http://' + priv + ':' + port : null;
}

// ---------------------------------------------------------------- 参数

/* 内置 CloudDrive2 引擎（手机本地跑的网盘聚合服务）的 native 可执行文件放哪、打哪些 ABI。
 *
 * 🔴 为什么必须打进 `lib/<abi>/`、而不能放 assets 或启动时下载：
 *    Android 10（API 29）起，**应用私有目录里的文件不允许被 execve**
 *    （SELinux 的 W^X：可写目录不可执行）。所以「首次运行时下载二进制再执行」这条路是死的。
 *    唯一能被执行的、属于本应用的路径是 `nativeLibraryDir`（即 APK 的 `lib/<abi>/`）——
 *    系统在安装时把 .so 解压到那里，那个目录是可执行的。
 *    ⚠️ 这要求 AndroidManifest 里 **`android:extractNativeLibs="true"`**
 *       （否则 .so 不从 APK 落地，nativeLibraryDir 指向包内，没法当独立进程跑）。
 *
 * 来源：libclouddrive.so 从 CloudDrive2 官方安卓 APK（v1.0.5）的
 *   assets/bin/aarch64|x86_64/clouddrive 提取（引擎是独立可执行文件，无 JNI 依赖）。
 * 体积：arm64 约 22MB、x86_64 约 24MB —— 比原 libopenlist.so（92MB）小一大截。
 *   两个都打进去没必要 —— 真机是 arm64，模拟器是 x86_64，
 *   所以做成 `--abi=` 可选，**默认只打 arm64**，出模拟器测试包时显式 `--abi=x86_64`。
 */
const ABI_DIRS = ['arm64-v8a', 'x86_64', 'armeabi-v7a'];
const DEFAULT_ABI = 'arm64-v8a';
const JNI_DIR = path.join(__dirname, 'jniLibs');

function parseArgs() {
  const o = {
    port: 8080, out: path.join(ROOT, 'douyin-nas.apk'), clean: false,
    abi: DEFAULT_ABI, noBump: false, versionPinned: false,
  };
  for (const a of process.argv.slice(2)) {
    if (a === '--clean') o.clean = true;
    // 反复打同一个版本号（调试用）：不涨、也不写回 build.js
    else if (a === '--no-bump') o.noBump = true;
    else if (a.startsWith('--default-url=')) o.defaultUrl = a.slice(14);
    else if (a.startsWith('--port=')) o.port = a.slice(7);
    else if (a.startsWith('--out=')) o.out = path.resolve(ROOT, a.slice(6));
    /* ⚠️ 相对路径按 **ROOT（项目根）** 解析，不是按 cwd。
       原来这里是裸 `a.slice(6)` —— 从 android/ 目录跑 `--out=douyin-nas-x86_64.apk`
       会把包写进 `android/`，而项目根下**同名的旧包**还在，于是
       `adb install douyin-nas-x86_64.apk` 装的是上一次的旧版本
       （实测撞到过：APK 里 versionCode=22，而 build.js 已经涨到 25）。
       这和 §68「交付时发错 ABI 的包」是同一类事故 —— 默认值本来就是绝对路径，
       相对路径跟着对齐才不会有两种解释。 */
    else if (a.startsWith('--abi=')) o.abi = a.slice(6);
    else if (a.startsWith('--min-api=')) APP.minApi = parseInt(a.slice(10), 10);
    else if (a.startsWith('--target-api=')) APP.targetApi = parseInt(a.slice(13), 10);
    // 显式指定版本号 → 跳过自增（但会把这个值写回去，当新基线）
    else if (a.startsWith('--version-name=')) { APP.versionName = a.slice(15); o.versionPinned = true; }
    else if (a.startsWith('--version-code=')) { APP.versionCode = parseInt(a.slice(15), 10); o.versionPinned = true; }
    else fatal('不认识的参数：' + a);
  }
  if (!ABI_DIRS.includes(o.abi)) {
    fatal('不支持的 --abi=' + o.abi + '（可选：' + ABI_DIRS.join(' / ') + '）');
  }
  if (!o.defaultUrl) o.defaultUrl = guessLanUrl(o.port) || 'http://192.168.1.100:8080';
  return o;
}

// ------------------------------------------------------------ 生成资源

function genResources(defaultUrl) {
  rmrf(GEN_RES);
  mkdirp(path.join(GEN_RES, 'values'));
  fs.writeFileSync(
    path.join(GEN_RES, 'values', 'build_default.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
    + '    <!-- 由 build.js 生成，勿手改 -->\n'
    + '    <string name="default_server_url" translatable="false">' + defaultUrl + '</string>\n'
    + '</resources>\n',
    'utf8'
  );
  for (const [d, size] of DENSITIES) {
    const dir = path.join(GEN_RES, 'mipmap-' + d);
    mkdirp(dir);
    fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png.icon(size));
  }
  ok('默认地址 ' + defaultUrl);
  ok('启动图标 ' + DENSITIES.map(([d]) => d).join(' / '));
}

// ---------------------------------------------------------------- 组装

/**
 * 打 APK 时要**从 public/ 里剔掉**的路径。
 *
 * 目前只有一样东西：`samples/`（五个演示用 mp4，共约 8.5MB）。
 *
 * 为什么要剔（2026-09-18 Phase L）：
 *   public/samples/*.mp4 是**电脑版 Node 后端**的演示片源（server.js 的
 *   DEMO_META / demoPayload 会列它们、/samples/* 会把它们流出去）。
 *   但 APK 侧的 demoPayload()（NasServer.java）返回的是**空数组** ——
 *   手机端从来不提供演示片源，只显示「去设置里配 NAA 地址」的空态。
 *   所以这 8.5MB 打进 APK 里是**死重量**：占了 82% 的体积，却没有任何代码能取到它。
 *
 *   剔掉之后 APK 从 ~10.3MB 回到 ~1.9MB。这也正是 Phase L 记录的 8413.8 KB
 *   那版的做法 —— 之前搬去解码服务时改动了打包逻辑，把这层过滤弄丢了。
 *
 * ⚠️ 如果哪天手机端也要支持演示片源，**不要**直接把这个过滤删掉：
 *    那等于凭空给 APK 加回 8.5MB。要么改成打压缩率更高的短样片，
 *    要么让 App 首次启动时按需下载。
 */
const ASSET_EXCLUDE_DIRS = ['samples/'];

/** 把 public/ 目录（前端网页）收集成 assets 条目：assets/xxx */
function collectAssets() {
  const src = path.join(ROOT, 'public');
  const out = [];
  if (!fs.existsSync(src)) return out;
  let skipped = 0, skippedBytes = 0;
  const walkDir = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const name = prefix + e.name;
      if (e.isDirectory()) {
        // 整个目录不在打包范围内就直接不进去（省一次遍历）
        if (ASSET_EXCLUDE_DIRS.includes(name + '/')) {
          for (const f of fs.readdirSync(p, { withFileTypes: true })) {
            if (f.isFile()) { skipped++; skippedBytes += fs.statSync(path.join(p, f.name)).size; }
          }
          continue;
        }
        walkDir(p, name + '/');
      } else if (e.isFile()) {
        out.push(zip.deflated('assets/' + name, fs.readFileSync(p)));
      }
    }
  };
  walkDir(src, '');
  if (skipped) {
    log('      剔除 assets：' + skipped + ' 个文件 / '
      + (skippedBytes / 1024 / 1024).toFixed(1) + 'MB（'
      + ASSET_EXCLUDE_DIRS.join(', ') + ' —— 手机端用不到，见 ASSET_EXCLUDE_DIRS 注释）');
  }
  return out;
}

/** 把 android/assets/ 下的文件收成 `assets/<name>` 条目。
 *
 * 现在这里面只有一个东西：`cd2wwwroot.zip` —— CloudDrive2 管理页的静态文件
 * （官方 APK 的 assets/wwwroot.zip 原样搬进来，MainActivity 启动引擎前解压到
 * CLOUDDRIVE_HOME，没有它管理页就是一片 404 黑屏 —— 见 ensureCd2Wwwroot）。
 * 用 deflated 就行：它由我们自己在运行时解压，不走 mmap。
 */
function collectAndroidAssets() {
  const src = path.join(HERE, 'assets');
  const out = [];
  if (!fs.existsSync(src)) return out;
  const walkDir = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const name = prefix + e.name;
      if (e.isDirectory()) walkDir(p, name + '/');
      else out.push(zip.deflated('assets/' + name, fs.readFileSync(p)));
    }
  };
  walkDir(src, '');
  return out;
}

/** 把 android/jniLibs/<abi>/*.so 收集成 `lib/<abi>/xxx` 条目（**必须 STORED**）。
 *
 * 现在这里面只有一个东西：`libclouddrive.so` —— CloudDrive2 引擎（见 JNI_DIR 注释）。
 * ⚠️ native 可执行文件**不能压缩**（method=0）：一是 `zipalign -p` 的页对齐要求，
 *    二是系统按 mmap 加载 native 库，压缩条目它不认（`sanityCheck` 会卡）。
 */
function collectJniLibs(abi) {
  const src = path.join(JNI_DIR, abi);
  const out = [];
  if (!fs.existsSync(src)) {
    log('      ⚠️ jniLibs/' + abi + ' 不存在 —— 这个包不会有内置 CloudDrive2');
    return out;
  }
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const p = path.join(src, e.name);
    const mb = (fs.statSync(p).size / 1024 / 1024).toFixed(1);
    out.push(zip.stored('lib/' + abi + '/' + e.name, fs.readFileSync(p)));
    log('      内置 ' + abi + '/' + e.name + '：' + mb + 'MB（STORED）');
  }
  return out;
}

function assemble(dexFiles, aaptApk, apkOut, abi) {
  const entries = zip.read(aaptApk);
  const seen = new Set(entries.map((e) => e.name));
  for (const d of dexFiles) {
    const name = path.basename(d);
    if (seen.has(name)) continue;
    entries.push(zip.deflated(name, fs.readFileSync(d)));
  }
  // 前端网页打进 assets/（WebView 走本地 HTTP 服务加载）
  for (const a of collectAssets()) {
    if (seen.has(a.name)) continue;
    entries.push(a);
  }
  // 内置 CloudDrive2 引擎的 native 可执行文件 → lib/<abi>/（必须 STORED，见 JNI_DIR 注释）
  for (const a of collectJniLibs(abi)) {
    if (seen.has(a.name)) continue;
    entries.push(a);
  }
  // android/assets/（cd2wwwroot.zip 等）→ assets/（运行时由 App 自己解压）
  for (const a of collectAndroidAssets()) {
    if (seen.has(a.name)) continue;
    entries.push(a);
  }
  // ⚠️ 这里原来还有一段 `for (const a of collectFfmpegAssets())`，
  //    把 30MB 的 ffmpeg/ffprobe 以 STORED 打进 assets/ffmpeg/。
  //    2026-09-18 转码搬到 NAS 的 Docker 解码服务后整段删除 —— 见上方 FFMPEG_BIN 的注释。
  // resources.arsc 必须在最前面（部分 ROM 会按顺序找）
  const arsc = entries.filter((e) => e.name === 'resources.arsc');
  const rest = entries.filter((e) => e.name !== 'resources.arsc');
  const ordered = arsc.concat(rest);
  zip.write(apkOut, ordered);
  return ordered;
}

/** 按无 Gradle 打包的老经验自检：resources.arsc 不能是压缩的，否则装上就崩 */
function sanityCheck(apk, abi) {
  const entries = zip.read(apk);
  const arsc = entries.find((e) => e.name === 'resources.arsc');
  if (!arsc) fatal('APK 里没有 resources.arsc');
  if (arsc.method !== 0) fatal('resources.arsc 被压缩了（method=' + arsc.method + '），系统会拒绝加载');
  for (const e of entries) {
    if (e.name.startsWith('lib/') && e.name.endsWith('.so') && e.method !== 0) {
      fatal('native 库必须是 STORED：' + e.name);
    }
  }
  /* 正向：内置 CloudDrive2 引擎必须在这个包里，而且是**当前 ABI** 的那份。
     ⚠️ 少了它，App 照样能装、能跑、首页也正常 —— 只是「内置网盘」那一路永远连不上，
        属于最难查的「功能半死」（§17 那类假按钮的进程版），所以这里硬卡。 */
  const cd2Name = 'lib/' + abi + '/libclouddrive.so';
  const cd2 = entries.find((e) => e.name === cd2Name);
  if (!cd2) {
    fatal('APK 里没有 ' + cd2Name + ' —— 内置的 CloudDrive2 引擎没进包。'
      + '检查 android/jniLibs/' + abi + '/ 是否就位，以及 assemble() 有没有调 collectJniLibs()。');
  }
  // ⚠️ 反向检查：内置 Alist（OpenList）**必须不在**包里 —— 2026-09-19 已整体移除，
  //    Alist 走 115 老接口风控太频繁。哪次改动不小心把它带回来了，这里当场 fail。
  for (const e of entries) {
    if (/libopenlist/i.test(e.name)) {
      fatal('APK 里出现了 ' + e.name + ' —— 内置 Alist 已于 2026-09-19 移除（改用 CloudDrive2 引擎）。');
    }
  }
  // ⚠️ 管理页静态文件也必须在包里 —— 少了它 WebDAV 照样能用，
  //    但「打开 CloudDrive2 管理」就是一片 404 黑屏（又一个功能半死，2026-09-19 真撞过）。
  if (!entries.find((e) => e.name === 'assets/cd2wwwroot.zip')) {
    fatal('APK 里没有 assets/cd2wwwroot.zip —— CloudDrive2 管理页会 404 黑屏。'
      + '检查 android/assets/cd2wwwroot.zip 是否就位，以及 assemble() 有没有调 collectAndroidAssets()。');
  }
  // ⚠️ 反向检查：内嵌 ffmpeg **必须不在**包里。
  //    删掉的是 30MB 的解码能力，如果哪次改动不小心又把 assets/ffmpeg 放回去，
  //    体积会悄悄涨回去 —— 这里显式 fail，别让「APK 变胖」无声发生。
  //    （decode-server/ 目录还留着做参考，但 APK 已经完全解耦、不再提它。）
  for (const n of ['assets/ffmpeg/ffmpeg', 'assets/ffmpeg/ffprobe']) {
    if (entries.find((x) => x.name === n)) {
      fatal('APK 里又出现了 ' + n + ' —— 内嵌解码已于 2026-09-18 移除。'
        + 'APK 现在不转码（Phase L：单机自包含，靠原生解码 + 原生 seek）。');
    }
  }
  // ⚠️ 反向检查：演示样片**必须不在**包里（2026-09-18 Phase L）。
  //    它曾经悄悄回归过一次：打包逻辑改动时把 public/samples 一起收进来了，
  //    APK 从 1.9MB 涨到 10.3MB（那五个 mp4 占 8.5MB），而且**没有任何代码能取到**——
  //    手机端的 demoPayload() 返回空数组，这 8.5MB 是纯死重量。
  //    这种「功能没变、体积翻五倍」的回归最难发现，所以这里显式卡住。
  const sampleEntries = entries.filter((e) => e.name.startsWith('assets/samples/'));
  if (sampleEntries.length) {
    const mb = (sampleEntries.reduce((s, e) => s + e.file_size, 0) / 1024 / 1024).toFixed(1);
    fatal('APK 里混进了 ' + sampleEntries.length + ' 个演示样片（' + mb + 'MB）'
      + '，手机端用不到它们（demoPayload() 返回空数组）。'
      + '检查 build.js 的 ASSET_EXCLUDE_DIRS 是不是被删了。');
  }
  const dexes = entries.filter((e) => /^classes\d*\.dex$/.test(e.name));
  if (!dexes.length) fatal('APK 里没有 classes.dex');
  return { entries, dexes };
}

// ---------------------------------------------------------------- 主流程

function main() {
  const t0 = Date.now();
  const o = parseArgs();

  const javaHome = findJavaHome();
  const sdk = findSdk();
  const bt = pickBuildTools(sdk);
  const { jar: androidJar, api: platformApi } = pickAndroidJar(sdk, APP.targetApi);
  const java = path.join(javaHome, 'bin', exe('java'));
  const keytool = path.join(javaHome, 'bin', exe('keytool'));
  const aapt2 = exe(path.join(bt, 'aapt2'));
  const zipalign = exe(path.join(bt, 'zipalign'));
  const d8Jar = path.join(bt, 'lib', 'd8.jar');
  const signerJar = path.join(bt, 'lib', 'apksigner.jar');
  for (const p of [aapt2, zipalign, d8Jar, signerJar, androidJar]) {
    if (!fs.existsSync(p)) fatal('缺少工具：' + p);
  }

  log('\x1b[1mNAS 短视频 · 打包 APK\x1b[0m');
  log('  JDK        ' + javaHome);
  log('  Android SDK ' + sdk + '  (build-tools ' + path.basename(bt) + ', ' + path.basename(dirOf(androidJar)) + ')');
  log('  目标       min ' + APP.minApi + ' / target ' + APP.targetApi + ', 平台 android-' + platformApi);
  log('  默认地址   ' + o.defaultUrl);

  // 版本号：每次打包自动涨（--no-bump 保持 / --version-name= 手动指定）
  bumpVersion(o);

  // manifest 与 build.js 的 minSdk 必须一致（不一致的后果很隐蔽，见 checkManifestMinSdk 注释）
  checkManifestMinSdk();

  if (o.clean) { rmrf(BUILD); ok('已清空 build/'); }
  for (const d of [GEN_RES, GEN_JAVA, OBJ, DEX]) mkdirp(d);

  // 0) 第三方库（aar / jar）—— 没有 Gradle，得自己铺开
  step(0, '依赖 —— 展开 android/libs 里的 aar');
  const AAR_CLASSES = path.join(BUILD, 'aar-classes');
  const AAR_RES = path.join(BUILD, 'aar-res');
  const { aars, jars: rawJars } = collectAars();
  const depJars = extractAarClasses(aars, AAR_CLASSES).concat(rawJars);
  const aarResCount = extractAarRes(aars, AAR_RES);
  if (!aars.length && !rawJars.length) log('      （没有第三方依赖）');
  else ok(aars.length + ' 个 aar + ' + rawJars.length + ' 个 jar → ' + depJars.length + ' 个 classes.jar，' + aarResCount + ' 个资源');

  // 关键运行期依赖的兜底检查。
  // ⚠️ 这行是拿血换来的：ExoPlayer/Media3 **不是**自包含的，它的 core/common/extractor/datasource
  //    全都在用 Guava（ImmutableList / Futures / Multimap / Suppliers / HttpHeaders …）。
  //    只加减了播放器的 aar 时，**javac 和 d8 都不会报错**（那些类只是没被解析到），
  //    编译一路绿、APK 照出，直到真机上一点播放就 NoClassDefFoundError 崩掉。
  //    所以这里显式拦一道，缺了就当场失败，别等装到手机上才发现。
  const GUAVA_NEEDED = ['base/Charsets', 'collect/ImmutableList', 'util/concurrent/Futures'];
  const haveGuava = rawJars.concat(depJars).some((j) => {
    try { return GUAVA_NEEDED.every((c) => zip.readAll(j).some((e) => e.name === 'com/google/common/' + c + '.class')); }
    catch (e) { return false; }
  });
  // 认得老包名（com.google.android.exoplayer2）和新包名（androidx.media3）两代，
  // 因为项目历史上这两套都用过，检查不能只认其中一个。
  const usesPlayer = depJars.some((j) => {
    try {
      return zip.readAll(j).some((e) =>
        /^com\/google\/android\/exoplayer2\/ExoPlayer\.class$/.test(e.name)
        || /^androidx\/media3\/exoplayer\/ExoPlayer\.class$/.test(e.name));
    } catch (e) { return false; }
  });
  if (usesPlayer && !haveGuava) {
    fatal('libs 里缺 guava：Media3 / ExoPlayer 运行期必须要有它（见 build.js 里这段注释）。\n'
      + '        取一份 android 变体放进 android/libs/ 即可：\n'
      + '        curl -sL -o android/libs/guava-32.1.3-android.jar \\\n'
      + '          https://repo1.maven.org/maven2/com/google/guava/guava/32.1.3-android/guava-32.1.3-android.jar');
  }
  if (usesPlayer) ok('Guava 在位（Media3 / ExoPlayer 的运行期依赖）');

  // Media3 还额外硬依赖 androidx.collection（AsynchronousMediaCodecAdapter 用了 CircularIntArray，
  // 而那个适配器会被 DefaultMediaCodecAdapterFactory 用到 → 一定会加载）。同样只能运行期炸。
  // ⚠️ 必须用 collection 的 **jar 变体**：1.4.x 的 .jar 是 KMP 产物，里面只有 linkdata 没有 .class。
  if (usesPlayer) {
    const haveCollection = rawJars.concat(depJars).some((j) => {
      try { return zip.readAll(j).some((e) => e.name === 'androidx/collection/CircularIntArray.class'); }
      catch (e) { return false; }
    });
    if (!haveCollection) {
      fatal('libs 里缺 androidx.collection：Media3 的 AsynchronousMediaCodecAdapter 要用 CircularIntArray。\n'
        + '        curl -sL -o android/libs/collection-1.2.0.jar \\\n'
        + '          https://dl.google.com/dl/android/maven2/androidx/collection/collection/1.2.0/collection-1.2.0.jar');
    }
    ok('androidx.collection 在位（Media3 的运行期依赖）');
  }

  // 1) 资源
  step(1, 'aapt2 compile —— 编译资源');
  genResources(o.defaultUrl);
  const resZip = path.join(BUILD, 'res.zip');
  const genZip = path.join(BUILD, 'gen-res.zip');
  const aarResZip = path.join(BUILD, 'aar-res.zip');
  run(aapt2, ['compile', '--dir', path.join(HERE, 'res'), '-o', resZip]);
  run(aapt2, ['compile', '--dir', GEN_RES, '-o', genZip]);
  if (aarResCount) run(aapt2, ['compile', '--dir', AAR_RES, '-o', aarResZip]);
  ok('资源编译完成');

  // 2) 链接 + 生成 R.java
  step(2, 'aapt2 link —— 链接资源，产出基础 APK');
  const baseApk = path.join(BUILD, 'base.apk');
  const linkArgs = [
    'link', '-o', baseApk,
    '-I', androidJar,
    '--manifest', path.join(HERE, 'AndroidManifest.xml'),
    '--java', GEN_JAVA,
    '--min-sdk-version', String(APP.minApi),
    '--target-sdk-version', String(APP.targetApi),
    '--version-code', String(APP.versionCode),
    '--version-name', APP.versionName,
  ];
  // 第三方库的 R 也要能被引用到；--auto-add-overlay 允许同名资源覆盖
  if (aarResCount) linkArgs.push('--auto-add-overlay');
  linkArgs.push(resZip, genZip);
  if (aarResCount) linkArgs.push(aarResZip);
  run(aapt2, linkArgs);
  const rJava = walk(GEN_JAVA, 'R.java');
  if (!rJava.length) fatal('aapt2 没有生成 R.java');
  ok('基础 APK + R.java');

  // 3) 编译 Java
  step(3, 'javac —— 编译 Java 源码');
  const sources = walk(path.join(HERE, 'src'), '.java').concat(rJava);
  run(path.join(javaHome, 'bin', exe('javac')), [
    '-source', '8', '-target', '8', '-Xlint:-options',
    '-encoding', 'UTF-8',
    '-classpath', [androidJar, ...depJars].join(path.delimiter),
    '-d', OBJ,
    ...sources,
  ]);
  ok(sources.length + ' 个源文件 → ' + walk(OBJ, '.class').length + ' 个 class');

  // 4) 转 dex
  step(4, 'd8 —— 转成 Dalvik 字节码');
  rmrf(DEX); mkdirp(DEX);
  // 子进程能申请的内存有限，d8 默认要 1G+ 会直接 OOM（"Could not reserve enough space"）。
  // 256m + SerialGC 够跑这几个类，且不会去申请大块连续虚拟内存。
  run(java, [
    ...JVM_SMALL,
    '-cp', d8Jar, 'com.android.tools.r8.D8',
    '--release', '--lib', androidJar, '--min-api', String(APP.minApi),
    '--output', DEX,
    ...walk(OBJ, '.class'),
    ...depJars,
  ]);
  const dexFiles = walk(DEX, '.dex');
  if (!dexFiles.length) fatal('d8 没有产出 .dex');
  ok(dexFiles.map((d) => path.basename(d)).join(', '));

  // 5) 组装
  step(5, '组装 —— 把 dex 塞进基础 APK');
  const unsigned = path.join(BUILD, 'unsigned.apk');
  const entries = assemble(dexFiles, baseApk, unsigned, o.abi);
  const chk = sanityCheck(unsigned, o.abi);
  ok(entries.length + ' 个条目（' + chk.dexes.length + ' 个 dex，resources.arsc 未压缩）');

  // 6) 对齐
  step(6, 'zipalign —— 4 字节对齐');
  const aligned = path.join(BUILD, 'aligned.apk');
  run(zipalign, ['-f', '-p', '4', unsigned, aligned]);
  ok('对齐完成');

  // 7) 签名
  step(7, 'apksigner —— 签名');
  if (!fs.existsSync(APP.keystore)) {
    run(keytool, [
      '-genkeypair', '-keystore', APP.keystore,
      '-alias', APP.ksAlias,
      '-storepass', APP.ksPass, '-keypass', APP.ksPass,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
      '-dname', 'CN=Android Debug,O=Android,C=US',
    ]);
    ok('已生成 debug.keystore（升级安装要一直用它，别删）');
  }
  mkdirp(path.dirname(o.out));
  run(java, [
    ...JVM_SMALL,
    '-cp', signerJar, 'com.android.apksigner.ApkSignerTool', 'sign',
    '--ks', APP.keystore,
    '--ks-pass', 'pass:' + APP.ksPass,
    '--key-pass', 'pass:' + APP.ksPass,
    '--ks-key-alias', APP.ksAlias,
    '--min-sdk-version', String(APP.minApi),
    '--out', o.out, aligned,
  ]);
  const verify = run(java, [
    ...JVM_SMALL,
    '-cp', signerJar, 'com.android.apksigner.ApkSignerTool', 'verify',
    '--min-sdk-version', String(APP.minApi), '--verbose', o.out,
  ], { capture: true });
  if (!/Verified using v\d+ scheme/.test(verify || '')) fatal('签名校验没过：\n' + verify);
  ok('签名校验通过');

  const size = fs.statSync(o.out).size;
  const sha = crypto.createHash('sha256').update(fs.readFileSync(o.out)).digest('hex');
  log('\n\x1b[32m完成\x1b[0m  ' + o.out);
  log('       ' + (size / 1024).toFixed(1) + ' KB,  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  log('       sha256 ' + sha);
  log('\n装到手机： adb install -r "' + o.out + '"');
  log('（手机与电脑在同一 WiFi 下；App 里如果连不上，按返回键 → 服务器设置改地址）');
}

function dirOf(p) { return path.dirname(p); }

main();
