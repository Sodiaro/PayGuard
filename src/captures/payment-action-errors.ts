import type { ActionEligibility } from './payment-action-lifecycle.js';

export class PaymentActionNotAllowedError extends Error {
  constructor(
    action: 'captured' | 'voided',
    readonly reason: Extract<ActionEligibility, { eligible: false }>['reason'],
  ) {
    super(`Payment cannot be ${action}: ${reason}`);
  }
}
