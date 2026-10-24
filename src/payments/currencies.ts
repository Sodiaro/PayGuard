// Amounts are always integers in the currency's minor unit. The exponent is the number of
// minor-unit digits (ISO 4217): 5000 NGN = 50.00 naira, 5000 JPY = 5000 yen, 5000 KWD = 5.000 dinar.
export const SUPPORTED_CURRENCIES = {
  NGN: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KWD: 3,
} as const satisfies Record<string, number>;

export type SupportedCurrency = keyof typeof SUPPORTED_CURRENCIES;

export const SUPPORTED_CURRENCY_CODES = Object.keys(
  SUPPORTED_CURRENCIES,
) as SupportedCurrency[];

// Bounded well below Number.MAX_SAFE_INTEGER so amounts survive JSON (IEEE-754) intact.
export const MAX_PAYMENT_AMOUNT = 1_000_000_000_000;
