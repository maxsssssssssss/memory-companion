export type BoundedSchedulerOptions = {
  concurrency: number;
};

export async function mapWithConcurrency<TInput, TOutput>(input: {
  items: TInput[];
  options: BoundedSchedulerOptions;
  worker: (item: TInput, index: number) => Promise<TOutput>;
}): Promise<TOutput[]> {
  if (!Number.isInteger(input.options.concurrency) || input.options.concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  const results = new Array<TOutput>(input.items.length);
  let nextIndex = 0;
  const runWorker = async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.items.length) {
        return;
      }
      results[index] = await input.worker(input.items[index], index);
    }
  };

  const workerCount = Math.min(input.options.concurrency, input.items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

export class ChunkAttemptTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`chunk attempt timed out after ${timeoutMs}ms`);
    this.name = "ChunkAttemptTimeoutError";
  }
}

export type ChunkAttemptResult<T> = {
  value: T;
  attempts: number;
  retryCount: number;
};

export async function runChunkAttempt<T>(input: {
  execute: (signal: AbortSignal, attempt: number) => Promise<T>;
  attemptTimeoutMs: number;
  maxRetries: number;
  retryDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}): Promise<ChunkAttemptResult<T>> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new ChunkAttemptTimeoutError(input.attemptTimeoutMs));
      }, input.attemptTimeoutMs);
    });

    try {
      const value = await Promise.race([input.execute(controller.signal, attempt), timeout]);
      return { value, attempts: attempt, retryCount: attempt - 1 };
    } catch (error) {
      const canRetry =
        attempt <= input.maxRetries && (input.shouldRetry ? input.shouldRetry(error) : true);
      if (!canRetry) {
        throw error;
      }
      if ((input.retryDelayMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, input.retryDelayMs));
      }
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
