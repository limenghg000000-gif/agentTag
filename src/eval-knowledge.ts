/**
 * 经验库检索测试：拿一批提问去团队经验库检索，按几档门槛统计能查到多少，列出每个提问最相近的 3 条和分数，用来调门槛。
 * 只读：只读表格、算向量，不改表格、不调 aiops、不发消息、不连长连接，机器人开着也能跑。
 *
 * 用法（在机器人目录下，先 npm run build）：
 *   npm run eval:knowledge                  用各群最近的话题里问过的问题（DATA_DIR/recent-threads/）
 *   npm run eval:knowledge -- 提问.txt      一行一个提问；行尾可以用「=>」写应该查到哪几条：
 *                                           「gateway 报 code=8 怎么办 => K1」「今天几号 => 无」，写了就多算查对了几条
 * 提问里像有密钥的跳过，手机号、身份证号打码后再查。输出里有提问原文和经验标题，贴给别人前看一眼。
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { loadConfig } from "./config.js";
import { containsSecret, KEYWORD_MIN, KnowledgeBase, type KnowledgeScore, maskPersonal, normalizeId, SEMANTIC_MIN, usable } from "./knowledge.js";
import { BitableKnowledgeBackend, createBitableApi } from "./knowledge-bitable.js";
import { createOpenAICompatibleEmbedder } from "./llm.js";

/** 回答前检索每个库最多用几条 */
const TOP = 3;
/** 拿来比的几档语义门槛（现在是 SEMANTIC_MIN） */
export const THRESHOLDS = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7];
/** 关键词、错误码、告警名对上几个时语义不够也算（和检索一样） */
const MARKERS_ENOUGH = 2;
const QUESTION_PREVIEW = 40;
const TITLE_PREVIEW = 30;

export interface Ask {
  text: string;
  /** 应该查到的编号；undefined 是没写，空数组是「无」 */
  expected?: string[];
}

/** 提问文件：一行一个，行尾「=> K1 K3」或「=> 无」标上应该查到哪几条 */
export function parseAsks(text: string, warn: (text: string) => void = console.error): Ask[] {
  return cleanAsks(
    text.split(/\r?\n/).flatMap((line): Ask[] => {
      const [question, labels] = line.split("=>");
      if (!question.trim()) {
        return [];
      }
      if (labels === undefined) {
        return [{ text: question }];
      }
      const ids = labels.trim() === "无" ? [] : labels.split(/[\s,，、]+/).filter(Boolean).map(normalizeId);
      return [{ text: question, expected: ids }];
    }),
    warn,
  );
}

/** 各群记下的最近话题里的提问：话题的第一个问题和最近一次问的，新的在前。只读文件，坏了的跳过（不改名、不动它） */
export async function recentAsks(dir: string, warn: (text: string) => void = console.error): Promise<Ask[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const asks: { text: string; at: number }[] = [];
  for (const name of names.filter((one) => /^[\w-]+\.json$/.test(one))) {
    try {
      const threads = JSON.parse(await readFile(path.join(dir, name), "utf8")) as unknown;
      for (const thread of Array.isArray(threads) ? threads : []) {
        const { topic, question, at } = (thread ?? {}) as Record<string, unknown>;
        for (const text of [topic, question]) {
          if (typeof text === "string") {
            asks.push({ text, at: Number(at) || 0 });
          }
        }
      }
    } catch {
      warn(`跳过读不了的 ${name}`);
    }
  }
  return cleanAsks(asks.sort((a, b) => b.at - a.at).map(({ text }) => ({ text })), warn);
}

/** 去掉重复的、像有密钥的；手机号、身份证号打码；空白并成一个空格 */
export function cleanAsks(asks: readonly Ask[], warn: (text: string) => void = console.error): Ask[] {
  const seen = new Set<string>();
  let secrets = 0;
  const kept = asks.flatMap((ask): Ask[] => {
    if (containsSecret(ask.text)) {
      secrets++;
      return [];
    }
    const text = maskPersonal(ask.text).replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) {
      return [];
    }
    seen.add(text);
    return [{ ...ask, text }];
  });
  if (secrets > 0) {
    warn(`有 ${secrets} 个提问里像有密钥，跳过了`);
  }
  return kept;
}

