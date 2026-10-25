import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { CoreEnvironment } from '../../config/environment.js';
import { OutboxStore } from '../../outbox/outbox-store.js';
import { AttemptJobProcessor } from './attempt-job-processor.js';

const BATCH_SIZE = 10;
const SWEEP_INTERVAL_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 10_000;

// Polls the outbox. Safe to run on any number of processes: claims use row locks and leases in
// PostgreSQL, so no coordination between instances is needed. The host process decides whether
// to start it: InProcessWorkerStarter in the API, or the standalone worker entry point.
@Injectable()
export class OutboxWorker implements BeforeApplicationShutdown {
  private readonly logger = new Logger(OutboxWorker.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private readonly pollIntervalMs: number;
  private readonly staleAfterSeconds: number;
  private running = false;
  private loop: Promise<void> | null = null;
  private interruptIdle: (() => void) | null = null;
  private lastSweepAt = 0;
  private lastHeartbeatAt = 0;
  private jobsFinished = 0;
  private lastJobFinishedAt: Date | null = null;

  constructor(
    private readonly outbox: OutboxStore,
    private readonly processor: AttemptJobProcessor,
    config: ConfigService<CoreEnvironment, true>,
  ) {
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });
    this.staleAfterSeconds = config.get('RECONCILIATION_DELAY_SECONDS', {
      infer: true,
    });
  }

  // Runs before the database pool closes (PrismaService disconnects on application shutdown), so
  // the batch in flight can finish and record its results.
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  get isRunning(): boolean {
    return this.running;
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
    await this.outbox.markWorkerStopped(this.workerId).catch(() =>
      this.logger.warn('Could not record worker stop', {
        workerId: this.workerId,
      }),
    );
    this.logger.log('Outbox worker stopped', { workerId: this.workerId });
  }

  async processDueJobs(): Promise<number> {
    const jobs = await this.outbox.claim(this.workerId, BATCH_SIZE);
    await Promise.all(jobs.map((job) => this.processor.handle(job)));
    if (jobs.length > 0) {
      this.jobsFinished += jobs.length;
      this.lastJobFinishedAt = new Date();
    }
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

  async recordHeartbeat(): Promise<void> {
    await this.outbox.recordWorkerHeartbeat(this.workerId, {
      jobsFinished: this.jobsFinished,
      lastJobFinishedAt: this.lastJobFinishedAt,
    });
    this.lastHeartbeatAt = Date.now();
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      let handled = 0;
      try {
        if (Date.now() - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
          await this.recordHeartbeat();
        }
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
