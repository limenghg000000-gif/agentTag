# AgentTag

仿照 Claude Tag 做的飞书版团队 AI 助手：机器人作为成员加入飞书群，群里任何人 @ 它即可提问或派活，它在那条消息的话题里回复。

当前是阶段 0（打通链路）：飞书长连接收消息 → 只处理 @ 机器人的群消息 → 调用大模型 → 在原消息的话题里回复。长连接模式只需要能访问公网，不需要公网地址，内网服务器或本地电脑都能跑。

模型通过 OpenAI 兼容接口调用，默认接阿里云百炼。接口地址、Key、模型 ID 都从环境变量读，换千问、Kimi、GLM 等模型不用改代码。

## 工作方式

```
飞书群 @机器人
  → 飞书长连接（WebSocket）推送 im.message.receive_v1
  → 飞书 SDK Channel：识别 @、按消息 id 去重、丢弃过期重推，事件处理立即返回（飞书要求 3 秒内确认）
  → bot.ts：只处理群白名单里的群，取出问题（去掉 @机器人，其他 @ 换成名字）
  → llm.ts：通过 OpenAI 兼容接口调用模型（默认阿里云百炼）
  → 以富文本（Markdown）回复到原消息的话题里，过长时拆成多条
```

## 目录

| 文件 | 作用 |
| --- | --- |
| `src/index.ts` | 入口：读配置、建立飞书长连接、注册消息处理、优雅退出 |
| `src/config.ts` | 从环境变量读取并校验配置 |
| `src/bot.ts` | 处理一条 @ 消息：问模型，回复到话题；处理截断、内容审核和报错 |
| `src/llm.ts` | 模型调用层：`ChatModel` 接口和 OpenAI 兼容实现，换模型服务只动这里或环境变量 |
| `src/markdown.ts` | 长回答按行切分，代码块不被切坏 |
| `test/` | 单元测试（`npm test`） |

## 第一步：在飞书开放平台创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app)，创建「企业自建应用」。
2. **添加应用能力** → 添加「机器人」。
3. **权限管理** → 至少开通以下两个权限（后续阶段会用到更多，可以一并开通）：
   - `im:message.group_at_msg:readonly`（接收群聊中 @ 机器人消息事件）
   - `im:message:send_as_bot`（以应用的身份发消息）
4. **凭证与基础信息** → 记下 App ID 和 App Secret，填进 `.env`（见第三步）。
5. **版本管理与发布** → 创建版本并发布，让机器人和权限生效。
6. 按第三步把程序跑起来，保持运行。
7. **事件与回调** → 事件配置 → 订阅方式选「使用长连接接收事件」并保存（程序没在运行时保存会失败）→ 添加事件「接收消息」`im.message.receive_v1`。
8. 再创建一个版本并发布，让事件订阅生效。以后改权限或事件都需要重新发布。
9. 在飞书里建一个测试群 → 群设置 → 群机器人 → 添加这个机器人。

## 第二步：开通阿里云百炼 API Key

1. 登录 [阿里云百炼控制台](https://bailian.console.aliyun.com)，开通服务。
2. 创建 API Key，填进 `.env` 的 `MODEL_API_KEY`。要用**按量计费的普通 API Key**，不要用 Coding Plan 的 Key，它的条款不允许用作应用后端。
3. 可选：百炼为北京地域推出了业务空间专属域名，建议把 `MODEL_BASE_URL` 设为 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`（WorkspaceId 在控制台查看）。不设时用默认的 `https://dashscope.aliyuncs.com/compatible-mode/v1`。

## 第三步：运行

需要 Node.js 22 或更高版本。

```bash
npm install
cp .env.example .env   # 填入 FEISHU_APP_ID、FEISHU_APP_SECRET、MODEL_API_KEY
npm run dev            # 开发模式，改代码自动重启
```

看到 `飞书长连接已建立，机器人「…」` 就说明连上了。完成第一步剩下的事件订阅和发布后：

1. 在测试群里 @ 机器人随便说一句。机器人默认不响应任何群，终端会打出 `忽略白名单外的群 chat=oc_xxx`。
2. 把这个 `oc_xxx` 填进 `.env` 的 `FEISHU_ALLOWED_CHAT_IDS`，重启程序。
3. 再 @ 机器人问个问题，回答会出现在这条消息的话题里。

机器人如果也在告警群等业务群里，只要不把那些群加进白名单，它在那里被 @ 也不会回应。

部署时：

```bash
npm run build
npm start
```

## 配置项

所有配置都从环境变量读取，程序启动时会自动加载当前目录下的 `.env`。完整列表和说明见 [.env.example](.env.example)。

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 是 | 飞书应用凭证 |
| `FEISHU_DOMAIN` | 否 | `feishu`（默认）或 `lark`（海外版） |
| `FEISHU_ALLOWED_CHAT_IDS` | 否 | 群白名单，逗号分隔的 chat_id。不填则不响应任何群 |
| `MODEL_API_KEY` | 是 | 模型服务的 API Key（默认百炼） |
| `MODEL_BASE_URL` | 否 | OpenAI 兼容接口地址，默认百炼北京 `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `MODEL_ID` | 否 | 模型 ID，默认 `qwen3.8-max` |

**换模型**：百炼上的其他模型（千问其他型号，以及 Kimi、GLM、DeepSeek 等第三方模型）只需改 `MODEL_ID`，模型 ID 在百炼控制台的模型列表里查。要换到别家的 OpenAI 兼容接口，再改 `MODEL_BASE_URL` 和 `MODEL_API_KEY`。

## 常见问题

- **启动时报「连接飞书失败」**：App ID / Secret 不对，应用还没添加机器人能力、没发布版本，或者服务器访问不了 `open.feishu.cn`（内网服务器需要放行出网）。
- **@ 了机器人没反应**：先看终端日志。出现 `忽略白名单外的群` 说明这个群还没加进 `FEISHU_ALLOWED_CHAT_IDS`。什么日志都没有的话，检查长连接订阅和 `im.message.receive_v1` 事件是否已添加并发布、机器人是否在群里，以及有没有别的程序（比如调试用的监听脚本，或同一个应用的其他服务）也用这个应用连着长连接：飞书只把每个事件推给其中一个连接，事件会被分走。
- **回复「连不上模型服务」**：运行环境访问不到 `MODEL_BASE_URL`，检查内网服务器的出网策略。
- **回复「模型服务返回错误」**：多半是 `MODEL_ID` 写错或该模型没开通，终端日志里有模型服务返回的原始报错。
- **回复「被内容审核拦下」**：百炼对输入输出做内容审核，换个说法即可。

## 当前限制（后续阶段解决）

- 每次提问独立回答，不带话题里的上下文。
- 单聊暂不响应，只处理群里 @ 机器人的消息。
- 去重记录在内存里，重启后清空。多开几个实例也不会重复回答，飞书只把每个事件推给其中一个连接。
- 还不能调用工具、没有记忆和定时任务。

## 开发

```bash
npm run typecheck   # 类型检查
npm test            # 单元测试
```
