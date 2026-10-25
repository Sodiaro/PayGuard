import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/environment.js';
import { OutboxJobType } from '../../generated/prisma/enums.js';
import type { ClaimedJob, OutboxStore } from '../../outbox/outbox-store.js';
import type { AttemptJobProcessor } from './attempt-job-processor.js';
import { OutboxWorker } from './outbox-worker.js';

const job: ClaimedJob = {
  id: 'job-1',
  type: OutboxJobType.PROCESS_ATTEMPT,
  paymentId: 'payment-1',
  attemptId: 'attempt-1',
  runCount: 1,
  leaseToken: 'lease-1',
  requestId: null,
  reclaimed: false,
};

function config(enabled: boolean): ConfigService<EnvironmentVariables, true> {
  const values: Partial<EnvironmentVariables> = {
    OUTBOX_WORKER_ENABLED: enabled,
    OUTBOX_POLL_INTERVAL_MS: 100,
    RECONCILIATION_DELAY_SECONDS: 60,
  };
  return {
    get: (key: keyof EnvironmentVariables) => values[key],
  } as unknown as ConfigService<EnvironmentVariables, true>;
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
    const outbox = {
      enqueueStaleReconciliations: () => Promise.resolve(0),
      claim: () => {
        polls += 1;
        if (polls === 1)
          return Promise.reject(new Error('connection terminated'));
        if (polls === 2) return Promise.resolve([job]);
        markThirdPoll();
        return Promise.resolve([]);
      },
    } as unknown as OutboxStore;
    const processor = {
      handle: (claimed: ClaimedJob) => {
        handled.push(claimed.id);
        return Promise.resolve();
      },
    } as unknown as AttemptJobProcessor;
    const worker = new OutboxWorker(outbox, processor, config(true));

    worker.onApplicationBootstrap();
    await thirdPoll;
    await worker.beforeApplicationShutdown();

    expect(handled).toEqual(['job-1']);
    expect(polls).toBe(3);
  });

  it('finishes the batch in flight before shutdown completes', async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    let finishJob!: () => void;
    let jobStarted!: () => void;
    const started = new Promise<void>((resolve) => (jobStarted = resolve));
    let claimed = false;
    const outbox = {
      enqueueStaleReconciliations: () => Promise.resolve(0),
      claim: () => {
        if (claimed) return Promise.resolve([]);
        claimed = true;
        return Promise.resolve([job]);
      },
    } as unknown as OutboxStore;
    const processor = {
      handle: () => {
        jobStarted();
        return new Promise<void>((resolve) => (finishJob = resolve));
      },
    } as unknown as AttemptJobProcessor;
    const worker = new OutboxWorker(outbox, processor, config(true));
    worker.start();
    await started;

    let stopped = false;
    const stopping = worker.stop().then(() => (stopped = true));
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishJob();
    await stopping;
    expect(stopped).toBe(true);
  });

  it('does not start when disabled', () => {
    const claim = jest.fn();
    const worker = new OutboxWorker(
      { claim } as unknown as OutboxStore,
      {} as AttemptJobProcessor,
      config(false),
    );

    worker.onApplicationBootstrap();

    expect(claim).not.toHaveBeenCalled();
  });
});
