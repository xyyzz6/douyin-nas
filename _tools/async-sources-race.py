#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实测「扫的中途又改片源」这条竞态 —— 也就是 server.js 里 scanAgain / Java 里 superseded
那套「丢弃本轮结果、按新配置重扫」的逻辑。

为什么要专门测：如果旧那轮结果被提交了，libVersion 会 +1，前端 peek 轮询
**立刻取走这份过期数据并停止轮询** —— 后面那轮正确的结果就永远没人看了，
界面会永久停在半路上（而且看起来「成功了」）。这是最难靠肉眼发现的一类 bug。

用法：python _tools/async-sources-race.py [base_url]
"""
import json
import sys
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8097'
A = ['/dav/示例目录']          # 小：2 个视频
B = ['/dav/示例片源']                    # 大：576 个视频，扫一次几十秒
C = ['/dav/示例目录', '/dav/示例片源']


def req(method, path, body=None, timeout=300):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        r.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def wait_done(v, limit=240, label=''):
    """等后台扫完，返回最终片库"""
    t0 = time.time()
    while time.time() - t0 < limit:
        time.sleep(4)
        r = req('GET', f'/api/library?peek=1&v={v}')
        if r.get('scanError'):
            print(f'    {label} ✗ 扫描失败：{r["scanError"]}')
            return None
        if r.get('changed'):
            full = req('GET', '/api/library')
            n = len(full.get('videos') or [])
            print(f'    {label} 扫完：{n} 个视频，dirs={full.get("dirs")}（{time.time()-t0:.0f}s）')
            return full
    print(f'    {label} ✗ {limit}s 内没等到 changed')
    return None


def main():
    print('后端 :', BASE)
    print()

    # ---------- 用例 1：移出片源也要立刻回话 ----------
    print('[用例 1] 移出片源（C → A，从几百个降到 2 个）')
    lib = req('POST', '/api/sources', {'dirs': C, 'recursive': True})
    print(f'    先设成 C：pendingScan={lib.get("pendingScan")} version={lib.get("version")}')
    wait_done(lib.get('version'), label='C:')

    t0 = time.time()
    lib = req('POST', '/api/sources', {'dirs': A, 'recursive': True})
    print(f'    移出示例片源 → 响应 {time.time()-t0:.2f}s，pendingScan={lib.get("pendingScan")}')
    full = wait_done(lib.get('version'), label='A:')
    assert full and len(full['videos']) == 2, f'移出后应该只剩 2 个，实际 {len(full["videos"]) if full else "?"}'
    print('    ✅ 移出立刻回话，扫完只剩 2 个（boki 的几百个真的清掉了）')
    print()

    # ---------- 用例 2：扫的中途又改一次（关键竞态） ----------
    # 故意让两次配置的规模差几个数量级：B 有几百个视频、要扫几十秒，
    # 第二次换成 A 只有 2 个。这样「最终看到的是哪一轮的结果」一目了然 ——
    # 如果被作废的 B 那轮偷偷提交了，我们就会看到几百个视频和 dirs=[boki]。
    print('[用例 2] 竞态：先设成 B（大，要扫几十秒），3 秒后再改成 A（只有 2 个）')
    print('         正确行为 = 丢弃 B 那轮、按 A 重扫；最终必须是 A 的结果')
    lib = req('POST', '/api/sources', {'dirs': B, 'recursive': True})
    v_after_b = lib.get('version')
    print(f'    第 1 次（B）：pendingScan={lib.get("pendingScan")} version={v_after_b}')
    time.sleep(3)
    lib = req('POST', '/api/sources', {'dirs': A, 'recursive': True})
    print(f'    第 2 次（A）：pendingScan={lib.get("pendingScan")} version={lib.get("version")}')
    full = wait_done(lib.get('version'), label='最终:')
    assert full is not None
    got = sorted(full.get('dirs') or [])
    assert got == sorted(A), f'最终 dirs 应该是 A={A}，实际 {got}（说明 B 那轮的结果被提交了）'
    assert len(full['videos']) == 2, \
        f'最终应该只有 2 个视频，实际 {len(full["videos"])}（说明 B 那轮的结果被提交了）'
    print(f'    ✅ 最终片源 = A、2 个视频 —— 被作废的 B 那轮没有把结果提交上去')
    print()

    # ---------- 用例 3：片源清空要同步给结果 ----------
    print('[用例 3] 片源清空（必须**同步**给空片库，不能等后台）')
    t0 = time.time()
    lib = req('POST', '/api/sources', {'dirs': [], 'recursive': True})
    dt = time.time() - t0
    n = len(lib.get('videos') or [])
    print(f'    响应 {dt:.2f}s  videos={n}  pendingScan={lib.get("pendingScan")}')
    assert dt < 5 and n == 0 and not lib.get('pendingScan'), lib
    print('    ✅ 同步回了空片库（否则旧视频会一直挂在首页上）')

    # 收尾：恢复到 C
    print()
    print('[收尾] 恢复片源为 C')
    lib = req('POST', '/api/sources', {'dirs': C, 'recursive': True})
    wait_done(lib.get('version'), label='恢复:')


if __name__ == '__main__':
    main()
