#!/usr/bin/env bash
# ════════════════════════════════════════════════════
#  积温桥 · VPS 部署脚本
#
#  在 VPS 上以 root 执行：
#    bash deploy.sh
#
#  作用：
#    1. 检查 Node 版本（需要 >= 20）
#    2. 安装到 /root/jiwen-bridge
#    3. 生成 systemd unit 并启用
#    4. 启动并做健康检查
# ════════════════════════════════════════════════════

set -e

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="/root/jiwen-bridge"
SERVICE="jiwen-bridge"

echo "═══ 积温桥部署 ═══"

# ── 1. Node 检查 ──
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未找到 node。请先安装 Node.js 20+："
  echo "    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"
  exit 1
fi
NODE_VER=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VER" -lt 20 ]; then
  echo "✗ Node 版本过低（$NODE_VER），需要 >= 20"
  exit 1
fi
echo "✓ Node $(node -v)"

# ── 2. 复制文件 ──
echo "→ 安装到 $DEST"
mkdir -p "$DEST"
cp -r "$SRC_DIR/bridge.js" "$SRC_DIR/lib" "$SRC_DIR/config" "$SRC_DIR/vendor" "$DEST/"
mkdir -p "$DEST/data"

# ── 3. .env ──
if [ ! -f "$DEST/.env" ]; then
  cp "$SRC_DIR/.env.example" "$DEST/.env"
  echo "✓ 已生成 $DEST/.env —— 请先编辑它，填 BRIDGE_TOKEN / UPSTREAM_TOKEN"
  echo "  编辑命令：nano $DEST/.env"
  NEED_EDIT=1
else
  echo "✓ 复用已有 $DEST/.env"
  NEED_EDIT=0
fi

# ── 4. systemd unit ──
cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=Jiwen Bridge - 积温注入桥 (Serein front proxy)
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=${DEST}
ExecStart=$(command -v node) ${DEST}/bridge.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=append:${DEST}/data/stdout.log
StandardError=append:${DEST}/data/stderr.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ${SERVICE} >/dev/null 2>&1 || true

if [ "$NEED_EDIT" = "1" ]; then
  echo ""
  echo "⚠️  请先编辑 $DEST/.env 填好凭据，然后执行："
  echo "     systemctl start ${SERVICE}"
  echo "     systemctl status ${SERVICE}"
  echo "     curl http://127.0.0.1:18220/bridge/health"
  exit 0
fi

# ── 5. 启动 ──
systemctl restart ${SERVICE}
sleep 2
echo ""
if systemctl is-active --quiet ${SERVICE}; then
  echo "✓ 服务已启动"
  curl -s http://127.0.0.1:18220/bridge/health || true
  echo ""
  echo "查看日志：journalctl -u ${SERVICE} -f"
  echo "或：tail -f ${DEST}/data/bridge.log"
else
  echo "✗ 启动失败，检查：journalctl -u ${SERVICE} -n 50"
  exit 1
fi
