# -*- coding: utf-8 -*-
"""
主题（深色 / 浅色 / 跟随系统）的**反向验证器**（2026-09-21，skill §79）。

给这套主题逐个注入缺陷，确认 check.js 里对应的断言真的会变红 ——
**不红的都是假断言**。主题改动涉及 100+ 行 CSS 与两个后端，改完务必重跑一遍。

用法（在项目根目录）：
  python _tools/theme-mut.py snap      # 先拍一份当前源码快照（每次改动后都要重拍）
  python _tools/theme-mut.py list      # 列出全部变异
  python _tools/theme-mut.py <编号>    # 注入第 N 个（会先把四个文件还原成快照）
  python _tools/theme-mut.py 0         # 还原
  # 配合 bash 循环跑全套（node 只负责改文件，check.js 交给 bash —— 见下面那段 shell）

🔴🔴 **顺序铁律：先 `snap`，再跑变异，最后 `0` 还原。**
   **绝对不要「先 `0` 再 `snap`」** —— `0` 是「用快照覆盖当前源码」，如果快照还是
   **上一轮**的，你刚改的东西会被**整块盖回去**，而且脚本只会说「已还原」，
   看起来一切正常（2026-09-21 就这么把自己的改动吃掉过一次，
   直到在真机上发现「改的没生效」才回头查出来）。
   判断方法：`snap` 之后立刻跑一次 `node check.js` 确认基线正常，再开始跑变异。

⚠️ 不用 node 起子进程跑 check.js（本环境里 spawnSync 起 node 会 EBUSY，
   而且 stdout 会空 —— 会被误读成「断言全没咬住」）。
   改成 bash 循环：node 只负责改写文件，check.js 由 bash 跑。
"""
import io
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BAK = os.path.join(ROOT, '_tmp', 'theme_bak')
FILES = {
    'html': os.path.join(ROOT, 'public', 'index.html'),
    'app': os.path.join(ROOT, 'public', 'js', 'app.js'),
    'css': os.path.join(ROOT, 'public', 'css', 'style.css'),
    'ma': os.path.join(ROOT, 'android', 'src', 'com', 'nas', 'douyin', 'MainActivity.java'),
}


def read(p):
    return io.open(p, encoding='utf-8').read()


def write(p, s):
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)


# ---------------- 各条变异的实现 ----------------

def m_html_drop_auto():
    """①2 三档少了 auto"""
    p = FILES['html']
    s = read(p)
    s = s.replace('          <button data-theme="auto">跟随系统</button>\n', '')
    write(p, s)


def m_html_script_after_css():
    """②1 内联脚本挪到样式表之后（会先画一帧深色再翻白）"""
    p = FILES['html']
    s = read(p)
    i = s.index('<script>\n(function () {')
    j = s.index('</script>', i) + len('</script>\n')
    blk = s[i:j]
    s = s[:i] + s[j:]
    link = '<link rel="stylesheet" href="/css/style.css">'
    k = s.index(link) + len(link)
    s = s[:k] + '\n' + blk.rstrip('\n') + s[k:]
    write(p, s)


def m_html_key():
    """②2 内联脚本换了 localStorage 键"""
    p = FILES['html']
    s = read(p)
    s = s.replace("localStorage.getItem('nasdy.theme')", "localStorage.getItem('nasdy.themeX')", 1)
    write(p, s)


def m_html_media():
    """②3 内联脚本的媒体查询判反了"""
    p = FILES['html']
    s = read(p)
    s = s.replace("matchMedia('(prefers-color-scheme: light)').matches", "matchMedia('(prefers-color-scheme: dark)').matches", 1)
    write(p, s)


def m_app_default():
    """③1 默认改成浅色"""
    p = FILES['app']
    s = read(p)
    s = s.replace("LS.get(THEME_LS, 'dark')", "LS.get(THEME_LS, 'light')", 1)
    write(p, s)


def m_app_fallback():
    """③2 非法值不再回落深色"""
    p = FILES['app']
    s = read(p)
    s = s.replace("return v === 'light' || v === 'auto' ? v : 'dark';", "return v || 'dark';", 1)
    write(p, s)


