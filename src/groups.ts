import type { Config, GroupConfig, McpScope } from "./config.js";

/**
 * 一个群现在用的配置：群里单独写了的项（GROUPS 加 GROUP_<名字>_…）用群里的，没写的用全局的。
 * 回答、定时任务、经验库卡片、主动接话都按消息所在的群取一份，限制在程序里：工具只按这一份建，A 群拿不到 B 群的仓库和工具
 */
export interface GroupPolicy {
  /** GROUPS 里给群起的名字；没单独配的群没有 */
  name?: string;
  /** 能操作的仓库（写法和 CODE_REPOS 一样，可能有 group/* 通配）；没有代码工具时为空 */
  codeRepos: readonly string[];
  /** 写权限名单：只有名单里的人能让机器人改文档、改代码、点经验库的「保存」。不传时群里所有人都能改（经验库没人能存） */
  writeAllowed?: ReadonlySet<string>;
  /** 能让机器人记、改、删群记忆的人。不传时所有人都能 */
  memoryEditors?: ReadonlySet<string>;
  /** 能用的 MCP 服务和工具；空的是这个群没有 MCP 工具 */
  mcp: McpScope;
  /** 回答前查团队经验库、给经验库的工具 */
  knowledge: boolean;
}

type PolicyConfig = Pick<Config, "code" | "mcp" | "knowledge" | "groups"> & {
  feishu: Pick<Config["feishu"], "allowedChatIds" | "writeAllowedUsers" | "memoryEditors">;
};

export class GroupPolicies {
  private readonly byChat: ReadonlyMap<string, GroupConfig>;
  private readonly global: GroupPolicy;

  constructor(private readonly config: PolicyConfig) {
    this.byChat = new Map(config.groups.map((group) => [group.chatId, group]));
    this.global = {
      codeRepos: config.code?.repos ?? [],
      ...(config.feishu.writeAllowedUsers ? { writeAllowed: config.feishu.writeAllowedUsers } : {}),
      ...(config.feishu.memoryEditors ? { memoryEditors: config.feishu.memoryEditors } : {}),
      mcp: new Map(config.mcp.map((server) => [server.name, "*" as const])),
      knowledge: config.knowledge !== undefined,
    };
  }

  /** 这个群的配置：单独配过的群逐项覆盖全局，没配过的就是全局那份 */
  of(chatId: string): GroupPolicy {
    const group = this.byChat.get(chatId);
    if (!group) {
      return this.global;
    }
    const writeAllowed = group.writeAllowedUsers ?? this.global.writeAllowed;
    const memoryEditors = group.memoryEditors ?? this.global.memoryEditors;
    return {
      name: group.name,
      codeRepos: group.codeRepos ?? this.global.codeRepos,
      ...(writeAllowed ? { writeAllowed } : {}),
      ...(memoryEditors ? { memoryEditors } : {}),
      mcp: group.mcp ?? this.global.mcp,
      knowledge: this.global.knowledge && group.knowledge !== false,
    };
  }

  /**
   * 这个群能用 aiops 经验库（回答前查、同步排查经验、归档 aiops 里的经验）：程序替这个群调的 aiops 读工具，这个群都要开着。
   * 要有 search_knowledge；全局开给模型的 get_knowledge 这个群收窄掉了的也不用（程序归档前、同步时会取经验详情）
   */
  usesAiopsLessons(chatId: string, server = "aiops"): boolean {
    const tools = this.of(chatId).mcp.get(server);
    if (tools === undefined || tools === "*") {
      return tools === "*";
    }
    const global = this.config.mcp.find((item) => item.name === server)?.tools ?? [];
    return tools.includes("search_knowledge") && (tools.includes("get_knowledge") || (global !== "*" && !global.includes("get_knowledge")));
  }

  /** 全局和各群写到的所有仓库（不分大小写去重，保留第一次的写法）：代码工作目录、启动时检查令牌用 */
  repoEntries(): string[] {
    const all = [...this.global.codeRepos, ...this.config.groups.flatMap((group) => group.codeRepos ?? [])];
    return all.filter((repo, i) => all.findIndex((other) => other.toLowerCase() === repo.toLowerCase()) === i);
  }

  /**
   * 机器人自己建的经验库表格共享给谁：用经验库的白名单群（只读），和这些群里能点「保存」的人（能管理表格，等于确认过）。
   * 关掉经验库的群不共享：表格里是别的群的排查经验
   */
  knowledgeShare(): { chatIds: string[]; editors: string[] } {
    const chatIds = [...this.config.feishu.allowedChatIds].filter((chatId) => this.of(chatId).knowledge);
    const editors = new Set(chatIds.flatMap((chatId) => [...(this.of(chatId).writeAllowed ?? [])]));
    return { chatIds, editors: [...editors] };
  }

  /** 启动日志：每个单独配过的群用的是什么（没写的项写「同全局」） */
  describe(): string[] {
    return this.config.groups.map((group) => {
      const policy = this.of(group.chatId);
      const people = (set: ReadonlySet<string> | undefined, fallback: string) =>
        set === undefined ? fallback : set.size === 0 ? "没人" : `${set.size} 人`;
      const mcp = [...policy.mcp].map(([server, tools]) => (tools === "*" ? server : `${server}（${tools.length} 个工具）`));
      return (
        `群 ${group.name}（${group.chatId}）单独配置：` +
        [
          `仓库 ${group.codeRepos === undefined ? "同全局" : policy.codeRepos.length > 0 ? policy.codeRepos.join(", ") : "不开"}`,
          `写权限 ${group.writeAllowedUsers === undefined ? "同全局" : people(policy.writeAllowed, "所有人")}`,
          `改群记忆 ${group.memoryEditors === undefined ? "同全局" : people(policy.memoryEditors, "所有人")}`,
          `MCP ${group.mcp === undefined ? "同全局" : mcp.length > 0 ? mcp.join(", ") : "不开"}`,
          `经验库 ${group.knowledge === undefined ? "同全局" : policy.knowledge ? "开" : "不用"}`,
        ].join("；")
      );
    });
  }
}

/** 仓库清单里的一项是不是 group/* 通配 */
export function isRepoPattern(entry: string): boolean {
  return entry.endsWith("/*");
}
