@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QQ Persona Bot
if not exist ".env" (
  echo [错误] 没找到 .env，先执行： copy .env.example .env   然后把里面填好
  pause
  exit /b 1
)
if not exist "node_modules" (
  echo 第一次运行，先装依赖...
  call npm install
)
echo 启动中... 控制台地址见下面日志里的 http://127.0.0.1:8099
node src/index.js
echo.
echo 程序已退出。
pause
