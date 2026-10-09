import assert from "node:assert/strict";
import { test } from "node:test";
import type { CardActionEvent, SendInput, SendOptions } from "@larksuiteoapi/node-sdk";
import {
  type Embedder,
  formatKnowledge,
  type KnowledgeBackend,
  KnowledgeBase,
  type KnowledgeEntry,
  KnowledgeError,
  normalizeDraft,
  renderHitsForPrompt,
} from "../src/knowledge.js";
import { AiopsLessons, type LessonsMcp, renderAiopsHitsForPrompt } from "../src/knowledge-aiops.js";
import { raceAbort } from "../src/abort.js";
import { readFile } from "node:fs/promises";
import { buildSystemPrompt } from "../src/prompt.js";
import { KNOWLEDGE_ACTION, KnowledgeDesk, PROPOSAL_TTL_MS } from "../src/tools/knowledge.js";

const quiet = { info() {}, warn() {}, error() {} };
const signal = new AbortController().signal;

class MemoryBackend implements KnowledgeBackend {
  entries: KnowledgeEntry[] = [];
  lists = 0;
  failAdd?: Error;
  /** 前几次 update 失败 */
  failUpdates = 0;
  /** 前几次 update 改成功了，但结果没传回来 */
  lostUpdates = 0;
  /** 发出过的最大编号 */
  highest = 0;

  async location() {
    return "https://example.feishu.cn/base/app1?table=tbl1";
  }

  async list() {
    this.lists++;
    return structuredClone(this.entries);
  }

  async issued() {
    return this.highest;
  }

  async issue(number: number) {
    this.highest = number;
  }

  async add(entry: KnowledgeEntry) {
    if (this.failAdd) {
      throw this.failAdd;
    }
    this.entries.push(structuredClone(entry));
  }

  async update(id: string, changes: Partial<KnowledgeEntry>) {
    if (this.failUpdates > 0) {
      this.failUpdates--;
      throw new KnowledgeError("飞书接口限流");
    }
    Object.assign(this.entries.find((entry) => entry.id === id)!, changes);
    if (this.lostUpdates > 0) {
      this.lostUpdates--;
      throw new KnowledgeError("socket hang up");
    }
  }
}

const code8 = {
  category: "incident",
  title: "gateway-api 报 code=8：user-rpc 单 Pod 被打满触发降载",
  scope: "gateway-api, user-rpc",
  question: "gateway-api 日志里大量 code=8 ResourceExhausted，接口返回 Success 但 data 为空",
  conclusion: "user-rpc 用 ClusterIP 走 gRPC 长连接，流量固定打到一个 Pod，CPU limit 350m 被打满后 go-zero 降载",
  handling: "未修复。建议改 headless Service 或 k8s:// 服务发现",
  keywords: "code=8，ResourceExhausted、user-rpc",
  error_codes: "8, ResourceExhausted",
};

const dau = {
  category: "metric",
  title: "日活的口径",
  question: "日活怎么统计",
  conclusion: "当天打开过 App 的去重用户数，排除内部测试账号",
  keywords: "日活,DAU",
};

test("起草的经验：去掉空白、检查必填和长度，关键词和错误码统一用逗号分隔", () => {
  const draft = normalizeDraft({ ...code8, title: `  ${code8.title}\n ` });
  assert.equal(draft.title, code8.title);
  assert.equal(draft.keywords, "code=8,ResourceExhausted,user-rpc");
  assert.equal(draft.errorCodes, "8,ResourceExhausted");
  assert.equal(draft.basis, undefined);

  assert.throws(() => normalizeDraft({ ...code8, category: "faq" }), /category 只能是/);
  assert.throws(() => normalizeDraft({ ...code8, conclusion: "  " }), /结论（conclusion）不能为空/);
  assert.throws(() => normalizeDraft({ ...code8, title: "长".repeat(81) }), /标题（title）最多 80 字/);
  assert.throws(() => normalizeDraft({ ...code8, scope: 42 }), /适用范围（scope）要填文字/);
});

test("草稿里有密钥、密码时不让存，错误信息里不复述密钥；只是提到令牌过期的照常", () => {
  for (const secret of [
    "GITLAB_TOKEN=glpat-abcdefghijklmnopqrstu",
    "用 sk-abcdefghijklmnopqrstuvwxyz123 调的接口",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789",
    "OPENAI_KEY 是 sk-proj-abcdefghij0123456789_ABCDEFGHIJ-klmnop",
    "sk-ant-api03-abcdefghijklmnop0123456789",
    "sk-svcacct-AbCdEfGhIj0123456789",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "AccessKeySecret: abcdefghijklmnopqrstuvwxyzABCD",
    "password=correcthorsebatterystaple",
    "mysql://agent:p4ssw0rd@10.0.0.5:3306/aiops",
    "数据库密码：Abc12345678",
    "-----BEGIN RSA PRIVATE KEY-----",
    // 拼出来的，免得源码里出现像真密钥的字符串
    ["xox", "b-1234567890-0987654321-AbCdEfGhIjKlMnOp"].join(""),
    ["xox", "e.xox", "p-1-AbCdEfGhIjKlMnOpQr"].join(""),
    ["xapp", "-1-A0123456789-0123456789-abcdef"].join(""),
    ["https://open.feishu.cn/open-apis/bot/v2/hook/", "3fa85f64-5717-4562-b3fc-2c963f66afa6"].join(""),
    ["https://hooks.slack.com/services/", "T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"].join(""),
    ["AIza", "SyA-abcdefghijklmnopqrstuvwxyz01234"].join(""),
    ["sk", "_live_", "abcdefghijklmnop0123"].join(""),
    ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcdefghijklmnopqrstuv"].join("."),
    // token、secret 后面写的值没有数字也算
    "MCP_AIOPS_TOKEN=correcthorsebatterystaple",
    "secret: correct-horse-battery-staple",
    'aiops 配置是 {"token": "CorrectHorseBatteryStaple"}',
    "https://aiops.example.com/mcp?token=correcthorsebattery&ns=prod",
    "FEISHU_APP_SECRET=CorrectHorseBattery。",
    // API Key：写明了是它的，值里有没有数字都算
    "MODEL_API_KEY=correcthorsebatterystaple",
    'const client = new OpenAI({ apiKey: "CorrectHorseBatteryStaple" })',
    "curl -H 'x-api-key: correct-horse-battery-staple'",
    "api_key=abcdef0123456789",
    // 夹着 token、secret 这类词的照样算，只有整个值都是报错、占位用词才不算
    "MCP_AIOPS_TOKEN=prod-secret-abcdefghijkl",
    "token=my-token-value-abcdef",
    // 带点的也算，只有读密钥的属性引用（cfg.Token、process.env.MODEL_API_KEY）不算
    "MODEL_API_KEY=correct.horse.battery.staple",
    "token: correct.horse.battery.staple.",
    // 值里带冒号、感叹号这些标点的整段都算，不会因为中间有标点就放过
    "MCP_AIOPS_TOKEN=abc:defghijklmnopqrstuvwxyz",
    "token=correct!horse#battery",
    'secret: "horse:battery:staple"',
    "api_key=horse&battery%staple^x",
    "**MCP_AIOPS_TOKEN=correcthorsebattery**",
    "token=correct:horse.Token",
    // JSON、PHP 里带引号的键和值，引号里带空格的口令整段都算
    '{"password":"correcthorsebatterystaple"}',
    '{"password": "correct horse battery staple"}',
    "'password' => 'hunter2hunter'",
    // 引号里转义的引号不算结束
    '{"password":"ab\\"correcthorsebatterystaple"}',
    "{'token': 'ab\\'correcthorsebattery'}",
    '{"token": "correct horse battery staple"}',
    "MCP_AIOPS_TOKEN='correct horse battery staple'",
    // .env、shell 里不带引号、中间有空格的值取到行尾
    "MCP_AIOPS_TOKEN=my correct horse battery staple",
    "export DB_PASSWORD=correct horse battery staple # 2026-10 换的",
    "设置 GITLAB_TOKEN=correct horse battery 后重启",
    "  export api_key=correct horse battery staple",
    // YAML 里写在下面几行的值：冒号后面空着换行缩进着写，或者块写法（|-、>）
    "aiops:\n  token:\n    correcthorsebatterystaple",
    "api_key:\n  my correct horse battery staple",
    "api_key: |-\n  my correct horse battery staple",
    "aiops:\n  token: >\n    correct horse\n    battery staple\n  url: https://aiops.example",
    // 一行开头的 YAML、properties 配置项，不带引号、中间有空格的值也取到行尾
    "api_key: my correct horse battery staple",
    "aiops:\n  api_key: my correct horse battery staple  # 换过",
    "- token: my correct horse battery staple",
    "spring.datasource.password=my correct horse battery",
    // 命令行里隔着空格写在密钥选项后面的值，exec 数组、YAML 的 args 列表里的也算
    "deployctl --password correcthorsebatterystaple",
    "deployctl --token correcthorsebattery --verbose",
    "deployctl --api-key 'correct horse battery staple'",
    "app -token correcthorsebattery",
    "app --db-password hunter2hunter",
    "mysql --password changeme",
    "deployctl --token dGhpcyBpcyBhIHRva2Vu=",
    'CMD ["deployctl", "--token", "correcthorsebattery"]',
    "args:\n  - --token\n  - correcthorsebattery",
    'args:\n  - "--password"\n  - "correcthorsebattery"',
    // shell 里转义的空格、行尾 \ 续行
    "deployctl --password correct\\ horse\\ battery\\ staple",
    "deployctl \\\n  --password \\\n  correcthorsebatterystaple \\\n  --verbose",
    // TOML、Python 里三个引号的多行字符串，跨行的、行尾 \ 续行的也算
    'password="""correct horse battery staple"""',
    "api_key = '''correct horse battery staple'''",
    '[aiops]\ntoken = """\ncorrect horse\nbattery staple\n"""',
    'db_password = """correct \\\n    horse battery staple"""',
    '配置里写 password = """ab\\"""correcthorsebatterystaple"""',
    // XML 里名字是密钥的元素（可以带命名空间、属性，值写在 CDATA 里），和 key/name 加 value 属性写的配置项
    "<server>\n  <username>deploy</username>\n  <password>correcthorsebatterystaple</password>\n</server>",
    "<password><![CDATA[correct horse battery staple]]></password>",
    '<api-key type="string">\n  correct horse battery\n</api-key>',
    "<ns:Token>correcthorsebattery</ns:TOKEN>",
    '<add key="ApiKey" value="correcthorsebatterystaple" />',
    "<property name='db.password' value='correct horse battery'/>",
    // value 写在 key、name 前面的，属性分几行写、别的属性值里有 > 的也算
    '<add value="correcthorsebatterystaple" key="ApiKey"/>',
    "<property\n  value='correct horse battery'\n  name=\"db.password\"\n/>",
    '<add key="ApiKey" description="a > b" value="correcthorsebatterystaple" />',
    // HTTP Basic 认证：后面是「用户名:密码」的 base64
    `curl -H "Authorization: Basic ${Buffer.from(["admin", "correcthorsebatterystaple"].join(":")).toString("base64")}"`,
    `Basic ${Buffer.from(["运维", "密码很长很长"].join(":")).toString("base64")}`,
  ]) {
    assert.throws(
      () => normalizeDraft({ ...code8, basis: secret }),
      (err: Error) => err instanceof KnowledgeError && /不能存密钥和密码/.test(err.message) && !err.message.includes(secret),
      secret,
    );
  }
  assert.ok(normalizeDraft({ ...code8, basis: "报错 token expired，令牌过期后重新登录；密码：***" }));
  assert.ok(normalizeDraft({ ...code8, basis: "密码：请找管理员重置；token=expired_session" }));
  assert.ok(normalizeDraft({ ...code8, basis: "用 sk-learn-preprocessing-pipeline 处理的数据" }));
  assert.ok(normalizeDraft({ ...code8, basis: "这次调用 total_tokens: 123456789" }));
  assert.ok(normalizeDraft({ ...code8, basis: "群机器人的 Webhook 地址在飞书群设置里，xoxo 不是令牌" }));
  for (const prose of [
    "日志里是 token=invalid_signature，换新令牌后好了",
    "MCP_AIOPS_TOKEN=${MCP_AIOPS_TOKEN}，从 .env 读",
    "token=<your-token>、token=your_token_here、access_token=xxxxxxxxxxxx 都是占位",
    "secret=FEISHU_APP_SECRET，在服务器 .env 里",
    "MODEL_API_KEY=${MODEL_API_KEY}，api_key: your_api_key_here",
    "代码里 token := cfg.Token，token = getToken()，secret: config.secret",
    "token: expired. 重新登录就好",
    "api_key=process.env.MODEL_API_KEY，apiKey: settings.apiKey",
    "接口要 Basic authentication，Authorization: Basic *** 或者 Basic <base64>，Basic configuration 不对时报 401",
    "secret 放在 vault 里：secret: https://vault.example.com/agenttag，token=ab***cd 是打了码的，token=$MCP_AIOPS_TOKEN 从环境变量读",
    "报错 token=expired! 重新登录；api_key=os.environ[\"MODEL_API_KEY\"]；secret_key: C:\\keys\\agent",
    '{"password": "******", "token": "${MCP_AIOPS_TOKEN}", "api_key": "<your-api-key>", "secret": "{{ .Values.secret }}"}',
    '{"token": "your token here", "密码": "请找管理员重置"}',
    "MCP_AIOPS_TOKEN=${{ secrets.MCP_AIOPS_TOKEN }}\nFEISHU_APP_SECRET=<your app secret>\nDB_PASSWORD=******** # 打码\nMODEL_API_KEY=your api key here",
    "把 MCP_AIOPS_TOKEN=xxx 写进 .env 后重启；MCP_AIOPS_TOKEN=${MCP_AIOPS_TOKEN} 从环境变量读",
    // 空着的 .env 配置项：下一行是别的配置，不是它的值；同一行的下一个赋值也不是
    "需要在 .env 里加：\nMCP_AIOPS_TOKEN=\nKNOWLEDGE=off\nKNOWLEDGE_TTL=3600",
    "MCP_AIOPS_TOKEN=null, FEISHU_APP_SECRET=undefined\naccess_token=null, refresh_token=undefined",
    // 一行开头的报错原文、名字不以密钥的词结尾的配置项
    "token: signature is invalid\nToken: has expired, please login again\ntoken_ttl: 3600 seconds\ntokenizer: bert base uncased",
    // 冒号后面空着、下面是嵌套的子项（k8s 的 secret: 下面写 secretName），不是它的值；块写法里是变量引用的也不算
    "volumes:\n  - name: tok\n    secret:\n      secretName: aiops-secrets\napi_key: |-\n  ${MODEL_API_KEY}",
    // 命令行：选项名不以密钥的词结尾的、值是下一个选项、变量、占位、打码、文件路径、另一个赋值的，和说选项本身的话
    "docker login --password-stdin < pw.txt；kubectl --token-file /var/run/token；app --no-password --verbose",
    'deployctl --token $MCP_AIOPS_TOKEN；deployctl --token "${MCP_AIOPS_TOKEN}"；deployctl --token <your-token> --password ******',
    "ansible-playbook --private-key ~/.ssh/deploy.pem site.yml；docker build --secret id=npmrc,src=$HOME/.npmrc .",
    "用 --token 参数传进去；pass the --token option, then restart；use --api-key instead of --password",
    "args:\n  - --token\n  - $(MCP_AIOPS_TOKEN)",
    "deployctl --token \\\n  $MCP_AIOPS_TOKEN \\\n  --private-key C:\\keys\\deploy.pem",
    // 三个引号里是变量、占位、打码、中文说明的，或者是空的
    '配置里 token = """${MCP_AIOPS_TOKEN}"""、api_key = \'\'\'<your-api-key>\'\'\' 都是占位；secret = """******""" 打了码；token = """""" 是空的；password = """请找管理员重置"""',
    // XML 里是变量、打码、空的、中文说明、报错原文的，名字不以密钥的词结尾的元素，和 key 不是密钥名字的属性
    "<password>${DB_PASSWORD}</password><token>******</token><secret></secret><api-key><![CDATA[请找管理员要]]></api-key><token>expired</token>",
    '<passwordPolicy>strongpolicyvalue</passwordPolicy><secretName>aiops-secrets</secretName><add key="Timeout" value="correcthorsebatterystaple"/>',
    '<property name="password" value="${DB_PASSWORD}"/>',
    '<add value="correcthorsebatterystaple" key="Timeout"/><property value="${DB_PASSWORD}" name="password"/>',
  ]) {
    assert.ok(normalizeDraft({ ...code8, basis: prose }), prose);
  }
});

