/** 不认中止信号的操作（比如飞书 SDK 的请求）：中止或超时就不再等它。之后它再失败也有人接着，不会变成未处理的 Promise 拒绝（那会让进程退出） */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * 到时间就中止的信号，用完调 clear。不用 AbortSignal.timeout：它的计时器不拦着进程退出，测试里等不到超时
 */
export function timeoutSignal(ms: number): { signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`超过 ${ms}ms`, "TimeoutError")), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/** 合并几个中止信号，没传的跳过；一个都没有时返回 undefined */
export function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return present.length <= 1 ? present[0] : AbortSignal.any(present);
}

/** 是不是超时引起的中止 */
export function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}
