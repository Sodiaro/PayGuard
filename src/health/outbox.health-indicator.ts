import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import type { ApiEnvironment } from '../config/environment.js';
import { OutboxStore } from '../outbox/outbox-store.js';

// Both indicators report `degraded` (HTTP stays 200) rather than `down`: background processing
// needing attention is not a reason to stop routing API traffic to this instance. Public responses
// carry reason codes only; `ops:status` in the operator CLI has the numbers.
@Injectable()
export class QueueHealthIndicator {
  private readonly backlogSeconds: number;

  constructor(
    private readonly outbox: OutboxStore,
    private readonly healthIndicatorService: HealthIndicatorService,
    config: ConfigService<ApiEnvironment, true>,
  ) {
    this.backlogSeconds = config.get('HEALTH_QUEUE_BACKLOG_SECONDS', {
      infer: true,
    });
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    let snapshot: Awaited<ReturnType<OutboxStore['backlogSnapshot']>>;
    try {
      snapshot = await this.outbox.backlogSnapshot(this.backlogSeconds);
    } catch {
      return indicator.degraded({ reasons: ['unavailable'] });
    }

    const reasons = [
      (snapshot.oldestDueJobAgeSeconds ?? 0) > this.backlogSeconds && 'backlog',
      snapshot.stalledLeases > 0 && 'stalled_jobs',
      snapshot.deadJobs > 0 && 'dead_jobs',
    ].filter((reason): reason is string => Boolean(reason));

    return reasons.length > 0
      ? indicator.degraded({ reasons })
      : indicator.up();
  }
}

// Healthy when at least one worker process, on any instance, has sent a heartbeat recently.
@Injectable()
export class WorkerHealthIndicator {
  private readonly timeoutSeconds: number;

  constructor(
    private readonly outbox: OutboxStore,
    private readonly healthIndicatorService: HealthIndicatorService,
    config: ConfigService<ApiEnvironment, true>,
  ) {
    this.timeoutSeconds = config.get('HEALTH_WORKER_TIMEOUT_SECONDS', {
      infer: true,
    });
  }

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    try {
      const { activeWorkers } = await this.outbox.workerSnapshot(
        this.timeoutSeconds,
      );
      return activeWorkers > 0
        ? indicator.up()
        : indicator.degraded({ reasons: ['no_active_worker'] });
    } catch {
      return indicator.degraded({ reasons: ['unavailable'] });
    }
  }
}
