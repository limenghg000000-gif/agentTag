import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** 同一个文件的读写排队，避免两次写入互相覆盖 */
export class FileQueue {
  private readonly queues = new Map<string, Promise<unknown>>();

  run<T>(file: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(file) ?? Promise.resolve()).catch(() => {}).then(task);
    this.queues.set(file, next);
    const clear = () => {
      if (this.queues.get(file) === next) {
        this.queues.delete(file);
      }
    };
    next.then(clear, clear);
    return next;
  }
}

/** 先写临时文件再改名，写到一半断电也不会留下半个文件 */
export async function writeAtomically(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, content, "utf8");
  await rename(temp, file);
}
