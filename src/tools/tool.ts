import type { ToolSpec } from "../llm.js";

export interface ToolContext {
  /** 用户停止任务时中止，工具里的网络请求等应随之取消 */
  signal: AbortSignal;
  /** 代码工具把这次结果里查到的代码位置交给它，机器人检查回答里的引用时用（见 CodeFact） */
  onFacts?: (facts: readonly CodeFact[]) => void;
}

/** 代码工具查到的一处代码位置：真实存在的文件（整理过的相对路径，可带查到的行，起止含），或者结果里写明的提交号、真实存在的分支名 */
export type CodeLocation = { path: string; lines?: [number, number] } | { commit: string } | { branch: string };

/**
 * 代码位置和它出自哪个仓库、在结果文字里结束的位置（at）。结果太长被截短时，at 在截断处以后的模型没看到，不算查到。
 * 由工具按它实际查到的记下，机器人检查回答里的引用时只认这些（见 src/bot.ts 的 codeEvidence），
 * 不从给模型看的文字里反解析：文字里的文件名、读到的代码正文都可能写得像别的路径和行号
 */
export type CodeFact = CodeLocation & { repo: string; at: number };

/** 带代码位置的工具结果：工具把 text 交给模型，facts 交给 ToolContext.onFacts */
export interface ToolOutput {
  /** 给模型看的文字 */
  text: string;
  facts: CodeFact[];
}

/** 工具执行失败，但查到了东西：比如文件在、只是太大读不了，路径是真的 */
export class ToolError extends Error {
  constructor(
    message: string,
    readonly facts: readonly CodeFact[] = [],
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** 一行一行拼代码工具的结果，同时记下每行里查到的代码位置 */
export class ToolOutputBuilder {
  private readonly lines: string[] = [];
  private readonly facts: CodeFact[] = [];
  private size = 0;

  constructor(private readonly repo: string) {}

  /** 加一行，locations 是这一行里查到的代码位置：这一行完整交给了模型才算 */
  line(text: string, ...locations: CodeLocation[]): this {
    const start = this.lines.length === 0 ? 0 : this.size + 1;
    this.lines.push(text);
    this.size = start + text.length;
    this.facts.push(...locations.map((location) => ({ ...location, repo: this.repo, at: this.size })));
    return this;
  }

  build(): ToolOutput {
    return { text: this.lines.join("\n"), facts: this.facts };
  }
}

/**
 * 机器人可调用的工具。内置工具和以后通过 MCP 接入的工具都实现这个接口。
 * run 返回给模型看的文本；参数不对或执行失败时直接抛错，错误信息会交给模型，由它决定重试还是换个办法。
 */
export interface Tool {
  spec: ToolSpec;
  /** 会改动文档、代码仓库等外部内容。配了 WRITE_ALLOWED_USERS 时，只有名单里的人提问才给模型这类工具 */
  writes?: boolean;
  /** 结果交给模型前的字数上限，不填用 MAX_TOOL_OUTPUT_CHARS。自己已经按字段截短的工具（如 MCP 工具）可以放宽 */
  maxOutputChars?: number;
  /** 进度卡片上显示的一句话，如「读取网页 example.com」 */
  describe(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
