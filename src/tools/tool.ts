import type { ToolSpec } from "../llm.js";

export interface ToolContext {
  /** 用户停止任务时中止，工具里的网络请求等应随之取消 */
  signal: AbortSignal;
  /** 代码工具把这次结果里查到的代码位置交给它，机器人检查回答里的引用时用（见 CodeFact） */
  onFacts?: (facts: readonly CodeFact[]) => void;
  /** 这次任务能不能改：有改文档、改代码的工具（不在写权限名单里、带着群聊只给读的就没有），而且发起人这句话本身说了要改。建定时任务时记下来，到点跑的时候不会比建的时候权限大 */
  writable?: boolean;
  /** 发起人这句话本身（不含话题上文、群聊）：建定时任务时核对要追加的文档链接是不是他自己贴的 */
  question?: string;
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

/** 结果里的一段文字，和写在这段里的代码位置 */
export type Piece = string | readonly [string, ...CodeLocation[]];

/** 一行一行拼代码工具的结果，同时记下每行里查到的代码位置 */
export class ToolOutputBuilder {
  private readonly lines: string[] = [];
  private readonly facts: CodeFact[] = [];
  private size = 0;

  constructor(private readonly repo: string) {}

  /** 加一行，locations 是这一行里查到的代码位置：这一行完整交给了模型才算 */
  line(text: string, ...locations: CodeLocation[]): this {
    return this.parts([text, ...locations]);
  }

  /**
   * 加一行，由几段拼成。[文字, ...代码位置] 这一段交给了模型，里面的代码位置就算，不用等这一行后面的部分：
   * 搜索结果「src/a.ts:12:很长的一行代码」截断在代码里时，src/a.ts:12 模型是看到了的
   */
  parts(...pieces: Piece[]): this {
    const start = this.lines.length === 0 ? 0 : this.size + 1;
    let text = "";
    for (const piece of pieces) {
      const [part, ...locations] = typeof piece === "string" ? [piece] : piece;
      text += part;
      this.facts.push(...locations.map((location) => ({ ...location, repo: this.repo, at: start + text.length })));
    }
    this.lines.push(text);
    this.size = start + text.length;
    return this;
  }

  build(): ToolOutput {
    return { text: this.lines.join("\n"), facts: this.facts };
  }
}

/** 改东西之前请发起人确认时，卡片上写的要做什么（见 src/confirm.ts） */
export interface ConfirmPreview {
  /** 一句话说做什么，写在卡片标题里，如「推代码、开合并请求」 */
  title: string;
  /** 具体做什么，一行一条：哪个仓库、开到哪个分支、改了哪些文件。卡片上照字面显示 */
  lines: string[];
  /** 点了确认、真做之前再核对一遍：要做的和卡片上写的不一样了（同一轮里又改了代码）返回 false，这次不做 */
  unchanged?: () => Promise<boolean>;
}

/**
 * 机器人可调用的工具。内置工具和以后通过 MCP 接入的工具都实现这个接口。
 * run 返回给模型看的文本；参数不对或执行失败时直接抛错，错误信息会交给模型，由它决定重试还是换个办法。
 */
export interface Tool {
  spec: ToolSpec;
  /** 会改动文档、代码仓库等外部内容。配了 WRITE_ALLOWED_USERS 时，只有名单里的人提问才给模型这类工具 */
  writes?: boolean;
  /**
   * 改东西之前先发卡片请发起人点「确认」（CONFIRM_WRITES，writes 的工具都要）：返回卡片上写的要做什么；这次其实不改什么（已经合并过了）返回 undefined，不发卡片。
   * 参数不对、做不成（要改的东西找不到、机器人不能合）时直接抛错，不发卡片。
   * false 表示不用确认：只改机器人自己的工作目录（还没推出去）、新建文档。不填时卡片上写 describe 和参数
   */
  confirm?: false | ((args: Record<string, unknown>, ctx: ToolContext) => Promise<ConfirmPreview | undefined>);
  /** 结果交给模型前的字数上限，不填用 MAX_TOOL_OUTPUT_CHARS。自己已经按字段截短的工具（如 MCP 工具）可以放宽 */
  maxOutputChars?: number;
  /** 不是这次查到的数据（如 MCP 服务端下发的排查剧本、之前话题里的回答）：调过不算查过，读到的内容也不算回答的证据 */
  instructionsOnly?: boolean;
  /** 进度卡片上显示的一句话，如「读取网页 example.com」 */
  describe(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
