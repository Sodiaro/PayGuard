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
import { DatabaseHealthIndicator } from './database.health-indicator.js';

@ApiTags('Health')
@Public()
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness: the API and its dependencies can serve traffic',
    description:
      'Returns 503 when a dependency (currently PostgreSQL) is unavailable.',
  })
  ready(
    @Res({ passthrough: true }) response: Response,
  ): Promise<HealthCheckResult> {
    return this.check(response, [() => this.database.pingCheck('database')]);
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
