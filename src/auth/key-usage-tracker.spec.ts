import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../database/prisma.service.js';
import { KEY_USAGE_WINDOW_MS, KeyUsageTracker } from './key-usage-tracker.js';

function setup(updateMany: () => Promise<unknown>) {
  const update = jest.fn<(args: unknown) => Promise<unknown>>(() =>
    updateMany(),
  );
  const prisma = {
    merchantApiKey: { updateMany: update },
  } as unknown as PrismaService;
  return { tracker: new KeyUsageTracker(prisma), update };
}

describe('KeyUsageTracker', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('writes at most once per key per window', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-25T10:00:00Z') });
    const { tracker, update } = setup(() => Promise.resolve({ count: 1 }));

    await tracker.recordUse('key-1');
    await tracker.recordUse('key-1');
    await tracker.recordUse('key-2');
    expect(update).toHaveBeenCalledTimes(2);

    jest.setSystemTime(Date.now() + KEY_USAGE_WINDOW_MS);
    await tracker.recordUse('key-1');
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('only overwrites values older than the window, so instances do not stack writes', async () => {
    const { tracker, update } = setup(() => Promise.resolve({ count: 0 }));

    await tracker.recordUse('key-1');

    expect(update).toHaveBeenCalledWith({
      where: {
        id: 'key-1',
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: expect.any(Date) } }],
      },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it('never fails the request, and retries on the next use after an error', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    let fail = true;
    const { tracker, update } = setup(() =>
      fail
        ? Promise.reject(new Error('connection lost'))
        : Promise.resolve({ count: 1 }),
    );

    await expect(tracker.recordUse('key-1')).resolves.toBeUndefined();
    fail = false;
    await tracker.recordUse('key-1');

    expect(update).toHaveBeenCalledTimes(2);
  });
});