function fakeEmbedder(topics: string[]) {
  const calls: string[][] = [];
  const embedder: Embedder & { fail?: boolean } = {
    model: "fake-embedding",
    async embed(texts) {
      calls.push([...texts]);
      if (embedder.fail) {
        throw new Error("embedding 服务挂了");
      }
      return texts.map((text) => [...topics.map((topic) => (text.includes(topic) ? 1 : 0)), 0.05]);
    },
  };
  return { embedder, calls };
}

test("经验库：编号按发过的最大编号加一（删掉的行的编号不再发），记下发起人、确认人和来源；归档后检索不到，不能重复归档", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet, now: () => new Date("2026-10-09T10:00:00Z") });

  const first = await base.save(normalizeDraft(code8), { proposedBy: "张三", confirmedBy: "ML", source: "飞书群 oc_1" });
  const second = await base.save(normalizeDraft(dau));
  assert.equal(first.id, "K1");
  assert.equal(second.id, "K2");
  assert.equal(backend.entries[0].confirmedBy, "ML");
  assert.equal(backend.entries[0].createdAt, "2026-10-09T10:00:00.000Z");
  assert.equal((await base.get("#k1"))?.title, code8.title);

  await base.archive("K1", { confirmedBy: "ML" });
  assert.equal(backend.entries[0].status, "archived");
  assert.deepEqual(await base.search("code=8 ResourceExhausted"), []);
  assert.equal((await base.search("code=8 ResourceExhausted", { includeArchived: true }))[0]?.entry.id, "K1");
  backend.failUpdates = 1;
  assert.equal((await base.archive("K1")).status, "archived", "已经归档了的再归档一次不报错，也不改表格");
  backend.failUpdates = 0;
  await assert.rejects(base.archive("K9"), /经验库里没有 K9/);

  // 有人在表格里删了中间的行，编号还是往后排
  backend.entries.push({ ...backend.entries[1], id: "K7" });
  assert.equal((await base.save(normalizeDraft(dau))).id, "K8");
  // 有人填了大得离谱的编号：不拿它往后排，免得加一还是它自己或者变成 KInfinity
  backend.entries.push({ ...backend.entries[1], id: "K9007199254740993" }, { ...backend.entries[1], id: `K${"9".repeat(400)}` });
  assert.equal((await base.save(normalizeDraft(dau))).id, "K9");
  // 有人在表格里删了编号最大的那几行：发过的编号不再发，旧消息里的 K9 还是指原来那条
  backend.entries = backend.entries.filter((entry) => !["K8", "K9"].includes(entry.id));
  assert.equal((await base.save(normalizeDraft(dau))).id, "K10");
  // 写表格失败：这个编号跳过，不会再发给下一条
  backend.failAdd = new Error("飞书接口限流");
  await assert.rejects(base.save(normalizeDraft(dau)), /飞书接口限流/);
  backend.failAdd = undefined;
  assert.equal((await base.save(normalizeDraft(dau))).id, "K12");
  // 有人填了离上限只差一点的编号：再往后发就超出能精确表示的整数，不存，也不记下这个编号（不然下次读 issued.json 就不认了）
  backend.entries.push({ ...backend.entries[1], id: "K9007199254740990" });
  const rows = backend.entries.length;
  await assert.rejects(base.save(normalizeDraft(dau)), /经验编号已经排到了 K9007199254740990，再发新编号就超出能精确表示的整数了/);
  assert.equal(backend.highest, 12);
  assert.equal(backend.entries.length, rows);
  assert.match(formatKnowledge(first), /^经验 K1 \[排查经验\]：gateway-api 报 code=8/);
  assert.match(formatKnowledge(first), /（确认人 ML，2026\/10\/9）$/);
});

test("没有向量模型时按关键词检索：关键词、错误码命中加分，中文按两字片段对上说法不同的提问", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet });
  await base.save(normalizeDraft(code8));
  await base.save(normalizeDraft(dau));
  await base.save(normalizeDraft({ category: "answer", title: "收不到验证码", question: "用户说收不到验证码", conclusion: "先查短信通道" }));

  assert.equal((await base.search("网关报错 ResourceExhausted，code=8 是怎么回事"))[0]?.entry.id, "K1");
  assert.equal((await base.search("DAU 怎么算的"))[0]?.entry.id, "K2");
  assert.equal((await base.search("验证码收不到怎么办"))[0]?.entry.id, "K3");
  assert.deepEqual(await base.search("今天中午吃什么"), []);
  assert.deepEqual(await base.search("   "), []);
  assert.equal((await base.search("code=8", { category: "metric" })).length, 0);
});

test("只写在处理办法、排查过程里的说法也能检索到", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet });
  await base.save(normalizeDraft({ ...code8, keywords: "", error_codes: "", handling: "user-rpc 改成 headless Service，客户端按 Pod 建连接" }));
  await base.save(normalizeDraft({ ...dau, keywords: "", basis: "查了埋点表 app_open 和登录日志，对不上的是内部测试账号" }));
  assert.equal((await base.search("headless Service 建连接"))[0]?.entry.id, "K1");
  assert.equal((await base.search("登录日志 埋点表 对不上"))[0]?.entry.id, "K2");
});

test("问题写得很长时，只在结论里出现的说法也能检索到", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet });
  await base.save(normalizeDraft({ ...dau, keywords: "", question: "讨论记录：".concat("大家各自说了统计的口径。".repeat(160)), conclusion: "以埋点表 app_open 去重为准" }));
  const hits = await base.search("app_open 去重");
  assert.equal(hits[0]?.entry.id, "K1");
  // 写进提示词时结论在前，每个字段截短，问题再长结论也在
  const rendered = renderHitsForPrompt(hits);
  assert.match(rendered, /^经验 K1 \[数据口径\]：日活的口径\n- 结论：以埋点表 app_open 去重为准\n- 问题或场景：讨论记录：/);
  assert.ok(rendered.length <= 1300, String(rendered.length));
});

test("有向量模型时按意思检索：向量按内容缓存，列表一分钟内不重读；向量服务出错时退回关键词", async () => {
  const backend = new MemoryBackend();
  const { embedder, calls } = fakeEmbedder(["降载", "日活"]);
  let now = new Date("2026-10-09T10:00:00Z");
  const base = new KnowledgeBase(backend, { embedder, logger: quiet, now: () => now });
  await base.save(normalizeDraft(code8));
  await base.save(normalizeDraft(dau));

  const [hit] = await base.search("user-rpc 降载了吗");
  assert.equal(hit.entry.id, "K1");
  assert.ok(hit.semantic! > 0.9);
  assert.equal(calls.length, 2, "第一次：两条经验一批，加上提问");
  await base.search("日活是多少");
  assert.equal(calls.length, 3, "经验的向量缓存住了，只算提问");
  const lists = backend.lists;
  await base.search("降载");
  assert.equal(backend.lists, lists, "一分钟内不重读表格");

  embedder.fail = true;
  assert.equal((await base.search("code=8 ResourceExhausted"))[0]?.entry.id, "K1");
  const failed = calls.length;
  now = new Date(now.getTime() + 5 * 60_000);
  await base.search("code=8");
  assert.equal(calls.length, failed, "出错后 10 分钟内不再调向量模型");
});

test("向量没在期限内算完：这次只按关键词，下次照常调向量模型；用户停止任务时整个检索中止", async () => {
  const backend = new MemoryBackend();
  const { embedder, calls } = fakeEmbedder(["降载"]);
  const base = new KnowledgeBase(backend, { embedder, logger: quiet });
  await base.save(normalizeDraft(code8));
  const embed = embedder.embed;
  // 向量服务卡住，也不认中止信号
  embedder.embed = () => new Promise(() => {});
  const deadline = new AbortController();
  const searching = base.search("code=8 ResourceExhausted", { semanticDeadline: deadline.signal });
  deadline.abort(new DOMException("超时", "TimeoutError"));
  assert.equal((await searching)[0]?.entry.id, "K1", "按关键词照样查到");

  embedder.embed = embed;
  assert.equal((await base.search("user-rpc 降载了吗"))[0]?.semantic !== undefined, true, "期限到了不算向量服务出错，下次照常按意思检索");
  assert.ok(calls.length > 0);

  embedder.embed = () => new Promise(() => {});
  const stop = new AbortController();
  const cancelled = base.search("今天降载了吗", { signal: stop.signal });
  stop.abort();
  await assert.rejects(cancelled, (err: Error) => err.name === "AbortError");
});

test("起草时找很像的已有经验", async () => {
  const backend = new MemoryBackend();
  const { embedder } = fakeEmbedder(["降载", "日活"]);
  const base = new KnowledgeBase(backend, { embedder, logger: quiet });
  await base.save(normalizeDraft(code8));
  assert.equal((await base.similar(normalizeDraft({ ...code8, title: "code=8 又出现了" })))?.entry.id, "K1");
  assert.equal(await base.similar(normalizeDraft(dau)), undefined);
});

function fakeMcp(handlers: Record<string, (args: Record<string, unknown>) => string>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const mcp: LessonsMcp & { up: boolean } = {
    up: true,
    hasTool: (_server, tool) => mcp.up && tool in handlers,
    connected: () => mcp.up,
    async callDirect(_server, tool, args) {
      calls.push({ tool, args });
      return handlers[tool](args);
    },
  };
  return { mcp, calls, handlers };
}

const task = { chatId: "oc_1", senderId: "ou_1", messageId: "om_1" };

test("aiops 经验库：检索只留够相近的；排查经验同步过去时字段对上，注明出自团队经验库；疑似重复时不存", async () => {
  const { mcp, calls } = fakeMcp({
    search_knowledge: () =>
      JSON.stringify({ hits: [{ id: 12, title: "user-rpc 降载", score: 9.1, root_cause: "单 Pod" }, { id: 13, title: "不太像", score: 3 }, { title: "没编号" }] }),
    get_knowledge: () => JSON.stringify({ knowledge: { id: 12, title: "user-rpc 降载", status: "archived" } }),
    save_lesson: (args) => (args.title === "重复的" ? JSON.stringify({ saved: false, duplicate_of: { id: 12, title: "user-rpc 降载", why: "错误码相同" } }) : JSON.stringify({ saved: true, id: 31 })),
    archive_lesson: () => JSON.stringify({ archived: true }),
  });
  const lessons = new AiopsLessons(mcp, "aiops", quiet);
  assert.ok(lessons.searchable && lessons.writable);

  assert.deepEqual(await lessons.search("code=8", task), [{ id: 12, title: "user-rpc 降载", score: 9.1, root_cause: "单 Pod" }]);
  // 返回的不是检索结果（不是 JSON、没有 hits）：报错，不当成没查到
  for (const reply of ["upstream error", JSON.stringify({ error: "db down" })]) {
    const broken = new AiopsLessons(fakeMcp({ search_knowledge: () => reply }).mcp, "aiops", quiet);
    await assert.rejects(broken.search("code=8", task), /aiops 检索返回的格式不对/);
  }
  assert.equal((await lessons.get(12, task)).status, "archived");

  const draft = normalizeDraft(code8);
  assert.deepEqual(await lessons.save(draft, { confirmedBy: "ML", teamId: "K1", caseId: 7 }, task), { saved: true, id: 31 });
  const saved = calls.find((call) => call.tool === "save_lesson")!.args;
  assert.equal(saved.root_cause, draft.conclusion);
  assert.equal(saved.symptom, draft.question);
  assert.equal(saved.service, draft.scope);
  assert.equal(saved.solution, draft.handling);
  assert.equal(saved.error_codes, "8,ResourceExhausted");
  assert.equal(saved.source, "case");
  assert.equal(saved.case_id, 7);
  assert.equal(saved.created_by, "feishu:ML");
  assert.equal(saved.diagnosis_path, "（来自飞书团队经验库 K1）");
  assert.equal(saved.force, undefined);

  assert.deepEqual(await lessons.save({ ...draft, title: "重复的" }, { confirmedBy: "ML", teamId: "K2" }, task), {
    saved: false,
    duplicate: { id: 12, title: "user-rpc 降载", why: "错误码相同" },
  });
  await lessons.save(draft, { confirmedBy: "ML", teamId: "K3", force: true }, task);
  assert.equal(calls.filter((call) => call.tool === "save_lesson").at(-1)!.args.force, true);
});

