#!/usr/bin/env node
/**
 * NAS 短视频 · 多设备同步服务端（**只存用户资料**，不含播放器/WebDAV/扫描）
 * ---------------------------------------------------------------------------
 *   node sync-server.js
 *   PORT=8099 NAS_DATA_DIR=/volume1/nas-douyin-sync node sync-server.js
 *   SYNC_ALLOW_REGISTER=0 node sync-server.js      # 关掉注册（只可登录）
 *
 * 它只做一件事：替你的多台设备**存**这些东西，并在设备之间做合并：
 *   · 点赞 / 收藏 / 坏码流名单      → 按时间戳取新，删除留 60 天墓碑
 *   · 昵称 / 头像                   → 改过才推，按时间戳取新
 *   · 片源 / 监控清单 / 扫描间隔    → 并集（只补不删）
 *   · strm 备份包                   → 每个账号存一份 zip（不解析，只当字节存着）
 *
 * 没有网页界面、不代理视频、不连你的 WebDAV —— 手机 App 只是把它当个「云上的小抽屉」。
 * 不配这一项，App 一切照常，数据只在本机。
 *
 * 接口（全部带 CORS，手机 App 直连这个地址）：
 *   POST /api/auth/register   注册（可用 SYNC_ALLOW_REGISTER=0 关掉）
 *   POST /api/auth/login      登录   → { token }
 *   GET  /api/auth/me         我是谁（用来验 token 还活着）
 *   POST /api/auth/logout     退出（作废当前 token）
 *   POST /api/auth/pass       改密码（作废该账号的全部 token）
 *   GET  /api/sync/pull       拉全量
 *   POST /api/sync/push       推增量（服务端合并后回全量）
 *   GET  /api/sync/strm       下载账号里的 strm 备份包
 *   PUT  /api/sync/strm       上传 strm 备份包（校验 zip 魔数）
 *   GET  /health              健康检查
 *
 * 存储：数据目录下 sync/accounts.json（账号） + sync/u-<名字>.json（数据）
 *       + sync/u-<名字>.strm.zip（备份包）。
 *       用户名被拼进文件名 → SYNC_NAME_RE 白名单是目录穿越的**唯一防线**，别放宽到允许斜杠。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DATA_DIR = process.env.NAS_DATA_DIR ? path.resolve(process.env.NAS_DATA_DIR) : path.join(ROOT, 'data');
const SYNC_DIR = path.join(DATA_DIR, 'sync');
const DB_FILE = path.join(SYNC_DIR, 'accounts.json');

const PORT = Number(process.env.PORT) || 8099;
const TOKEN_TTL = 180 * 24 * 3600 * 1000;      // token 半年
const BODY_MAX = 8 * 1024 * 1024;              // 同步请求体上限（头像 base64 可能几百 KB）
const ZIP_MAX = 64 * 1024 * 1024;              // strm 备份包上限
const TOMB_KEEP = 60 * 24 * 3600 * 1000;       // 删除墓碑保留 60 天
const SYNC_NAME_RE = /^[A-Za-z0-9_.\-\u4e00-\u9fa5]{1,32}$/;
/* 默认开放注册（第一次部署总得有个账号）。这个服务一旦能从公网访问，
   开着注册就等于把「往你 NAS 写数据」的入口公开 —— 虽然账号之间隔离、别人看不到你的数据，
   但能占你的盘。关掉后已有账号照常登录。 */
const ALLOW_REGISTER = process.env.SYNC_ALLOW_REGISTER !== '0';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ───────────────────────────────────────────────────────────── 存储

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}
function writeJson(p, o) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.part';
  fs.writeFileSync(tmp, JSON.stringify(o));
  fs.renameSync(tmp, p);
}
const userFile = (n) => path.join(SYNC_DIR, 'u-' + n + '.json');
const zipFile = (n) => path.join(SYNC_DIR, 'u-' + n + '.strm.zip');

function dbLoad() {
  const o = readJson(DB_FILE) || {};
  return { users: o.users || {}, tokens: o.tokens || {} };
}
function dbSave(db) { writeJson(DB_FILE, db); }

const hashOf = (pass, salt) => crypto.scryptSync(String(pass), String(salt), 32).toString('hex');

function emptyData() {
  return { likes: {}, favorites: {}, badStreams: {}, profile: {}, sources: {}, updatedAt: 0 };
}
function dataLoad(n) { return { ...emptyData(), ...(readJson(userFile(n)) || {}) }; }
function dataSave(n, d) { d.updatedAt = Date.now(); writeJson(userFile(n), d); }

// ───────────────────────────────────────────────────────────── 账号