def m_app_sys_follow():
    """③6 系统主题变了不再跟随"""
    p = FILES['app']
    s = read(p)
    s = s.replace("const onSysTheme = () => { if (themeChoice() === 'auto') applyTheme(); };",
                  "const onSysTheme = () => {};", 1)
    write(p, s)


def m_app_config():
    """③7 主题被塞进了 /api/config 的表单"""
    p = FILES['app']
    s = read(p)
    s = s.replace("    fit,\n", "    fit,\n    theme: themeChoice(),\n", 1)
    write(p, s)


def m_app_bridge():
    """④1 applyTheme 不再推给原生"""
    p = FILES['app']
    s = read(p)
    s = s.replace("    if (window.NasBridge && window.NasBridge.setTheme) window.NasBridge.setTheme(t);",
                  "    /* 变异：不推 */", 1)
    write(p, s)


def m_ma_no_annotation():
    """④2 setTheme 丢了 @JavascriptInterface（网页调不到）"""
    p = FILES['ma']
    s = read(p)
    s = s.replace("        @android.webkit.JavascriptInterface\n        public void setTheme(String theme) {",
                  "        public void setTheme(String theme) {", 1)
    write(p, s)


def m_ma_no_restore():
    """④4 退出全屏后不补回主题配色"""
    p = FILES['ma']
    s = read(p)
    s = s.replace("            applySystemBarTheme(lightTheme);\n", "            // 变异：不补\n", 1)
    write(p, s)


def m_css_bare_attr():
    """⑤1 浅色块写成裸属性选择器（特异性只 0,1,0，压不住 :root）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('html[data-theme="light"]{', '[data-theme="light"]{', 1)
    write(p, s)


def m_css_miss_ink():
    """⑤2 浅色块漏覆盖 --ink（面板上的主文字在浅色下还是白的）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('  --ink:#161823;\n', '', 1)
    write(p, s)


def m_css_brand():
    """⑤3 浅色块动了品牌色"""
    p = FILES['css']
    s = read(p)
    s = s.replace('html[data-theme="light"]{\n', 'html[data-theme="light"]{\n  --brand:#FE2C55;\n', 1)
    write(p, s)


def m_css_typo():
    """⑥ 变量名拼错一个字母"""
    p = FILES['css']
    s = read(p)
    s = s.replace('var(--w08)', 'var(--w08x)', 1)
    write(p, s)


def m_css_feed():
    """⑦1 压在视频上的 .feed 被改成了主题令牌"""
    p = FILES['css']
    s = read(p)
    s = s.replace('  scrollbar-width:none;\n  background:#000;\n',
                  '  scrollbar-width:none;\n  background:var(--srf);\n', 1)
    write(p, s)


def m_css_overlay_text():
    """⑦2 压在深底上的次要文字改成 --muted（浅色下会变深灰 → 看不见）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('.item .vph,\n.v-err .d,\n.loading p{color:rgba(255,255,255,.62);}',
                  '.item .vph,\n.v-err .d,\n.loading p{color:var(--muted);}', 1)
    write(p, s)


def m_css_tabbar():
    """⑦b2 又把首页底栏钉回深色（用户圈出来说不行的那条）"""
    p = FILES['css']
    s = read(p)
    anchor = '/* 转圈：.spinner 同时用在'
    s = s.replace(anchor,
                  '.phone[data-nav="home"] .tabbar{background:linear-gradient(180deg,rgba(22,24,33,.82),rgba(11,12,16,.95));}\n'
                  + anchor, 1)
    write(p, s)


def m_app_datanav():
    """①3 把外观开关挪回「数据源设置」（上一版放错的位置）"""
    p = FILES['html']
    s = read(p)
    blk = ('      <label class="switch-row">\n'
           '        <span>外观</span>\n'
           '        <div class="seg" id="themeSeg">\n'
           '          <button data-theme="dark" class="active">深色</button>\n'
           '          <button data-theme="light">浅色</button>\n'
           '          <button data-theme="auto">跟随系统</button>\n'
           '        </div>\n'
           '      </label>\n')
    assert blk in s, '找不到外观那一段'
    s = s.replace(blk, '', 1)
    s = s.replace('      </div>\n\n      <!-- ---- .strm 自动库',
                  '        <label class="switch-row"><span>外观</span>'
                  '<div class="seg" id="themeSeg"><button data-theme="dark" class="active">深色</button>'
                  '<button data-theme="light">浅色</button>'
                  '<button data-theme="auto">跟随系统</button></div></label>\n'
                  '      </div>\n\n      <!-- ---- .strm 自动库', 1)
    write(p, s)


def m_css_loading_spinner():
    """⑧3 .loading 里的转圈跟着主题变深（压在黑视频上看不见）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('.loading .spinner{border-color:rgba(255,255,255,.18);border-top-color:var(--brand);}',
                  '.loading .spinnerXXX{border-color:rgba(255,255,255,.18);border-top-color:var(--brand);}', 1)
    write(p, s)


