@echo off
chcp 65001 >nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8080 ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
echo 服务已停止（若本来没在跑则无变化）
timeout /t 2 >nul