test("aiops 里的经验只有排查过程最后一行是这一条的出处才算从它同步过去的：中间引用了出处的不归档，也不当成上次存进去的", async () => {
  const paths: Record<number, string> = {
    31: "看了 user-rpc 每个 Pod 的连接数\r\n（来自飞书团队经验库 K1）\n",
    40: "参考了（来自飞书团队经验库 K1）那条，后来查明是别的原因",
    41: "（来自飞书团队经验库 K1）\n补充：网关也要改",
  };
  const { mcp, calls } = fakeMcp({
    get_knowledge: (args) => JSON.stringify({ id: args.id, title: "t", status: "active", diagnosis_path: paths[Number(args.id)] }),
    search_knowledge: () => JSON.stringify({ hits: [40, 41, 31].map((id) => ({ id, title: "t", score: 9, diagnosis_path: paths[id] })) }),
    archive_lesson: () => JSON.stringify({ archived: true }),
  });
  const lessons = new AiopsLessons(mcp, "aiops", quiet);
  for (const id of [40, 41]) {
    await assert.rejects(lessons.archiveSynced(id, "K1", "ML", task), /它不是从 K1 同步过去的/, String(id));
  }
  await lessons.archiveSynced(31, "K1", "ML", task);
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.equal((await lessons.findSynced([normalizeDraft(code8)], "K1", task))?.id, 31);
});

function deskSetup({
  aiops = true,
  approvers = new Set(["ou_admin"]),
  saveLesson = () => JSON.stringify({ saved: true, id: 31 }),
  searchLessons = () => JSON.stringify({ hits: [{ id: 31, title: "已同步的", score: 9 }, { id: 40, title: "Open WebUI 存的", score: 8 }] }),
}: {
  aiops?: boolean;
  approvers?: ReadonlySet<string>;
  saveLesson?: (args: Record<string, unknown>) => string;
  searchLessons?: (args: Record<string, unknown>) => string;
} = {}) {
  // holds：按发送的先后，每次发送等对应的一个；用完了等 hold
  const control: { failSend: boolean; failUpdate?: boolean; hold?: Promise<void>; holds?: Promise<void>[]; updateHold?: Promise<void> } = { failSend: false };
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet, readTimeoutMs: 200 });
  const sent: { to: string; input: SendInput; opts?: SendOptions }[] = [];
  const updates: { messageId: string; card: any }[] = [];
  // aiops 里各条经验排查过程末尾的出处：存进去的按存的时候写的；测试里直接在表格里记的 31、35 算 K1 同步过去的，别的（比如 40）是 Open WebUI 存的
  const lessonPaths = new Map<number, string>([
    [31, "（来自飞书团队经验库 K1）"],
    [35, "（来自飞书团队经验库 K1）"],
  ]);
  const { mcp, calls, handlers } = fakeMcp({
    search_knowledge: searchLessons,
    get_knowledge: (args) =>
      JSON.stringify({
        id: args.id,
        title: "Open WebUI 存的",
        status: "active",
        root_cause: "旧结论",
        ...(lessonPaths.has(Number(args.id)) ? { diagnosis_path: lessonPaths.get(Number(args.id)) } : {}),
      }),
    save_lesson: (args) => {
      const raw = saveLesson(args);
      const data = JSON.parse(raw) as { saved?: boolean; id?: number };
      if (data.saved === true && typeof data.id === "number") {
        lessonPaths.set(data.id, String(args.diagnosis_path));
      }
      return raw;
    },
    archive_lesson: () => JSON.stringify({ archived: true }),
  });
  let now = 1_000_000;
  const desk = new KnowledgeDesk({
    base,
    ...(aiops ? { aiops: new AiopsLessons(mcp, "aiops", quiet) } : {}),
    send: async (to, input, opts) => {
      await (control.holds?.shift() ?? control.hold);
      if (control.failSend) {
        throw new Error("飞书发送失败");
      }
      sent.push({ to, input, opts });
      return { messageId: `om_card_${sent.length}` };
    },
    updateCard: async (messageId, card) => {
      if (control.updateHold) {
        await control.updateHold;
      }
      if (control.failUpdate) {
        throw new Error("飞书更新卡片失败");
      }
      updates.push({ messageId, card });
    },
    approvers,
    allowedChatIds: new Set(["oc_1"]),
    logger: quiet,
    now: () => now,
    retryDelayMs: 0,
  });
  const ctx = { chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" };
  const tool = (name: string) => desk.tools(ctx).find((t) => t.spec.name === name)!;
  const click = (card: any, op: string, openId = "ou_admin", name = "ML"): CardActionEvent => {
    const buttons = JSON.stringify(card).match(/"value":\{[^}]*\}/g)!.map((v) => JSON.parse(v.slice(8)));
    const value = buttons.find((v) => v.op === op);
    assert.ok(value, `卡片上没有 ${op} 按钮`);
    return { messageId: "om_card_1", chatId: "oc_1", operator: { openId, name }, action: { tag: "button", value } };
  };
  const lastCard = () => updates.at(-1)!.card;
  return { backend, base, desk, sent, updates, calls, mcp, handlers, lessonPaths, tool, click, lastCard, control, advance: (ms: number) => (now += ms) };
}

const cardText = (card: any) => JSON.stringify(card);

test("起草：发确认卡片到话题里，卡片上是草稿全文和保存、取消按钮；告诉模型还没存", async () => {
  const { desk, sent, tool } = deskSetup();
  assert.deepEqual(
    desk.tools({ chatId: "oc_1", threadKey: "t", senderId: "ou_1", messageId: "om_1" }).map((t) => t.spec.name),
    ["knowledge_search", "knowledge_get", "knowledge_propose", "knowledge_propose_archive"],
  );

  const result = await tool("knowledge_propose").run(code8, { signal });
  assert.match(result, /还没有保存/);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].opts, { replyTo: "om_1", replyInThread: true });
  const card = (sent[0].input as { card: any }).card;
  assert.equal(card.header.title.content, "存进经验库？");
  assert.match(cardText(card), /\*\*类别\*\*：排查经验/);
  assert.match(cardText(card), /\*\*结论\*\*：user-rpc 用 ClusterIP/);
  assert.match(cardText(card), /排查经验会同时存一份到 aiops 经验库/);
  assert.match(cardText(card), /发起人：张三/);
  assert.match(cardText(card), new RegExp(`"action":"${KNOWLEDGE_ACTION}"`));

  await assert.rejects(tool("knowledge_propose").run({ ...code8, basis: "token=glpat-abcdefghijklmnopqrstu" }, { signal }), /不能存密钥和密码/);
  assert.equal(sent.length, 1, "有密钥的草稿不发卡片");
});

test("写权限名单里的人点保存：存进经验库，排查经验同步到 aiops 并记下编号，卡片变成已存，话题里发一句结果", async () => {
  const { backend, desk, sent, calls, tool, click, lastCard } = deskSetup();
  await tool("knowledge_propose").run({ ...code8, case_id: 7 }, { signal });
  const card = (sent[0].input as { card: any }).card;

  // 不在名单里的人点了不执行
  assert.equal(await desk.handleCardAction(click(card, "save", "ou_2", "李四")), true);
  await desk.idle();
  assert.equal(backend.entries.length, 0);
  assert.match(cardText(lastCard()), /李四点了确认：只有写权限名单里的人能确认，这次没有执行/);

  await desk.handleCardAction(click(card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 1);
  const [entry] = backend.entries;
  assert.equal(entry.id, "K1");
  assert.equal(entry.proposedBy, "张三");
  assert.equal(entry.confirmedBy, "ML");
  assert.equal(entry.source, "飞书群 oc_1 的话题（消息 om_1）");
  assert.equal(entry.aiopsId, 31);
  assert.equal(calls.find((call) => call.tool === "save_lesson")!.args.case_id, 7);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.doesNotMatch(cardText(lastCard()), /"tag":"button"/);
  const reply = sent.at(-1)!;
  assert.deepEqual(reply.opts, { replyTo: "om_card_1", replyInThread: true });
  const text = (reply.input as { markdown: string }).markdown;
  assert.match(text, /已存进团队经验库：经验 K1「gateway-api 报 code=8/);
  assert.match(text, /已同步到 aiops 经验库（经验 #31）/);
  assert.match(text, /经验库表格：https:\/\/example\.feishu\.cn\/base\/app1\?table=tbl1/);

  // 再点一次：草稿已经处理完，卡片提示失效
  await desk.handleCardAction(click(card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 1);
  assert.equal(lastCard().header.title.content, "已失效");
});

test("点了保存马上返回，后台执行；执行中再点不会存两遍", async () => {
  const { backend, desk, sent, click, tool, lastCard } = deskSetup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const add = backend.add.bind(backend);
  backend.add = async (entry) => {
    await gate;
    return add(entry);
  };
  await tool("knowledge_propose").run(dau, { signal });
  const card = (sent[0].input as { card: any }).card;
  assert.equal(await desk.handleCardAction(click(card, "save")), true);
  assert.equal(await desk.handleCardAction(click(card, "save", "ou_admin2")), true);
  assert.equal(backend.entries.length, 0);
  release();
  await desk.idle();
  assert.equal(backend.entries.length, 1);
  assert.equal(lastCard().header.title.content, "已存进经验库");
});

test("别的类别不同步到 aiops；没接 aiops 时排查经验也照常存", async () => {
  const one = deskSetup();
  await one.tool("knowledge_propose").run(dau, { signal });
  await one.desk.handleCardAction(one.click((one.sent[0].input as { card: any }).card, "save"));
  await one.desk.idle();
  assert.equal(one.backend.entries[0].category, "metric");
  assert.ok(!one.calls.some((call) => call.tool === "save_lesson"));

  const two = deskSetup({ aiops: false });
  await two.tool("knowledge_propose").run(code8, { signal });
  assert.doesNotMatch(cardText((two.sent[0].input as { card: any }).card), /aiops/);
  await two.desk.handleCardAction(two.click((two.sent[0].input as { card: any }).card, "save"));
  await two.desk.idle();
  assert.equal(two.backend.entries[0].aiopsId, undefined);
  assert.doesNotMatch((two.sent.at(-1)!.input as { markdown: string }).markdown, /aiops/);
});

test("保存失败时卡片回到待确认，写上原因，可以再点", async () => {
  const { backend, desk, sent, click, tool, lastCard } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  backend.failAdd = new KnowledgeError("机器人缺少飞书应用的多维表格权限（bitable:app）");
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(lastCard().header.title.content, "存进经验库？");
  assert.match(cardText(lastCard()), /上次点确认没成功：机器人缺少飞书应用的多维表格权限/);

  backend.failAdd = undefined;
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 1);
});

test("保存的结果没传回来、再点一次：同一张卡片不会存两遍", async () => {
  const { backend, desk, sent, click, tool, lastCard } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  const add = backend.add.bind(backend);
  backend.add = async (entry) => {
    await add(entry);
    throw new KnowledgeError("飞书接口超时");
  };
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.match(cardText(lastCard()), /上次点确认没成功：飞书接口超时/);

  backend.add = add;
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 1);
  assert.ok(backend.entries[0].requestId);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /已存进团队经验库：经验 K1「日活的口径」/);
});

test("改草稿时新卡片没发出去，旧卡片还能用", async () => {
  const { backend, desk, sent, updates, click, tool, control } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  control.failSend = true;
  await assert.rejects(tool("knowledge_propose").run({ ...dau, title: "日活的口径（改）" }, { signal }), /飞书发送失败/);
  control.failSend = false;
  assert.ok(!updates.some((u) => u.card.header.title.content === "已换成新的草稿"));
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries[0]?.title, "日活的口径");
});

test("改草稿时新卡片还在发：这时点旧卡片不算，发出去以后旧卡片作废，只存新的", async () => {
  const { backend, desk, sent, updates, click, tool, control } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  let release!: () => void;
  control.hold = new Promise((resolve) => (release = resolve));
  const revising = tool("knowledge_propose").run({ ...dau, title: "日活的口径（改）" }, { signal });
  await new Promise((resolve) => setImmediate(resolve));
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 0, "新卡片发的时候点旧卡片不存");
  control.hold = undefined;
  release();
  await revising;
  assert.equal(updates.filter((u) => u.messageId === "om_card_1").at(-1)!.card.header.title.content, "已换成新的草稿");
  await desk.handleCardAction({ ...click((sent[1].input as { card: any }).card, "save"), messageId: "om_card_2" });
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => e.title),
    ["日活的口径（改）"],
  );
});

