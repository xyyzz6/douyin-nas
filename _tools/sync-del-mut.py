# -*- coding: utf-8 -*-
"""
「同步删除语义 + 本机前缀脏值」的反向验证器（2026-09-21，skill §80）。

给这两个修复逐个注入缺陷，确认 check.js 里对应断言真的会变红 —— 不红的都是假断言。

用法（在项目根目录）：
  python _tools/sync-del-mut.py snap     # 先拍快照（🔴 先 snap，再跑变异，最后 0）
  python _tools/sync-del-mut.py list
  python _tools/sync-del-mut.py <编号>
  python _tools/sync-del-mut.py 0        # 还原

🔴🔴 **顺序铁律：先 `snap`，再跑变异，最后 `0`。绝不能「先 `0` 再 `snap`」** ——
   `0` 是「用快照覆盖当前源码」，快照若是上一轮的，你刚改的东西会被**整块盖回去**，
   脚本只说「已还原」、check.js 全绿，直到真机上发现「改的没生效」才查得出来。
"""
import io
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAK = os.path.join(ROOT, '_tmp', 'syncdel_bak')
FILES = {
    'app': os.path.join(ROOT, 'public', 'js', 'app.js'),
    'nj': os.path.join(ROOT, 'android', 'src', 'com', 'nas', 'douyin', 'NasServer.java'),
    'srv': os.path.join(ROOT, 'server.js'),
    'sync': os.path.join(ROOT, 'sync-server.js'),
}


def read(p):
    return io.open(p, encoding='utf-8').read()


def write(p, s):
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)


# ---------------- 同步协议：服务端 ----------------

def m_sync_union_back():
    """① 服务端 sources 改回并集（就是「删了又被加回来」的原样）"""
    p = FILES['sync']
    s = read(p)
    s = s.replace("""          const t = Number(inc.sources[k + 'T']) || 0;
          const ct = Number(cs[k + 'T']) || 0;
          if (Array.isArray(inc.sources[k]) && t > ct) {""",
                  """          const t = Number(inc.sources[k + 'T']) || 0;
          const ct = Number(cs[k + 'T']) || 0;
          if (Array.isArray(inc.sources[k])) {""", 1)
    write(p, s)


def m_srv_union_back():
    """② PC 侧（server.js）sources 改回并集"""
    p = FILES['srv']
    s = read(p)
    s = s.replace("        if (Array.isArray(inc.sources[k]) && t > ct) {",
                  "        if (Array.isArray(inc.sources[k])) {", 1)
    write(p, s)


def m_sync_interval_max():
    """③ 间隔改回 max()（调小间隔同步不出去）"""
    p = FILES['sync']
    s = read(p)
    s = s.replace("""          if (t > ct) {
            ns.strmIntervalH = Math.max(0, Math.min(168, inc.sources.strmIntervalH));
            ns.strmIntervalHT = t;
          }""",
                  """          if (true) {
            ns.strmIntervalH = Math.max(Number(cs.strmIntervalH) || 0, inc.sources.strmIntervalH);
          }""", 1)
    write(p, s)


# ---------------- 同步协议：客户端 ----------------

def m_app_payload_always():
    """④ syncPayload 总是带数组（不看「改过没改过」）→ 没改过的设备也会来抢"""
    p = FILES['app']
    s = read(p)
    s = s.replace("    if (!sameArr(cfg[k], sOld[k])) { src[k] = (cfg[k] || []).map(String); src[k + 'T'] = now; }",
                  "    if (true) { src[k] = (cfg[k] || []).map(String); src[k + 'T'] = now; }", 1)
    write(p, s)


