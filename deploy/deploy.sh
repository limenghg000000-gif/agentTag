#!/usr/bin/env bash
# 把机器人服务器上的 AgentTag 更新到指定提交：GitLab 流水线的 deploy 任务在服务器上跑它（Runner 和机器人是同一个用户）。
#
# 做的事：
#   1. 从 GitLab 拉代码，把 ~/agentTag 切到这次的提交（只往前更新；要部署的比服务器上的旧就跳过）
#   2. package-lock.json 变了才 npm ci，然后构建；构建失败不重启，切回原来那一版
#   3. 重启 agenttag-feishu，等启动日志里出现「飞书长连接已建立，版本 X」；等不到就切回上一版再重启
#   4. 拿不准服务器上是什么状态时（第一次部署、上一次部署中途被停了、有人手动切过代码），不跳过，重装依赖、构建、重启
#
# 回滚：在 GitHub 上 revert 那个 PR 再合并，走同一条路。
# 手动跑：CI_COMMIT_SHA=<提交> CI_REPOSITORY_URL=<GitLab 仓库地址> bash deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/agentTag}"
SERVICE="${SERVICE:-agenttag-feishu}"
BRANCH="${DEPLOY_BRANCH:-master}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
WAIT_SECONDS="${WAIT_SECONDS:-120}"
TARGET="${CI_COMMIT_SHA:?要给 CI_COMMIT_SHA：要部署的提交}"
REPO_URL="${CI_REPOSITORY_URL:?要给 CI_REPOSITORY_URL：从哪拉代码}"

# systemctl --user、journalctl --user 要找到这个用户的 systemd
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

log() { echo "[部署] $*"; }
fail() {
  echo "[部署] 失败：$*" >&2
  exit 1
}

for cmd in git node npm systemctl journalctl flock; do
  command -v "$cmd" >/dev/null || fail "找不到 $cmd（Runner 的 PATH 里要有 node 和 npm，见 deploy/README.md）"
done

# 同一时间只跑一个部署（流水线的 resource_group 之外再拦一道，防着有人同时手动跑）
exec 9>"$XDG_RUNTIME_DIR/agenttag-deploy.lock"
flock -w 600 9 || fail "等了 10 分钟，还有别的部署在跑"

cd "$APP_DIR"
# 没提交的改动、多出来的文件都不行（.gitignore 里的 .env、data/、dist/、node_modules/ 不算）：src/ 下多一个文件也会被一起构建
if [ -n "$(git status --porcelain)" ]; then
  git status --short | head -20 >&2
  fail "$APP_DIR 里有没提交的改动或多出来的文件（上面列的），先处理掉再部署"
fi

git fetch --quiet --no-tags "$REPO_URL" "+refs/heads/$BRANCH:refs/remotes/gitlab/$BRANCH"
git cat-file -e "$TARGET^{commit}" 2>/dev/null || fail "从 GitLab 拉下来的代码里没有提交 $TARGET"
target=$(git rev-parse "$TARGET^{commit}")