test("一次回复里同时起草两条：第二张等第一张登记好再发；第二张在发的时候点第一张不算，发出去以后第一张作废，只存一条", async () => {
  const { backend, desk, sent, updates, click, tool, control } = deskSetup();
  let release1!: () => void;
  let release2!: () => void;
  control.holds = [new Promise((resolve) => (release1 = resolve)), new Promise((resolve) => (release2 = resolve))];
  const first = tool("knowledge_propose").run(dau, { signal });
  const second = tool("knowledge_propose").run({ ...dau, title: "日活的口径（另一版）" }, { signal });
  await new Promise((resolve) => setImmediate(resolve));
  release1();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 0, "第二张发的时候点第一张不存");
  release2();
  await second;
  assert.equal(updates.filter((u) => u.messageId === "om_card_1").at(-1)!.card.header.title.content, "已换成新的草稿");
  await desk.handleCardAction({ ...click((sent[1].input as { card: any }).card, "save"), messageId: "om_card_2" });
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => e.title),
    ["日活的口径（另一版）"],
  );
});

test("一次回复里同时起草两条、后一条还在查（取要归档的 aiops 经验）：前一张发出去后先不让点，后一张发出去就作废前一张", async () => {
  const { backend, desk, sent, updates, click, tool, handlers } = deskSetup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const getLesson = handlers.get_knowledge;
  handlers.get_knowledge = (async (args: Record<string, unknown>) => {
    await gate;
    return getLesson(args);
  }) as unknown as typeof getLesson;
  const first = tool("knowledge_propose").run(dau, { signal });
  const second = tool("knowledge_propose_archive").run({ aiops_id: 40 }, { signal });
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 0, "后一条还在查的时候点前一张不存");
  release();
  await second;
  assert.equal(sent.length, 2);
  assert.equal(updates.filter((u) => u.messageId === "om_card_1").at(-1)!.card.header.title.content, "已换成新的草稿");
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 0, "作废以后点了也不存");
});

test("一次回复里同时起草两条、改话题里的旧卡片很慢：第一张新卡片发出去后照样先不让点，第二张发出去就作废它，只存一条", async () => {
  const { backend, desk, sent, click, tool, control } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  let releaseUpdate!: () => void;
  control.updateHold = new Promise((resolve) => (releaseUpdate = resolve));
  let releaseThird!: () => void;
  control.holds = [Promise.resolve(), new Promise((resolve) => (releaseThird = resolve))];
  const first = tool("knowledge_propose").run({ ...dau, title: "日活的口径（第二版）" }, { signal });
  const second = tool("knowledge_propose").run({ ...dau, title: "日活的口径（第三版）" }, { signal });
  for (let i = 0; i < 5 && sent.length < 2; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(sent.length, 2);
  // 第二张卡片发出去了，第一张卡片（话题里原来那张）还在改；这时点第二张
  await desk.handleCardAction({ ...click((sent[1].input as { card: any }).card, "save"), messageId: "om_card_2" });
  await desk.idle();
  const savedEarly = backend.entries.length;
  releaseThird();
  releaseUpdate();
  await Promise.all([first, second]);
  assert.equal(savedEarly, 0, "后一条还在发的时候点前一张不存");
  await desk.handleCardAction({ ...click((sent[2].input as { card: any }).card, "save"), messageId: "om_card_3" });
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => e.title),
    ["日活的口径（第三版）"],
  );
});

test("卡片发的时候任务停了：发出去的卡片作废、点了不存，话题里之前的卡片照旧能用", async () => {
  const { backend, desk, sent, updates, click, tool, control } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  const stop = new AbortController();
  let release!: () => void;
  control.hold = new Promise((resolve) => (release = resolve));
  const revising = tool("knowledge_propose").run({ ...dau, title: "日活的口径（改）" }, { signal: stop.signal });
  await new Promise((resolve) => setImmediate(resolve));
  stop.abort();
  control.hold = undefined;
  release();
  await assert.rejects(revising, (err: Error) => err.name === "AbortError");
  assert.equal(sent.length, 2, "卡片已经发出去了");
  const voided = updates.filter((u) => u.messageId === "om_card_2").at(-1)!.card;
  assert.equal(voided.header.title.content, "已取消");
  assert.match(cardText(voided), /任务已经停了，这张卡片作废，没有改动经验库/);
  await desk.handleCardAction({ ...click((sent[1].input as { card: any }).card, "save"), messageId: "om_card_2" });
  await desk.idle();
  assert.equal(backend.entries.length, 0);
  assert.ok(!updates.some((u) => u.messageId === "om_card_1" && u.card.header.title.content === "已换成新的草稿"));
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => e.title),
    ["日活的口径"],
  );
});

test("任务停了就不发确认卡片：起草时查很像的经验、取要归档的经验时停止都不发", async () => {
  const { base, backend, sent, tool } = deskSetup();
  await base.save(normalizeDraft(dau));
  // 表格读不出来，卡住
  backend.list = () => new Promise(() => {});
  const stop = new AbortController();
  const proposing = tool("knowledge_propose").run(code8, { signal: stop.signal });
  const archiving = tool("knowledge_propose_archive").run({ id: "K1" }, { signal: stop.signal });
  stop.abort();
  await assert.rejects(proposing, (err: Error) => err.name === "AbortError");
  await assert.rejects(archiving, (err: Error) => err.name === "AbortError");
  assert.equal(sent.length, 0);
});

test("发起人可以取消，别人不行；同一个话题再起草时旧卡片作废；超过 24 小时点了提示失效", async () => {
  const { backend, desk, sent, updates, click, tool, lastCard, advance } = deskSetup();
  await tool("knowledge_propose").run(dau, { signal });
  const first = (sent[0].input as { card: any }).card;
  await desk.handleCardAction(click(first, "cancel", "ou_2", "李四"));
  await desk.idle();
  assert.match(cardText(lastCard()), /只有发起人或写权限名单里的人能取消/);
  await desk.handleCardAction(click(first, "cancel", "ou_1", "张三"));
  await desk.idle();
  assert.equal(lastCard().header.title.content, "已取消");

  await tool("knowledge_propose").run(dau, { signal });
  await tool("knowledge_propose").run({ ...dau, title: "日活的口径（改）" }, { signal });
  const superseded = updates.find((u) => u.messageId === "om_card_2" && u.card.header.title.content === "已换成新的草稿");
  assert.ok(superseded, "旧卡片换成「已换成新的草稿」");
  await desk.handleCardAction({ ...click((sent[1].input as { card: any }).card, "save"), messageId: "om_card_2" });
  await desk.idle();
  assert.equal(backend.entries.length, 0);

  advance(PROPOSAL_TTL_MS + 1);
  await desk.handleCardAction(click((sent[2].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries.length, 0);
  assert.equal(lastCard().header.title.content, "已失效");
});

test("起草时经验库里有很像的，卡片上提示；带 replaces 时保存后归档旧的，连同 aiops 里同步的那条", async () => {
  const { backend, base, desk, sent, calls, click, tool } = deskSetup({ saveLesson: () => JSON.stringify({ saved: true, id: 32 }) });
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);

  await tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（第二次）" }, { signal });
  assert.match(cardText((sent[0].input as { card: any }).card), /经验库里已有很像的经验 K1/);

  await tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  const card = (sent[1].input as { card: any }).card;
  assert.match(cardText(card), /保存后归档旧的经验 K1/);
  assert.doesNotMatch(cardText(card), /已有很像的经验/);
  await desk.handleCardAction({ ...click(card, "save"), messageId: "om_card_2" });
  await desk.idle();
  assert.equal(backend.entries.find((e) => e.id === "K1")!.status, "archived");
  assert.equal(backend.entries.find((e) => e.id === "K2")!.status, "active");
  assert.equal(backend.entries.find((e) => e.id === "K2")!.aiopsId, 32);
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /旧的经验 K1「.*」已归档。\naiops 经验库里同步的经验 #31 也已归档。/);

  await assert.rejects(tool("knowledge_propose").run({ ...code8, replaces: "K1" }, { signal }), /经验 K1 已经归档了/);
});

test("取代旧的排查经验：aiops 说和旧的那条很像时照样存一条新的再归档旧的；新的没进 aiops 时旧的在 aiops 里那条先留着，再试一次进了 aiops 才归档", async () => {
  const replace = async (saveLesson: (args: Record<string, unknown>) => string) => {
    const setup = deskSetup({ saveLesson });
    await setup.base.save(normalizeDraft(code8));
    await setup.base.linkAiops("K1", 31);
    await setup.tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
    await setup.desk.handleCardAction(setup.click((setup.sent[0].input as { card: any }).card, "save"));
    await setup.desk.idle();
    return setup;
  };
  const markdown = (setup: { sent: { input: SendInput }[] }) => (setup.sent.at(-1)!.input as { markdown: string }).markdown;

  const dup = await replace((args) =>
    args.force ? JSON.stringify({ saved: true, id: 32 }) : JSON.stringify({ saved: false, duplicate_of: { id: 31, title: "旧的", why: "错误码相同" } }),
  );
  assert.equal(dup.backend.entries.find((e) => e.id === "K2")!.aiopsId, 32);
  assert.deepEqual(dup.calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.match(markdown(dup), /已同步到 aiops 经验库（经验 #32）/);

  let up = false;
  const down = await replace(() => {
    if (!up) {
      throw new Error("aiops 现在连不上");
    }
    return JSON.stringify({ saved: true, id: 33 });
  });
  assert.equal(down.backend.entries.find((e) => e.id === "K1")!.status, "archived");
  assert.equal(down.calls.filter((call) => call.tool === "archive_lesson").length, 0);
  const partial = down.lastCard();
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(partial), /没能同步到 aiops 经验库：aiops 现在连不上/);
  assert.match(cardText(partial), /aiops 经验库里同步的旧经验 #31 先留着没归档/);
  assert.match(cardText(partial), /"content":"再试一次"/);
  assert.equal(down.sent.length, 1, "没做完时话题里不发结果");

  up = true;
  await down.desk.handleCardAction(down.click(partial, "save"));
  await down.desk.idle();
  assert.deepEqual(
    down.backend.entries.map((e) => [e.id, e.status, e.aiopsId]),
    [
      ["K1", "archived", 31],
      ["K2", "active", 33],
    ],
  );
  assert.deepEqual(down.calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.equal(down.lastCard().header.title.content, "已存进经验库");
  assert.match(markdown(down), /已同步到 aiops 经验库（经验 #33）[\s\S]*旧的经验 K1「.*」已归档。\naiops 经验库里同步的经验 #31 也已归档。/);
});

test("取代旧的排查经验：aiops 不认 force、强制保存还说重复时不算进了 aiops，旧的在 aiops 里那条留着，卡片可以再试一次", async () => {
  const setup = deskSetup({ saveLesson: () => JSON.stringify({ saved: false, duplicate_of: { id: 31, title: "旧的", why: "错误码相同" } }) });
  await setup.base.save(normalizeDraft(code8));
  await setup.base.linkAiops("K1", 31);
  await setup.tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  await setup.desk.handleCardAction(setup.click((setup.sent[0].input as { card: any }).card, "save"));
  await setup.desk.idle();
  assert.deepEqual(
    setup.calls.filter((call) => call.tool === "save_lesson").map((call) => call.args.force),
    [undefined, true],
  );
  assert.equal(setup.calls.filter((call) => call.tool === "archive_lesson").length, 0, "aiops 里旧的那条不归档");
  const partial = setup.lastCard();
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(partial), /没能同步到 aiops 经验库：aiops 说新的这条和要取代的经验 #31 重复，带上 force 也没有存/);
  assert.match(cardText(partial), /aiops 经验库里同步的旧经验 #31 先留着没归档/);
  assert.equal(setup.backend.entries.find((e) => e.id === "K2")!.aiopsId, undefined);
});

test("aiops 连上了却少了同步、归档经验要用的工具（存、归档，或者再试时要用的检索、取详情）：起草时不答应同步，保存不调 aiops；卡片答应了同步、之后才少了的，算没做完，补上工具后再试一次接着同步", async () => {
  for (const tools of [["save_lesson", "archive_lesson"], ["search_knowledge"], ["get_knowledge"]]) {
    const missing = deskSetup();
    for (const tool of tools) {
      delete missing.handlers[tool];
    }
    const propose = missing.tool("knowledge_propose");
    assert.doesNotMatch(propose.spec.description, /aiops/, tools.join());
    await propose.run(code8, { signal });
    const card = (missing.sent[0].input as { card: any }).card;
    assert.doesNotMatch(cardText(card), /排查经验会同时存一份到 aiops 经验库/);
    await missing.desk.handleCardAction(missing.click(card, "save"));
    await missing.desk.idle();
    assert.equal(missing.lastCard().header.title.content, "已存进经验库");
    assert.equal(missing.calls.filter((call) => call.tool === "save_lesson").length, 0);
  }

  // 还没连上时照样答应，连上了再同步
  const later = deskSetup();
  later.mcp.up = false;
  assert.match(later.tool("knowledge_propose").spec.description, /排查经验同时存一份到 aiops 经验库/);
  later.mcp.up = true;

  const dropped = deskSetup();
  await dropped.tool("knowledge_propose").run(code8, { signal });
  const saveLesson = dropped.handlers.save_lesson;
  delete dropped.handlers.save_lesson;
  await dropped.desk.handleCardAction(dropped.click((dropped.sent[0].input as { card: any }).card, "save"));
  await dropped.desk.idle();
  const partial = dropped.lastCard();
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(partial), /aiops 少了同步、归档经验要用的工具（save_lesson），还没同步到 aiops 经验库。aiops 补上这些工具后点「再试一次」/);
  assert.match(cardText(partial), /"content":"再试一次"/);
  assert.equal(dropped.sent.length, 1, "没做完时话题里不发结果");

  dropped.handlers.save_lesson = saveLesson;
  await dropped.desk.handleCardAction(dropped.click(partial, "save"));
  await dropped.desk.idle();
  assert.equal(dropped.lastCard().header.title.content, "已存进经验库");
  assert.equal(dropped.backend.entries[0].aiopsId, 31);
  assert.equal(dropped.calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.match((dropped.sent.at(-1)!.input as { markdown: string }).markdown, /已同步到 aiops 经验库（经验 #31）/);
});

test("同步到 aiops 没做成，再试一次前有人在表格里归档了这一行或者改了类别：不再同步过去", async () => {
  for (const [change, note] of [
    [(row: KnowledgeEntry) => (row.status = "archived"), /经验 K1 在表格里已经归档了，没有同步到 aiops 经验库/],
    [(row: KnowledgeEntry) => (row.category = "metric"), /经验 K1 在表格里已经改成「数据口径」，不是排查经验了，没有同步到 aiops 经验库/],
  ] as const) {
    let down = true;
    const setup = deskSetup({
      saveLesson: () => {
        if (down) {
          throw new Error("aiops 现在连不上");
        }
        return JSON.stringify({ saved: true, id: 31 });
      },
    });
    await setup.tool("knowledge_propose").run(code8, { signal });
    await setup.desk.handleCardAction(setup.click((setup.sent[0].input as { card: any }).card, "save"));
    await setup.desk.idle();
    assert.match(cardText(setup.lastCard()), /没能同步到 aiops 经验库/);
    change(setup.backend.entries[0]);
    down = false;
    await setup.desk.handleCardAction(setup.click(setup.lastCard(), "save"));
    await setup.desk.idle();
    assert.equal(setup.calls.filter((call) => call.tool === "save_lesson").length, 1, "只有第一次没成功的那次");
    assert.equal(setup.lastCard().header.title.content, "已存进经验库");
    assert.match((setup.sent.at(-1)!.input as { markdown: string }).markdown, note);
  }
});

test("同步到 aiops 时结果没传回来，再试一次前表格改了标题：确认改过的以后，按当时发过去的内容找到存进去的那条（分数低也认），内容旧了归档它、按改过的存", async () => {
  let stored: Record<string, unknown> | undefined;
  const { backend, desk, sent, calls, click, tool, lastCard } = deskSetup({
    saveLesson: (args) => {
      if (!stored) {
        stored = args;
        throw new Error("socket hang up");
      }
      return JSON.stringify({ saved: true, id: 99 });
    },
    // aiops 只在检索文字里有当时的标题时才返回存进去的那条，分数也不高
    searchLessons: (args) =>
      JSON.stringify({
        hits:
          stored && String(args.text).includes(String(stored.title))
            ? [{ id: 31, title: String(stored.title), score: 3, diagnosis_path: String(stored.diagnosis_path) }]
            : [],
      }),
  });
  await tool("knowledge_propose").run(code8, { signal });
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.match(cardText(lastCard()), /socket hang up/);

  backend.entries[0].title = "gateway-api 报 code=8：user-rpc 只连一个 Pod";
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1, "改过的没确认，不同步");
  assert.match(cardText(lastCard()), /表格里现在的内容/);

  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  const lookup = calls.find((call) => call.tool === "search_knowledge")!.args;
  assert.equal(lookup.service, "gateway-api, user-rpc");
  assert.equal(lookup.keywords, "code=8,ResourceExhausted,user-rpc");
  // 找到的 31 是按当时的标题存的，和确认的不一样：归档它，按改过的存一条
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args.id), [31]);
  const saves = calls.filter((call) => call.tool === "save_lesson");
  assert.equal(saves.length, 2);
  assert.equal(saves[1].args.title, "gateway-api 报 code=8：user-rpc 只连一个 Pod");
  assert.equal(backend.entries[0].aiopsId, 99);
  assert.equal(lastCard().header.title.content, "已存进经验库");
});

test("取代旧经验时归档旧的失败：卡片留着再试一次，新的不会存两遍，aiops 也不再存一条", async () => {
  const { backend, base, desk, sent, calls, click, tool, lastCard } = deskSetup({ saveLesson: () => JSON.stringify({ saved: true, id: 32 }) });
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  const update = backend.update.bind(backend);
  let limited = true;
  backend.update = async (id, changes) => {
    if (id === "K1" && limited) {
      throw new KnowledgeError("飞书接口限流");
    }
    return update(id, changes);
  };
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status]),
    [
      ["K1", "active"],
      ["K2", "active"],
    ],
  );
  const partial = lastCard();
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(partial), /旧的经验 K1 没能归档：飞书接口限流/);
  assert.match(cardText(partial), /已存进团队经验库：经验 K2/);

  limited = false;
  await desk.handleCardAction(click(partial, "save"));
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status, e.aiopsId]),
    [
      ["K1", "archived", 31],
      ["K2", "active", 32],
    ],
  );
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /旧的经验 K1「.*」已归档/);
});

