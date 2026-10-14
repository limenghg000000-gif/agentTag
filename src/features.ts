import { escapeCardMarkdown } from "./markdown.js";
import { ASK_ACTION } from "./progress.js";
import { actionQuestion } from "./rich-ui.js";

/**
 * 产品功能清单（FEATURES.md）：有人只问「你能做什么」「我想看看所有功能」时，不问模型，直接回一张功能卡片，
 * 每项点开看怎么用、怎么问，标了「试一试」的问法做成按钮（和回答下面的「接着查」一样，点了在话题里接着问，只查不改）。
 * 2026-10-14 测试群问「你能做什么」，模型按工具说了几类事，和产品功能说明对不上，还写了仓库路径这类技术词
 */

export interface FeatureExample {
  text: string;
  /** 卡片上做成「试一试」按钮 */
  tryable: boolean;
}

export interface Feature {
  name: string;
  /** 一句话说能做什么，卡片上收起时也看得到 */
  summary: string;
  /** 怎么用，一条一句 */
  how: string[];
  examples: FeatureExample[];
  /** 要用到的工具名或工具名的开头，有一个就显示；空的一直显示 */
  needs: string[];
}

export interface FeatureList {
  features: Feature[];
  /** 现在还做不了的 */
  limits: string[];
}

/** 清单里的「需要：看图」：机器人配了看图的模型 */
export const VISION_FEATURE = "看图";

const LIMITS_HEADING = "现在还做不了的";
const EXAMPLES_LABEL = /^这么问[:：]\s*$/;
const NEEDS_LABEL = /^需要[:：]\s*(.*)$/;
const EXAMPLE = /^- 「(.+)」\s*(〔试一试〕)?\s*$/;

