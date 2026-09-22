#!/usr/bin/env bash
# 真机连接助手 —— 把「插上线就能在手机上测」这条路上的坑一次趟平。
#
# 踩过的坑（按出现顺序）：
#   1) adb devices 显示两台（模拟器 + 真机）→ 每条命令都得带 -s <序列号>，
#      否则报 "more than one device/emulator"。
#   2) Android 13 的 adb 默认走**增量安装**，MIUI 直接拒：
#      Failure [Incremental installation not allowed] → 加 --no-incremental。
#   3) 即使加了 --no-incremental，MIUI 还是会回
#      INSTALL_FAILED_USER_RESTRICTED: Install canceled by user。
#      这个**不是**「USB 调试」没开，而是少开了那个单独的
#      「USB 调试（安全设置）」—— 见下面 print_miui_hint。
#   4) 真机上 WebView 的调试端口要单独 forward（本脚本用 9224，避开模拟器的 9223）。
#
# 用法：
#   bash _tools/device.sh list          看当前接了哪些设备
#   bash _tools/device.sh install       编 APK 并装到真机
#   bash _tools/device.sh run           启动 App
#   bash _tools/device.sh log           看服务端日志
#   bash _tools/device.sh devtools      把真机 WebView 的调试端口 forward 到 9224
#   bash _tools/device.sh lan           不开 USB 也能测：用局域网把手机连到开发机 Node
set -u

ADB="${ADB:-D:/leidian/LDPlayer14/adb.exe}"
APK="${APK:-douyin-nas.apk}"
PKG=com.nas.douyin

# 真机序列号：默认取「不是 emulator- 开头」的那台
pick_serial() {
  "$ADB" devices | awk '/\tdevice$/{print $1}' | grep -v '^emulator-' | head -1
}

print_miui_hint() {
  cat <<'HINT'

  ┌──────────────────────────────────────────────────────────────────┐
  │  MIUI / 红米 上 adb install 被拒（INSTALL_FAILED_USER_RESTRICTED）   │
  │                                                                  │
  │  这不是普通的「USB 调试」没开 —— 那个开了也照样报这个错。          │
  │  要开的是**另一个**开关：                                         │
  │                                                                  │
  │    设置 → 更多设置 → 开发者选项 → 「USB 调试（安全设置）」         │
  │                                                                  │
  │  · 这个开关要求：登录小米账号 + 插着 SIM 卡 + 关掉「查找手机」      │
  │  · 打开时会弹窗确认，可能要等 10 秒左右                           │
  │  · 名字也可能叫「USB 安装」「允许通过 USB 安装应用」                │
  │                                                                  │
  │  打开后回到电脑,重跑:  bash _tools/device.sh install               │
  └──────────────────────────────────────────────────────────────────┘

HINT
}

cmd="${1:-list}"

