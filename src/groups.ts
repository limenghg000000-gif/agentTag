import type { Config, GroupConfig, McpScope } from "./config.js";
import type { GroupOverride, GroupSettings } from "./settings.js";

/**
 * 一个群现在用的配置：管理群的卡片上定了的项用卡片的，没定的看 .env 里这个群单独写了没有（GROUPS 加 GROUP_<名字>_…），再没有用全局的。
 * 回答、定时任务、经验库卡片、主动接话都按消息所在的群取一份，限制在程序里：工具只按这一份建，A 群拿不到 B 群的仓库和工具。
 * 卡片上改了以后下一次取就是新的，不用重启
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
  /** 不 @ 也主动接话（PROACTIVE_CHAT_IDS，或者管理群的卡片上打开的） */
  proactive: boolean;
}

type PolicyConfig = Pick<Config, "code" | "mcp" | "knowledge" | "groups"> & {
  feishu: Pick<Config["feishu"], "allowedChatIds" | "writeAllowedUsers" | "memoryEditors">;
  proactive: Pick<Config["proactive"], "chatIds">;
};

/** 管理群卡片上定的项从哪儿取（GroupSettings） */
export type CardSettings = Pick<GroupSettings, "override" | "chatIds">;

export class GroupPolicies {
  private readonly byChat: ReadonlyMap<string, GroupConfig>;
  private readonly global: Omit<GroupPolicy, "proactive">;
  private readonly live = new Set<string>();

  /** cards：管理群的卡片上给各群单独定的项（GroupSettings），没开管理群、也没存过时不传 */
  constructor(
    private readonly config: PolicyConfig,
    private readonly cards?: CardSettings,
  ) {
    this.byChat = new Map(config.groups.map((group) => [group.chatId, group]));
    this.global = {
      codeRepos: config.code?.repos ?? [],
      ...(config.feishu.writeAllowedUsers ? { writeAllowed: config.feishu.writeAllowedUsers } : {}),
      ...(config.feishu.memoryEditors ? { memoryEditors: config.feishu.memoryEditors } : {}),
      mcp: new Map(config.mcp.map((server) => [server.name, "*" as const])),
      knowledge: config.knowledge !== undefined,
    };
    this.refresh();
  }

  /**
   * 现在开通的群：服务器白名单（FEISHU_ALLOWED_CHAT_IDS）里的，去掉卡片上停用的，加上卡片上开通的。
   * 一直是同一个 Set：各处拿着它判断收不收这个群的消息，卡片上存了以后 refresh 一下马上生效
   */
  get allowed(): ReadonlySet<string> {
    return this.live;
  }

  /** 卡片上存了新设置以后调：按服务器白名单和卡片上的开通、停用重新算 allowed（原地改，拿着它的地方不用换） */
  refresh(): void {
    const next = new Set([...this.config.feishu.allowedChatIds].filter((chatId) => this.cards?.override(chatId)?.enabled !== false));
    for (const chatId of this.cards?.chatIds() ?? []) {
      if (this.cards?.override(chatId)?.enabled === true) {
        next.add(chatId);
      }
    }
    for (const chatId of this.live) {
      if (!next.has(chatId)) {
        this.live.delete(chatId);
      }
    }
    for (const chatId of next) {
      this.live.add(chatId);
    }
  }

  /** 这个群写在服务器白名单里（不看卡片上的开通、停用） */
  onServer(chatId: string): boolean {
    return this.config.feishu.allowedChatIds.has(chatId);
  }

  /**
   * 这个群的配置：卡片上定了的项盖过 .env 里的，.env 里单独配过的群逐项覆盖全局，没配过的就是全局那份。
   * card: false 只看服务器上的配置（卡片上显示「照服务器上的配置（现在：…）」用）。没开通的群不看卡片
   */
  of(chatId: string, { card = true }: { card?: boolean } = {}): GroupPolicy {
    const base = this.fromEnv(chatId);
    const override = card ? this.carded(chatId) : undefined;
    return override ? this.withCard(base, override) : base;
  }

  /** 卡片上把这个群换成 override 以后用的配置（卡片上核对改前改后用；空对象就是全照服务器上的配置） */
  preview(chatId: string, override: GroupOverride): GroupPolicy {
    const base = this.fromEnv(chatId);
    return Object.keys(override).length > 0 ? this.withCard(base, override) : base;
  }

