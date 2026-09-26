import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";
import type { Tool } from "./tool.js";

const MAX_REDIRECTS = 5;
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** 返回给模型的正文字数上限 */
const MAX_TEXT_CHARS = 12000;
const USER_AGENT = "Mozilla/5.0 (compatible; AgentTag/0.1; +https://github.com/limenghg000000-gif/agentTag)";

/**
 * 内网、本机、云服务器元数据（阿里云 100.100.100.200 在 100.64.0.0/10 里）等地址一律不让访问：
 * 机器人跑在公司服务器上，网页内容和群消息都可能诱导它去读内网服务。
 */
// IPv4 和 IPv6 分开放：Node 的 BlockList 检查 IPv4 地址时也会匹配 IPv6 规则里的 IPv4 映射段
const blockedV4 = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  blockedV4.addSubnet(net, prefix, "ipv4");
}
const blockedV6 = new BlockList();
for (const [net, prefix] of [
  ["::", 96], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["100::", 64], ["2001::", 32],
  ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
] as const) {
  blockedV6.addSubnet(net, prefix, "ipv6");
}

/** 是否是可以访问的公网地址 */
export function isPublicAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4:
      return !blockedV4.check(address, "ipv4");
    case 6: {
      // IPv4 映射地址按其中的 IPv4 判断，其余映射写法一律拒绝
      const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
      return mapped ? isPublicAddress(mapped[1]) : !blockedV6.check(address, "ipv6");
    }
    default:
      return false;
  }
}

export class BlockedAddressError extends Error {
  constructor(host: string) {
    super(`${host} 是内网或保留地址，不允许访问`);
    this.name = "BlockedAddressError";
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** 解析域名后只留下公网地址，连接就用这里校验过的地址，避免解析和连接之间被换成内网地址 */
function publicOnlyLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) {
      callback(err, []);
      return;
    }
    const allowed = addresses.filter((entry) => isPublicAddress(entry.address));
    if (allowed.length === 0) {
      callback(new BlockedAddressError(hostname), []);
      return;
    }
    if (options.all) {
      callback(null, allowed);
    } else {
      callback(null, allowed[0].address, allowed[0].family);
    }
  });
}

export interface FetchUrlOptions {
  /** 只给测试用：允许访问本机等内网地址 */
  allowPrivateNetwork?: boolean;
}

export function createFetchUrlTool({ allowPrivateNetwork = false }: FetchUrlOptions = {}): Tool {
  return {
    spec: {
      name: "fetch_url",
      description:
        "读取一个公网网页或文本文件，返回标题和正文（网页会转成带链接的纯文本）。" +
        "用户给了链接、或者需要查看某个网页的内容时使用。只能访问公网地址。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "完整网址，以 http:// 或 https:// 开头" },
        },
        required: ["url"],
      },
    },
    describe(args) {
      const url = new URL(String(args.url));
      const path = url.pathname === "/" ? "" : url.pathname;
      return `读取网页 ${url.host}${path.length > 40 ? `${path.slice(0, 40)}…` : path}`;
    },
    async run(args, { signal }) {
      if (typeof args.url !== "string") {
        throw new Error("缺少 url 参数");
      }
      let url: URL;
      try {
        url = new URL(args.url);
      } catch {
        throw new Error(`不是合法的网址：${args.url}`);
      }
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      try {
        return formatPage(await fetchPage(url, AbortSignal.any([signal, timeout]), allowPrivateNetwork));
      } catch (err) {
        if (timeout.aborted && !signal.aborted) {
          throw new Error(`请求超时（${TIMEOUT_MS / 1000} 秒）`);
        }
        throw err;
      }
    },
  };
}

interface FetchedPage {
  url: URL;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

async function fetchPage(start: URL, signal: AbortSignal, allowPrivateNetwork: boolean): Promise<FetchedPage> {
  let url = start;
  for (let redirects = 0; ; redirects++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`只支持 http 和 https 网址：${url.href}`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "");
    // 直接写 IP 的网址不经过域名解析，要单独检查
    if (!allowPrivateNetwork && isIP(host) && !isPublicAddress(host)) {
      throw new BlockedAddressError(host);
    }

    const res = await request(url, signal, allowPrivateNetwork);
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (redirects >= MAX_REDIRECTS) {
        throw new Error("重定向次数太多");
      }
      url = new URL(res.headers.location, url);
      continue;
    }
    if (status < 200 || status >= 300) {
      res.resume();
      throw new Error(`网站返回 HTTP ${status}`);
    }

