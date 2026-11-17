export class InsufficientBalanceError extends Error {
  constructor(
    readonly currency: string,
    readonly available: bigint,
  ) {
    super(
      `Payout exceeds the available balance: ${available.toString()} ${currency} available`,
    );
  }
}
