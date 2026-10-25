import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ApiEnvironment } from '../../config/environment.js';
import { OutboxWorker } from './outbox-worker.js';

// Starts the outbox worker inside the API process when OUTBOX_WORKER_ENABLED is set; shutdown is
// handled by OutboxWorker itself.
@Injectable()
export class InProcessWorkerStarter implements OnApplicationBootstrap {
  constructor(
    private readonly worker: OutboxWorker,
    private readonly config: ConfigService<ApiEnvironment, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.get('OUTBOX_WORKER_ENABLED', { infer: true })) {
      this.worker.start();
    }
  }
}