function register(name, pass) {
  if (!SYNC_NAME_RE.test(name)) return { error: '账号名只能用中英文、数字、_ - .（1~32 位）' };
  if (String(pass || '').length < 4) return { error: '密码至少 4 位' };
  const db = dbLoad();
  if (db.users[name]) return { error: '这个账号名已经被用了' };
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[name] = { salt, hash: hashOf(pass, salt), at: Date.now() };
  const token = crypto.randomBytes(24).toString('hex');
  db.tokens[token] = { user: name, at: Date.now() };
  dbSave(db);                       // 🔴 token 必须落盘，否则服务一重启所有人掉线
  dataSave(name, emptyData());
  return { token, user: name };
}

function login(name, pass) {
  const db = dbLoad();
  const u = db.users[name];
  /* ⚠️「账号不存在」与「密码错」必须是同一句提示 —— 否则等于白送一个账号枚举接口 */
  if (!u || hashOf(pass, u.salt) !== u.hash) return { error: '账号或密码不对' };
  const token = crypto.randomBytes(24).toString('hex');
  db.tokens[token] = { user: name, at: Date.now() };
  dbSave(db);
  return { token, user: name };
}

function authOf(req) {
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/i.exec(String(req.headers.authorization || '').trim());
  if (!m) return null;
  const db = dbLoad();
  const rec = db.tokens[m[1]];
  if (!rec) return null;
  if (Date.now() - Number(rec.at || 0) > TOKEN_TTL) {
    delete db.tokens[m[1]];
    dbSave(db);
    return null;
  }
  return { user: rec.user, token: m[1] };
}

// ───────────────────────────────────────────────────────────── 合并规则

/** 老格式（true/1/字符串）也要认；老格式 t=0，只在两边都没时间信息时才可能胜出 */
function norm(v) {
  if (v && typeof v === 'object') return { t: Number(v.t) || 0, del: !!v.del };
  return { t: 0, del: false };
}

/**
 * 按时间戳取新：
 *   · 并集（A 收的、B 收的，合并后两边都有）；
 *   · 同一条听晚的那次；
 *   · **墓碑留着**（del:true 且 t>0）—— 不留的话「取消收藏」会在对方那儿复活，
 *     因为它只看到「我这边有、你那边没有」，会以为是我还没同步过去。
 */
function mergeMap(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = norm((a || {})[k]);
    const y = norm((b || {})[k]);
    const win = y.t > x.t ? y : x;          // 平手取本地（刚点的那下更可信）
    if (!win.del) out[k] = { t: win.t || 0 };
    else if (win.t > 0) out[k] = { t: win.t, del: true };
  }
  return out;
}
function pruneTomb(m) {
  const now = Date.now();
  const out = {};
  for (const [k, v] of Object.entries(m || {})) {
    if (v && v.del && now - Number(v.t || 0) > TOMB_KEEP) continue;
    out[k] = v;
  }
  return out;
}
/** 🗑️ 这里原来有个 `union(a, b)`（数组并集），2026-09-21 **删掉了**。
 *
 * 它当时是给 sources（片源 / 不重扫 / 监控清单）合并用的，注释写着
 * 「只补不删 —— 谁都不想同步一次就丢掉自己的文件夹」。
 * 但**并集在语义上就表达不了删除**：用户删掉一个监控文件夹，下一次同步
 * 就被账号里那份并回来，症状是「这个文件夹已经不需要监控了但是无法移除」。
 * 现在改成「按时间戳取最后改过的那份」，见 mergeSnapshot 里 sources 那段。
 * ⚠️ 别再加回来。 */

/** 只收认识的字段，避免客户端把整份配置塞进来 */
function snapshotOf(body) {
  const b = body || {};
  const snap = {};
  for (const k of ['likes', 'favorites', 'badStreams']) {
    if (b[k] && typeof b[k] === 'object') snap[k] = b[k];
  }
  if (b.profile && typeof b.profile === 'object' && Object.keys(b.profile).length) {
    snap.profile = {};
    if (typeof b.profile.nickname === 'string') snap.profile.nickname = b.profile.nickname.slice(0, 40);
    if (typeof b.profile.avatar === 'string' && b.profile.avatar.length <= 1.5e6) {
      snap.profile.avatar = b.profile.avatar;
    }
    /* 🔴 昵称头像也要带 t：前端只在**确实改过**时才带，缺省 0 = 不参与竞争。
       否则「谁后同步谁赢」，没改过的设备会把别人改的名字盖回去。 */
    snap.profile.t = Number(b.profile.t) || 0;
  }
  if (b.sources && typeof b.sources === 'object') {
    const s = b.sources;
    snap.sources = {};
    for (const k of ['dirs', 'skipDirs', 'strmJobs']) {
      if (Array.isArray(s[k])) snap.sources[k] = s[k].map(String).slice(0, 500);
    }
    if (typeof s.strmIntervalH === 'number') {
      snap.sources.strmIntervalH = Math.max(0, Math.min(168, s.strmIntervalH));
    }
    // .strm 体积阈值（2026-09-22）：与 server.js 的白名单保持一致
    if (typeof s.strmMinSizeMB === 'number') {
      snap.sources.strmMinSizeMB = Math.max(0, Math.min(102400, Math.floor(s.strmMinSizeMB)));
    }
  }
  return snap;
}

