#!/usr/bin/env bash
# 在机器人服务器上装 GitLab Runner，给 ai/agent-tag 的流水线自动部署用。
# 用跑机器人的同一个用户装，不用 sudo：Runner 作为这个用户的 systemd 服务常驻，部署时能直接重启 agenttag-feishu。
#
# 用法：bash deploy/install-runner.sh
#   按提示粘贴在 GitLab 上新建 Runner 时给的令牌（输入不显示，也不进 shell 历史）。
#   重复跑没关系：已经注册过就只更新 systemd 服务。
set -euo pipefail

GITLAB_URL="${GITLAB_URL:-https://lab.yuebai.site}"
RUNNER_TAG="${RUNNER_TAG:-agenttag-ecs}"
BIN="$HOME/bin/gitlab-runner"
CONFIG="$HOME/.gitlab-runner/config.toml"
WORK_DIR="$HOME/gitlab-runner"
UNIT="$HOME/.config/systemd/user/gitlab-runner.service"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

node_bin=$(command -v node) || {
  echo "当前 shell 里找不到 node，先在能跑 npm 的 shell 里执行这个脚本"
  exit 1
}

if [ ! -x "$BIN" ]; then
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64) arch=arm64 ;;
    *) echo "不认识的 CPU 架构 $(uname -m)" && exit 1 ;;
  esac
  url="${RUNNER_URL:-https://gitlab-runner-downloads.s3.amazonaws.com/latest/binaries/gitlab-runner-linux-$arch}"
  echo "下载 GitLab Runner：$url"
  mkdir -p "$HOME/bin"
  curl -fL --retry 3 -o "$BIN.tmp" "$url"
  chmod +x "$BIN.tmp"
  mv "$BIN.tmp" "$BIN"
fi
"$BIN" --version | head -1

mkdir -p "$(dirname "$CONFIG")" "$WORK_DIR"
if [ ! -f "$CONFIG" ] || ! grep -q "url = \"$GITLAB_URL" "$CONFIG"; then
  read -rsp "粘贴 GitLab 上新建 Runner 给的令牌：" token
  echo
  [ -n "$token" ] || { echo "没输入令牌"; exit 1; }
  common=(--non-interactive --config "$CONFIG" --url "$GITLAB_URL" --executor shell
    --builds-dir "$WORK_DIR/builds" --cache-dir "$WORK_DIR/cache")
  if [[ "$token" == glrt-* ]]; then
    # 新版 GitLab：标签、「受保护」、「不跑没打标签的任务」在 GitLab 页面上建 Runner 时就设好了
    CI_SERVER_TOKEN="$token" "$BIN" register "${common[@]}"
  else
    # 老版 GitLab 的注册令牌：这几项在这里设
    REGISTRATION_TOKEN="$token" "$BIN" register "${common[@]}" \
      --description agenttag-ecs --tag-list "$RUNNER_TAG" --run-untagged=false --locked=true --access-level=ref_protected
  fi
  unset token
fi
chmod 600 "$CONFIG"

mkdir -p "$(dirname "$UNIT")"
cat >"$UNIT" <<EOF
[Unit]
Description=GitLab Runner（AgentTag 自动部署）
After=network-online.target

[Service]
# 跟手动执行这个脚本时一样能找到 node 和 npm
Environment=PATH=$(dirname "$node_bin"):/usr/local/bin:/usr/bin:/bin
ExecStart=$BIN run --config $CONFIG --working-directory $WORK_DIR
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now gitlab-runner
systemctl --user restart gitlab-runner

if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  echo "注意：这个用户没开 linger，退出登录后 Runner 会停。用有 sudo 的账号执行：sudo loginctl enable-linger $USER"
fi
sleep 3
systemctl --user --no-pager --lines=5 status gitlab-runner || true
echo "装好了。到 GitLab 项目的 设置 → CI/CD → Runner 里，这台 Runner 应该显示在线（绿点）。"
