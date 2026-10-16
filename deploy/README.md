# 自动部署

代码在 GitHub 上评审、合并到 main 以后自动上线，不用再登服务器手动更新。

## 怎么走的

1. **GitHub 自动检查**（`.github/workflows/ci.yml`）：每个 PR 和 main 都跑类型检查、单元测试、构建，PR 上能看到结果。
2. **同步到公司 GitLab**：main 上都过了，把这一版推到 GitLab `ai/agent-tag` 的 master。只往后加，从不强推。
3. **GitLab 流水线**（`.gitlab-ci.yml`）：master 有新提交就建流水线，在机器人服务器上的 GitLab Runner 里跑两步：
   - `test`：在 Runner 自己的目录里装依赖、跑类型检查和单元测试，不碰正在跑的机器人；
   - `deploy`：`deploy/deploy.sh` 把 `~/agentTag` 切到这次的提交，依赖变了才 `npm ci`，构建，重启 `agenttag-feishu`，等启动日志里出现「飞书长连接已建立，版本 X」。
4. 机器人起来以后，照旧往群里发这一版的更新通知。

`deploy` 遇到问题时：

| 情况 | 怎么处理 |
| --- | --- |
| 构建没过 | 不重启，切回原来那一版，流水线标红 |
| 重启后 2 分钟内没等到启动日志 | 切回上一版再重启，流水线标红 |
| 要部署的比服务器上的旧 | 跳过（流水线顺序乱了、或者有人手动部署过更新的） |
| `~/agentTag` 里有没提交的改动 | 不部署，流水线标红，先在服务器上处理掉 |

部署以后服务器上的 `~/agentTag` 停在部署的那个提交上，`git status` 显示 `HEAD detached`，这是正常的。

## 回滚

在 GitHub 上 revert 那个 PR 再合并，走同一条路上线。

急的时候在服务器上手动切回某个提交（依赖变过的话构建前先 `npm ci --registry=https://registry.npmmirror.com`）：

```bash
cd ~/agentTag && git checkout --detach <提交号> && npm run build && systemctl --user restart agenttag-feishu
```

手动切过以后，流水线再部署更新的提交时照常往前走。

## 一次性设置

### GitLab（`ai/agent-tag`）

1. **项目访问令牌**（设置 → 访问令牌）：角色选 Maintainer（master 是保护分支，只有 Maintainer 能推），权限只勾 `write_repository`，设一个过期时间。GitHub 往这里推代码用它。
2. **新建项目 Runner**（设置 → CI/CD → Runner）：标签填 `agenttag-ecs`；不勾「运行未打标签的作业」；勾「受保护」，只跑保护分支的作业。建好后页面给一个 `glrt-` 开头的令牌，下面在服务器上用。
3. **保护分支只留 master**（设置 → 仓库 → 受保护分支）：master 只有 Maintainer 能推和合并，不允许强推。别的保护规则（比如以前留下的 release、staging、test，允许 Developer 推送）要删掉：受保护的 Runner 会跑所有保护分支上的作业，谁建了同名分支，那个分支自己的 `.gitlab-ci.yml` 就能在服务器上执行命令。保护标签也不要设。
4. 这边的合并请求不要在 GitLab 上直接合，改动都走 GitHub 评审，不然下次同步会推不上去。

### GitHub 仓库

设置 → Environments → 新建环境 `gitlab-sync`：

- Deployment branches and tags 选「Selected branches and tags」，只加 `main`；
- Environment secrets 加 `GITLAB_PUSH_TOKEN`：上面的项目访问令牌；
- Environment variables 加 `GITLAB_REPO_URL`：`https://lab.yuebai.site/ai/agent-tag.git`（要同步到 master 以外的分支时再加 `GITLAB_BRANCH`）。

令牌一定放在这个环境里，不要放仓库级的 Secrets：环境只给 main 用，别的分支就算改了流水线文件也拿不到它。两个都配了才同步，没配时那一步跳过。配好以后可以在 Actions → CI → Run workflow 手动跑一次 main，不用等下一次合并。

### 服务器

用跑机器人的那个用户执行，按提示粘贴上面的 `glrt-` 令牌（输入不显示）：

```bash
cd ~/agentTag && git pull --ff-only
bash deploy/install-runner.sh
```

脚本会从 GitLab 官方下载 Runner；服务器上下载太慢的话，先在别处下好同一个文件放到 `~/bin/gitlab-runner`（加执行权限），或者用 `RUNNER_URL=<下载地址>` 指定，脚本就不再下载。

Runner 装在 `~/bin/gitlab-runner`，作为这个用户的 systemd 服务常驻（`systemctl --user status gitlab-runner`，日志 `journalctl --user -u gitlab-runner -f`）。配置在 `~/.gitlab-runner/config.toml`，里面有 Runner 令牌，权限 600。装好后 GitLab 的 Runner 页面上它显示在线。

## 安全

- 流水线只给 master 建，Runner 又设成受保护：机器人自己推的分支、合并请求里的代码不会在服务器上跑。
- Runner 和机器人是同一个用户，读得到 `.env`。能往 master 推代码就等于能在服务器上执行命令，所以 master 只给 Maintainer 推。
- GitHub 往 GitLab 推用的项目令牌只有 `write_repository` 权限，只能动这一个项目；GitHub 那边存在只给 main 用的环境里，日志里会被遮住。
- 流水线日志里只有部署步骤的输出，不打机器人的运行日志（里面有群里的对话）。要看原因去服务器上看 `journalctl --user -u agenttag-feishu`。
