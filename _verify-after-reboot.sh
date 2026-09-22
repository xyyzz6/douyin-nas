#!/usr/bin/env bash
# 重启手机后的一键验证：blkio cgroup 是否恢复 + WebView 渲染进程能否派生 + App 能否出片库
# 用法：bash _verify-after-reboot.sh
set -u
DEV=6518ec54
cd "$(dirname "$0")"

echo "════════════════════════════════════════════════════"
echo " 重启后验证  $(date '+%H:%M:%S')"
echo "════════════════════════════════════════════════════"

echo
echo "【0】设备是否回来了"
adb devices -l 2>&1 | grep -E "^$DEV" || { echo "  ✗ 设备未就绪，等 adb 重连"; exit 1; }
echo "  ✓ $DEV 已连接"

echo
echo "【1】blkio cgroup 挂载（这是上次的病根）"
M=$(adb -s $DEV shell "grep blkio /proc/mounts 2>/dev/null")
if [ -n "$M" ]; then
  echo "  ✓ 已挂载：$M"
else
  echo "  ✗ 仍未挂载（持久性损坏，重启救不了 → 需要刷机/换机）"
fi
P=$(adb -s $DEV shell "ls /dev/blkio/cgroup.procs 2>&1")
case "$P" in
  *"No such file"*) echo "  ✗ /dev/blkio/cgroup.procs 不存在" ;;
  *"Permission denied"*) echo "  ✓ /dev/blkio/cgroup.procs 存在（只是 shell 读不了，正常）" ;;
  *) echo "  ? $P" ;;
esac

echo
echo "【2】SELinux"
echo "  getenforce = $(adb -s $DEV shell getenforce 2>/dev/null)   （正常应为 Enforcing）"

echo
echo "【3】启动 App 并看渲染进程"
adb -s $DEV shell "am force-stop com.nas.douyin" 2>/dev/null
sleep 1
adb -s $DEV logcat -c
adb -s $DEV shell "am start -n com.nas.douyin/.MainActivity" >/dev/null 2>&1
sleep 14

SB=$(adb -s $DEV shell "ps -A -o NAME | grep -c sandboxed" 2>/dev/null | tr -d '\r')
ZY=$(adb -s $DEV logcat -d 2>&1 | grep -c "through Zygote failed")
echo "  sandboxed 渲染进程数 = $SB   （>0 才算好）"
echo "  Zygote failed 次数    = $ZY   （0 才算好）"

echo
echo "【4】本机服务是否正常（排除服务端问题）"
for u in "/" "/js/app.js" "/api/library"; do
  printf "  %-14s " "$u"
  adb -s $DEV shell "curl -s -m 10 -o /dev/null -w 'code=%{http_code} size=%{size_download} t=%{time_total}\n' http://127.0.0.1:8099$u" 2>/dev/null | tr -d '\r'
done

echo
echo "【5】结论"
if [ "$SB" -gt 0 ] 2>/dev/null && [ "$ZY" -eq 0 ] 2>/dev/null; then
  echo "  ✅ WebView 渲染进程已恢复 → 可以开始真机几何验收"
  adb -s $DEV shell "screencap -p /sdcard/_v.png" 2>/dev/null
  adb -s $DEV pull /sdcard/_v.png _shots/phase-r/60-after-reboot.png >/dev/null 2>&1
  echo "     截图：_shots/phase-r/60-after-reboot.png"
else
  echo "  ❌ 渲染进程仍起不来 → 是持久性问题，不是重启能解决的"
fi
echo "════════════════════════════════════════════════════"
