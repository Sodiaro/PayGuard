import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { HttpStatus, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import { OutboxStore } from '../outbox/outbox-store.js';
import { DatabaseHealthIndicator } from './database.health-indicator.js';
import { HealthController } from './health.controller.js';
import { OutboxHealthIndicator } from './outbox.health-indicator.js';

type BacklogSnapshot = Awaited<ReturnType<OutboxStore['backlogSnapshot']>>;

const HEALTHY_OUTBOX: BacklogSnapshot = {
  oldestDueJobAgeSeconds: null,
  stalledLeases: 0,
  deadJobs: 0,
};

async function createController(
  queryRaw: () => Promise<unknown>,
  outbox: () => Promise<BacklogSnapshot> = () =>
    Promise.resolve(HEALTHY_OUTBOX),
): Promise<HealthController> {
  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule.forRoot({ logger: false })],
    controllers: [HealthController],
    providers: [
      DatabaseHealthIndicator,
      OutboxHealthIndicator,
      { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
      { provide: OutboxStore, useValue: { backlogSnapshot: outbox } },
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

  it('reports ready when the database answers', async () => {
    const controller = await createController(() => Promise.resolve([1]));
    const response = fakeResponse();

    const result = await controller.ready(response);

    expect(result.status).toBe('ok');
    expect(result.details.database?.status).toBe('up');
    expect(response.statusCode).toBeUndefined();
  });

  it('returns 503 with a generic reason when the database is down', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controller = await createController(() =>
      Promise.reject(
        new Error('password authentication failed for "payguard"'),
      ),
    );
    const response = fakeResponse();

    const result = await controller.ready(response);

    expect(response.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(result.status).toBe('error');
    expect(result.details.database).toMatchObject({
      status: 'down',
      message: 'Database is unreachable',
    });
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it.each([
    [{ ...HEALTHY_OUTBOX, oldestDueJobAgeSeconds: 600 }, ['backlog']],
    [{ ...HEALTHY_OUTBOX, stalledLeases: 2 }, ['stalled_jobs']],
    [
      { ...HEALTHY_OUTBOX, deadJobs: 1, oldestDueJobAgeSeconds: 5 },
      ['dead_jobs'],
    ],
  ])(
    'stays ready but reports degraded background processing (%j)',
    async (snapshot, reasons) => {
      const controller = await createController(
        () => Promise.resolve([1]),
        () => Promise.resolve(snapshot),
      );
      const response = fakeResponse();

      const result = await controller.ready(response);

      expect(response.statusCode).toBeUndefined();
      expect(result.status).toBe('degraded');
      expect(result.details.outbox).toEqual({ status: 'degraded', reasons });
    },
  );

  it('does not fail readiness when the outbox snapshot itself fails', async () => {
    const controller = await createController(
      () => Promise.resolve([1]),
      () => Promise.reject(new Error('query cancelled')),
    );

    const result = await controller.ready(fakeResponse());

    expect(result.status).toBe('degraded');
    expect(result.details.outbox).toEqual({
      status: 'degraded',
      reasons: ['unavailable'],
    });
  });

  it('reports live without touching the database', async () => {
    const queryRaw = jest.fn(() => Promise.resolve([1]));
    const controller = await createController(queryRaw);

    const result = await controller.live(fakeResponse());

    expect(result.status).toBe('ok');
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