def m_app_apply_union_back():
    """⑤ syncApply 改回本地并集（刚删的又被拼回去）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("""  if (Array.isArray(src.strmJobs) && srvNewer('strmJobs') && !sameArr(src.strmJobs, og.strmJobs)) {
    S.config = { ...S.config, strmJobs: src.strmJobs.map(String) };""",
                  """  const uni = (a, b) => { const o = []; for (const x of [...(a || []), ...(b || [])]) { const v = String(x == null ? '' : x).trim(); if (v && !o.includes(v)) o.push(v); } return o; };
  const merged = uni(og.strmJobs, src.strmJobs);
  if (!sameArr(merged, og.strmJobs)) {
    S.config = { ...S.config, strmJobs: merged };""", 1)
    write(p, s)


def m_app_snap_no_sources():
    """⑥ syncSnapNow 不记 sources（判断基准没了 → 每次同步都抢）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("""    sources: {
      dirs: ((S.config || {}).dirs || []).map(String),
      skipDirs: ((S.config || {}).skipDirs || []).map(String),
      strmJobs: ((S.config || {}).strmJobs || []).map(String),
      strmIntervalH: Number((S.config || {}).strmIntervalH) || 0,
    },
""", "", 1)
    write(p, s)


# ---------------- 本机前缀脏值 ----------------

def m_app_no_srvnewer():
    """⑬ syncApply 不看服务端时间戳（旧服务端不返回 T 时会无脑采用 → 更删不掉）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("if (Array.isArray(src.strmJobs) && srvNewer('strmJobs') && !sameArr(src.strmJobs, og.strmJobs)) {",
                  "if (Array.isArray(src.strmJobs) && !sameArr(src.strmJobs, og.strmJobs)) {", 1)
    write(p, s)


def m_nj_islocal_strict():
    """⑦ isLocalSrc 不剥前导斜杠（/local: 认不出来 → 短路失效）"""
    p = FILES['nj']
    s = read(p)
    s = s.replace("""        int i = 0;
        while (i < t.length() && t.charAt(i) == '/') i++;
        return t.startsWith(LOCAL_PREFIX, i);""",
                  """        return t.startsWith(LOCAL_PREFIX);""", 1)
    write(p, s)


def m_nj_normsrc_strict():
    """⑧ normSrc 不剥脏前导斜杠（脏值修不回来）"""
    p = FILES['nj']
    s = read(p)
    s = s.replace("""        while (t.startsWith("/")) t = t.substring(1);
        if (t.isEmpty()) return "";""",
                  """        if (t.isEmpty()) return "";""", 1)
    write(p, s)


def m_nj_post_dir_normabs():
    """⑨ POST /api/config 的 dir 改回 normAbs（**脏值的源头**）"""
    p = FILES['nj']
    s = read(p)
    s = s.replace('dir = d.trim().isEmpty() ? "" : normSrc(d); }',
                  'dir = d.trim().isEmpty() ? "" : NasService.normAbs(d); }', 1)
    write(p, s)


def m_nj_load_dir_raw():
    """⑩ loadConfig 里 dir 不过 normSrc（脏值一直留着）"""
    p = FILES['nj']
    s = read(p)
    s = s.replace('        dir = normSrc(p.getString("dir", ""));',
                  '        dir = p.getString("dir", "");', 1)
    write(p, s)


def m_srv_effective_strict():
    """⑪ PC 侧 effectiveDir 判据不收前导斜杠（/local: 又会被补成 /dav/local:）"""
    p = FILES['srv']
    s = read(p)
    s = s.replace("  if (isLocalSrcPath(pick)) return '';",
                  "  if (typeof pick === 'string' && pick.trim().startsWith('local:')) return '';", 1)
    write(p, s)


def m_srv_dir_normabs():
    """⑫ PC 侧 dir 改回 normAbs"""
    p = FILES['srv']
    s = read(p)
    s = s.replace("  c.dir = c.dir ? normSrcPath(c.dir) : '';",
                  "  c.dir = c.dir ? normAbs(c.dir) : '';", 1)
    write(p, s)


MUTS = [
    ('① 服务端 sources 改回并集', m_sync_union_back),
    ('② PC 侧 sources 改回并集', m_srv_union_back),
    ('③ 间隔改回 max()', m_sync_interval_max),
    ('④ 客户端总是带数组', m_app_payload_always),
    ('⑤ 客户端 syncApply 并集', m_app_apply_union_back),
    ('⑥ 快照不记 sources', m_app_snap_no_sources),
    ('⑬ 不看服务端时间戳', m_app_no_srvnewer),
    ('⑦ isLocalSrc 不剥前导斜杠', m_nj_islocal_strict),
    ('⑧ normSrc 不剥脏斜杠', m_nj_normsrc_strict),
    ('⑨ POST dir 改回 normAbs', m_nj_post_dir_normabs),
    ('⑩ loadConfig 的 dir 不过 normSrc', m_nj_load_dir_raw),
    ('⑪ PC effectiveDir 判据收窄', m_srv_effective_strict),
    ('⑫ PC dir 改回 normAbs', m_srv_dir_normabs),
]

if __name__ == '__main__':
    arg = sys.argv[1] if len(sys.argv) > 1 else '0'
    if arg == 'snap':
        os.makedirs(BAK, exist_ok=True)
        for k, p in FILES.items():
            shutil.copy(p, os.path.join(BAK, k))
        print('已拍快照 → ' + BAK)
    elif arg == '0':
        for k, p in FILES.items():
            shutil.copy(os.path.join(BAK, k), p)
        print('已还原')
    elif arg == 'list':
        for i, (name, _) in enumerate(MUTS, 1):
            print('%2d  %s' % (i, name))
    else:
        i = int(arg) - 1
        name, fn = MUTS[i]
        if not os.path.isdir(BAK):
            raise SystemExit('没有快照，先跑：python _tools/sync-del-mut.py snap')
        for k, p in FILES.items():
            shutil.copy(os.path.join(BAK, k), p)
        before = {k: read(p) for k, p in FILES.items()}
        fn()
        after = {k: read(p) for k, p in FILES.items()}
        changed = [k for k in FILES if before[k] != after[k]]
        print('%s   [改了 %s]' % (name, ','.join(changed)) if changed
              else '!! 没改动（替换没命中）%s' % name)
