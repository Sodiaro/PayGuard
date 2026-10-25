import {
  Controller,
  Get,
  HttpStatus,
  Res,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  type HealthIndicatorFunction,
} from '@nestjs/terminus';
import type { Response } from 'express';
import { Public } from '../auth/auth.decorators.js';
import { SkipRateLimit } from '../common/rate-limit/rate-limit.guards.js';
import { DatabaseHealthIndicator } from './database.health-indicator.js';
import { OutboxHealthIndicator } from './outbox.health-indicator.js';

@ApiTags('Health')
@Public()
@SkipRateLimit()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly outbox: OutboxHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness: the API and its dependencies can serve traffic',
    description:
      'Returns 503 when PostgreSQL is unavailable. Background processing problems (backlog, stalled ' +
      'or dead outbox jobs) report status "degraded" with HTTP 200.',
  })
  ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthCheckResult> {
    return this.check(response, [
      () => this.database.pingCheck('database'),
      () => this.outbox.check('outbox'),
    ]);
  }

  @Get('live')
  @HealthCheck()
  @ApiOperation({
    summary: 'Liveness: the process is running and serving HTTP',
    description:
      'Does not check dependencies, so a database outage never causes restarts.',
  })
  live(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthCheckResult> {
    return this.check(response, []);
  }

  private async check(
    response: Response,
    indicators: HealthIndicatorFunction[],
  ): Promise<HealthCheckResult> {
    try {
      return await this.health.check(indicators);
    } catch (error) {
      // Keep Terminus's per-dependency result for monitoring instead of letting
      // the global filter collapse it into the generic error envelope.
      if (error instanceof ServiceUnavailableException) {
        response.status(HttpStatus.SERVICE_UNAVAILABLE);
        return error.getResponse() as HealthCheckResult;
      }
      throw error;
    }
  }
}
