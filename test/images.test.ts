import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGE_INSTRUCTION, ImageReader, imageKeysIn, inlineImages, MAX_IMAGES_PER_TASK, pickImages, UNREAD_IMAGE } from "../src/images.js";
import { LlmError, type VisionModel } from "../src/llm.js";

const png = { data: Buffer.from("png"), mimeType: "image/png" };

function setup(options: { download?: () => Promise<typeof png>; describe?: VisionModel["describe"]; timeoutMs?: number } = {}) {
  const downloads: string[] = [];
  const described: { mimeType: string; instruction: string }[] = [];
  const warnings: string[] = [];
  const reader = new ImageReader({
    download: async (messageId, imageKey) => {
      downloads.push(`${messageId}/${imageKey}`);
      return (options.download ?? (async () => png))();
    },
    vision: {
      model: "qwen3.8-max",
      describe:
        options.describe ??
        (async (image, instruction) => {
          described.push({ mimeType: image.mimeType, instruction });
          return " 告警名称：悦拜-日志重点关注告警触发\n服务名称：prod/gateway-api ";
        }),
    },
    logger: { info() {}, warn: (line: string) => warnings.push(line), error() {} },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  });
  return { reader, downloads, described, warnings };
}

test("把图片标记换成识别出的文字，没识别出来的换成「没能看到」的说明；不是消息里的图片（自己贴的 Markdown）原样保留", () => {
  const text = "![image](img_a)\n这个线上报警是咋回事 ![image](img_b)";
  const known = new Set(["img_a", "img_b"]);
  assert.deepEqual(imageKeysIn(text), ["img_a", "img_b"]);
  const out = inlineImages(text, new Map([["img_a", "服务名称：prod/gateway-api"]]), known);
  assert.match(out, /\[图片内容：机器人用看图模型识别的文字，个别字可能识别错\]\n服务名称：prod\/gateway-api\n\[图片内容结束\]/);
  assert.ok(out.endsWith(UNREAD_IMAGE));
  assert.doesNotMatch(out, /img_/);
  assert.equal(inlineImages("没有图片", new Map(), known), "没有图片");
  const readme = "README 里这行 ![image](https://example.com/a.png) 为啥不显示";
  assert.equal(inlineImages(readme, new Map(), known), readme);
});

test("挑图片：提问里的在前，再从新到旧挑上文里还看得到的，同一张只挑一次，最多 4 张", () => {
  const asked = [{ messageId: "om_q", imageKey: "img_q" }];
  const context = [
    { messageId: "om_1", imageKey: "img_old" },
    { messageId: "om_2", imageKey: "img_cut" },
    { messageId: "om_3", imageKey: "img_2" },
    { messageId: "om_4", imageKey: "img_3" },
    { messageId: "om_4", imageKey: "img_q" },
    { messageId: "om_5", imageKey: "img_4" },
  ];
  // img_cut 所在的消息因为太长被省略了，history 里看不到它
  const history = ["![image](img_old)", "![image](img_2)", "![image](img_3) ![image](img_q)", "![image](img_4)"].join("\n");
  assert.deepEqual(
    pickImages(asked, context, history).map((ref) => ref.imageKey),
    ["img_q", "img_4", "img_3", "img_2"],
  );
  assert.equal(MAX_IMAGES_PER_TASK, 4);
  assert.deepEqual(pickImages([], [], ""), []);
});

test("下载图片交给看图模型，按要求原样抄文字；同一张图第二次直接用记住的结果", async () => {
  const { reader, downloads, described } = setup();
  const ref = { messageId: "om_1", imageKey: "img_a" };

  const first = await reader.read([ref]);
  assert.equal(first.get("img_a"), "告警名称：悦拜-日志重点关注告警触发\n服务名称：prod/gateway-api");
  assert.deepEqual(downloads, ["om_1/img_a"]);
  assert.equal(described[0].mimeType, "image/png");
  assert.equal(described[0].instruction, IMAGE_INSTRUCTION);
  assert.match(IMAGE_INSTRUCTION, /一个字都不能改/);

  const second = await reader.read([ref]);
  assert.equal(second.get("img_a"), first.get("img_a"));
  assert.equal(downloads.length, 1);
});

test("下载失败、识别失败、识别超时、识别出空的：这张图不在结果里，日志写明原因和怎么查", async () => {
  const feishuError = Object.assign(new Error("Request failed"), { response: { data: { code: 99991672, msg: "Access denied" } } });
  const failedDownload = setup({ download: async () => Promise.reject(feishuError) });
  assert.equal((await failedDownload.reader.read([{ messageId: "om_1", imageKey: "img_a" }])).size, 0);
  assert.match(failedDownload.warnings[0], /下载图片失败 message=om_1 image=img_a：code=99991672 Access denied.*读取消息资源的权限/);

  const failedVision = setup({ describe: async () => Promise.reject(new LlmError("api", "400 model does not support image input")) });
  assert.equal((await failedVision.reader.read([{ messageId: "om_1", imageKey: "img_a" }])).size, 0);
  assert.match(failedVision.warnings[0], /识别图片失败.*model does not support image input.*MODEL_VISION_ID=qwen3.8-max/);

  const slow = setup({ describe: (_image, _instruction, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))), timeoutMs: 20 });
  assert.equal((await slow.reader.read([{ messageId: "om_1", imageKey: "img_a" }])).size, 0);
  assert.match(slow.warnings[0], /识别图片失败.*超过 0.02 秒/);

  const empty = setup({ describe: async () => "  " });
  assert.equal((await empty.reader.read([{ messageId: "om_1", imageKey: "img_a" }])).size, 0);
  assert.match(empty.warnings[0], /识别图片没有得到文字/);
  // 失败的不记住，下次还会再试
  await empty.reader.read([{ messageId: "om_1", imageKey: "img_a" }]);
  assert.equal(empty.downloads.length, 2);
});

test("任务在读上下文时就被停止了：不再下载；停止后下载才失败也不会变成未处理的拒绝", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const stopped = new AbortController();
    stopped.abort();
    const early = setup();
    assert.equal((await early.reader.read([{ messageId: "om_1", imageKey: "img_a" }], stopped.signal)).size, 0);
    assert.deepEqual(early.downloads, []);

    // 下载途中被停止，下载过一会儿才失败（比如没开 im:resource）
    const midway = new AbortController();
    const late = setup({
      download: () => new Promise((_, reject) => setTimeout(() => reject(new Error("Access denied")), 10)),
    });
    const pending = late.reader.read([{ messageId: "om_1", imageKey: "img_a" }], midway.signal);
    midway.abort();
    assert.equal((await pending).size, 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(late.warnings, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(unhandled, []);
});

test("任务被停止时不再等识别结果，也不当成失败写日志", async () => {
  const controller = new AbortController();
  const { reader, warnings } = setup({
    describe: (_image, _instruction, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
  });
  const pending = reader.read([{ messageId: "om_1", imageKey: "img_a" }], controller.signal);
  controller.abort();
  assert.equal((await pending).size, 0);
  assert.deepEqual(warnings, []);
});