test("同步到 aiops 时结果没传回来：再试一次先找到已经存进去的那条，不再存一条", async () => {
  const lessons: { id: number; title: string; score: number; diagnosis_path: string }[] = [
    { id: 50, title: "另一条团队经验同步的", score: 9, diagnosis_path: "（来自飞书团队经验库 K10）" },
  ];
  let lose = true;
  let broken = false;
  const { backend, desk, sent, calls, click, tool, lastCard } = deskSetup({
    saveLesson: (args) => {
      lessons.push({ id: 31, title: String(args.title), score: 9.8, diagnosis_path: String(args.diagnosis_path) });
      if (lose) {
        lose = false;
        throw new Error("socket hang up");
      }
      return JSON.stringify({ saved: true, id: 31 });
    },
    searchLessons: () => (broken ? "upstream error" : JSON.stringify({ hits: lessons })),
  });
  await tool("knowledge_propose").run(code8, { signal });
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  const partial = lastCard();
  assert.match(cardText(partial), /没能同步到 aiops 经验库：socket hang up/);
  assert.equal(backend.entries[0].aiopsId, undefined);

  // aiops 检索返回的格式不对：不能当成没找到再存一条
  broken = true;
  await desk.handleCardAction(click(partial, "save"));
  await desk.idle();
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.match(cardText(lastCard()), /没能同步到 aiops 经验库：aiops 检索返回的格式不对/);

  broken = false;
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.equal(backend.entries.length, 1);
  assert.equal(backend.entries[0].aiopsId, 31);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /已同步到 aiops 经验库（经验 #31）/);
});

test("同步到 aiops 没做成、有人在表格里改了这一行：改过的列在卡片上，写权限名单里的人核对后点再试一次才同步；改进去的密钥不带过去", async () => {
  let down = true;
  const { backend, desk, sent, calls, click, tool, lastCard } = deskSetup({
    saveLesson: () => {
      if (down) {
        throw new Error("aiops 现在连不上");
      }
      return JSON.stringify({ saved: true, id: 31 });
    },
  });
  await tool("knowledge_propose").run(code8, { signal });
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  const failed = lastCard();
  assert.match(cardText(failed), /没能同步到 aiops 经验库：aiops 现在连不上/);

  // 卡片没做完时有人在表格里改了这一行，改进去一个密钥
  const row = backend.entries[0];
  row.title = "gateway-api 报 code=8：user-rpc 只连一个 Pod";
  row.conclusion = "user-rpc 走 ClusterIP，gRPC 长连接只连到一个 Pod，单 Pod 被打满后降载";
  row.basis = `curl -H "Authorization: Basic ${Buffer.from(["admin", "correcthorsebatterystaple"].join(":")).toString("base64")}"`;
  down = false;
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.match(cardText(lastCard()), /经验 K1 在表格里依据或排查过程里像是有HTTP Basic 认证的用户名和密码，没有同步到 aiops 经验库/);
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1, "带密钥的这一行没有同步过去");

  row.basis = "看了 user-rpc 每个 Pod 的连接数";
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1, "改过的内容没人确认过，不同步");
  const review = lastCard();
  assert.equal(review.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(review), /经验 K1 在表格里改过，和确认的内容不一样，改过的没有同步到 aiops 经验库/);
  assert.match(cardText(review), /表格里现在的内容.*user-rpc 走 ClusterIP，gRPC 长连接只连到一个 Pod/);

  // 不在写权限名单里的人点了不算；点之前那张卡片（上面没列改过的内容）也不算
  await desk.handleCardAction(click(review, "save", "ou_2", "李四"));
  await desk.handleCardAction(click(failed, "save"));
  await desk.idle();
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.match(cardText(lastCard()), /ML点的卡片上列的不是表格里现在的内容，这次没有执行/);

  await desk.handleCardAction(click(review, "save"));
  await desk.idle();
  const saves = calls.filter((call) => call.tool === "save_lesson");
  assert.equal(saves.length, 2);
  assert.equal(saves[1].args.title, row.title);
  assert.equal(saves[1].args.root_cause, row.conclusion);
  assert.match(String(saves[1].args.diagnosis_path), /^看了 user-rpc 每个 Pod 的连接数\n（来自飞书团队经验库 K1）$/);
  assert.equal(backend.entries.length, 1);
  assert.equal(backend.entries[0].aiopsId, 31);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  const result = (sent.at(-1)!.input as { markdown: string }).markdown;
  assert.match(result, /经验 K1「gateway-api 报 code=8：user-rpc 只连一个 Pod」/);
  assert.match(result, /已按表格里改过、ML在卡片上核对过的内容同步到 aiops 经验库（经验 #31）/);
});

test("存好了、后面的步骤没做成，有人在表格里改了草稿编号：再试一次按编号认出存过的那一行，不再存一行；编号也改了就说找不到，也不再存", async () => {
  for (const both of [false, true]) {
    let down = true;
    const { backend, desk, sent, calls, click, tool, lastCard } = deskSetup({
      saveLesson: () => {
        if (down) {
          throw new Error("aiops 现在连不上");
        }
        return JSON.stringify({ saved: true, id: 31 });
      },
    });
    await tool("knowledge_propose").run(code8, { signal });
    await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
    await desk.idle();
    const partial = lastCard();
    delete backend.entries[0].requestId;
    if (both) {
      backend.entries[0].id = "K100";
    }
    down = false;
    await desk.handleCardAction(click(partial, "save"));
    await desk.idle();
    assert.equal(backend.entries.length, 1, "没有再存一行");
    assert.equal(backend.highest, 1, "没有再发编号");
    if (both) {
      assert.match(cardText(lastCard()), /上次存进去的经验 K1 在表格里找不到了（编号和草稿编号都被改了，或者这一行被删了），没有再存一遍/);
      assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1);
    } else {
      assert.deepEqual(
        backend.entries.map((e) => [e.id, e.aiopsId]),
        [["K1", 31]],
      );
      assert.equal(lastCard().header.title.content, "已存进经验库");
    }
  }
});

test("没做成的卡片：写权限名单里的人点「不用了」或者超过 24 小时就不再试，结果里写上没做成的；发起人不在名单里时不能放弃", async () => {
  const fail = () => {
    throw new Error("aiops 现在连不上");
  };
  const quit = deskSetup({ saveLesson: fail });
  await quit.tool("knowledge_propose").run(code8, { signal });
  await quit.desk.handleCardAction(quit.click((quit.sent[0].input as { card: any }).card, "save"));
  await quit.desk.idle();
  const partial = quit.lastCard();
  for (const [openId, name] of [
    ["ou_2", "李四"],
    ["ou_1", "张三"],
  ]) {
    await quit.desk.handleCardAction(quit.click(partial, "cancel", openId, name));
    assert.match(cardText(quit.lastCard()), new RegExp(`${name}点了「不用了」：做了一半的卡片只有写权限名单里的人能决定不再试`));
    assert.match(cardText(quit.lastCard()), /"tag":"button"/, "卡片还能再试");
  }
  await quit.desk.handleCardAction(quit.click(partial, "cancel"));
  const given = quit.lastCard();
  assert.equal(given.header.title.content, "已存进经验库");
  assert.match(cardText(given), /已存进团队经验库：经验 K1/);
  assert.match(cardText(given), /ML点了「不用了」，下面没做成的不再试了：\\n- 没能同步到 aiops 经验库：aiops 现在连不上/);
  assert.doesNotMatch(cardText(given), /"tag":"button"/);
  assert.equal(quit.backend.entries.length, 1);

  const late = deskSetup({ saveLesson: fail });
  await late.tool("knowledge_propose").run(code8, { signal });
  await late.desk.handleCardAction(late.click((late.sent[0].input as { card: any }).card, "save"));
  await late.desk.idle();
  late.advance(PROPOSAL_TTL_MS + 1);
  await late.desk.handleCardAction(late.click(late.lastCard(), "save"));
  await late.desk.idle();
  assert.equal(late.lastCard().header.title.content, "已存进经验库");
  assert.match(cardText(late.lastCard()), /卡片超过 24 小时，下面没做成的不再试了/);
  assert.equal(late.calls.filter((call) => call.tool === "save_lesson").length, 1);
});

