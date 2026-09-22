#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实测「扫描中标志」不会被另一条扫描路径提前清掉（libScanDepth 那个修复的回归测试）。

背景（2026-09-18 实测抓到的坑）：
  有**两条**互不相干的路径会扫 —— 后台那条链（startBackgroundScan）和同步那条
  （scanNowSync，用户点「重新扫描」/ 首次没缓存走它）。原来共用一个布尔标志，
  先结束的那条会把它清成 false，另一条还在扫却对外说「没在扫」。后果：
    · POST /api/sources 回 pendingScan:false → 前端拿**旧片库**去 applyLibrary
      （首页闪空 / 正在看的被切走）
    · startBackgroundScan 的单飞判断失灵 → 同时开两路全量扫描
  logcat 特征：`扫描期间片源又变了` 紧跟着 `同步扫描期间片源又变了`，
  之后 scanning 提前变 false。

用法：python _tools/async-sources-scanflag.py [base_url]
"""
import json
import sys
import threading
import time
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:18099'
BIG = ['/dav/示例片源']        # 几百个视频，扫一次几十秒 —— 够长，好观察
SMALL = ['/dav/示例目录']


def req(method, path, body=None, timeout=300):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode('utf-8')
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        r.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.loads(resp.read().decode('utf-8'))


def main():
    print('后端 :', BASE)
    print()

    print('[0] 先让片源变成 SMALL，等它扫完，制造一个「缓存是旧配置的」状态')
    lib = req('POST', '/api/sources', {'dirs': SMALL, 'recursive': True})
    v = lib.get('version')
    t0 = time.time()
    while time.time() - t0 < 120:
        time.sleep(3)
        if req('GET', f'/api/library?peek=1&v={v}').get('changed'):
            break
    print('    片源 = SMALL，扫完了')
    print()

    print('[1] POST /api/sources 换成 BIG（几百个视频）→ 应该 pendingScan=True')
    lib = req('POST', '/api/sources', {'dirs': BIG, 'recursive': True})
    assert lib.get('pendingScan') is True, f'pendingScan 应该是 true，实际 {lib.get("pendingScan")}'
    v = lib.get('version')
    print(f'    pendingScan={lib.get("pendingScan")} version={v}')
    print()

    # 关键：中途插一条**非 peek** 的 /api/library。它会走 scanNowSync（同步扫一遍），
    # 而那时缓存还是旧配置的 → sigOk=false → 真的会同步扫。
    # 修复前：它结束时的 finally 会把标志清成 false，于是「后台还在扫却报 scanning=false」。
    fired = {'at': None, 'done': None}

    def sync_scan():
        time.sleep(8)
        fired['at'] = time.time()
        try:
            req('GET', '/api/library', timeout=300)      # 非 peek = 可能触发同步扫描
            fired['done'] = time.time()
        except Exception as e:
            fired['done'] = f'err {e}'

    threading.Thread(target=sync_scan, daemon=True).start()

    print('[2] 每 3 秒看一次 peek（中途会插一条同步 /api/library）')
    t0 = time.time()
    samples = []
    changed_at = None
    while time.time() - t0 < 200:
        time.sleep(3)
        r = req('GET', f'/api/library?peek=1&v={v}')
        el = time.time() - t0
        samples.append((el, r.get('scanning'), r.get('changed'), r.get('scanError')))
        print(f'    +{el:5.1f}s  scanning={r.get("scanning")}  changed={r.get("changed")}'
              f'  count={r.get("count")}' + (f'  scanError={r["scanError"]}' if r.get('scanError') else ''))
        if r.get('scanError'):
            print('    ✗ 扫描失败')
            return
        if r.get('changed'):
            changed_at = el
            break

    print()
    print('    同步扫描那条：开始于 +%.0fs，结束于 %s'
          % (fired['at'] - t0 if fired['at'] else -1,
             ('+%.0fs' % (fired['done'] - t0)) if isinstance(fired['done'], float) else str(fired['done'])))
    if changed_at is None:
        print('    ✗ 200 秒内没等到 changed')
        return

    # 断言：在 changed 之前，scanning 必须**一直是 true**（不能中途变 false）
    early_false = [(round(el), s) for el, s, ch, _ in samples if not ch and s is not True]
    if early_false:
        print(f'    ✗ 有 {len(early_false)} 次在扫完之前就报 scanning=false：{early_false[:5]}')
        print('       → 两条扫描路径的标志又互相清掉了（libScanDepth 修复被破坏）')
    else:
        print('    ✅ 扫完之前 scanning 一直是 true —— 两条路径没有互相清标志')

    print()
    print('[3] 收尾：恢复片源')
    lib = req('POST', '/api/sources', {'dirs': BIG + ['/dav/云下载'], 'recursive': True})
    print(f'    dirs = {lib.get("dirs")}')


if __name__ == '__main__':
    main()
