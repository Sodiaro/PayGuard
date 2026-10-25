import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service.js';

export const KEY_USAGE_WINDOW_MS = 15 * 60_000;
const MAX_TRACKED_KEYS = 10_000;

// Records when an API key was last used, so operators can confirm a rotated-out key has gone quiet
// before revoking it. Writes are throttled twice: in memory, a key is written at most once per
// window per process; in the database, the update only applies when the stored value is older
// than the window, so instances that do not share memory still write at most once per window.
@Injectable()
export class KeyUsageTracker {
  private readonly logger = new Logger(KeyUsageTracker.name);
  private readonly recordedAt = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  // Never throws: usage tracking must not fail an otherwise valid request.
  async recordUse(apiKeyId: string): Promise<void> {
    const now = Date.now();
    const previous = this.recordedAt.get(apiKeyId);
    if (previous !== undefined && now - previous < KEY_USAGE_WINDOW_MS) return;
    this.remember(apiKeyId, now);

    try {
      await this.prisma.merchantApiKey.updateMany({
        where: {
          id: apiKeyId,
          OR: [
            { lastUsedAt: null },
            { lastUsedAt: { lt: new Date(now - KEY_USAGE_WINDOW_MS) } },
          ],
        },
        data: { lastUsedAt: new Date(now) },
      });
    } catch {
      this.recordedAt.delete(apiKeyId);
      this.logger.warn('Could not record API key usage', { apiKeyId });
    }
  }

  private remember(apiKeyId: string, at: number): void {
    if (this.recordedAt.size >= MAX_TRACKED_KEYS) this.recordedAt.clear();
    this.recordedAt.set(apiKeyId, at);
  }
}
