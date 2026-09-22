"""扫描 CD2 的 WebDAV，找视频。注意：curl 不会自动编码 URL 里的非 ASCII，
必须自己 urllib.parse.quote —— 否则中文目录永远「列出为空」。"""
import subprocess, re, urllib.parse, sys, os
# 凭据与地址从环境变量取（**不要写死在这里** —— 这是要进版本库的脚本）
U = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("DAV_AUTH", "user:pass")
# ⚠️ BASE 就是**服务地址**（含子路径 /dav），路径一律传「含 /dav 前缀」的绝对路径。
#    别再拼一次 /dav —— 我就踩了这个，得到 /dav/dav/… 全空，还以为是 NAS 没内容。
BASE = os.environ.get("DAV_BASE", "http://127.0.0.1:19798/dav")
VID = {'.mp4','.mkv','.avi','.mov','.webm','.flv','.wmv','.ts','.m2ts','.mpg','.mpeg','.rmvb','.m4v','.3gp'}

def pf(path):
    # path 形如 '/dav/媒体库'（含前缀），BASE 只提供 origin+前缀 —— 这里要削掉重复前缀
    rel = path
    pfx = urllib.parse.urlparse(BASE).path.rstrip('/')
    if pfx and (rel == pfx or rel.startswith(pfx + '/')):
        rel = rel[len(pfx):]
    url = BASE + urllib.parse.quote(rel)
    try:
        r = subprocess.run(['curl','-s','-m','12','-X','PROPFIND','-u',U,
                            '-H','Depth: 1', url], capture_output=True, text=True, timeout=25)
        return r.stdout
    except Exception:
        return ''

def entries(path):
    out = []
    for seg in re.split(r'<D:response>', pf(path))[1:]:
        h = re.search(r'<D:href>(.*?)</D:href>', seg)
        if not h: continue
        href = urllib.parse.unquote(h.group(1))
        isdir = '<D:collection>' in seg
        sz = re.search(r'<D:getcontentlength>(\d+)</D:getcontentlength>', seg)
        out.append((href, isdir, int(sz.group(1)) if sz else 0))
    return [e for e in out if e[0].rstrip('/') != path.rstrip('/')]

def walk(path, depth=0, maxdepth=4, acc=None):
    if acc is None: acc = []
    if depth > maxdepth: return acc
    for href, isdir, sz in entries(path):
        if isdir:
            walk(href, depth + 1, maxdepth, acc)
        elif any(href.lower().endswith(v) for v in VID):
            acc.append((href, sz))
    return acc

ROOTS = ['/dav/示例目录','/dav/示例片源','/dav/示例片源2','/dav/云下载',
         '/dav/修仙','/dav/媒体库','/dav/最近接收','/dav/电影电视']
print('目录'.ljust(20), '视频数', '总量')
grand = []
for r in ROOTS:
    vids = walk(r)
    tot = sum(v[1] for v in vids)
    grand += vids
    flag = '' if vids else '   (空)'
    print(r.replace('/dav/','').ljust(18), str(len(vids)).rjust(5),
          ('%.2f GB' % (tot/1e9)).rjust(9), flag)
    for h, s in vids[:5]:
        print('       ·', h.replace('/dav/',''), '%.0f MB' % (s/1e6))
    if len(vids) > 5: print('       · …还有', len(vids)-5, '个')
print('\n合计', len(grand), '个视频，%.2f GB' % (sum(v[1] for v in grand)/1e9))
