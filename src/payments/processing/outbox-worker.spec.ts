import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type {
  ApiEnvironment,
  CoreEnvironment,
} from '../../config/environment.js';
import { OutboxJobType } from '../../generated/prisma/enums.js';
import type { ClaimedJob, OutboxStore } from '../../outbox/outbox-store.js';
import type { AttemptJobProcessor } from './attempt-job-processor.js';
import { InProcessWorkerStarter } from './in-process-worker.js';
import { OutboxWorker } from './outbox-worker.js';

const job: ClaimedJob = {
  id: 'job-1',
  type: OutboxJobType.PROCESS_ATTEMPT,
  paymentId: 'payment-1',
  attemptId: 'attempt-1',
  runCount: 1,
  leaseToken: 'lease-1',
  requestId: null,
  webhookEventId: null,
  reclaimed: false,
};

const config = {
  get: (key: keyof CoreEnvironment) =>
    ({ OUTBOX_POLL_INTERVAL_MS: 100, RECONCILIATION_DELAY_SECONDS: 60 })[
      key as 'OUTBOX_POLL_INTERVAL_MS'
    ],
} as unknown as ConfigService<CoreEnvironment, true>;

function fakeOutbox(claim: () => Promise<ClaimedJob[]>) {
  const heartbeats: { jobsFinished: number }[] = [];
  const stopped: string[] = [];
  const outbox = {
    claim,
    enqueueStaleReconciliations: () => Promise.resolve(0),
    recordWorkerHeartbeat: (
      _id: string,
      progress: { jobsFinished: number },
    ) => {
      heartbeats.push(progress);
      return Promise.resolve();
    },
    markWorkerStopped: (id: string) => {
      stopped.push(id);
      return Promise.resolve();
    },
  } as unknown as OutboxStore;
  return { outbox, heartbeats, stopped };
}

describe('OutboxWorker', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps polling after a failed poll, such as a lost database connection', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const handled: string[] = [];
    let polls = 0;
    let markThirdPoll!: () => void;
    const thirdPoll = new Promise<void>((resolve) => (markThirdPoll = resolve));
    const { outbox, heartbeats, stopped } = fakeOutbox(() => {
      polls += 1;
      if (polls === 1)
        return Promise.reject(new Error('connection terminated'));
      if (polls === 2) return Promise.resolve([job]);
      markThirdPoll();
      return Promise.resolve([]);
    });
    const processor = {
      handle: (claimed: ClaimedJob) => {
        handled.push(claimed.id);
        return Promise.resolve();
      },
    } as unknown as AttemptJobProcessor;
    const worker = new OutboxWorker(outbox, processor, config);

    worker.start();
    await thirdPoll;
    await worker.beforeApplicationShutdown();

    expect(handled).toEqual(['job-1']);
    expect(polls).toBe(3);
    expect(heartbeats[0]).toEqual({ jobsFinished: 0, lastJobFinishedAt: null });
    expect(stopped).toEqual([worker.workerId]);
    expect(worker.isRunning).toBe(false);
  });

  it('finishes the batch in flight before shutdown completes', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let finishJob!: () => void;
    let jobStarted!: () => void;
    const started = new Promise<void>((resolve) => (jobStarted = resolve));
    let claimed = false;
    const { outbox, stopped } = fakeOutbox(() => {
      if (claimed) return Promise.resolve([]);
      claimed = true;
      return Promise.resolve([job]);
    });
    const processor = {
      handle: () => {
        jobStarted();
        return new Promise<void>((resolve) => (finishJob = resolve));
      },
    } as unknown as AttemptJobProcessor;
    const worker = new OutboxWorker(outbox, processor, config);
    worker.start();
    await started;

    let isStopped = false;
    const stopping = worker.stop().then(() => (isStopped = true));
    await Promise.resolve();
    expect(isStopped).toBe(false);
    expect(stopped).toEqual([]);

    finishJob();
    await stopping;
    expect(isStopped).toBe(true);
    expect(stopped).toEqual([worker.workerId]);
  });

  it('counts finished jobs for the next heartbeat', async () => {
    const { outbox, heartbeats } = fakeOutbox(() =>
      Promise.resolve([job, job]),
    );
    const processor = {
      handle: () => Promise.resolve(),
    } as unknown as AttemptJobProcessor;
    const worker = new OutboxWorker(outbox, processor, config);

    await worker.processDueJobs();
    await worker.recordHeartbeat();

    expect(heartbeats).toEqual([
      { jobsFinished: 2, lastJobFinishedAt: expect.any(Date) },
    ]);
  });
});

describe('InProcessWorkerStarter', () => {
  const apiConfig = (enabled: boolean) =>
    ({
      get: () => enabled,
    }) as unknown as ConfigService<ApiEnvironment, true>;

  it.each([
    [true, 1],
    [false, 0],
  ])(
    'starts the worker only when OUTBOX_WORKER_ENABLED=%s',
    (enabled, starts) => {
      const start = jest.fn();
      const starter = new InProcessWorkerStarter(
        { start } as unknown as OutboxWorker,
        apiConfig(enabled),
      );

      starter.onApplicationBootstrap();

      expect(start).toHaveBeenCalledTimes(starts);
    },
  );
});
