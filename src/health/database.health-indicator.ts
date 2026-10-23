import { Injectable, Logger } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { PrismaService } from '../database/prisma.service.js';

const PING_TIMEOUT_MS = 1000;

// Terminus's PrismaHealthIndicator probes with $runCommandRaw, which Prisma 7's PostgreSQL client lacks.
@Injectable()
export class DatabaseHealthIndicator {
  private readonly logger = new Logger(DatabaseHealthIndicator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async pingCheck(key: string): Promise<HealthIndicatorResult> {
    return await this.healthIndicatorService
      .check(key)
      .attempt(async () => {
        try {
          await this.prisma.$queryRaw`SELECT 1`;
        } catch (error) {
          // Terminus copies error.message into the public response, and driver
          // errors can name hosts and users; keep the detail in the server log.
          this.logger.error(
            'Database ping failed',
            error instanceof Error ? error.stack : String(error),
          );
          throw new Error('Database is unreachable', { cause: error });
        }
      })
      .withTimeout(PING_TIMEOUT_MS);
  }
}
