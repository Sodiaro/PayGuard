import type { Logger } from '@nestjs/common';
import { OutboxErrorCategory } from '../../generated/prisma/enums.js';
import type { ClaimedJob, OutboxStore } from '../../outbox/outbox-store.js';
import {
  ProviderTimeoutError,
  type ProviderLookupResult,
} from '../providers/payment-provider.js';

// Shared by the attempt, refund, capture/void and payout job processors.

export async function retryLater(
  outbox: OutboxStore,
  logger: Logger,
  job: ClaimedJob,
  category: OutboxErrorCategory,
): Promise<void> {
  const outcome = await outbox.rescheduleWithHistory(job, category);
  const fields = { ...jobFields(job), category, runCount: job.runCount };
  if (outcome === 'dead') {
    logger.error('Outbox job exhausted its runs; needs investigation', fields);
  } else if (outcome === 'rescheduled') {
    logger.warn('Outbox job rescheduled', fields);
  }
}

export function providerErrorCategory(error: unknown): OutboxErrorCategory {
  return error instanceof ProviderTimeoutError
    ? OutboxErrorCategory.PROVIDER_TIMEOUT
    : OutboxErrorCategory.PROVIDER_ERROR;
}

export function jobFields(job: ClaimedJob) {
  return {
    jobId: job.id,
    jobType: job.type,
    ...(job.paymentId && { paymentId: job.paymentId }),
    ...(job.attemptId && { attemptId: job.attemptId }),
    ...(job.refundId && { refundId: job.refundId }),
    ...(job.paymentActionId && { paymentActionId: job.paymentActionId }),
    ...(job.payoutId && { payoutId: job.payoutId }),
  };
}

export function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

// Logged instead of the raw value so an unexpected provider answer cannot inject arbitrary text.
export function knownLookupStatus(lookup: ProviderLookupResult): string {
  const known = [
    'succeeded',
    'authorized',
    'declined',
    'processing',
    'not_found',
    'unavailable',
  ];
  return known.includes(lookup.status) ? lookup.status : 'unrecognised';
}
