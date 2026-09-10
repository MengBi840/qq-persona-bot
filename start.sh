#!/usr/bin/env bash
# macOS / Linux / WSL 启动脚本（NapCat 一般跑在 Windows，这个只跑机器人本体）
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "[错误] 没有 .env，先 cp .env.example .env 并填好"
  exit 1
fi
[ -d node_modules ] || npm install
exec node src/index.js
