import { ConsoleLogger, type LogLevel } from '@nestjs/common';
import { API_KEY_LIKE } from '../../auth/api-key.js';
import { requestContext } from './request-context.js';

const SENSITIVE_KEYS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'apiKey',
  'api_key',
  'secret',
  'secretHash',
  'password',
  'token',
  'plaintext',
];

export function scrubSecrets(text: string): string {
  return text.replace(API_KEY_LIKE, 'pgsk_[REDACTED]');
}

function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubSecrets(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, scrubDeep(entry)]),
    );
  }
  return value;
}

// ConsoleLogger's `redact` masks sensitive keys but prints string values, messages and
// error stacks verbatim, so anything shaped like a PayGuard key is scrubbed as well.
export class AppLogger extends ConsoleLogger {
  constructor(options: { json: boolean; logLevels?: LogLevel[] }) {
    super({
      json: options.json,
      logLevels: options.logLevels,
      flattenParams: true,
      redact: SENSITIVE_KEYS,
    });
  }

  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
    params?: Record<string, unknown>,
  ): void {
    const store = requestContext.getStore();
    const correlation = store && {
      requestId: store.requestId,
      ...(store.merchantId && { merchantId: store.merchantId }),
    };
    const merged =
      correlation || params ? { ...correlation, ...params } : undefined;

    super.printMessages(
      messages.map(scrubDeep),
      context && scrubSecrets(context),
      logLevel,
      writeStreamType,
      scrubDeep(errorStack),
      merged && (scrubDeep(merged) as Record<string, unknown>),
    );
  }

  // When an Error is logged directly, its message becomes the record's message after scrubbing ran.
  protected override extractJsonError(messages: unknown[]): {
    messages: unknown[];
    error?: Error;
  } {
    const extracted = super.extractJsonError(messages);
    return { ...extracted, messages: extracted.messages.map(scrubDeep) };
  }

  protected override serializeError(
    error: Error,
    depth?: number,
    ancestors?: Set<Error>,
  ): Record<string, unknown> {
    return scrubDeep(super.serializeError(error, depth, ancestors)) as Record<
      string,
      unknown
    >;
  }
}
