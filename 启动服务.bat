@echo off
chcp 65001 >nul
title douyin-nas 服务

REM 优先用受管 Node；没有就用系统 PATH 里的 node
set "NODE_EXE=C:\Users\25407\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

cd /d "%~dp0"
echo.
echo   douyin-nas 服务启动中...
echo   本机访问: http://localhost:8080
echo   手机访问: http://192.168.1.136:8080   (同一 WiFi)
echo.
echo   关闭这个黑窗口 = 停止服务
echo.

REM 已有实例在跑就先停掉，避免端口占用
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8080 ^| findstr LISTENING') do (
  taskkill /F /PID %%p >nul 2>&1
)

"%NODE_EXE%" server.js
pause
