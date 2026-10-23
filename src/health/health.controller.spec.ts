import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { HttpStatus, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TerminusModule } from '@nestjs/terminus';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service.js';
import { DatabaseHealthIndicator } from './database.health-indicator.js';
import { HealthController } from './health.controller.js';

async function createController(
  queryRaw: () => Promise<unknown>,
): Promise<HealthController> {
  const moduleRef = await Test.createTestingModule({
    imports: [TerminusModule.forRoot({ logger: false })],
    controllers: [HealthController],
    providers: [
      DatabaseHealthIndicator,
      { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
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

  it('reports live without touching the database', async () => {
    const queryRaw = jest.fn(() => Promise.resolve([1]));
    const controller = await createController(queryRaw);

    const result = await controller.live(fakeResponse());

    expect(result.status).toBe('ok');
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
