#!/usr/bin/env sh
# DCODE 便携启动器（macOS / Linux）：在 Release 包目录下执行 ./dcode.sh
# 依赖：本机已安装 Node.js 18+

set -e
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "[DCODE] 未检测到 Node.js，请从 https://nodejs.org 安装后重试。"
  exit 1
fi

if [ ! -f "$ROOT/dist/cli.js" ]; then
  echo "[DCODE] 找不到 dist/cli.js，请下载完整的 Release 安装包。"
  exit 1
fi

# 工作目录：优先读 工作目录.txt，否则使用 $HOME
WORKDIR=""
if [ -f "$ROOT/工作目录.txt" ]; then
  WORKDIR="$(head -n 1 "$ROOT/工作目录.txt" | tr -d '\r')"
fi
if [ -z "$WORKDIR" ]; then
  WORKDIR="${HOME:-.}"
fi
if [ ! -d "$WORKDIR" ]; then
  echo "[DCODE] 工作目录不存在：$WORKDIR"
  echo "        请编辑 $ROOT/工作目录.txt"
  exit 1
fi

cd "$WORKDIR"
echo "[DCODE] 工作目录：$(pwd)"
exec node "$ROOT/dist/cli.js" "$@"
