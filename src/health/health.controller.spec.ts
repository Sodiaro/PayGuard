import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { DatabaseHealthIndicator } from './database.health-indicator.js';
import { HealthController } from './health.controller.js';
import {
  QueueHealthIndicator,
  WorkerHealthIndicator,
} from './outbox.health-indicator.js';

type BacklogSnapshot = Awaited<ReturnType<OutboxStore['backlogSnapshot']>>;
type WorkerSnapshot = Awaited<ReturnType<OutboxStore['workerSnapshot']>>;

const HEALTHY_QUEUE: BacklogSnapshot = {
  oldestDueJobAgeSeconds: null,
  stalledLeases: 0,
  deadJobs: 0,
};
const ONE_WORKER: WorkerSnapshot = {
  activeWorkers: 1,
  lastHeartbeatAgeSeconds: 3,
  lastJobFinishedAgeSeconds: 5,
};

interface Fakes {
  database?: () => Promise<unknown>;
  queue?: () => Promise<BacklogSnapshot>;
  workers?: () => Promise<WorkerSnapshot>;
}

async function createController(fakes: Fakes = {}): Promise<HealthController> {
  const settings: Record<string, number> = {
    HEALTH_QUEUE_BACKLOG_SECONDS: 120,
    HEALTH_WORKER_TIMEOUT_SECONDS: 30,
  };
  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule.forRoot({ logger: false })],
    controllers: [HealthController],
    providers: [
      DatabaseHealthIndicator,
      QueueHealthIndicator,
      WorkerHealthIndicator,
      {
        provide: PrismaService,
        useValue: { $queryRaw: fakes.database ?? (() => Promise.resolve([1])) },
      },
      {
        provide: OutboxStore,
        useValue: {
          backlogSnapshot:
            fakes.queue ?? (() => Promise.resolve(HEALTHY_QUEUE)),
          workerSnapshot: fakes.workers ?? (() => Promise.resolve(ONE_WORKER)),
        },
      },
      {
        provide: ConfigService,
        useValue: { get: (key: string) => settings[key] },
      },
    ],
  }).compile();

  return moduleRef.get(HealthController);
}

function fakeResponse(): Response & { statusCode?: number } {
  const response = {
    status(code: number) {
      response.statusCode = code;
      return response;
    },
  } as Response & { statusCode?: number };
  return response;
}

describe('HealthController', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reports ready when the database, queue and workers are healthy', async () => {
    const controller = await createController();
    const response = fakeResponse();

    const result = await controller.ready(response);

    expect(result.status).toBe('ok');
    expect(result.details).toEqual({
      database: expect.objectContaining({ status: 'up' }),
      queue: { status: 'up' },
      workers: { status: 'up' },
    });
    expect(response.statusCode).toBeUndefined();
  });

  it('returns 503 with a generic reason when the database is down', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = await createController({
      database: () =>
        Promise.reject(
          new Error('password authentication failed for "payguard"'),
        ),
      queue: () => Promise.reject(new Error('connection refused')),
      workers: () => Promise.reject(new Error('connection refused')),
    });
    const response = fakeResponse();

    const result = await controller.ready(response);

    expect(response.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result.status).toBe('error');
    expect(result.details.database).toMatchObject({
      status: 'down',
      message: 'Database is unreachable',
    });
    expect(JSON.stringify(result)).not.toMatch(/password|refused/);
  });

  it.each([
    [{ ...HEALTHY_QUEUE, oldestDueJobAgeSeconds: 600 }, ['backlog']],
    [{ ...HEALTHY_QUEUE, stalledLeases: 2 }, ['stalled_jobs']],
    [
      { ...HEALTHY_QUEUE, deadJobs: 1, oldestDueJobAgeSeconds: 5 },
      ['dead_jobs'],
    ],
  ])(
    'stays ready but reports a degraded queue (%j)',
    async (snapshot, reasons) => {
      const controller = await createController({
        queue: () => Promise.resolve(snapshot),
      });
      const response = fakeResponse();

      const result = await controller.ready(response);

      expect(response.statusCode).toBeUndefined();
      expect(result.status).toBe('degraded');
      expect(result.details.queue).toEqual({ status: 'degraded', reasons });
    },
  );

  it('stays ready but reports when no worker has a recent heartbeat', async () => {
    const controller = await createController({
      workers: () =>
        Promise.resolve({
          ...ONE_WORKER,
          activeWorkers: 0,
          lastHeartbeatAgeSeconds: 900,
        }),
    });
    const response = fakeResponse();

    const result = await controller.ready(response);

    expect(response.statusCode).toBeUndefined();
    expect(result.status).toBe('degraded');
    expect(result.details.workers).toEqual({
      status: 'degraded',
      reasons: ['no_active_worker'],
    });
  });

  it('does not fail readiness when a background-processing query fails', async () => {
    const controller = await createController({
      queue: () => Promise.reject(new Error('query cancelled')),
      workers: () => Promise.reject(new Error('query cancelled')),
    });

    const result = await controller.ready(fakeResponse());

    expect(result.status).toBe('degraded');
    expect(result.details.queue).toEqual({
      status: 'degraded',
      reasons: ['unavailable'],
    });
    expect(result.details.workers).toEqual({
      status: 'degraded',
      reasons: ['unavailable'],
    });
  });

  it('reports live without touching the database or the queue', async () => {
    const database = jest.fn(() => Promise.resolve([1]));
    const queue = jest.fn(() => Promise.resolve(HEALTHY_QUEUE));
    const controller = await createController({ database, queue });

    const result = await controller.live(fakeResponse());

    expect(result.status).toBe('ok');
    expect(database).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });
});