short() { git rev-parse --short=8 "$1"; }
version_at() { git show "$1:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'; }
# 依赖的指纹：package-lock.json 去掉自己的版本号（每次发版都改，不算依赖变了）
deps_of() {
  git show "$1:package-lock.json" | node -p '
    const lock = JSON.parse(require("fs").readFileSync(0, "utf8"));
    delete lock.version;
    if (lock.packages?.[""]) delete lock.packages[""].version;
    require("crypto").createHash("sha256").update(JSON.stringify(lock)).digest("hex")'
}

# 两个记号放在 .git 里（不算工作区的改动）：
#   DEPLOYED：上一次部署成功、服务起来时用的提交
#   PENDING：部署开始前服务器上原来那一版；部署成功（或者切回去起来）后删掉。开始时它还在，说明上一次部署中途被停了（流水线超时、被取消）
GIT_DIR=$(git rev-parse --absolute-git-dir)
DEPLOYED="$GIT_DIR/agenttag-deployed"
PENDING="$GIT_DIR/agenttag-deploy-pending"

old=$(git rev-parse HEAD)
# 服务器上的代码、构建、跑着的服务对得上：上一次部署成功的就是现在这个提交，而且没有半截的部署
known_good=
if [ -f "$PENDING" ]; then
  old=$(cat "$PENDING")
  git cat-file -e "$old^{commit}" 2>/dev/null || fail "上一次部署中途停了，记下的原版本 $old 找不到，去服务器上看一下（记号在 $PENDING）"
  log "上一次部署中途停了，代码和构建可能是半截的：按 $(short "$old") 算原来那一版，这次重装依赖、重新构建"
elif [ -f "$DEPLOYED" ] && [ "$(cat "$DEPLOYED")" = "$old" ]; then
  known_good=1
else
  log "没有 $(short "$old") 部署成功的记录（第一次自动部署，或者有人手动切过代码）：这次重装依赖、重新构建、重启"
fi

# node_modules 是按哪个提交的依赖装的；拿不准时留空，下次切换一定 npm ci
modules_of=
[ -z "$known_good" ] || modules_of=$old

# 等这一次重启后的启动日志里出现「飞书长连接已建立，版本 X，」
wait_started() {
  local version="$1" since="$2" deadline=$(($(date +%s) + WAIT_SECONDS))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if journalctl --user -u "$SERVICE" --since "@$since" -o cat --no-pager 2>/dev/null | grep -qF "飞书长连接已建立，版本 $version，"; then
      return 0
    fi
    sleep 3
  done
  return 1
}

# 切到某个提交并构建；依赖跟 node_modules 装的那一版不一样（或者拿不准）才 npm ci
switch_and_build() {
  git -c advice.detachedHead=false checkout --quiet --detach "$1" || return 1
  if [ ! -d node_modules ] || [ -z "$modules_of" ] || [ "$(deps_of "$1")" != "$(deps_of "$modules_of")" ]; then
    log "装依赖（npm ci）"
    modules_of=
    npm ci --no-audit --no-fund --registry="$NPM_REGISTRY" || return 1
    modules_of=$1
  fi
  npm run build || return 1
}

# 重启并等启动日志；起来了就记下这一版部署成功
restart() {
  local since
  since=$(date +%s)
  systemctl --user restart "$SERVICE"
  wait_started "$(version_at "$1")" "$since" || return 1
  echo "$1" >"$DEPLOYED"
  rm -f "$PENDING"
}

if [ "$target" = "$old" ] && [ -n "$known_good" ]; then
  systemctl --user is-active --quiet "$SERVICE" || fail "服务器上已经是 $(short "$target")，但 $SERVICE 没在跑"
  log "服务器上已经是 $(short "$target")，不用更新"
  exit 0
fi
if [ "$target" != "$old" ] && git merge-base --is-ancestor "$target" "$old"; then
  if [ -n "$known_good" ]; then
    log "服务器上的 $(short "$old") 比 $(short "$target") 新，跳过（回滚请在 GitHub 上 revert 再合并）"
    exit 0
  fi
  log "要部署的 $(short "$target") 比原来那一版 $(short "$old") 旧，不部署它，只把服务器恢复到 $(short "$old")"
  target=$old
fi
if [ "$target" != "$old" ]; then
  git merge-base --is-ancestor "$old" "$target" ||
    fail "服务器上的 $(short "$old") 不在 $(short "$target") 的历史里（有人在服务器上单独提交过？），不自动覆盖"
fi

new_version=$(version_at "$target")
old_version=$(version_at "$old")
if [ "$target" = "$old" ]; then
  log "重新构建、重启 $(short "$target")（版本 $new_version）"
else
  log "更新 $(short "$old")（版本 $old_version）→ $(short "$target")（版本 $new_version）"
fi
echo "$old" >"$PENDING"

if ! switch_and_build "$target"; then
  [ "$target" != "$old" ] || fail "构建 $(short "$target") 没过，没重启；机器人还在跑原来的进程，但下次重启前要有人看一下"
  log "构建没过，切回 $(short "$old")"
  switch_and_build "$old" || fail "构建没过，切回 $(short "$old") 也构建失败；机器人还在跑原来的进程，但下次重启前要有人看一下"
  # 原来就对得上，切回去以后还是对得上；原来拿不准的，留着记号，下次照样重新构建
  [ -z "$known_good" ] || rm -f "$PENDING"
  fail "构建没过，没重启，服务器上的代码切回了 $(short "$old")"
fi

log "重启 $SERVICE，等启动日志（最多 ${WAIT_SECONDS} 秒）"
if restart "$target"; then
  log "已上线：版本 $new_version（提交 $(short "$target")）"
  exit 0
fi
[ "$target" != "$old" ] ||
  fail "重启后 ${WAIT_SECONDS} 秒没看到「飞书长连接已建立，版本 $new_version」，去服务器上看：journalctl --user -u $SERVICE -n 200"

log "等了 ${WAIT_SECONDS} 秒没看到「飞书长连接已建立，版本 $new_version」，切回 $(short "$old")"
switch_and_build "$old" || fail "新版本没起来，切回 $(short "$old") 又构建失败，去服务器上看：journalctl --user -u $SERVICE -n 100"
if restart "$old"; then
  fail "新版本没起来，已经切回 $(short "$old")（版本 $old_version）并重启好了；原因去服务器上看：journalctl --user -u $SERVICE -n 200"
fi
fail "新版本没起来，切回 $(short "$old") 后也没起来，去服务器上看：journalctl --user -u $SERVICE -n 200"
