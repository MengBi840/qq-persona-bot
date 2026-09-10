@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QQ 群 BOT
set LOG=%~dp0startup-log.txt

echo.
echo   ============================================
echo      QQ 群 BOT   NapCat + DeepSeek
echo   ============================================
echo.

if not exist "qqbot.exe" (
  echo   [错误] 这个文件夹里没有 qqbot.exe
  echo.
  echo   你可能双击错了文件。qqbot.exe 在 dist\qqbot\ 里面。
  echo   如果还没打包，先在项目根目录执行： npm run build:exe
  echo.
  pause
  exit /b 1
)

rem ---------- 1) 没有 .env 就生成一份并打开记事本 ----------
if not exist ".env" (
  if not exist ".env.example" (
    echo   [错误] 既没有 .env 也没有 .env.example，文件不完整。
    pause
    exit /b 1
  )
  copy /y ".env.example" ".env" >nul
  echo   [首次运行] 已生成 .env，现在打开记事本，请把这三行改成你自己的：
  echo.
  echo       DEEPSEEK_API_KEY    你的 DeepSeek 密钥（sk- 开头，去 platform.deepseek.com 申请）
  echo       PANEL_PASSWORD      控制台登录密码（自己随便定一个）
  echo       OB_ACCESS_TOKEN     和 NapCat 里填的 Token 一模一样
  echo.
  echo   改完按 Ctrl+S 保存，关掉记事本，再双击一次本文件。
  echo.
  start "" notepad ".env"
  pause
  exit /b 0
)

rem ---------- 2) 先自检，报告同时写屏幕和日志 ----------
echo   正在自检...
echo.
qqbot.exe --check
set CHECK=%errorlevel%
qqbot.exe --check > "%LOG%" 2>&1

if not "%CHECK%"=="0" (
  echo.
  echo   ============================================
  echo    自检没通过，所以没有启动。
  echo   ============================================
  echo.
  echo   请按上面【5】里的提示改 .env，改完重新双击本文件。
  echo   完整报告也写到了：%LOG%
  echo.
  echo   想先看看控制台界面、暂时不连 QQ，可以执行：
  echo       qqbot.exe --no-qq
  echo.
  pause
  exit /b 1
)

rem ---------- 3) 自检通过，正式启动 ----------
echo.
echo   自检通过，正在启动...
echo.
echo   启动后浏览器打开控制台（密码是 .env 里的 PANEL_PASSWORD）：
echo       http://127.0.0.1:8099
echo.
echo   关掉这个窗口就是停止机器人。
echo.

qqbot.exe %*
set RUN=%errorlevel%

echo.
if not "%RUN%"=="0" (
  echo   [程序异常退出] 退出码 %RUN%
  echo   详细自检日志：%LOG%
) else (
  echo   程序已正常退出。
)
echo.
pause
