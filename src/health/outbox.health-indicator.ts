import { Injectable } from '@nestjs/common';
import {
  HealthIndicatorResult,
  HealthIndicatorService,
} from '@nestjs/terminus';
import { OutboxStore } from '../outbox/outbox-store.js';

const BACKLOG_DEGRADED_AFTER_SECONDS = 120;

// Reports `degraded` (HTTP stays 200) rather than `down`: a backlog or dead jobs mean background
// processing needs attention, not that this instance should stop receiving traffic. The public
// response carries only reason codes; `ops:status` in the operator CLI has the numbers.
@Injectable()
export class OutboxHealthIndicator {
  constructor(
    private readonly outbox: OutboxStore,
    private readonly healthIndicatorService: HealthIndicatorService,
  ) {}

  async check(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);
    let snapshot: Awaited<ReturnType<OutboxStore['backlogSnapshot']>>;
    try {
      snapshot = await this.outbox.backlogSnapshot(
        BACKLOG_DEGRADED_AFTER_SECONDS,
      );
    } catch {
      return indicator.degraded({ reasons: ['unavailable'] });
    }

    const reasons = [
      (snapshot.oldestDueJobAgeSeconds ?? 0) > BACKLOG_DEGRADED_AFTER_SECONDS &&
        'backlog',
      snapshot.stalledLeases > 0 && 'stalled_jobs',
      snapshot.deadJobs > 0 && 'dead_jobs',
    ].filter((reason): reason is string => Boolean(reason));

    return reasons.length > 0
      ? indicator.degraded({ reasons })
      : indicator.up();
  }
}
