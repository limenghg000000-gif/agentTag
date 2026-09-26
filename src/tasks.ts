import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export interface Task {
  readonly id: string;
  readonly chatId: string;
  readonly threadKey: string;
  readonly signal: AbortSignal;
  /** 创建时同一话题里是否已有任务在进行，是的话要排队 */
  readonly queued: boolean;
  /** 等同一话题里排在前面的任务都结束。返回 false 表示等的时候任务被停止了 */
  waitTurn(): Promise<boolean>;
}

interface Entry extends Task {
  controller: AbortController;
  /** 本任务结束 */
  done: () => void;
}

/**
 * 进行中的任务。同一话题里的任务排队依次执行，这样追问能看到上一个回答；不同话题互不影响。
 * 任务可以按 id（卡片上的停止按钮）或按话题（在话题里说「停止」）停止。
 */
export class TaskRegistry {
  private readonly tasks = new Map<string, Entry>();
  /** 每个话题最后一个任务「连同它前面的任务都结束」的 Promise */
  private readonly tails = new Map<string, Promise<void>>();

  create(chatId: string, threadKey: string): Task {
    const controller = new AbortController();
    const queued = this.tails.has(threadKey);
    const previous = this.tails.get(threadKey) ?? Promise.resolve();
    let done!: () => void;
    const own = new Promise<void>((resolve) => (done = resolve));
    // 排在后面的任务要等前面所有任务结束，即使本任务提前被停止也一样
    const tail = Promise.all([previous, own]).then(() => {
      if (this.tails.get(threadKey) === tail) {
        this.tails.delete(threadKey);
      }
    });
    this.tails.set(threadKey, tail);

    const entry: Entry = {
      id: randomUUID(),
      chatId,
      threadKey,
      controller,
      signal: controller.signal,
      queued,
      done,
      async waitTurn() {
        if (controller.signal.aborted) {
          return false;
        }
        const aborted = new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
        await Promise.race([previous, aborted]);
        return !controller.signal.aborted;
      },
    };
    this.tasks.set(entry.id, entry);
    return entry;
  }

  /** 任务结束（无论成功、失败还是被停止）后必须调用，放行同一话题里的下一个任务 */
  finish(task: Task): void {
    const entry = this.tasks.get(task.id);
    if (entry) {
      this.tasks.delete(task.id);
      entry.done();
    }
  }

  /** 停止一个任务。任务不存在（已经结束）或不在给定的群里时返回 false */
  stop(taskId: string, chatId?: string): boolean {
    const entry = this.tasks.get(taskId);
    if (!entry || entry.signal.aborted || (chatId !== undefined && entry.chatId !== chatId)) {
      return false;
    }
    entry.controller.abort();
    return true;
  }

  /** 停止某个话题里的所有任务，返回停止了几个 */
  stopThread(threadKey: string): number {
    return this.stopWhere((task) => task.threadKey === threadKey);
  }

  /** 停止某个群里的所有任务，返回停止了几个 */
  stopChat(chatId: string): number {
    return this.stopWhere((task) => task.chatId === chatId);
  }

  /** 停止所有任务（退出前用），返回停止了几个 */
  stopAll(): number {
    return this.stopWhere(() => true);
  }

  /** 等所有任务结束，最多等 timeoutMs 毫秒 */
  async idle(timeoutMs: number): Promise<void> {
    await Promise.race([Promise.all(this.tails.values()), sleep(timeoutMs, undefined, { ref: false })]);
  }

  get size(): number {
    return this.tasks.size;
  }

  private stopWhere(match: (task: Entry) => boolean): number {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (match(task) && this.stop(task.id)) {
        count++;
      }
    }
    return count;
  }
}
