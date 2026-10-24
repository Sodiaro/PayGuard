// Domain errors, independent of HTTP: the admin CLI and controllers translate them.
export class MerchantAlreadyExistsError extends Error {
  constructor(readonly slug: string) {
    super(`A merchant with slug "${slug}" already exists`);
  }
}

export class MerchantNotFoundError extends Error {
  constructor(reference: string) {
    super(`Merchant "${reference}" not found`);
  }
}

export class ApiKeyNotFoundError extends Error {
  constructor(reference: string) {
    super(`API key "${reference}" not found`);
  }
}

export class InvalidMerchantInputError extends Error {}
