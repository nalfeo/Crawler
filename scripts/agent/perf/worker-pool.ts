import { Worker, type WorkerOptions } from 'node:worker_threads';

export interface WorkerPoolTaskPayload<TTask, TShared> {
  taskIndex: number;
  task: TTask;
  shared: TShared;
}

export interface WorkerTaskSuccess<TResult> {
  taskIndex: number;
  result: TResult;
}

export interface WorkerTaskFailure {
  taskIndex: number;
  error: string;
}

interface WorkerPoolOptions<TTask, TShared> {
  workerUrl: URL;
  tasks: readonly TTask[];
  shared: TShared;
  maxWorkers: number;
  workerOptions?: Omit<WorkerOptions, 'workerData'>;
}

/** Use tsx's worker hook only for the source .ts execution path. */
export function workerOptionsForModule(moduleUrl: string | URL): Omit<WorkerOptions, 'workerData'> {
  const url = moduleUrl instanceof URL ? moduleUrl : new URL(moduleUrl);
  if (/\.bundle-[0-9a-f]+\.mjs$/.test(url.pathname)) {
    return {};
  }
  return {
    execArgv: [...process.execArgv, '--import', new URL('./tsx-worker-hooks.mjs', url).href],
  };
}

export async function runWorkerPool<TTask, TShared, TResult>({
  workerUrl,
  tasks,
  shared,
  maxWorkers,
  workerOptions,
}: WorkerPoolOptions<TTask, TShared>): Promise<TResult[]> {
  if (tasks.length === 0) {
    return [];
  }
  const concurrency = Math.max(1, Math.min(maxWorkers, tasks.length));
  const results = new Array<TResult>(tasks.length);
  let nextTaskIndex = 0;
  let inFlight = 0;
  let completed = 0;
  let settled = false;

  return await new Promise<TResult[]>((resolve, reject) => {
    const fail = (message: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(message));
    };

    const maybeDone = (): void => {
      if (!settled && completed === tasks.length && inFlight === 0) {
        settled = true;
        resolve(results);
      }
    };

    const launch = (): void => {
      while (!settled && inFlight < concurrency && nextTaskIndex < tasks.length) {
        const taskIndex = nextTaskIndex;
        const task = tasks[taskIndex];
        nextTaskIndex += 1;
        inFlight += 1;

        const worker = new Worker(workerUrl, {
          ...workerOptions,
          workerData: { taskIndex, task, shared } as WorkerPoolTaskPayload<TTask, TShared>,
        });

        let finished = false;
        const finish = (): void => {
          if (finished) {
            return;
          }
          finished = true;
          inFlight -= 1;
          launch();
          maybeDone();
        };

        worker.once('message', (message: WorkerTaskSuccess<TResult> | WorkerTaskFailure) => {
          if ('error' in message) {
            fail(`Worker task ${message.taskIndex} failed: ${message.error}`);
            finish();
            return;
          }
          results[message.taskIndex] = message.result;
          completed += 1;
          finish();
        });

        worker.once('error', (error) => {
          fail(
            `Worker task ${taskIndex} crashed: ${error instanceof Error ? error.message : String(error)}`,
          );
          finish();
        });

        worker.once('exit', (code) => {
          if (code !== 0) {
            fail(`Worker task ${taskIndex} exited with code ${code}`);
            return;
          }
          if (!finished) {
            fail(`Worker task ${taskIndex} exited before posting a result`);
          }
        });
      }
    };

    launch();
  });
}