/** 检索每个提问，返回要打印的几段：经验列表、几档门槛的统计、每个提问的前 3 名 */
export async function evaluate(base: Pick<KnowledgeBase, "explain" | "entries">, asks: readonly Ask[], source: string, model?: string): Promise<string[]> {
  const results: { ask: Ask; scores: KnowledgeScore[]; semantic: boolean }[] = [];
  for (const ask of asks) {
    results.push({ ask, ...(await base.explain(ask.text)) });
  }
  const entries = (await base.entries()).filter((entry) => entry.status === "active" && usable(entry));
  const semantic = results.length > 0 && results.every((result) => result.semantic);
  const out = [`经验库有效的 ${entries.length} 条：`, ...entries.map((entry) => `  ${entry.id} ${clip(entry.title, TITLE_PREVIEW)}`)];
  out.push(
    "",
    `提问 ${asks.length} 个（${source}）。` +
      (semantic ? `按意思检索用 ${model ?? "向量模型"}。` : `向量模型没用上（没配或者出错了），下面只是关键词分，门槛是 ${KEYWORD_MIN}。`),
  );

  if (semantic) {
    const labeled = results.some((result) => result.ask.expected !== undefined);
    out.push("", `门槛    有查到的提问   平均每问查到   ${labeled ? "查到的里对的   该查到的查到了" : ""}`.trimEnd());
    for (const threshold of THRESHOLDS) {
      let answered = 0;
      let found = 0;
      // 标了应该查到哪几条的提问：查到的里面对的几条、一共查到几条、应该查到几条
      let right = 0;
      let shown = 0;
      let expected = 0;
      for (const { ask, scores } of results) {
        const hits = pick(scores, threshold);
        answered += hits.length > 0 ? 1 : 0;
        found += hits.length;
        if (ask.expected !== undefined) {
          const ids = new Set(hits.map((score) => normalizeId(score.entry.id)));
          shown += ids.size;
          right += ask.expected.filter((id) => ids.has(id)).length;
          expected += ask.expected.length;
        }
      }
      out.push(
        `${threshold.toFixed(2)}    ${pad(`${answered}/${results.length}`, 13)}${pad((found / results.length).toFixed(1), 15)}` +
          (labeled ? `${pad(`${right}/${shown}`, 15)}${right}/${expected}` : "").trimEnd() +
          (threshold === SEMANTIC_MIN ? "  ←现在" : ""),
      );
    }
    const tops = results.flatMap((result) => (result.scores[0]?.semantic !== undefined ? [result.scores[0].semantic] : [])).sort((a, b) => a - b);
    if (tops.length > 0) {
      const at = (q: number) => tops[Math.min(tops.length - 1, Math.floor(q * tops.length))].toFixed(2);
      out.push("", `每个提问最像的那条的语义相似度：最低 ${tops[0].toFixed(2)}，四分之一 ${at(0.25)}，中位 ${at(0.5)}，四分之三 ${at(0.75)}，最高 ${tops.at(-1)!.toFixed(2)}`);
    }
  }

  out.push("", `每个提问的前 ${TOP} 名（${semantic ? "语义相似度，+n 是关键词命中几个" : "关键词分"}；✓ 是现在的门槛下会写进提示词的）：`);
  results.forEach(({ ask, scores }, i) => {
    const top = scores
      .slice(0, TOP)
      .map((score) => {
        const value = score.semantic !== undefined ? score.semantic.toFixed(2) + (score.markerHits > 0 ? `+${score.markerHits}` : "") : score.keyword.toFixed(2);
        return `${score.passes ? "✓" : " "}${score.entry.id} ${value}`;
      })
      .join("  ");
    const expected = ask.expected === undefined ? "" : `  应查到：${ask.expected.length > 0 ? ask.expected.join(" ") : "无"}`;
    out.push(`${pad(`${i + 1}.`, 4)}${top || "（经验库是空的）"}  ｜ ${clip(ask.text, QUESTION_PREVIEW)}${expected}`);
  });
  return out;
}

/** 按某档语义门槛（关键词命中够数的照样算），回答前检索会用上的那几条 */
function pick(scores: readonly KnowledgeScore[], threshold: number): KnowledgeScore[] {
  return scores.filter((score) => score.semantic !== undefined && (score.semantic >= threshold || score.markerHits >= MARKERS_ENOUGH)).slice(0, TOP);
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : text;
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(1, width - text.length));
}

async function main(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
  const config = loadConfig();
  if (!config.knowledge) {
    console.error("经验库没开（KNOWLEDGE=off），没什么可测的。");
    process.exit(1);
  }
  const file = process.argv[2];
  const asks = file ? parseAsks(await readFile(file, "utf8")) : await recentAsks(config.recentThreadsDir);
  if (asks.length === 0) {
    console.error(file ? "提问文件里没有提问。" : `${config.recentThreadsDir} 里还没有记下的提问，换成给一个提问文件。`);
    process.exit(1);
  }
  const client = new Client({ appId: config.feishu.appId, appSecret: config.feishu.appSecret, domain: config.feishu.domain, loggerLevel: LoggerLevel.error });
  const backend = new BitableKnowledgeBackend({
    api: createBitableApi(client),
    stateFile: config.knowledge.stateFile,
    ...(config.knowledge.bitable ? { target: config.knowledge.bitable } : {}),
    // 这里只读表格（list），不调整共享；名单照机器人的填
    share: { chatIds: [...config.feishu.allowedChatIds], editors: [...(config.feishu.writeAllowedUsers ?? [])] },
  });
  const model = config.knowledge.embeddingModel;
  const base = new KnowledgeBase(backend, {
    ...(model ? { embedder: createOpenAICompatibleEmbedder({ baseURL: config.llm.baseURL, apiKey: config.llm.apiKey, model }) } : {}),
    logger: { info() {}, warn: (...args: unknown[]) => console.error(...args), error: (...args: unknown[]) => console.error(...args) },
  });
  for (const line of await evaluate(base, asks, file ? "来自提问文件" : "来自各群最近的话题", model)) {
    console.log(line);
  }
  // 飞书、百炼的客户端会留着连接，等它们自己断开要好一会儿
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
