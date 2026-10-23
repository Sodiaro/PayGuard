import { describe, expect, it } from '@jest/globals';
import type { ValidationError } from '@nestjs/common';
import { toErrorDetails } from './validation.js';

function validationError(
  property: string,
  constraints?: Record<string, string>,
  children: ValidationError[] = [],
): ValidationError {
  return { property, constraints, children };
}

describe('toErrorDetails', () => {
  it('maps each failing property to its messages', () => {
    const details = toErrorDetails([
      validationError('amount', { isPositive: 'amount must be positive' }),
      validationError('currency', { isIn: 'currency must be one of: NGN' }),
    ]);

    expect(details).toEqual([
      { field: 'amount', messages: ['amount must be positive'] },
      { field: 'currency', messages: ['currency must be one of: NGN'] },
    ]);
  });

  it('flattens nested errors into dotted field paths', () => {
    const details = toErrorDetails([
      validationError('items', undefined, [
        validationError('0', undefined, [
          validationError('amount', { isInt: 'amount must be an integer' }),
        ]),
      ]),
    ]);

    expect(details).toEqual([
      { field: 'items.0.amount', messages: ['amount must be an integer'] },
    ]);
  });
});
