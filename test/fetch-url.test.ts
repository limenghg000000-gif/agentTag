import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { gzipSync } from "node:zlib";
import { createFetchUrlTool, htmlToText, isPublicAddress } from "../src/tools/fetch-url.js";

const GBK_NIHAO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // 「你好」的 GBK 编码

const server = createServer((req, res) => {
  switch (req.url) {
    case "/page":
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(`<html><head><title>测试页 &amp; 标题</title><style>.x{}</style></head>
        <body><script>alert(1)</script><h1>大标题</h1><p>第一段<br>第二行</p>
        <ul><li>甲</li><li>乙</li></ul><a href="/next">下一页</a></body></html>`);
      return;
    case "/gbk":
      res.setHeader("content-type", "text/html");
      res.end(Buffer.concat([Buffer.from('<meta charset="gbk"><p>'), GBK_NIHAO, Buffer.from("</p>")]));
      return;
    case "/gzip":
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync("压缩过的文本"));
      return;
    case "/redirect":
      res.statusCode = 302;
      res.setHeader("location", "/page");
      res.end();
      return;
    case "/image":
      res.setHeader("content-type", "image/png");
      res.end(Buffer.alloc(10));
      return;
    default:
      res.statusCode = 404;
      res.end("not found");
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const local = createFetchUrlTool({ allowPrivateNetwork: true });
const ctx = { signal: new AbortController().signal };

test("读取网页：返回标题和去掉脚本样式后的正文，链接转成绝对地址", async () => {
  const output = await local.run({ url: `${base}/page` }, ctx);

  assert.match(output, /^网址：http:\/\/127\.0\.0\.1:\d+\/page\n标题：测试页 & 标题\n/);
  assert.match(output, /# 大标题/);
  assert.match(output, /第一段\n第二行/);
  assert.match(output, /- 甲\n- 乙/);
  assert.match(output, new RegExp(`\\[下一页\\]\\(${base}/next\\)`));
  assert.doesNotMatch(output, /alert|\.x\{/);
});

test("按网页声明的编码解码，支持 gzip，跟随重定向", async () => {
  assert.match(await local.run({ url: `${base}/gbk` }, ctx), /你好/);
  assert.match(await local.run({ url: `${base}/gzip` }, ctx), /压缩过的文本/);
  assert.match(await local.run({ url: `${base}/redirect` }, ctx), /网址：.*\/page\n标题：测试页/);
});

test("非文本内容、HTTP 错误和不合法的网址报错", async () => {
  await assert.rejects(local.run({ url: `${base}/image` }, ctx), /暂不支持读取这种内容（image\/png）/);
  await assert.rejects(local.run({ url: `${base}/missing` }, ctx), /HTTP 404/);
  await assert.rejects(local.run({ url: "ftp://example.com/a" }, ctx), /只支持 http 和 https/);
  await assert.rejects(local.run({ url: "不是网址" }, ctx), /不是合法的网址/);
  await assert.rejects(local.run({}, ctx), /缺少 url/);
});

test("默认不允许访问本机、内网和云服务器元数据地址", async () => {
  const tool = createFetchUrlTool();
  await assert.rejects(tool.run({ url: `${base}/page` }, ctx), /127\.0\.0\.1 是内网或保留地址/);
  await assert.rejects(tool.run({ url: `http://localhost:${new URL(base).port}/page` }, ctx), /localhost 是内网或保留地址/);
  await assert.rejects(tool.run({ url: "http://100.100.100.200/latest/meta-data/" }, ctx), /内网或保留地址/);
  await assert.rejects(tool.run({ url: "http://[::1]/" }, ctx), /内网或保留地址/);
});

test("区分公网地址和内网、保留地址", () => {
  for (const ip of ["8.8.8.8", "223.5.5.5", "::ffff:8.8.8.8", "2400:3200::1"]) {
    assert.equal(isPublicAddress(ip), true, ip);
  }
  for (const ip of [
    "127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "100.100.100.200", "169.254.169.254", "0.0.0.0",
    "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "fe80::1", "fd00::1", "example.com",
  ]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
});

test("进度卡片上的说明带上网站和路径", () => {
  assert.equal(local.describe({ url: "https://example.com/" }), "读取网页 example.com");
  assert.equal(local.describe({ url: "https://example.com/a/b?x=1" }), "读取网页 example.com/a/b");
});

test("HTML 转文本：解码实体，合并空白", () => {
  const { title, text } = htmlToText("<title> A </title><div>  x&nbsp;&lt;y&gt;  &#20320;&#x597d;</div>\n\n\n\n<p>z</p>", new URL("https://a.com"));
  assert.equal(title, "A");
  assert.equal(text, "x <y> 你好\n\nz");
});
