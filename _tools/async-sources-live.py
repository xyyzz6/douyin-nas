#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实测「加/删片源立刻回话」这条链路（对着跑起来的后端打真请求）。

用法：
    python _tools/async-sources-live.py [base_url] [dir1] [dir2] ...

不加参数 = http://127.0.0.1:8097 + 两个自带片源（第二个是有 498 个视频的 /dav/示例片源）。
脚本会：
  1. 打 POST /api/sources，量**响应耗时**（改造前这里要 12~40 秒）；
  2. 确认回包里 pendingScan=true（前端据此不拿旧片库灌界面）；
  3. 按 4 秒一次轮询 GET /api/library?peek=1&v=N，等 changed；
  4. 打印最终片库条数，并核对「加的那个文件夹里的视频真的进来了」。

⚠️ 这个脚本会**改写服务端的 data/config.json**（片源就是配置本身）。
   跑完请把配置恢复回去（_backup/config.json.* 里有）。
"""
import json
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8097'
DIRS = sys.argv[2:] or ['/dav/示例目录', '/dav/示例片源']


def req(method, path, body=None, timeout=180):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        r.add_header('Content-Type', 'application/json')
    t0 = time.time()
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        raw = resp.read().decode('utf-8')
    return json.loads(raw), time.time() - t0


def main():
    print('后端      :', BASE)
    print('目标片源  :', DIRS)
    print()

    before, _ = req('GET', '/api/library?peek=1&v=-1')
    v0 = before.get('version')
    print(f'[0] 当前版本 v={v0}，片库 {before.get("count")} 个视频')

    print('[1] POST /api/sources …')
    lib, dt = req('POST', '/api/sources', {'dirs': DIRS, 'recursive': True})
    print(f'    响应耗时 {dt:.2f}s   ← 改造前这里是同步全扫，要 12~40s')
    print(f'    ok={lib.get("ok")}  pendingScan={lib.get("pendingScan")}  '
          f'scanning={lib.get("scanning")}  version={lib.get("version")}')
    print(f'    dirs 回包 = {lib.get("dirs")}')
    assert lib.get('ok'), lib
    assert lib.get('dirs') == DIRS, '回包的 dirs 必须是新配置（片源栏读的就是它）'
    if dt > 5:
        print('    ⚠️ 超过 5 秒 —— 说明又同步扫了，异步改造没生效！')

    if not lib.get('pendingScan'):
        print('    （没有 pendingScan：服务端同步给了结果，链路走的是另一条分支）')
        print(f'    片库 {len(lib.get("videos") or [])} 个视频')
        return

    print('[2] 轮询 /api/library?peek=1 等后台扫完 …')
    v = lib.get('version')
    t0 = time.time()
    while time.time() - t0 < 150:
        time.sleep(4)
        r, _ = req('GET', f'/api/library?peek=1&v={v}', timeout=30)
        el = time.time() - t0
        print(f'    +{el:5.1f}s  changed={r.get("changed")}  '
              f'scanning={r.get("scanning")}  count={r.get("count")}')
        if r.get('scanError'):
            print('    ✗ 后台扫描失败：', r['scanError'])
            return
        if r.get('changed'):
            full, _ = req('GET', '/api/library', timeout=120)
            n = len(full.get('videos') or [])
            print(f'\n[3] 后台扫完，共 {n} 个视频（耗时约 {el:.0f}s）')
            for d in DIRS:
                hit = [x for x in (full.get('videos') or []) if x['p'].startswith(d + '/')]
                print(f'    {d} → {len(hit)} 个')
            print('\n✅ 链路通了：立刻回话 + 后台扫 + 扫完通知前端换新')
            return
    print('    ✗ 等了 150 秒也没等到 changed')


if __name__ == '__main__':
    main()