def m_css_theme_seg_flex():
    """①4 外观三档丢了 flex:none（「跟随系统」会被挤成两行）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('#themeSeg button{flex:none;white-space:nowrap;padding:7px 12px;}',
                  '#themeSeg button{white-space:nowrap;padding:7px 12px;}', 1)
    write(p, s)


def m_html_head_no_bridge():
    """②3 内联脚本不再问原生（WebView 的媒体查询恒为 dark，「跟随系统」变假档位）"""
    p = FILES['html']
    s = read(p)
    s = s.replace('if (window.NasBridge && window.NasBridge.systemTheme) sys = window.NasBridge.systemTheme();',
                  'if (false) sys = "";', 1)
    write(p, s)


def m_app_systheme_no_bridge():
    """②b1 systemTheme() 不问题原生，直接信媒体查询"""
    p = FILES['app']
    s = read(p)
    s = s.replace("""  try {
    if (window.NasBridge && window.NasBridge.systemTheme) {
      const v = window.NasBridge.systemTheme();
      if (v === 'light' || v === 'dark') return v;
    }
  } catch (_) { /* 桥挂了就回落 */ }
  return (THEME_MQ && THEME_MQ.matches) ? 'light' : 'dark';""",
                  "  return (THEME_MQ && THEME_MQ.matches) ? 'light' : 'dark';", 1)
    write(p, s)


def m_app_resolved_media():
    """②b2 themeResolved 绕过 systemTheme() 自己读媒体查询"""
    p = FILES['app']
    s = read(p)
    s = s.replace('  return systemTheme();', "  return (THEME_MQ && THEME_MQ.matches) ? 'light' : 'dark';", 1)
    write(p, s)


def m_ma_systheme_apptheme():
    """②b3 Java 的 systemTheme() 不再读系统 uiMode"""
    p = FILES['ma']
    s = read(p)
    s = s.replace('                    & android.content.res.Configuration.UI_MODE_NIGHT_MASK;\n', '', 1)
    write(p, s)


def m_ma_no_push():
    """②b4 系统换深浅色时不推给网页（Activity 不会重建 → 要等下次冷启动）"""
    p = FILES['ma']
    s = read(p)
    s = s.replace('        Log.i(TAG, "配置变更：系统主题 = " + (isSystemDark() ? "深色" : "浅色"));\n        pushSystemTheme();\n',
                  '        Log.i(TAG, "配置变更：系统主题 = " + (isSystemDark() ? "深色" : "浅色"));\n', 1)
    write(p, s)


def m_app_no_hook():
    """②b5 没留 window.__onSystemTheme 钩子（原生推过来时页面接不住）"""
    p = FILES['app']
    s = read(p)
    s = s.replace("window.__onSystemTheme = () => { if (themeChoice() === 'auto') applyTheme(); };\n", '', 1)
    write(p, s)


def m_css_stray_close():
    """⑥b 注释里混进「星号紧跟斜杠」→ 提前结束注释、吞掉紧跟的声明"""
    p = FILES['css']
    s = read(p)
    s = s.replace('.grad-* 系列 /', '.grad-*/.topbar /', 1)
    write(p, s)


def m_css_topbar_hardcode():
    """⑦b1 顶栏改成跟随主题（用户明确说这块「跟深色主题一样就可以了」）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('  background:linear-gradient(180deg,rgba(0,0,0,.55),transparent);',
                  '  background:#f4f5f7;', 1)
    write(p, s)


