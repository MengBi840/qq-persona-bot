@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QQ 群 BOT（源码模式）
set LOG=%~dp0startup-log.txt

echo.
echo   ============================================
echo      QQ 群 BOT  源码模式（需要装过 Node）
echo   ============================================
echo.

rem 如果你只是想直接用打包好的机器人，请看 dist\qqbot\启动.bat
if exist "dist\qqbot\qqbot.exe" (
  echo   [提示] 检测到已经打包好的版本，那个不用装 Node，更省事：
  echo          dist\qqbot\启动.bat
  echo.
  echo   如果你想用源码模式继续，就按下面走。
  echo.
)

if not exist "package.json" (
  echo   [错误] 这里不是项目根目录（没找到 package.json）
  pause
  exit /b 1
)

where node >nul 2>nul
if not "%errorlevel%"=="0" (
  echo   [错误] 没找到 node 命令。
  echo.
  echo   源码模式需要先装 Node.js 18+： https://nodejs.org
  echo   或者直接用打包好的版本： dist\qqbot\启动.bat（那个不用装 Node）
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo   第一次运行，正在装依赖（要等一会儿）...
  echo.
  call npm install
  if not "%errorlevel%"=="0" (
    echo   [错误] npm install 失败了，把上面的报错发出来看看。
    pause
    exit /b 1
  )
  echo.
)

if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo   [首次运行] 已生成 .env，现在打开记事本，请把这三行改成你自己的：
    echo.
    echo       DEEPSEEK_API_KEY    你的 DeepSeek 密钥（sk- 开头）
    echo       PANEL_PASSWORD      控制台登录密码（自己定）
    echo       OB_ACCESS_TOKEN     和 NapCat 里填的 Token 一样
    echo.
    echo   改完保存，再双击一次本文件。
    echo.
    start "" notepad ".env"
    pause
    exit /b 0
  )
  echo   [错误] 找不到 .env 和 .env.example
  pause
  exit /b 1
)

echo   正在自检...
echo.
node src\index.js --check
set CHECK=%errorlevel%
node src\index.js --check > "%LOG%" 2>&1

if not "%CHECK%"=="0" (
  echo.
  echo   ============================================
  echo    自检没通过，所以没有启动。
  echo   ============================================
  echo.
  echo   请按上面提示改 .env，改完重新双击本文件。
  echo   完整报告：%LOG%
  echo.
  echo   想先看控制台界面、不连 QQ： npm run panel
  echo.
  pause
  exit /b 1
)

echo.
echo   自检通过，正在启动...
echo.
echo   控制台： http://127.0.0.1:8099   （密码是 .env 里的 PANEL_PASSWORD）
echo   关掉这个窗口就是停止机器人。
echo.

node src\index.js %*
set RUN=%errorlevel%

echo.
if not "%RUN%"=="0" (
  echo   [程序异常退出] 退出码 %RUN%
  echo   自检日志：%LOG%
) else (
  echo   程序已正常退出。
)
echo.
pause