function zipStat(name) {
  try {
    const st = fs.statSync(zipFile(name));
    if (st.isFile() && st.size) return { has: true, bytes: st.size, at: Math.round(st.mtimeMs) };
  } catch (_) {}
  return null;
}

// ───────────────────────────────────────────────────────────── HTTP

function send(res, code, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    /* 🔴 CORS 只给这些接口开（它们有 token 鉴权）。别把通配 CORS 加到没有鉴权的接口上。 */
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Max-Age': '86400',
  });
  res.end(buf);
}
function readRaw(req, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > max) { dead = true; req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(dead ? null : Buffer.concat(chunks)));
    req.on('error', () => resolve(null));
  });
}
async function readJsonBody(req) {
  const buf = await readRaw(req, BODY_MAX);
  if (!buf) return null;
  try { return JSON.parse(buf.toString('utf8') || '{}'); } catch (_) { return null; }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});

    /* 一个极简的状态页：不是界面，只是让你用浏览器打开能确认「它在跑」 */
    if (p === '/' || p === '/health') {
      const db = dbLoad();
      return send(res, 200, {
        ok: true,
        service: 'nas-douyin-sync',
        users: Object.keys(db.users).length,
        allowRegister: ALLOW_REGISTER,
        dataDir: DATA_DIR,
      });
    }

    if (p === '/api/auth/register' || p === '/api/auth/login') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' });
      const b = await readJsonBody(req);
      if (!b) return send(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      const name = String(b.user || '').trim();
      const pass = String(b.pass || '');
      if (!name || !pass) return send(res, 400, { ok: false, error: '账号和密码都要填' });
      const isReg = p.endsWith('register');
      if (isReg && !ALLOW_REGISTER) {
        return send(res, 200, { ok: false, error: '这台服务器没有开放注册（已有账号可以直接登录）' });
      }
      const r = isReg ? register(name, pass) : login(name, pass);
      if (r.error) return send(res, 200, { ok: false, error: r.error });
      log(`${isReg ? '注册' : '登录'}：${r.user}`);
      return send(res, 200, { ok: true, token: r.token, user: r.user });
    }

    const auth = authOf(req);
    if (!auth) return send(res, 401, { ok: false, error: '未登录或登录已过期' });

    if (p === '/api/auth/me') return send(res, 200, { ok: true, user: auth.user });
    if (p === '/api/auth/logout') {
      const db = dbLoad();
      delete db.tokens[auth.token];
      dbSave(db);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/auth/pass') {
      if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'method' });
      const b = await readJsonBody(req) || {};
      const db = dbLoad();
      const me = db.users[auth.user];
      if (!me || hashOf(String(b.old || ''), me.salt) !== me.hash) {
        return send(res, 200, { ok: false, error: '原密码不对' });
      }
      const np = String(b.pass || '');
      if (np.length < 4) return send(res, 200, { ok: false, error: '新密码至少 4 位' });
      me.salt = crypto.randomBytes(16).toString('hex');
      me.hash = hashOf(np, me.salt);
      /* 改密码要作废该账号的**全部** token（只作废当前那个是最常见的疏漏） */
      for (const [t, rec] of Object.entries(db.tokens)) if (rec.user === auth.user) delete db.tokens[t];
      dbSave(db);
      return send(res, 200, { ok: true });
    }

    if (p === '/api/sync/pull' && req.method === 'GET') {
      return send(res, 200, { ok: true, user: auth.user, data: dataLoad(auth.user), strm: zipStat(auth.user) });
    }

    if (p === '/api/sync/push' && req.method === 'POST') {
      const b = await readJsonBody(req);
      if (!b) return send(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      const inc = snapshotOf(b);
      const cur = dataLoad(auth.user);
      const out = { ...cur };

      for (const k of ['likes', 'favorites', 'badStreams']) {
        out[k] = pruneTomb(mergeMap(cur[k], inc[k]));
      }
      if (inc.profile && Object.keys(inc.profile).length) {
        const curT = Number((cur.profile || {}).t) || 0;
        const incT = Number(inc.profile.t) || 0;
        if (incT >= curT) out.profile = { ...(cur.profile || {}), ...inc.profile };
      }
      if (inc.sources) {
        const cs = cur.sources || {};
        const ns = { ...cs };
        /* 🔴 数组按**时间戳**取新的那份，**不是并集**（2026-09-21 修）。
           旧版是 union，导致「删除」永远同步不出去：本机删掉一个监控文件夹，
           下一次同步就被账号里那份并回来 —— 用户的原话是
           「这个文件夹已经不需要监控了但是无法移除」。
           点赞/收藏早有墓碑机制（mergeMap + del），sources 一直没有。
           现在：哪台设备**最后一次改过**这个数组就以谁为准。
           前端只在「本机数组 ≠ 上次同步的快照」时才带 `<k>T`，
           所以没改过的设备不会来抢 —— 另一台设备的改动不会被它的普通同步冲掉。
           ⚠️ 别再改回 union：union 表达不了删除，这是语义问题，不是实现细节。 */
        for (const k of ['dirs', 'skipDirs', 'strmJobs']) {
          const t = Number(inc.sources[k + 'T']) || 0;
          const ct = Number(cs[k + 'T']) || 0;
          if (Array.isArray(inc.sources[k]) && t > ct) {
            ns[k] = inc.sources[k].map(String).slice(0, 500);
            ns[k + 'T'] = t;
          }
        }
        /* 间隔同理走时间戳。原来取 max() —— 那会让「把间隔调小」永远同步不出去
           （另一端的旧大值总是赢）。没改过的设备不带 T，不会来抢。 */
        if (typeof inc.sources.strmIntervalH === 'number') {
          const t = Number(inc.sources.strmIntervalHT) || 0;
          const ct = Number(cs.strmIntervalHT) || 0;
          if (t > ct) {
            ns.strmIntervalH = Math.max(0, Math.min(168, inc.sources.strmIntervalH));
            ns.strmIntervalHT = t;
          }
        }
        // 体积阈值（2026-09-22）：同样按时间戳，别用 max()（那会让「调小」同步不出去）
        if (typeof inc.sources.strmMinSizeMB === 'number') {
          const t = Number(inc.sources.strmMinSizeMBT) || 0;
          const ct = Number(cs.strmMinSizeMBT) || 0;
          if (t > ct) {
            ns.strmMinSizeMB = Math.max(0, Math.min(102400, Math.floor(inc.sources.strmMinSizeMB)));
            ns.strmMinSizeMBT = t;
          }
        }
        out.sources = ns;
      }
      dataSave(auth.user, out);
      /* 顺带回 strm 包信息 —— 前端就不必为「远端有没有备份包」多跑一次 pull */
      return send(res, 200, { ok: true, user: auth.user, data: out, strm: zipStat(auth.user) });
    }

    if (p === '/api/sync/strm') {
      const f = zipFile(auth.user);
      if (req.method === 'GET') {
        try {
          const st = fs.statSync(f);
          if (!st.isFile() || !st.size) return send(res, 404, { ok: false, error: '账号里还没有 strm 备份' });
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Length': st.size,
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Expose-Headers': 'Content-Length',
          });
          return fs.createReadStream(f).pipe(res);
        } catch (_) {
          return send(res, 404, { ok: false, error: '账号里还没有 strm 备份' });
        }
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        const buf = await readRaw(req, ZIP_MAX);
        if (!buf) return send(res, 413, { ok: false, error: '备份包太大' });
        /* 不解析 zip（解包在 App 那侧），只当不透明字节存着。
           但仍校验魔数：存一个不是 zip 的东西进来，要等新设备下载时才报错，
           那时候人已经在另一台设备上了，排查成本高得多。 */
        if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
          return send(res, 400, { ok: false, error: '这不是一个 zip 备份包' });
        }
        fs.mkdirSync(SYNC_DIR, { recursive: true });
        const tmp = f + '.part';
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, f);
        log(`${auth.user} 上传 strm 备份：${(buf.length / 1024 / 1024).toFixed(2)} MB`);
        return send(res, 200, { ok: true, bytes: buf.length });
      }
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log('出错', e && e.message);
    return send(res, 500, { ok: false, error: '服务端出错：' + (e && e.message) });
  }
});

fs.mkdirSync(SYNC_DIR, { recursive: true });
server.listen(PORT, () => {
  log(`NAS 短视频 · 同步服务已启动`);
  log(`  监听      http://0.0.0.0:${PORT}`);
  log(`  数据目录  ${DATA_DIR}`);
  log(`  开放注册  ${ALLOW_REGISTER ? '是' : '否（SYNC_ALLOW_REGISTER=0）'}`);
  log(`  手机 App 里填：http://<这台机器的IP>:${PORT}`);
});
