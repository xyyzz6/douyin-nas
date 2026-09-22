# -*- coding: utf-8 -*-
"""
首页窗口化（virtualization）的反向验证器（2026-09-21，skill §81）。

用法（在项目根目录）：
  python _tools/feed-win-mut.py snap     # 先拍快照（🔴 先 snap，再跑变异，最后 0）
  python _tools/feed-win-mut.py list
  python _tools/feed-win-mut.py <编号>
  python _tools/feed-win-mut.py 0        # 还原

🔴🔴 **顺序铁律：先 `snap`，再跑变异，最后 `0`。绝不能「先 `0` 再 `snap`」** ——
   `0` 是用快照覆盖当前源码；快照若是上一轮的，刚改的东西会被整块盖回去。
"""
import io
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAK = os.path.join(ROOT, '_tmp', 'feedwin_bak')
FILES = {
    'app': os.path.join(ROOT, 'public', 'js', 'app.js'),
    'css': os.path.join(ROOT, 'public', 'css', 'style.css'),
    'check': os.path.join(ROOT, 'check.js'),
}


def read(p):
    return io.open(p, encoding='utf-8').read()


def write(p, s):
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)


def m_build_full():
    """① build() 回到「全量建 DOM」（20 万节点那版）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("    syncWindow(0);          // 先把第 0 条附近建出来（真正的起播在 load/reshuffleNow 的 activate(0)）",
                  """    const frag = document.createDocumentFragment();
    list.forEach((v, i) => { frag.appendChild(makeItem(i)); });
    container.appendChild(frag);
    lo = 0; hi = list.length - 1;""", 1)
    write(p, s)


def m_pad_zero():
    """② 占位块高度不算（滚动高度塌掉 → 几何不变式破了）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("    topPad.style.height = (lo * 100) + '%';",
                  "    topPad.style.height = '0%';", 1)
    write(p, s)


def m_asc_insert():
    """③ 补 item 改成正序插（参照物还没建出来 → insertBefore(null) 甩到队尾）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("    for (let k = nhi; k >= nlo; k--) {", "    for (let k = nlo; k <= nhi; k++) {", 1)
    write(p, s)


def m_bad_ref():
    """③b 参照物用旧 hi 算（新加的那批全落 botPad → 倒序插变反序 → 落点错位）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("        container.insertBefore(item, itemOf(k + 1) || botPad);",
                  "        container.insertBefore(item, (k + 1 <= hi) ? itemOf(k + 1) : botPad);", 1)
    write(p, s)


def m_govid_raw_write():
    """⑩ 跳首页改回直写 scrollTop（会被吸附钳到窗口边缘 → 停错地方/空白）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("$('goVid').addEventListener('click', () => { setNav('home'); main.scrollToIndex(0, false); main.activate(0, true); });",
                  "$('goVid').addEventListener('click', () => { setNav('home'); feedEl.scrollTop = 0; main.activate(0, true); });", 1)
    write(p, s)


def m_reshuffle_order():
    """⑪ 换一批改回「先写 scrollTop 再 build」（会被吸附弹回 → 换一批不回第一条）"""
    p = FILES['app']
    s = read(p)
    a = "    list = orderVideos(S.videos);\n    build();\n    container.scrollTop = 0;"
    z = "    container.scrollTop = 0;\n    list = orderVideos(S.videos);\n    build();"
    assert a in s, 'reshuffleNow 的正文没找到'
    write(p, s.replace(a, z, 1))


def m_mount_no_window():
    """④ mount() 里去掉 ensureWindow（窗口外那条静默不挂视频 → 滑过去一片黑）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("""    ensureWindow(i);
    const item = itemOf(i);
    if (!item) return null;""",
                  """    const item = itemOf(i);
    if (!item) return null;""", 1)
    write(p, s)


def m_no_scroll_listener():
    """⑤ 去掉只读 scrollTop 的监听（窗口卡住、屏幕只剩占位块）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("""  container.addEventListener('scroll', () => {
    if (cur < 0 || !topPad) return;
    const h = container.clientHeight;
    if (!h) return;
    ensureWindow(Math.round(container.scrollTop / h));
  }, { passive: true });""", "", 1)
    write(p, s)


def m_scroll_writes():
    """⑥ 那个监听改成**写** scrollTop（违反 §39「JS 不许碰滚动位置」）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("    ensureWindow(Math.round(container.scrollTop / h));",
                  "    ensureWindow(Math.round(container.scrollTop / h));\n    container.scrollTop = container.scrollTop;", 1)
    write(p, s)


def m_pad_snap():
    """⑦ 占位块加上 scroll-snap-align（它自己成了吸附点 → 一整屏空白）"""
    p = FILES['css']
    s = read(p)
    s = s.replace(".feed-pad{width:100%;height:0;pointer-events:none;}",
                  ".feed-pad{width:100%;height:0;pointer-events:none;scroll-snap-align:start;}", 1)
    write(p, s)


def m_clear_no_reset():
    """⑧ clear() 不复位窗口状态（下次 build 的 syncWindow 以为窗口还在、一条都不建）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("      lo = -1; hi = -2; topPad = null; botPad = null;   // 窗口状态一起复位，否则下次 build 的 syncWindow 会以为窗口还在",
                  "      /* 变异：不复位 */", 1)
    write(p, s)


def m_grabFn_old():
    """⑨ grabFn 回到旧实现（数 `{` 不看形参表 → 只抠出 40 字符签名 → 一整批断言假绿）"""
    p = FILES['check']
    s = read(p)
    old_body = """  let j = src.indexOf('(', i);
  if (j < 0) throw new Error('找不到形参表 ' + name);
  let pd = 0;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '(') pd++;
    else if (c === ')') { pd--; if (pd === 0) { j++; break; } }
  }
  const b = src.indexOf('{', j);
  if (b < 0) throw new Error('找不到函数体 ' + name);
  let d = 0;
  for (let k = b; k < src.length; k++) {
    const c = src[k];
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error('括号不配对 ' + name);"""
    new_body = """  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') { d++; started = true; }
    else if (c === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
  throw new Error('括号不配对 ' + name);"""
    assert old_body in s, 'grabFn 的函数体没找到'
    write(p, s.replace(old_body, new_body, 1))


MUTS = [
    ('① build 回到全量建 DOM', m_build_full),
    ('② 占位块高度算成 0', m_pad_zero),
    ('③ 补 item 改成正序插', m_asc_insert),
    ('③b 参照物用旧 hi 算', m_bad_ref),
    ('⑩ 跳首页改回直写 scrollTop', m_govid_raw_write),
    ('⑪ 换一批顺序改回去', m_reshuffle_order),
    ('④ mount 去掉 ensureWindow', m_mount_no_window),
    ('⑤ 去掉 scroll 监听', m_no_scroll_listener),
    ('⑥ scroll 监听改成写 scrollTop', m_scroll_writes),
    ('⑦ 占位块加了 scroll-snap-align', m_pad_snap),
    ('⑧ clear 不复位窗口状态', m_clear_no_reset),
    ('⑨ grabFn 回到旧实现', m_grabFn_old),
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
            raise SystemExit('没有快照，先跑：python _tools/feed-win-mut.py snap')
        for k, p in FILES.items():
            shutil.copy(os.path.join(BAK, k), p)
        before = {k: read(p) for k, p in FILES.items()}
        fn()
        after = {k: read(p) for k, p in FILES.items()}
        changed = [k for k in FILES if before[k] != after[k]]
        print('%s   [改了 %s]' % (name, ','.join(changed)) if changed
              else '!! 没改动（替换没命中）%s' % name)
