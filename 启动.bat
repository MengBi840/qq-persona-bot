@echo off
chcp 65001 >nul
cd /d "%~dp0"
title QQ 群 BOT

echo.
echo   ==========================================
echo      QQ 群 BOT  （NapCat + DeepSeek）
echo   ==========================================
echo.

if not exist "qqbot.exe" (
  echo   [错误] 没找到 qqbot.exe
  echo   如果你是从源码运行的，请改用： npm start
  pause
  exit /b 1
)

if not exist ".env" (
  if exist ".env.example" (
    copy /y ".env.example" ".env" >nul
    echo   [首次运行] 已帮你生成 .env，现在打开记事本，把这三个值改成你自己的：
    echo.
    echo       PANEL_PASSWORD     控制台登录密码
    echo       DEEPSEEK_API_KEY   你的 DeepSeek 密钥（sk- 开头）
    echo       OB_ACCESS_TOKEN    要和 NapCat 里填的一模一样
    echo.
    echo   改完保存，再双击一次本文件。
    echo.
    start "" notepad ".env"
    pause
    exit /b 0
  )
  echo   [错误] 既没有 .env 也没有 .env.example
  pause
  exit /b 1
)

echo   正在启动... 稍等一下，控制台地址会打在下面。
echo   默认 http://127.0.0.1:8099   密码就是 .env 里的 PANEL_PASSWORD
echo   （如果提示配置没填完，按提示改 .env 后重开本文件）
echo.

qqbot.exe %*

echo.
echo   程序已退出。
pause