test("两张卡片取代同一条经验：先点的存好并归档旧的，后点的不再存（同时点也一样）", async () => {
  for (const together of [false, true]) {
    const { backend, base, desk, sent, updates, click } = deskSetup();
    await base.save(normalizeDraft(code8));
    const other = { chatId: "oc_1", threadKey: "om_other", senderId: "ou_2", askerName: "李四", messageId: "om_2" };
    await desk.tools({ chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" }).find((t) => t.spec.name === "knowledge_propose")!
      .run({ ...code8, title: "gateway-api 报 code=8（张三改的）", replaces: "K1" }, { signal });
    await desk.tools(other).find((t) => t.spec.name === "knowledge_propose")!.run({ ...code8, title: "gateway-api 报 code=8（李四改的）", replaces: "K1" }, { signal });
    const [first, second] = sent.map((s) => (s.input as { card: any }).card);
    await desk.handleCardAction(click(first, "save"));
    if (!together) {
      await desk.idle();
    }
    await desk.handleCardAction({ ...click(second, "save"), messageId: "om_card_2" });
    await desk.idle();
    assert.deepEqual(
      backend.entries.map((e) => [e.id, e.status]),
      [
        ["K1", "archived"],
        ["K2", "active"],
      ],
      together ? "同时点" : "先后点",
    );
    assert.equal(backend.entries[1].title, "gateway-api 报 code=8（张三改的）");
    const voided = updates.filter((u) => u.messageId === "om_card_2").at(-1)!.card;
    assert.equal(voided.header.title.content, "已作废");
    assert.match(cardText(voided), /要取代的经验 K1 已经归档了（可能已经被别的卡片取代），这张卡片不能再保存/);
    assert.doesNotMatch(cardText(voided), /"保存"/);
  }
});

test("取代旧经验时归档旧的没做成：别的卡片不能再取代那条旧的，免得两条新的同时有效", async () => {
  const { backend, base, desk, sent, updates, click } = deskSetup({ aiops: false });
  await base.save(normalizeDraft(dau));
  const other = { chatId: "oc_1", threadKey: "om_other", senderId: "ou_2", askerName: "李四", messageId: "om_2" };
  await desk.tools({ chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" }).find((t) => t.spec.name === "knowledge_propose")!
    .run({ ...dau, title: "日活的口径（张三改的）", replaces: "K1" }, { signal });
  await desk.tools(other).find((t) => t.spec.name === "knowledge_propose")!.run({ ...dau, title: "日活的口径（李四改的）", replaces: "K1" }, { signal });
  const [first, second] = sent.map((s) => (s.input as { card: any }).card);
  const update = backend.update.bind(backend);
  let limited = true;
  backend.update = async (id, changes) => {
    if (id === "K1" && limited) {
      throw new KnowledgeError("飞书接口限流");
    }
    return update(id, changes);
  };
  await desk.handleCardAction(click(first, "save"));
  await desk.idle();
  const partial = updates.filter((u) => u.messageId === "om_card_1").at(-1)!.card;
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.equal(backend.entries[1].replaces, "K1", "表格里记下新的这条取代的是哪条");

  limited = false;
  await desk.handleCardAction({ ...click(second, "save"), messageId: "om_card_2" });
  await desk.idle();
  const voided = updates.filter((u) => u.messageId === "om_card_2").at(-1)!.card;
  assert.equal(voided.header.title.content, "已作废");
  assert.match(cardText(voided), /经验 K1 已经有取代它的新经验 K2「日活的口径（张三改的）」，只是旧的还没归档，这张卡片不能再保存/);
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status]),
    [
      ["K1", "active"],
      ["K2", "active"],
    ],
  );

  await desk.handleCardAction(click(partial, "save"));
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status]),
    [
      ["K1", "archived"],
      ["K2", "active"],
    ],
  );
  // 取代它的那条归档了，旧的又能被取代
  await base.archive("K2");
  await update("K1", { status: "active" });
  const again = await base.save(normalizeDraft({ ...dau, title: "日活的口径（王五改的）" }), { replaces: "k1" });
  assert.deepEqual([again.id, again.replaces], ["K3", "K1"]);
});

test("归档、取代时用表格里现在的 aiops 编号：卡片发出后编号换成了这一条同步过去的另一条，归档换过的那条", async () => {
  const { backend, base, desk, sent, calls, click, tool } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose_archive").run({ id: "K1" }, { signal });
  backend.entries[0].aiopsId = 35;
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "archive"));
  await desk.idle();
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 35 }]);

  const replace = deskSetup({ saveLesson: () => JSON.stringify({ saved: true, id: 32 }) });
  await replace.base.save(normalizeDraft(code8));
  await replace.base.linkAiops("K1", 31);
  await replace.tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  replace.backend.entries[0].aiopsId = 35;
  await replace.desk.handleCardAction(replace.click((replace.sent[0].input as { card: any }).card, "save"));
  await replace.desk.idle();
  assert.deepEqual(replace.calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 35 }]);
});

test("取代旧经验、存好后重新读旧的那条失败：不拿卡片上的旧 aiops 编号凑合，同步和归档等再试一次，按表格里现在的编号认出重复的那条", async () => {
  const setup = deskSetup({
    saveLesson: (args) =>
      args.force ? JSON.stringify({ saved: true, id: 32 }) : JSON.stringify({ saved: false, duplicate_of: { id: 35, title: "旧的", why: "错误码相同" } }),
  });
  const { backend, base, desk, sent, calls, click, tool, lastCard } = setup;
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  // 卡片发出后 K1 的 aiops 编号换成了 35（也是从 K1 同步过去的）；存好新的以后读表格失败一次
  backend.entries[0].aiopsId = 35;
  const add = backend.add.bind(backend);
  const list = backend.list.bind(backend);
  let failNext = false;
  backend.add = async (entry) => {
    await add(entry);
    failNext = true;
  };
  backend.list = async () => {
    if (failNext) {
      failNext = false;
      throw new KnowledgeError("飞书接口超时");
    }
    return list();
  };
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  const partial = lastCard();
  assert.match(cardText(partial), /没能重新读取要取代的旧经验 K1：飞书接口超时。同步 aiops、归档旧经验这几步先没做/);
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 0);
  assert.equal(calls.filter((call) => call.tool === "archive_lesson").length, 0);
  assert.equal(backend.entries[0].status, "active");

  await desk.handleCardAction(click(partial, "save"));
  await desk.idle();
  // aiops 说重复的是 35，正是表格里 K1 现在的编号：强制存新的，再归档 35
  assert.deepEqual(
    calls.filter((call) => call.tool === "save_lesson").map((call) => call.args.force),
    [undefined, true],
  );
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 35 }]);
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status, e.aiopsId]),
    [
      ["K1", "archived", 35],
      ["K2", "active", 32],
    ],
  );
});

test("归档、取代时表格里的 aiops 编号被改成了别的经验（不是从这一条同步过去的）：不归档那条，卡片说明原因，表格改正后再试一次才归档", async () => {
  const { backend, base, desk, sent, calls, click, tool, lastCard } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose_archive").run({ id: "K1" }, { signal });
  backend.entries[0].aiopsId = 40;
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "archive"));
  await desk.idle();
  assert.equal(backend.entries[0].status, "archived");
  assert.equal(calls.filter((call) => call.tool === "archive_lesson").length, 0, "Open WebUI 存的 #40 不归档");
  const partial = lastCard();
  assert.match(cardText(partial), /aiops 经验库里同步的经验 #40 没能归档：它不是从 K1 同步过去的.*可能有人在表格里改了 K1 的 aiops 编号/);
  backend.entries[0].aiopsId = 31;
  await desk.handleCardAction(click(partial, "archive"));
  await desk.idle();
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);

  const replace = deskSetup({ saveLesson: () => JSON.stringify({ saved: true, id: 32 }) });
  await replace.base.save(normalizeDraft(code8));
  await replace.base.linkAiops("K1", 31);
  await replace.tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  replace.backend.entries[0].aiopsId = 40;
  await replace.desk.handleCardAction(replace.click((replace.sent[0].input as { card: any }).card, "save"));
  await replace.desk.idle();
  assert.equal(replace.calls.filter((call) => call.tool === "archive_lesson").length, 0);
  assert.match(cardText(replace.lastCard()), /aiops 经验库里同步的经验 #40 没能归档：它不是从 K1 同步过去的/);
  // 新的这条同步过去的 #32 是 K2 的，也不能当成 K1 的归档
  replace.backend.entries[0].aiopsId = 32;
  await replace.desk.handleCardAction(replace.click(replace.lastCard(), "save"));
  await replace.desk.idle();
  assert.equal(replace.calls.filter((call) => call.tool === "archive_lesson").length, 0);
  assert.match(cardText(replace.lastCard()), /aiops 经验库里同步的经验 #32 没能归档：它不是从 K1 同步过去的/);
});

test("取代旧经验：存好新的以后、归档旧的之前有人在表格里改了旧的（同步 aiops 的时候）：不归档改过的，aiops 里旧的那条也不动，结果里说明", async () => {
  let setup: ReturnType<typeof deskSetup>;
  setup = deskSetup({
    saveLesson: () => {
      setup.backend.entries[0].conclusion = "有人在表格里改过的结论";
      return JSON.stringify({ saved: true, id: 32 });
    },
  });
  const { backend, base, desk, sent, calls, click, tool, lastCard } = setup;
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose").run({ ...code8, title: "gateway-api 报 code=8（已修复）", replaces: "K1" }, { signal });
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.deepEqual(
    backend.entries.map((e) => [e.id, e.status, e.aiopsId]),
    [
      ["K1", "active", 31],
      ["K2", "active", 32],
    ],
  );
  assert.equal(calls.filter((call) => call.tool === "archive_lesson").length, 0);
  assert.equal(lastCard().header.title.content, "已存进经验库");
  assert.match(
    (sent.at(-1)!.input as { markdown: string }).markdown,
    /旧的经验 K1 在卡片发出后在表格里改过，卡片上确认取代的不是现在这条，没有归档它，aiops 里同步的那条也没动/,
  );
});

test("aiops 编号、案例编号超出能精确表示的整数时报错，不会四舍五入到别的经验", async () => {
  const { tool } = deskSetup();
  await assert.rejects(tool("knowledge_propose_archive").run({ aiops_id: "9007199254740993" }, { signal }), /aiops_id 要填正整数/);
  await assert.rejects(tool("knowledge_propose_archive").run({ aiops_id: 2 ** 53 }, { signal }), /aiops_id 要填正整数/);
  await assert.rejects(tool("knowledge_propose").run({ ...code8, case_id: "#9007199254740993" }, { signal }), /case_id 要填正整数/);
});