/** 读 FEATURES.md：第一个 ## 之前是给维护的人看的说明，不要 */
export function parseFeatures(text: string): FeatureList {
  const list: FeatureList = { features: [], limits: [] };
  for (const part of text.split(/^(?=## )/m).filter((section) => section.startsWith("## "))) {
    const [heading = "", ...body] = part.split("\n");
    const name = heading.replace(/^##\s+/, "").trim();
    const lines = body.map((line) => line.trim()).filter((line) => line !== "");
    if (name === LIMITS_HEADING) {
      list.limits = lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2).trim());
      continue;
    }
    const feature: Feature = { name, summary: "", how: [], examples: [], needs: [] };
    let inExamples = false;
    for (const line of lines) {
      const needs = NEEDS_LABEL.exec(line);
      if (needs) {
        feature.needs = needs[1]!.split(/[、,，\s]+/).filter(Boolean);
      } else if (EXAMPLES_LABEL.test(line)) {
        inExamples = true;
      } else if (inExamples) {
        const example = EXAMPLE.exec(line);
        if (example) {
          feature.examples.push({ text: example[1]!.trim(), tryable: Boolean(example[2]) });
        }
      } else if (line.startsWith("- ")) {
        feature.how.push(line.slice(2).trim());
      } else if (!feature.summary) {
        feature.summary = line;
      }
    }
    if (name && feature.summary) {
      list.features.push(feature);
    }
  }
  return list;
}

/** 机器人配了的工具（toolNames 里可以是工具名，也可以是 aiops_ 这样的开头）用得上的那几项 */
export function availableFeatures(list: FeatureList, toolNames: readonly string[]): FeatureList {
  return {
    ...list,
    features: list.features.filter(
      (feature) => feature.needs.length === 0 || feature.needs.some((need) => toolNames.some((name) => name.startsWith(need) || need.startsWith(name))),
    ),
  };
}

const WHO = "(?:你|您|你们|机器人|飞书cli)?";
/** 只问能做什么的几种说法（整句，去掉标点、空格和句尾语气词以后）。带了别的事的不算，交给模型 */
const FEATURE_ASKS = [
  // 你能做什么、你会什么、你都能干啥、你可以帮我做哪些事、能干嘛
  new RegExp(`^${WHO}(?:都|还|到底|现在|平时|一般)?(?:能|会|可以)(?:帮(?:我|我们|大家|忙)?)?(?:做|干|干点|做点)?些?(?:什么|啥|哪些|嘛)(?:事|事情|活|活儿|工作)?$`),
  // 你有什么功能、有哪些功能、你都有啥本事
  new RegExp(`^${WHO}(?:都|还|现在)?有(?:什么|啥|哪些)(?:功能|本事|能力|用处|技能)$`),
  // 我想看看所有功能、看全部功能、功能列表、你的功能有哪些
  /^我?(?:想|要)?(?:看看|看一下|看下|看|查看|了解一下|了解|介绍一下|介绍下|列一下|列下)?(?:你的|你们的|机器人的)?(?:所有|全部|完整)?的?功能(?:说明|列表|清单|介绍|一览)?(?:有哪些|有什么|都有啥|有啥)?$/,
  // 怎么用你、你怎么用、如何使用
  new RegExp(`^(?:怎么|如何|咋)(?:用|使用)${WHO}$`),
  new RegExp(`^${WHO}(?:要|该)?(?:怎么|如何|咋)(?:用|使用)$`),
  /^介绍(?:一下|下)?(?:你|您)?自己$/,
  /^(?:帮助|help|使用说明|使用帮助|产品功能说明)$/,
];

export function asksForFeatures(question: string): boolean {
  const normalized = question
    .toLowerCase()
    .replace(/[\s，。,.？?！!~～、：:;；"'“”‘’（）()]/g, "")
    .replace(/^(?:请问|那么?|嗨|哈喽|hi|hello|你好|您好)+/, "")
    .replace(/(?:呢|呀|啊|吗|哈|啦|哇)+$/, "");
  return Array.from(normalized).length <= 20 && FEATURE_ASKS.some((ask) => ask.test(normalized));
}

export interface FeaturesCardOptions {
  botName?: string;
  /** 产品功能说明的链接（ANNOUNCE_LINK）：卡片最下面放一个按钮 */
  link?: string;
}

const PANEL_ICON = { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" };

function panel(title: string, elements: object[]): object {
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: { title: { tag: "markdown", content: title }, icon: PANEL_ICON, icon_position: "right", icon_expanded_angle: -180 },
    elements,
  };
}

function tryButton(question: string): object {
  return {
    tag: "button",
    text: { tag: "plain_text", content: `试一试：${question}` },
    type: "default",
    size: "small",
    width: "fill",
    behaviors: [{ type: "callback", value: { action: ASK_ACTION, q: question } }],
  };
}

function intro(name: string): string {
  return `在群里 @${name} 提问，回答写在你那条消息的话题里，不刷群。`;
}

/** 功能卡片（JSON 2.0）：每项一个默认收起的面板，点开是怎么用、怎么问和「试一试」按钮 */
export function renderFeaturesCard(list: FeatureList, options: FeaturesCardOptions = {}): object {
  const name = escapeCardMarkdown(options.botName || "机器人");
  const title = `${options.botName || "机器人"} 能帮你做什么`;
  const grey = (text: string) => `<font color='grey'>${text}</font>`;
  const tries = list.features.some((feature) => feature.examples.some((example) => example.tryable));
  const elements: object[] = [
    {
      tag: "markdown",
      content: `${intro(name)}点开每一项看怎么用、怎么问${tries ? "；点「试一试」，我就在这个话题里接着查（只查不改）" : ""}。`,
    },
  ];
  list.features.forEach((feature, i) => {
    const how = feature.how.map((line) => `- ${escapeCardMarkdown(line)}`);
    const examples = feature.examples.map((example) => `- 「${escapeCardMarkdown(example.text)}」`);
    const body = [...how, ...(examples.length > 0 ? [`**这么问**`, ...examples] : [])].join("\n");
    const buttons = feature.examples
      .filter((example) => example.tryable)
      .map((example) => actionQuestion(example.text))
      .filter((question): question is string => question !== undefined)
      .map(tryButton);
    const number = String(i + 1).padStart(2, "0");
    elements.push(
      panel(`**${number}　${escapeCardMarkdown(feature.name)}**　${grey(escapeCardMarkdown(feature.summary))}`, [
        ...(body ? [{ tag: "markdown", content: body }] : []),
        ...buttons,
      ]),
    );
  });
  if (list.limits.length > 0) {
    elements.push(panel(grey(LIMITS_HEADING), [{ tag: "markdown", content: list.limits.map((line) => `- ${escapeCardMarkdown(line)}`).join("\n") }]));
  }
  if (options.link) {
    elements.push(
      { tag: "markdown", content: grey("每一项的详细用法、提问模板和常见问题，见产品功能说明。") },
      {
        tag: "button",
        text: { tag: "plain_text", content: "产品功能说明" },
        type: "primary",
        size: "small",
        behaviors: [{ type: "open_url", default_url: options.link }],
      },
    );
  }
  return {
    schema: "2.0",
    config: { width_mode: "fill", summary: { content: title } },
    header: { title: { tag: "plain_text", content: title }, template: "blue" },
    body: { elements },
  };
}

/**
 * 文字版：卡片发不出去时发它；也记进话题历史（飞书读不出卡片里的字），话题里接着问「第 4 个怎么用」时模型看得到。
 * 尖括号换成全角：Markdown 里的 <at id=all></at> 也会 @所有人
 */
export function renderFeaturesMarkdown(list: FeatureList, options: FeaturesCardOptions = {}): string {
  const name = options.botName || "机器人";
  const lines = [`**${name} 能帮你做什么**`, intro(name), ""];
  list.features.forEach((feature, i) => {
    const example = feature.examples[0];
    lines.push(`${i + 1}. **${feature.name}**：${feature.summary}${example ? `例：「${example.text}」` : ""}`);
  });
  if (list.limits.length > 0) {
    lines.push("", `${LIMITS_HEADING}：${list.limits.join("；")}`);
  }
  if (options.link) {
    lines.push("", `每一项的详细用法见产品功能说明：${options.link}`);
  }
  return lines.join("\n").replace(/</g, "＜").replace(/>/g, "＞");
}

/** 写进提示词的功能清单：每项一行，功能名、一句话、一个例子 */
export function featurePromptLines(list: FeatureList): string[] {
  return list.features.map((feature) => {
    const example = feature.examples[0];
    return `- **${feature.name}**：${feature.summary}${example ? `例：「${example.text}」` : ""}`;
  });
}