    const contentType = String(res.headers["content-type"] ?? "").toLowerCase();
    const { body, truncated } = await readBody(res, decompress(res), MAX_BYTES);
    return { url, contentType, body, truncated };
  }
}

function request(url: URL, signal: AbortSignal, allowPrivateNetwork: boolean): Promise<http.IncomingMessage> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        signal,
        lookup: allowPrivateNetwork ? undefined : publicOnlyLookup,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
          "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

/** 按 content-encoding 解压。用 pipeline 串起来，连接中断或解压出错时读取会跟着报错，不会卡住 */
function decompress(res: http.IncomingMessage): Readable {
  const ignore = () => {};
  switch (String(res.headers["content-encoding"] ?? "").toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return pipeline(res, zlib.createGunzip(), ignore);
    case "deflate":
      return pipeline(res, zlib.createInflate(), ignore);
    case "br":
      return pipeline(res, zlib.createBrotliDecompress(), ignore);
    default:
      return res;
  }
}

async function readBody(res: http.IncomingMessage, stream: Readable, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
    size += (chunk as Buffer).length;
    if (size >= limit) {
      truncated = true;
      break;
    }
  }
  res.destroy();
  return { body: Buffer.concat(chunks).subarray(0, limit), truncated };
}

function formatPage({ url, contentType, body, truncated }: FetchedPage): string {
  const isHtml = /html/.test(contentType) || (!contentType && /^\s*</.test(body.subarray(0, 100).toString("latin1")));
  const isText = /^text\/|json|xml|javascript|yaml|csv/.test(contentType);
  if (!isHtml && !isText) {
    throw new Error(`暂不支持读取这种内容（${contentType || "未知类型"}），只能读网页和文本`);
  }

  const raw = decode(body, contentType, isHtml);
  const { title, text } = isHtml ? htmlToText(raw, url) : { title: "", text: raw.trim() };
  const cut = text.length > MAX_TEXT_CHARS;
  const lines = [`网址：${url.href}`];
  if (title) {
    lines.push(`标题：${title}`);
  }
  if (cut || truncated) {
    lines.push(`（内容过长，只保留了前 ${Math.min(text.length, MAX_TEXT_CHARS)} 字）`);
  }
  lines.push("", cut ? text.slice(0, MAX_TEXT_CHARS) : text || "（页面没有可读的文字）");
  return lines.join("\n");
}

function decode(body: Buffer, contentType: string, isHtml: boolean): string {
  let charset = /charset=["']?([\w-]+)/.exec(contentType)?.[1];
  if (!charset && isHtml) {
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.subarray(0, 4096).toString("latin1"))?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

const BLOCK_TAGS = "p|div|section|article|header|footer|main|aside|nav|ul|ol|table|tr|blockquote|pre|form|figure|figcaption|dl|dt|dd|hr";

/** 把 HTML 粗略转成纯文本：去掉脚本和样式，保留段落、标题、列表和链接 */
export function htmlToText(html: string, base: URL): { title: string; text: string } {
  const title = decodeEntities(stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")).trim();
  let s = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|iframe|head|title|canvas)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi, (_, _q, dq, sq, bare, inner) => {
      const label = decodeEntities(stripTags(inner)).replace(/\s+/g, " ").trim();
      const href = decodeEntities(dq ?? sq ?? bare ?? "");
      let abs: URL | undefined;
      try {
        abs = new URL(href, base);
      } catch {
        abs = undefined;
      }
      if (!label) {
        return "";
      }
      return abs && /^https?:$/.test(abs.protocol) ? `[${label}](${abs.href})` : label;
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(td|th)\b[^>]*>/gi, " ")
    .replace(new RegExp(`</?(${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n");
  s = decodeEntities(stripTags(s));
  const text = s
    .split("\n")
    .map((line) => line.replace(/[ \t 　]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ensp: " ", emsp: " ", thinsp: " ",
  mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", laquo: "«", raquo: "»", times: "×", divide: "÷",
  yen: "¥", euro: "€", pound: "£", deg: "°", plusmn: "±", larr: "←", rarr: "→", uarr: "↑", darr: "↓",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
  });
}