test("同步到 aiops 后记编号失败会再试；几次都不行时卡片可以再试一次，aiops 里不再存一条", async () => {
  const once = deskSetup();
  await once.tool("knowledge_propose").run(code8, { signal });
  once.backend.failUpdates = 1;
  await once.desk.handleCardAction(once.click((once.sent[0].input as { card: any }).card, "save"));
  await once.desk.idle();
  assert.equal(once.backend.entries[0].aiopsId, 31);
  assert.doesNotMatch((once.sent.at(-1)!.input as { markdown: string }).markdown, /手动|没能在经验库表格里/);

  const never = deskSetup();
  await never.tool("knowledge_propose").run(code8, { signal });
  never.backend.failUpdates = 99;
  await never.desk.handleCardAction(never.click((never.sent[0].input as { card: any }).card, "save"));
  await never.desk.idle();
  assert.equal(never.backend.entries[0].aiopsId, undefined);
  const partial = never.lastCard();
  assert.equal(partial.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(partial), /没能在经验库表格里记下 aiops 编号 #31（飞书接口限流）/);

  never.backend.failUpdates = 0;
  await never.desk.handleCardAction(never.click(partial, "save"));
  await never.desk.idle();
  assert.equal(never.backend.entries[0].aiopsId, 31);
  assert.equal(never.calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.equal(never.lastCard().header.title.content, "已存进经验库");
});

test("aiops 已经存了、记编号没成功，再试一次前表格里改了这一行：归档 aiops 里上次那条，改过的确认后再同步；归档了这一行的不再同步", async () => {
  for (const [change, synced] of [
    [(row: KnowledgeEntry) => (row.conclusion = "改过的结论：user-rpc 改成 headless Service 后恢复"), true],
    [(row: KnowledgeEntry) => (row.status = "archived"), false],
  ] as const) {
    let next = 31;
    const setup = deskSetup({ saveLesson: () => JSON.stringify({ saved: true, id: next++ }) });
    await setup.tool("knowledge_propose").run(code8, { signal });
    setup.backend.failUpdates = 99;
    await setup.desk.handleCardAction(setup.click((setup.sent[0].input as { card: any }).card, "save"));
    await setup.desk.idle();
    const partial = setup.lastCard();
    assert.match(cardText(partial), /没能在经验库表格里记下 aiops 编号 #31/);

    setup.backend.failUpdates = 0;
    change(setup.backend.entries[0]);
    await setup.desk.handleCardAction(setup.click(partial, "save"));
    await setup.desk.idle();
    assert.deepEqual(
      setup.calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args.id),
      [31],
      "aiops 里上次那条归档",
    );
    if (synced) {
      const review = setup.lastCard();
      assert.match(cardText(review), /之前同步到 aiops 的经验 #31 已经不对了，已归档/);
      assert.match(cardText(review), /表格里现在的内容.*改过的结论：user-rpc 改成 headless Service 后恢复/);
      assert.equal(setup.calls.filter((call) => call.tool === "save_lesson").length, 1, "改过的确认之前不同步");
      await setup.desk.handleCardAction(setup.click(review, "save"));
      await setup.desk.idle();
      assert.equal(setup.calls.filter((call) => call.tool === "save_lesson").length, 2);
      assert.equal(setup.backend.entries[0].aiopsId, 32);
    } else {
      const result = (setup.sent.at(-1)!.input as { markdown: string }).markdown;
      assert.match(result, /之前同步到 aiops 的经验 #31 已经不对了，已归档/);
      assert.equal(setup.calls.filter((call) => call.tool === "save_lesson").length, 1);
      assert.equal(setup.backend.entries[0].aiopsId, undefined);
      assert.match(result, /经验 K1 在表格里已经归档了，没有同步到 aiops 经验库/);
    }
  }
});

test("做了一半、卡片改不回带按钮的样子：在话题里重新发一张带「再试一次」的，点新的这张能补上", async () => {
  let down = true;
  const { backend, desk, sent, calls, click, tool, control } = deskSetup({
    saveLesson: () => {
      if (down) {
        throw new Error("aiops 现在连不上");
      }
      return JSON.stringify({ saved: true, id: 31 });
    },
  });
  await tool("knowledge_propose").run(code8, { signal });
  control.failUpdate = true;
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(sent.length, 2, "重新发了一张");
  const resent = (sent[1].input as { card: any }).card;
  assert.equal(resent.header.title.content, "已存进经验库，还有没做成的");
  assert.equal(sent[1].opts?.replyTo, "om_card_1");

  control.failUpdate = false;
  down = false;
  await desk.handleCardAction({ ...click(resent, "save"), messageId: "om_card_2" });
  await desk.idle();
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 2);
  assert.equal(backend.entries[0].aiopsId, 31);
  assert.equal(backend.entries.length, 1);
});

test("aiops 归档：archive_lesson 报错时看一下，已经归档了就算成功，还有效的照样报错", async () => {
  let status = "archived";
  const { mcp } = fakeMcp({
    archive_lesson: () => {
      throw new Error("经验不存在或已归档");
    },
    get_knowledge: (args) => JSON.stringify({ id: args.id, title: "user-rpc 降载", status }),
  });
  const lessons = new AiopsLessons(mcp, "aiops", quiet);
  await lessons.archive(12, "ML", task);
  status = "active";
  await assert.rejects(lessons.archive(12, "ML", task), /经验不存在或已归档/);
});

test("aiops 返回的经验编号不是正的安全整数时不认：存的结果报错，检索里的跳过，取到的编号对不上报错", async () => {
  let saved: unknown = 2 ** 53;
  let duplicate: unknown = 12;
  let got: unknown = 12;
  const { mcp } = fakeMcp({
    save_lesson: (args) =>
      args.title === "重复的"
        ? JSON.stringify({ saved: false, duplicate_of: { id: duplicate, title: "user-rpc 降载" } })
        : JSON.stringify({ saved: true, id: saved }),
    search_knowledge: () =>
      JSON.stringify({
        hits: [
          { id: 1.5, title: "小数", score: 9 },
          { id: -3, title: "负数", score: 9 },
          { id: 2 ** 53, title: "超出范围", score: 9 },
          { id: 12, title: "user-rpc 降载", score: 9 },
        ],
      }),
    get_knowledge: () => JSON.stringify({ id: got, title: "user-rpc 降载", status: "active" }),
    archive_lesson: () => JSON.stringify({ archived: true }),
  });
  const lessons = new AiopsLessons(mcp, "aiops", quiet);
  const draft = normalizeDraft(code8);
  for (const id of [2 ** 53, 1.5, 0, -1, "31"]) {
    saved = id;
    await assert.rejects(lessons.save(draft, { confirmedBy: "ML", teamId: "K1" }, task), /aiops 没有说存没存成功/);
  }
  for (const id of [2 ** 53, 0.5]) {
    duplicate = id;
    await assert.rejects(lessons.save({ ...draft, title: "重复的" }, { confirmedBy: "ML", teamId: "K1" }, task), /aiops 没有说存没存成功/);
  }
  assert.deepEqual(
    (await lessons.search("user-rpc 降载", task)).map((hit) => hit.id),
    [12],
  );
  assert.equal((await lessons.get(12, task)).id, 12);
  got = 13;
  await assert.rejects(lessons.get(12, task), /取经验 #12 时返回的是别的编号/);
});

test("同步到 aiops 时有人在表格里改了这一行：存完重新读表格，归档刚存的那条，改过的列在卡片上，确认后再同步、记编号", async () => {
  let saves = 0;
  let setup: ReturnType<typeof deskSetup>;
  setup = deskSetup({
    saveLesson: () => {
      saves++;
      if (saves === 1) {
        setup.backend.entries[0].conclusion = "user-rpc 只有一个 Pod 接住了全部 gRPC 长连接，CPU 打满后降载（表格里改过）";
      }
      return JSON.stringify({ saved: true, id: 30 + saves });
    },
  });
  const { backend, desk, sent, calls, click, tool, lastCard } = setup;
  await tool("knowledge_propose").run(code8, { signal });
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1, "改过的没确认，不同步");
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.equal(backend.entries[0].aiopsId, undefined);
  const review = lastCard();
  assert.equal(review.header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(review), /经验 K1 在表格里改过，之前同步到 aiops 的经验 #31 已经不对了，已归档/);
  assert.match(cardText(review), /表格里现在的内容.*（表格里改过）/);

  await desk.handleCardAction(click(review, "save"));
  await desk.idle();
  const lessonSaves = calls.filter((call) => call.tool === "save_lesson");
  assert.equal(lessonSaves.length, 2);
  assert.match(String(lessonSaves[1].args.root_cause), /表格里改过/);
  assert.equal(backend.entries[0].aiopsId, 32);
  assert.equal(lastCard().header.title.content, "已存进经验库");
});

test("同步到 aiops 时有人在表格里归档或者删了这一行：归档刚存的那条，不记编号、不再同步；确认后存的时候又改了，再列出来，点之前那张不算", async () => {
  for (const change of ["archive", "delete"] as const) {
      let setup: ReturnType<typeof deskSetup>;
    setup = deskSetup({
      saveLesson: () => {
        if (change === "archive") {
          setup.backend.entries[0].status = "archived";
        } else {
          setup.backend.entries.pop();
        }
        return JSON.stringify({ saved: true, id: 31 });
      },
    });
    const { backend, desk, sent, calls, click, tool, lastCard } = setup;
    await tool("knowledge_propose").run(code8, { signal });
    await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
    await desk.idle();
    assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1, change);
    assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }], change);
    assert.equal(backend.entries[0]?.aiopsId, undefined, change);
    assert.equal(lastCard().header.title.content, "已存进经验库", change);
    assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /经验 K1 在表格里已经归档了，没有同步到 aiops 经验库/, change);
  }

  let saves = 0;
  let busy: ReturnType<typeof deskSetup>;
  busy = deskSetup({
    saveLesson: () => {
      saves++;
      busy.backend.entries[0].conclusion = `user-rpc 只有一个 Pod 接住了全部 gRPC 长连接，CPU 打满后降载（第 ${saves} 次改）`;
      return JSON.stringify({ saved: true, id: 30 + saves });
    },
  });
  await busy.tool("knowledge_propose").run(code8, { signal });
  await busy.desk.handleCardAction(busy.click((busy.sent[0].input as { card: any }).card, "save"));
  await busy.desk.idle();
  const first = busy.lastCard();
  assert.equal(saves, 1);
  assert.match(cardText(first), /表格里现在的内容.*第 1 次改/);

  await busy.desk.handleCardAction(busy.click(first, "save"));
  await busy.desk.idle();
  assert.equal(saves, 2);
  assert.deepEqual(busy.calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args.id), [31, 32]);
  assert.equal(busy.lastCard().header.title.content, "已存进经验库，还有没做成的");
  assert.match(cardText(busy.lastCard()), /表格里现在的内容.*第 2 次改/);

  // 点的是列着第 1 次改的那张：不是现在要同步的内容，不算
  await busy.desk.handleCardAction(busy.click(first, "save"));
  await busy.desk.idle();
  assert.equal(saves, 2);
  assert.match(cardText(busy.lastCard()), /ML点的卡片上列的不是表格里现在的内容，这次没有执行/);
  assert.equal(busy.backend.entries[0].aiopsId, undefined);
});

test("取代旧的排查经验、新的不同步到 aiops（改成了别的类别）：aiops 里旧的那条留着", async () => {
  const { backend, base, desk, sent, calls, click, tool } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose").run({ ...code8, category: "answer", title: "用户反馈接口返回空时怎么回复", replaces: "K1" }, { signal });
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  assert.equal(backend.entries.find((e) => e.id === "K1")!.status, "archived");
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 0);
  assert.equal(calls.filter((call) => call.tool === "archive_lesson").length, 0);
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /aiops 经验库里同步的旧经验 #31 留着没归档/);
});

test("aiops 经验写进提示词：根因和处理办法在前面，每一项限长，现象写得很长也看得到根因", () => {
  const text = renderAiopsHitsForPrompt([
    { id: 12, title: "user-rpc 降载", score: 9, symptom: "接口返回空".repeat(300), root_cause: "单 Pod 被打满", solution: "改 headless Service", diagnosis_path: "看 Pod CPU" },
  ]);
  assert.match(text, /^aiops 经验 #12：user-rpc 降载\n- 根因：单 Pod 被打满\n- 处理办法：改 headless Service\n- 现象：/);
  assert.match(text, /- 现象：(接口返回空)+…（这一项后面省略，要看全文用 aiops_get_knowledge）\n- 排查过程：看 Pod CPU/);
});

test("模型查经验库、看经验时任务停了不等表格", async () => {
  const { base, backend, tool } = deskSetup();
  await base.save(normalizeDraft(dau));
  backend.list = () => new Promise(() => {});
  const stop = new AbortController();
  const searching = tool("knowledge_search").run({ query: "日活" }, { signal: stop.signal });
  const getting = tool("knowledge_get").run({ id: "K1" }, { signal: stop.signal });
  stop.abort();
  await assert.rejects(searching, (err: Error) => err.name === "AbortError");
  await assert.rejects(getting, (err: Error) => err.name === "AbortError");
});

test("读表格卡住时这次报错、不留在缓存里：回答前检索超时后模型再查，不会一直等那次读", async () => {
  const backend = new MemoryBackend();
  const base = new KnowledgeBase(backend, { logger: quiet, readTimeoutMs: 30 });
  await base.save(normalizeDraft(dau));
  const list = backend.list.bind(backend);
  backend.list = () => new Promise(() => {});
  // 回答前检索到时间就不等了，那次读还挂着
  const lookup = new AbortController();
  const abandoned = raceAbort(base.search("日活"), lookup.signal);
  lookup.abort();
  await assert.rejects(abandoned, (err: Error) => err.name === "AbortError");
  // 模型接着调 knowledge_search：用的是缓存里那次读，到了读表格的期限就报错
  await assert.rejects(base.search("日活"), /读经验库表格超过 0.03 秒没读完/);
  // 报错的那次不留在缓存里，表格好了马上能查到
  backend.list = list;
  assert.deepEqual(
    (await base.search("日活")).map((hit) => hit.entry.id),
    ["K1"],
  );
});

test("归档：团队经验库的按编号，aiops 经验库的按 aiops_id；两个都填或都不填报错", async () => {
  const { backend, base, desk, sent, calls, click, tool } = deskSetup();
  await base.save(normalizeDraft(dau));
  await assert.rejects(tool("knowledge_propose_archive").run({}, { signal }), /id 和 aiops_id 填一个/);
  await assert.rejects(tool("knowledge_propose_archive").run({ id: "K1", aiops_id: 3 }, { signal }), /id 和 aiops_id 填一个/);

  await tool("knowledge_propose_archive").run({ id: "k1", reason: "口径改了" }, { signal });
  const card = (sent[0].input as { card: any }).card;
  assert.equal(card.header.title.content, "归档这条经验？");
  assert.match(cardText(card), /归档原因：口径改了/);
  await desk.handleCardAction(click(card, "archive"));
  await desk.idle();
  assert.equal(backend.entries[0].status, "archived");

  await tool("knowledge_propose_archive").run({ aiops_id: 40 }, { signal });
  const lessonCard = (sent.at(-1)!.input as { card: any }).card;
  assert.match(cardText(lessonCard), /aiops 经验 #40/);
  await desk.handleCardAction({ ...click(lessonCard, "archive"), messageId: "om_card_3" });
  await desk.idle();
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 40 }]);
});

test("归档时表格改成功了、结果没传回来：再点一次照常完成，aiops 里同步的那条也归档", async () => {
  const { backend, base, desk, sent, calls, click, tool, lastCard } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  await tool("knowledge_propose_archive").run({ id: "K1", reason: "已修复" }, { signal });
  const card = (sent[0].input as { card: any }).card;
  backend.lostUpdates = 1;
  await desk.handleCardAction(click(card, "archive"));
  await desk.idle();
  assert.equal(backend.entries[0].status, "archived");
  assert.match(cardText(lastCard()), /上次点确认没成功：socket hang up/);
  assert.equal(calls.filter((call) => call.tool === "archive_lesson").length, 0);

  await desk.handleCardAction(click(card, "archive"));
  await desk.idle();
  assert.deepEqual(calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args), [{ id: 31 }]);
  assert.match((sent.at(-1)!.input as { markdown: string }).markdown, /已归档经验 K1.*\naiops 经验库里同步的经验 #31 也已归档/);
});

test("回答前检索：团队经验库这次没查到的，aiops 查到了它同步过去的那条照样列出", async () => {
  const { base, desk } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);
  const found = await desk.lookup("完全不相干的一句话", task);
  assert.deepEqual(found?.ids, ["aiops#31", "aiops#40"]);
});

