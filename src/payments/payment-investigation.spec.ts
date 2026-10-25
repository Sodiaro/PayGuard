import { describe, expect, it } from '@jest/globals';
import {
  OutboxErrorCategory,
  OutboxJobStatus,
  OutboxJobType,
} from '../generated/prisma/enums.js';
import { diagnoseUnresolved, type JobView } from './payment-investigation.js';

const NEXT = new Date('2026-10-26T12:00:00.000Z');

const job = (overrides: Partial<JobView>): JobView => ({
  type: OutboxJobType.PROCESS_ATTEMPT,
  status: OutboxJobStatus.QUEUED,
  runCount: 0,
  lastError: null,
  availableAt: NEXT,
  ...overrides,
});

const completedSubmission = job({ status: OutboxJobStatus.COMPLETED });

describe('diagnoseUnresolved', () => {
  it('reports work a worker holds right now', () => {
    expect(
      diagnoseUnresolved([
        completedSubmission,
        job({
          type: OutboxJobType.RECONCILE_ATTEMPT,
          status: OutboxJobStatus.PROCESSING,
        }),
      ]),
    ).toMatchObject({ state: 'in_progress', needsOperator: false });
  });

  it('distinguishes a first submission from one retried after internal failures', () => {
    expect(diagnoseUnresolved([job({})])).toEqual({
      state: 'awaiting_submission',
      needsOperator: false,
      lastError: null,
      nextRunAt: NEXT,
    });
    expect(
      diagnoseUnresolved([
        job({ runCount: 2, lastError: OutboxErrorCategory.INTERNAL_ERROR }),
      ]),
    ).toMatchObject({
      state: 'submission_retrying',
      lastError: 'INTERNAL_ERROR',
    });
  });

  it('distinguishes a pending lookup from one retrying after inconclusive answers', () => {
    const lookup = (runCount: number) =>
      diagnoseUnresolved([
        completedSubmission,
        job({
          type: OutboxJobType.RECONCILE_ATTEMPT,
          runCount,
          lastError:
            runCount > 0
              ? OutboxErrorCategory.OUTCOME_PROCESSING
              : OutboxErrorCategory.PROVIDER_TIMEOUT,
        }),
      ]);

    expect(lookup(0)).toMatchObject({
      state: 'awaiting_lookup',
      nextRunAt: NEXT,
    });
    expect(lookup(3)).toMatchObject({
      state: 'lookup_retrying',
      lastError: 'OUTCOME_PROCESSING',
      needsOperator: false,
    });
  });

  it('flags exhausted lookups as needing an operator, never as resolved', () => {
    expect(
      diagnoseUnresolved([
        completedSubmission,
        job({
          type: OutboxJobType.RECONCILE_ATTEMPT,
          status: OutboxJobStatus.DEAD,
          runCount: 10,
          lastError: OutboxErrorCategory.PROVIDER_UNAVAILABLE,
        }),
      ]),
    ).toEqual({
      state: 'reconciliation_exhausted',
      needsOperator: true,
      lastError: 'PROVIDER_UNAVAILABLE',
      nextRunAt: null,
    });
  });

  it('leaves attempts without live work to the stale sweep', () => {
    expect(diagnoseUnresolved([])).toMatchObject({ state: 'awaiting_sweep' });
    expect(
      diagnoseUnresolved([
        job({
          status: OutboxJobStatus.DEAD,
          lastError: OutboxErrorCategory.INTERNAL_ERROR,
        }),
      ]),
    ).toEqual({
      state: 'awaiting_sweep',
      needsOperator: false,
      lastError: 'INTERNAL_ERROR',
      nextRunAt: null,
    });
  });

  it('ignores webhook jobs when explaining where the attempt itself stands', () => {
    expect(
      diagnoseUnresolved([
        completedSubmission,
        job({ type: OutboxJobType.APPLY_WEBHOOK_EVENT }),
        job({ type: OutboxJobType.RECONCILE_ATTEMPT }),
      ]),
    ).toMatchObject({ state: 'awaiting_lookup' });
  });
});
