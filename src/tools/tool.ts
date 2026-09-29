import type { ToolSpec } from "../llm.js";

export interface ToolContext {
  /** 用户停止任务时中止，工具里的网络请求等应随之取消 */
  signal: AbortSignal;
}

/**
 * 机器人可调用的工具。内置工具和以后通过 MCP 接入的工具都实现这个接口。
 * run 返回给模型看的文本；参数不对或执行失败时直接抛错，错误信息会交给模型，由它决定重试还是换个办法。
 */
export interface Tool {
  spec: ToolSpec;
  /** 会改动文档、代码仓库等外部内容。配了 WRITE_ALLOWED_USERS 时，只有名单里的人提问才给模型这类工具 */
  writes?: boolean;
  /** 进度卡片上显示的一句话，如「读取网页 example.com」 */
  describe(args: Record<string, unknown>): string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
