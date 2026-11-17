import type { RefundEligibility } from './refund-lifecycle.js';

export class RefundNotAllowedError extends Error {
  constructor(
    readonly reason: Extract<RefundEligibility, { eligible: false }>['reason'],
  ) {
    super(`Payment cannot be refunded: ${reason}`);
  }
}

export class RefundNotFoundError extends Error {
  constructor() {
    super('Refund not found');
  }
}
