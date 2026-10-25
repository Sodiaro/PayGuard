import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { EnvironmentVariables } from '../../config/environment.js';
import { OutboxStore } from '../../outbox/outbox-store.js';
import { AttemptJobProcessor } from './attempt-job-processor.js';

const BATCH_SIZE = 10;
const SWEEP_INTERVAL_MS = 30_000;

// Polls the outbox in-process. Safe to run on any number of instances: claims use row locks and
// leases in PostgreSQL, so no coordination between instances is needed.
@Injectable()
export class OutboxWorker
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxWorker.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly staleAfterSeconds: number;
  private running = false;
  private loop: Promise<void> | null = null;
  private interruptIdle: (() => void) | null = null;
  private lastSweepAt = 0;

  constructor(
    private readonly outbox: OutboxStore,
    private readonly processor: AttemptJobProcessor,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.enabled = config.get('OUTBOX_WORKER_ENABLED', { infer: true });
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });
    this.staleAfterSeconds = config.get('RECONCILIATION_DELAY_SECONDS', {
      infer: true,
    });
  }

  onApplicationBootstrap(): void {
    if (this.enabled) this.start();
  }

  // Runs before the database pool closes (PrismaService disconnects on application shutdown), so
  // the batch in flight can finish and record its results.
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop();
    this.logger.log('Outbox worker started', { workerId: this.workerId });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.interruptIdle?.();
    await this.loop;
    this.logger.log('Outbox worker stopped', { workerId: this.workerId });
  }

  async processDueJobs(): Promise<number> {
    const jobs = await this.outbox.claim(this.workerId, BATCH_SIZE);
    await Promise.all(jobs.map((job) => this.processor.handle(job)));
    return jobs.length;
  }

  async sweepStaleAttempts(): Promise<number> {
    const queued = await this.outbox.enqueueStaleReconciliations(
      this.staleAfterSeconds,
    );
    if (queued > 0) {
      this.logger.warn('Queued reconciliation for stale pending attempts', {
        count: queued,
      });
    }
    return queued;
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let handled = 0;
      try {
        if (Date.now() - this.lastSweepAt >= SWEEP_INTERVAL_MS) {
          this.lastSweepAt = Date.now();
          await this.sweepStaleAttempts();
        }
        handled = await this.processDueJobs();
      } catch (error) {
        // Usually the database being unreachable. Jobs claimed before the failure are recovered
        // when their leases expire.
        this.logger.error(
          'Outbox poll failed',
          error instanceof Error ? error.stack : String(error),
        );
      }
      if (handled === 0) await this.idle();
    }
  }

  private idle(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, this.pollIntervalMs);
      this.interruptIdle = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}