  /** 卡片上给这个群单独定的项（没开通的群不算），没定过返回 undefined */
  carded(chatId: string): GroupOverride | undefined {
    return this.live.has(chatId) ? this.cards?.override(chatId) : undefined;
  }

  private fromEnv(chatId: string): GroupPolicy {
    const proactive = this.config.proactive.chatIds.has(chatId);
    const group = this.byChat.get(chatId);
    if (!group) {
      return { ...this.global, proactive };
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
      proactive,
    };
  }

  /**
   * 卡片上定的项盖上去。仓库照写（用的时候只认服务器上接入了的）；MCP 只认配置里有的服务，工具只能在全局开了的里挑；
   * 全局关着经验库时卡片上打开也不算
   */
  private withCard(base: GroupPolicy, card: GroupOverride): GroupPolicy {
    const { writeAllowed, memoryEditors, ...rest } = base;
    const writers = card.writeAllowed ? new Set(card.writeAllowed) : writeAllowed;
    const editors = card.memoryEditors ? new Set(card.memoryEditors) : memoryEditors;
    return {
      ...rest,
      codeRepos: card.codeRepos ?? base.codeRepos,
      ...(writers ? { writeAllowed: writers } : {}),
      ...(editors ? { memoryEditors: editors } : {}),
      mcp: card.mcp ? this.mcpWithCard(base.mcp, card.mcp) : base.mcp,
      knowledge: card.knowledge === undefined ? base.knowledge : this.global.knowledge && card.knowledge,
      proactive: card.proactive ?? base.proactive,
    };
  }

  private mcpWithCard(base: McpScope, card: NonNullable<GroupOverride["mcp"]>): McpScope {
    const scope = new Map(base);
    for (const [server, choice] of Object.entries(card)) {
      const global = this.config.mcp.find((item) => item.name === server)?.tools;
      if (global === undefined) {
        continue;
      }
      if (choice === "off") {
        scope.delete(server);
      } else if (choice === "all") {
        scope.set(server, "*");
      } else {
        scope.set(server, global === "*" ? [...choice] : choice.filter((tool) => global.includes(tool)));
      }
    }
    return scope;
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
    const chatIds = [...this.live].filter((chatId) => this.of(chatId).knowledge);
    const editors = new Set(chatIds.flatMap((chatId) => [...(this.of(chatId).writeAllowed ?? [])]));
    return { chatIds, editors: [...editors] };
  }

  /** 启动日志：.env 里单独配过的群用的是什么（没写的项写「同全局」），再加卡片上改过（包括开通、停用）的群各一行 */
  describe(): string[] {
    const carded = (this.cards?.chatIds() ?? []).flatMap((chatId) => {
      const card = this.cards?.override(chatId);
      if (!card) {
        return [];
      }
      const state = this.live.has(chatId) ? (card.enabled ? ["开通"] : []) : [card.enabled === false ? "停用" : "没开通"];
      return [`群 ${this.of(chatId).name ?? chatId}（${chatId}）在管理群的卡片上改过：${[...state, describeOverride(card)].filter(Boolean).join("；")}`];
    });
    return [...this.describeEnv(), ...carded];
  }

  private describeEnv(): string[] {
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

/** 卡片上改过的项（启动日志用，人名不写，写几个人） */
function describeOverride(card: GroupOverride): string {
  const people = (list: readonly string[]) => (list.length === 0 ? "没人" : `${list.length} 人`);
  return [
    ...(card.codeRepos ? [`仓库 ${card.codeRepos.length > 0 ? card.codeRepos.join(", ") : "不开"}`] : []),
    ...(card.writeAllowed ? [`写权限 ${people(card.writeAllowed)}`] : []),
    ...(card.memoryEditors ? [`改群记忆 ${people(card.memoryEditors)}`] : []),
    ...Object.entries(card.mcp ?? {}).map(
      ([server, choice]) => `MCP ${server} ${choice === "all" ? "全开" : choice === "off" ? "不开" : `${choice.length} 个工具`}`,
    ),
    ...(card.knowledge === undefined ? [] : [`经验库 ${card.knowledge ? "用" : "不用"}`]),
    ...(card.proactive === undefined ? [] : [`主动接话 ${card.proactive ? "开" : "关"}`]),
  ].join("；");
}

/** 仓库清单里的一项是不是 group/* 通配 */
export function isRepoPattern(entry: string): boolean {
  return entry.endsWith("/*");
}