case "$cmd" in
  list)
    echo "== 当前 adb 可见设备 =="
    "$ADB" devices -l
    S="$(pick_serial)"
    if [ -n "$S" ]; then
      echo
      echo "== 真机 $S =="
      echo "  型号    : $("$ADB" -s "$S" shell getprop ro.product.model | tr -d '\r')"
      echo "  系统    : Android $("$ADB" -s "$S" shell getprop ro.build.version.release | tr -d '\r')  MIUI $("$ADB" -s "$S" shell getprop ro.miui.ui.version.name | tr -d '\r')"
      echo "  分辨率  : $("$ADB" -s "$S" shell wm size | tr -d '\r')"
      echo "  密度    : $("$ADB" -s "$S" shell wm density | tr -d '\r')"
      echo "  ABI     : $("$ADB" -s "$S" shell getprop ro.product.cpu.abi | tr -d '\r')"
      D=$("$ADB" -s "$S" shell wm size | sed 's/.*: //' | cut -dx -f1 | tr -d '\r')
      N=$("$ADB" -s "$S" shell wm density | sed 's/.*: //' | tr -d '\r')
      if [ -n "$D" ] && [ -n "$N" ]; then
        echo "  CSS 视口: $((D*160/N)) x $(( ($("$ADB" -s "$S" shell wm size | sed 's/.*: //' | cut -dx -f2 | tr -d '\r')*160)/N ))  (dpr=$((N/160)))"
      fi
    else
      echo
      echo "没找到真机。检查：① 数据线是不是只能充电的那种 ② 手机上有没有弹「允许 USB 调试」"
    fi
    ;;

  install)
    S="$(pick_serial)"
    [ -z "$S" ] && { echo "没找到真机"; exit 1; }
    echo "== 构建 APK =="
    node android/build.js 2>&1 | grep -E "KB|sha256" || exit 1
    echo
    echo "== 安装到真机 $S =="
    OUT="$("$ADB" -s "$S" install -r --no-incremental "$APK" 2>&1)"
    echo "$OUT" | tail -3
    if echo "$OUT" | grep -q USER_RESTRICTED; then
      print_miui_hint
      exit 2
    fi
    if ! echo "$OUT" | grep -q Success; then
      echo "安装失败，原文：$OUT"
      exit 3
    fi
    echo "装好了。接着跑：bash _tools/device.sh run"
    ;;

  run)
    S="$(pick_serial)"
    [ -z "$S" ] && { echo "没找到真机"; exit 1; }
    "$ADB" -s "$S" shell am force-stop $PKG
    "$ADB" -s "$S" shell am start -n $PKG/.MainActivity
    echo "已启动。日志：bash _tools/device.sh log"
    ;;

  log)
    S="$(pick_serial)"
    [ -z "$S" ] && { echo "没找到真机"; exit 1; }
    "$ADB" -s "$S" logcat -v time | grep -Ei "nas\.douyin|transcode|chromium|nodejs|ffmpeg" | head -200
    ;;

  devtools)
    S="$(pick_serial)"
    [ -z "$S" ] && { echo "没找到真机"; exit 1; }
    PID="$("$ADB" -s "$S" shell pidof $PKG | tr -d '\r')"
    [ -z "$PID" ] && { echo "App 没在跑，先 bash _tools/device.sh run"; exit 1; }
    "$ADB" -s "$S" forward tcp:9224 localabstract:webview_devtools_remote_$PID
    echo "真机 WebView 调试端口 → http://127.0.0.1:9224/json/list"
    echo "（模拟器用的是 9223，不冲突）"
    ;;

  lan)
    # 不开 USB 调试也能在真机上测：手机浏览器直连开发机 Node。
    # 注意：这条路走不到 CDP（第三方浏览器不暴露 webview_devtools_remote），
    # 所以量不了 CSS 视口；黑边/转圈这类尺寸敏感的验收仍要插 USB 走 APK。
    PORT="${PORT:-8080}"
    # ⚠️ 必须过 iconv：ipconfig 是 GBK，直接 grep 会被判成 binary file 而静默无输出
    IP="$(ipconfig 2>/dev/null | iconv -f GBK -t UTF-8 2>/dev/null \
          | grep -oE '192\.168\.[0-9]+\.[0-9]+' | head -1)"
    [ -z "$IP" ] && { echo "没找到 192.168.x.x 网段，检查 PC 是否连着同一个 WiFi"; exit 1; }
    echo "== 开发机 Node 服务 =="
    if ! curl -s -m 3 "http://127.0.0.1:$PORT/api/config" >/dev/null 2>&1; then
      echo "  :$PORT 没在跑！先开服务： node server.js"
      exit 1
    fi
    echo "  ✓ http://$IP:$PORT 在跑"
    S="$(pick_serial)"
    if [ -n "$S" ]; then
      echo
      echo "== 真机 $S 直连自检 =="
      for u in "/" "/api/library"; do
        R="$("$ADB" -s "$S" shell "curl -s -m 8 -o /dev/null -w '%{http_code} %{size_download}B' 'http://$IP:$PORT$u'" 2>&1 | tr -d '\r')"
        echo "  $u -> $R"
      done
      echo
      echo "== 在手机浏览器打开 =="
      "$ADB" -s "$S" shell "am start -a android.intent.action.VIEW -d 'http://$IP:$PORT/'"
    fi
    echo
    echo "手机浏览器手动输入： http://$IP:$PORT"
    ;;

  *)
    echo "用法: bash _tools/device.sh {list|install|run|log|devtools|lan}"
    ;;
esac