test("回答前检索：两个库一起查，已同步到 aiops 的只列团队经验库那条；一个库出错不影响另一个，都出错时返回空", async () => {
  const { base, desk } = deskSetup();
  await base.save(normalizeDraft(code8));
  await base.linkAiops("K1", 31);

  const found = await desk.lookup("gateway-api 报 code=8 ResourceExhausted", task);
  assert.deepEqual(found?.ids, ["K1", "aiops#40"]);
  assert.match(found!.text, /^经验 K1 \[排查经验\]/);
  assert.match(found!.text, /aiops 经验 #40：Open WebUI 存的/);
  assert.doesNotMatch(found!.text, /aiops 经验 #31/);

  const none = deskSetup({ aiops: false });
  assert.deepEqual(await none.desk.lookup("今天中午吃什么", task), { text: "", ids: [], missed: [] });

  const broken = new KnowledgeDesk({
    base: new KnowledgeBase({ location: async () => undefined, list: async () => Promise.reject(new Error("飞书接口限流")), add: async () => {}, update: async () => {} }, { logger: quiet }),
    aiops: new AiopsLessons(
      {
        hasTool: () => true,
        connected: () => true,
        callDirect: async () => {
          throw new Error("aiops 现在连不上");
        },
      },
      "aiops",
      quiet,
    ),
    send: async () => ({ messageId: "x" }),
    updateCard: async () => {},
    allowedChatIds: new Set(["oc_1"]),
    logger: quiet,
  });
  assert.equal(await broken.lookup("code=8", task), undefined);
});

test("回答前检索每个库限时：表格卡住了照样用 aiops 的结果；没接 aiops、aiops 没连上时团队经验库没查成就返回空", async () => {
  const hanging: KnowledgeBackend = { location: async () => undefined, list: () => new Promise(() => {}), add: async () => {}, update: async () => {} };
  const lessons = new AiopsLessons(fakeMcp({ search_knowledge: () => JSON.stringify({ hits: [{ id: 40, title: "Open WebUI 存的", score: 8 }] }) }).mcp, "aiops", quiet);
  const make = (aiops?: AiopsLessons) =>
    new KnowledgeDesk({
      base: new KnowledgeBase(hanging, { logger: quiet, readTimeoutMs: 200 }),
      ...(aiops ? { aiops } : {}),
      send: async () => ({ messageId: "x" }),
      updateCard: async () => {},
      allowedChatIds: new Set(["oc_1"]),
      logger: quiet,
      lookupMs: 20,
    });
  const found = await make(lessons).lookup("code=8", task);
  assert.deepEqual(found?.ids, ["aiops#40"]);
  assert.deepEqual(found?.missed, ["团队经验库"]);

  assert.equal(await make().lookup("code=8", task), undefined);
  const disconnected = new AiopsLessons({ hasTool: () => false, connected: () => false, callDirect: async () => "" }, "aiops", quiet);
  assert.equal(await make(disconnected).lookup("code=8", task), undefined);

  const stop = new AbortController();
  const pending = make(lessons).lookup("code=8", task, stop.signal);
  stop.abort();
  await assert.rejects(pending, (err: Error) => err.name === "AbortError");
});

test("不是经验库的卡片、不在白名单里的群，经验库不处理", async () => {
  const { desk, sent, click, tool, backend } = deskSetup();
  assert.equal(await desk.handleCardAction({ messageId: "m", chatId: "oc_1", operator: { openId: "ou_admin" }, action: { tag: "button", value: { action: "stop", task: "t" } } }), false);
  await desk.idle();
  await tool("knowledge_propose").run(dau, { signal });
  assert.equal(await desk.handleCardAction({ ...click((sent[0].input as { card: any }).card, "save"), chatId: "oc_other" }), true);
  await desk.idle();
  assert.equal(backend.entries.length, 0);
});

test("类别只认经验库的几类：constructor、toString、__proto__ 这类名字不算", async () => {
  for (const category of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => normalizeDraft({ ...dau, category }), /category 只能是/, category);
  }
  const { base, tool } = deskSetup();
  await base.save(normalizeDraft(dau));
  assert.match(await tool("knowledge_search").run({ query: "日活", category: "toString" }, { signal }), /K1/, "不认的类别不拿来过滤");
});

test("「把案例 #N 沉淀为经验」按 aiops 开了的工具说：有 promote_case 用它，没有就用 get_case 自己整理", () => {
  const prompt = (toolNames: string[]) => buildSystemPrompt({ botName: "飞书 CLI", now: new Date(0), toolNames, knowledge: { hits: "" } });
  const promote = prompt(["knowledge_propose", "aiops_get_case", "aiops_promote_case"]);
  assert.match(promote, /先用 aiops_promote_case 拿草稿/);
  const getCase = prompt(["knowledge_propose", "aiops_get_case"]);
  assert.doesNotMatch(getCase, /aiops_promote_case/);
  assert.match(getCase, /用 aiops_get_case 取出案例，自己整理成草稿再调 knowledge_propose，带上 case_id/);
  assert.doesNotMatch(prompt(["knowledge_propose"]), /「把案例 #N 沉淀为经验」：/);
});

test("没接 aiops 时：经验库的工具说明和提示词都不提 aiops 的工具和经验库，免得模型去调不存在的工具", () => {
  const ctx = { chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" };
  const specs = (desk: KnowledgeDesk, other: string[] = []) => JSON.stringify(desk.tools(ctx, other).map((tool) => tool.spec));
  const plain = deskSetup({ aiops: false }).desk;
  assert.doesNotMatch(specs(plain), /aiops/);
  const withAiops = deskSetup().desk;
  // 接了 aiops，但这次模型没有 aiops_search_knowledge（比如 aiops 没连上）：不让模型去调它
  assert.doesNotMatch(specs(withAiops), /aiops_search_knowledge/);
  assert.match(specs(withAiops), /aiops_id/);
  assert.match(specs(withAiops, ["aiops_search_knowledge"]), /aiops 自带的经验库用 aiops_search_knowledge 查/);

  const prompt = (toolNames: string[], knowledge: { hits?: string; missed?: string[]; failed?: boolean }) =>
    buildSystemPrompt({ botName: "飞书 CLI", now: new Date(0), toolNames, knowledge });
  const team = ["knowledge_search", "knowledge_get", "knowledge_propose", "knowledge_propose_archive"];
  for (const knowledge of [{ hits: "经验 K1 …" }, { hits: "", missed: ["团队经验库"] }, { failed: true }]) {
    const text = prompt(team, knowledge);
    assert.doesNotMatch(text.slice(text.indexOf("## 团队经验库")), /aiops/, JSON.stringify(knowledge));
  }
  const both = prompt([...team, "aiops_search_knowledge", "aiops_get_knowledge"], { hits: "经验 K1 …" });
  assert.match(both, /参考 aiops 经验 #N/);
  assert.match(both, /aiops 的用 aiops_get_knowledge/);
});

test("模型查经验库时向量服务卡住：到期限就只按关键词，不一直等", async () => {
  const backend = new MemoryBackend();
  const { embedder } = fakeEmbedder(["日活"]);
  const base = new KnowledgeBase(backend, { embedder, logger: quiet });
  await base.save(normalizeDraft(dau));
  // 向量服务卡住，也不认中止信号
  embedder.embed = () => new Promise(() => {});
  const desk = new KnowledgeDesk({
    base,
    send: async () => ({ messageId: "x" }),
    updateCard: async () => {},
    allowedChatIds: new Set(["oc_1"]),
    logger: quiet,
    semanticMs: 20,
  });
  const ctx = { chatId: "oc_1", threadKey: "om_root", senderId: "ou_1", askerName: "张三", messageId: "om_1" };
  const search = desk.tools(ctx).find((tool) => tool.spec.name === "knowledge_search")!;
  assert.match(await search.run({ query: "日活" }, { signal }), /经验 K1/);
});

test("aiops 的说明在经验库关掉时也成立：只在有起草工具时让模型用，没有时直说做不了", async () => {
  const text = await readFile(new URL("../prompts/mcp/aiops.md", import.meta.url), "utf8");
  assert.match(text, /你的工具里有 knowledge_propose、knowledge_propose_archive 时，沉淀经验、归档经验用它们起草/);
  assert.match(text, /没有这两个工具时（经验库没开），有人要沉淀或归档经验，直说现在做不了/);
});

test("存好了、同步到 aiops 之前有人在表格里清空了标题：再试一次不按卡片上的草稿同步，表格里补上以后再试才同步", async () => {
  let down = true;
  const { backend, desk, sent, calls, click, tool, lastCard } = deskSetup({
    saveLesson: () => {
      if (down) {
        throw new Error("aiops 现在连不上");
      }
      return JSON.stringify({ saved: true, id: 31 });
    },
  });
  await tool("knowledge_propose").run(code8, { signal });
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  backend.entries[0].title = "";
  down = false;
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.match(cardText(lastCard()), /经验 K1 在表格里标题是空的，没有同步到 aiops 经验库/);
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1, "没有按卡片上的草稿同步过去");
  assert.equal(backend.entries.length, 1);

  backend.entries[0].title = code8.title;
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  const saves = calls.filter((call) => call.tool === "save_lesson");
  assert.equal(saves.length, 2);
  assert.equal(saves[1].args.title, code8.title);
  assert.equal(backend.entries[0].aiopsId, 31);
  assert.equal(lastCard().header.title.content, "已存进经验库");
});

test("aiops 已经存了、记编号没成功，再试一次前表格里清空了结论：归档 aiops 里上次那条，补上之前不再同步", async () => {
  let next = 31;
  const { backend, desk, sent, calls, click, tool, lastCard } = deskSetup({ saveLesson: () => JSON.stringify({ saved: true, id: next++ }) });
  await tool("knowledge_propose").run(code8, { signal });
  backend.failUpdates = 99;
  await desk.handleCardAction(click((sent[0].input as { card: any }).card, "save"));
  await desk.idle();
  backend.failUpdates = 0;
  backend.entries[0].conclusion = "";
  await desk.handleCardAction(click(lastCard(), "save"));
  await desk.idle();
  assert.deepEqual(
    calls.filter((call) => call.tool === "archive_lesson").map((call) => call.args.id),
    [31],
  );
  assert.equal(calls.filter((call) => call.tool === "save_lesson").length, 1);
  assert.match(cardText(lastCard()), /之前同步到 aiops 的经验 #31 已经不对了，已归档/);
  assert.match(cardText(lastCard()), /经验 K1 在表格里结论是空的，没有同步到 aiops 经验库/);
});

test("归档、取代卡片发出后有人在表格里改了那一条：点确认时卡片作废，不归档改过的，也不存取代它的", async () => {
  const archiving = deskSetup();
  await archiving.base.save(normalizeDraft(dau));
  await archiving.tool("knowledge_propose_archive").run({ id: "K1" }, { signal });
  archiving.backend.entries[0].conclusion = "改过的口径：以登录日志去重为准";
  await archiving.desk.handleCardAction(archiving.click((archiving.sent[0].input as { card: any }).card, "archive"));
  await archiving.desk.idle();
  assert.equal(archiving.backend.entries[0].status, "active");
  assert.match(cardText(archiving.lastCard()), /经验 K1 在卡片发出后在表格里改过/);

  // 改了内容还顺手归档了：也不算这张卡片归档成功，不去归档它同步在 aiops 里的那条
  const archived = deskSetup();
  await archived.base.save(normalizeDraft(code8));
  archived.backend.entries[0].aiopsId = 31;
  await archived.tool("knowledge_propose_archive").run({ id: "K1" }, { signal });
  archived.backend.entries[0].conclusion = "改过的结论：user-rpc 改成 headless Service 后恢复";
  archived.backend.entries[0].status = "archived";
  await archived.desk.handleCardAction(archived.click((archived.sent[0].input as { card: any }).card, "archive"));
  await archived.desk.idle();
  assert.match(cardText(archived.lastCard()), /经验 K1 在卡片发出后在表格里改过/);
  assert.equal(archived.calls.filter((call) => call.tool === "archive_lesson").length, 0);

  const replacing = deskSetup();
  await replacing.base.save(normalizeDraft(dau));
  await replacing.tool("knowledge_propose").run({ ...dau, title: "日活的口径（新）", replaces: "K1" }, { signal });
  replacing.backend.entries[0].keywords = "日活,DAU,活跃用户";
  await replacing.desk.handleCardAction(replacing.click((replacing.sent[0].input as { card: any }).card, "save"));
  await replacing.desk.idle();
  assert.equal(replacing.backend.entries.length, 1);
  assert.equal(replacing.backend.entries[0].status, "active");
  assert.match(cardText(replacing.lastCard()), /经验 K1 在卡片发出后在表格里改过/);
});

test("有人直接在表格里写进了密钥：这一行不拿来检索、不给模型看，也不能起草归档卡片；编号照常算它", async () => {
  const { base, backend } = deskSetup();
  await base.save(normalizeDraft(dau));
  await base.save(normalizeDraft({ ...dau, title: "日活的口径（App 端）", keywords: "日活,App" }));
  // 表格里直接改的：结论后面贴了令牌
  backend.entries[1].conclusion += ["\nMCP_AIOPS_TOKEN=my correct", "horse battery staple"].join(" ");
  // 另一行的处理办法里贴了带密码的命令
  await base.save(normalizeDraft({ ...dau, title: "日活的口径（小程序）", keywords: "日活,小程序" }));
  backend.entries[2].handling = ["deployctl --password", "correcthorsebatterystaple"].join(" ");
  // 再一行的依据里贴了 XML 配置里的密码
  await base.save(normalizeDraft({ ...dau, title: "日活的口径（H5）", keywords: "日活,H5" }));
  backend.entries[3].basis = ["<password><![CDATA[correct horse", "battery staple]]></password>"].join(" ");
  // 还有一行是确认人那一列里贴了密码（检索结果、knowledge_get 里会写出确认人）
  await base.save(normalizeDraft({ ...dau, title: "日活的口径（PC）", keywords: "日活,PC" }));
  backend.entries[4].confirmedBy = ["password", "correcthorsebatterystaple"].join("=");
  const fresh = new KnowledgeBase(backend, { logger: quiet });
  const hits = await fresh.search("日活");
  assert.deepEqual(
    hits.map((hit) => hit.entry.id),
    ["K1"],
  );
  const desk = deskSetup();
  desk.backend.entries = structuredClone(backend.entries);
  assert.doesNotMatch(await desk.tool("knowledge_search").run({ query: "日活" }, { signal }), /K2|K3|K4|K5|horse/);
  await assert.rejects(desk.tool("knowledge_get").run({ id: "K2" }, { signal }), /经验 K2 在表格里被改过，结论里像是有密码或令牌/);
  await assert.rejects(desk.tool("knowledge_propose_archive").run({ id: "K2" }, { signal }), /结论里像是有密码或令牌/);
  await assert.rejects(desk.tool("knowledge_get").run({ id: "K3" }, { signal }), /经验 K3 在表格里被改过，怎么处理里像是有密码或令牌/);
  await assert.rejects(desk.tool("knowledge_get").run({ id: "K4" }, { signal }), /经验 K4 在表格里被改过，依据或排查过程里像是有密码或令牌/);
  await assert.rejects(desk.tool("knowledge_get").run({ id: "K5" }, { signal }), /经验 K5 在表格里被改过，确认人里像是有密码/);
  assert.equal(desk.sent.length, 0);
  // 新存的不会占掉 K2 到 K5
  assert.equal((await fresh.save(normalizeDraft({ ...dau, title: "周活的口径", keywords: "周活" }))).id, "K6");
});