def m_css_tbbtn_translucent():
    """⑦b1c 顶栏按钮文字改成走令牌（顶栏不该跟随主题）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('  display:grid;place-items:center;color:#fff;',
                  '  display:grid;place-items:center;color:var(--ink);', 1)
    write(p, s)


def m_css_sheet_compact():
    """⑦b4 设置面板改回 60% 高（只放一行会是一大块空白）"""
    p = FILES['html']
    s = read(p)
    s = s.replace('<section class="sheet compact" id="settingsSheet"', '<section class="sheet" id="settingsSheet"', 1)
    write(p, s)


def m_css_badge_hardcode():
    """⑦b1b 悬浮徽标改成浅色（和顶栏一样不该跟随主题）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('  background:rgba(0,0,0,.62);border:1px solid var(--line);',
                  '  background:rgba(255,255,255,.92);border:1px solid var(--line);', 1)
    write(p, s)


def m_css_tabbar_hardcode():
    """⑦b2b 底栏改成硬编码深色（用户第一条反馈就是这条）"""
    p = FILES['css']
    s = read(p)
    s = s.replace('  background:var(--tabbar-bg);',
                  '  background:linear-gradient(180deg,rgba(22,24,33,.82),rgba(11,12,16,.95));', 1)
    write(p, s)


MUTS = [
    ('①2 三档少了 auto', m_html_drop_auto),
    ('①4 外观三档丢 flex:none', m_css_theme_seg_flex),
    ('②1 内联脚本挪到样式表之后', m_html_script_after_css),
    ('②2 内联脚本换了 localStorage 键', m_html_key),
    ('②3 内联脚本媒体查询判反', m_html_media),
    ('②3b 内联脚本不问原生', m_html_head_no_bridge),
    ('②b1 systemTheme 不问原生', m_app_systheme_no_bridge),
    ('②b2 themeResolved 绕过 systemTheme', m_app_resolved_media),
    ('②b3 Java 不读系统 uiMode', m_ma_systheme_apptheme),
    ('②b4 系统换主题不推网页', m_ma_no_push),
    ('②b5 没留 __onSystemTheme 钩子', m_app_no_hook),
    ('③1 默认改成浅色', m_app_default),
    ('③2 非法值不回落深色', m_app_fallback),
    ('③6 系统主题不再跟随', m_app_sys_follow),
    ('③7 主题塞进 /api/config', m_app_config),
    ('④1 applyTheme 不推给原生', m_app_bridge),
    ('④2 setTheme 丢 @JavascriptInterface', m_ma_no_annotation),
    ('④4 退出全屏不补主题配色', m_ma_no_restore),
    ('⑤1 浅色块用裸属性选择器', m_css_bare_attr),
    ('⑤2 浅色块漏覆盖 --ink', m_css_miss_ink),
    ('⑤3 浅色块动了品牌色', m_css_brand),
    ('⑥ 变量名拼错', m_css_typo),
    ('⑦1 视频区 .feed 改成令牌', m_css_feed),
    ('⑦2 深底次要文字改 --muted', m_css_overlay_text),
    ('⑦b2 底栏又钉回深色', m_css_tabbar),
    ('①3 外观挪回数据源设置', m_app_datanav),
    ('⑧3 .loading 转圈跟着主题变深', m_css_loading_spinner),
    ('⑥b 注释里混进注释结束标记', m_css_stray_close),
    ('⑦b1 顶栏改成跟随主题', m_css_topbar_hardcode),
    ('⑦b1c 顶栏按钮字改成令牌', m_css_tbbtn_translucent),
    ('⑦b4 设置面板改回 60% 高', m_css_sheet_compact),
    ('⑦b1b 悬浮徽标改成浅色', m_css_badge_hardcode),
    ('⑦b2b 底栏改成硬编码深色', m_css_tabbar_hardcode),
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
            raise SystemExit('没有快照，先跑：python _tools/theme-mut.py snap')
        for k, p in FILES.items():
            shutil.copy(os.path.join(BAK, k), p)      # 先还原，保证每次只注一个
        before = {k: read(p) for k, p in FILES.items()}
        fn()
        after = {k: read(p) for k, p in FILES.items()}
        changed = [k for k in FILES if before[k] != after[k]]
        if not changed:
            # 替换没命中 = 测试脚手架的问题（不是覆盖缺口），必须显式报出来，
            # 否则会把它误读成「断言没咬住」
            print('!! 没改动（替换没命中）%s' % name)
        else:
            print('%s   [改了 %s]' % (name, ','.join(changed)))
