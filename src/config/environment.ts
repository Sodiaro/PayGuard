import { Expose, plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
  ValidateBy,
} from 'class-validator';
import { isIP } from 'node:net';
import { SimulatorOutcome } from '../payments/providers/simulated-payment-provider.js';

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

// Only "true"/"false" are accepted; implicit conversion would turn "false" into true.
function StrictBoolean(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  );
}

function CommaSeparated(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : value,
  );
}

// Compose passes unset variables through as empty strings.
function EmptyAsUnset(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    value === '' ? undefined : value,
  );
}

const PROXY_KEYWORDS = new Set(['loopback', 'linklocal', 'uniquelocal']);

export function isTrustedProxyEntry(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry)) return true;
  const [address, prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  // A /0 range would trust every client's X-Forwarded-For, which defeats the purpose.
  return /^\d+$/.test(prefix) && bits >= 1 && bits <= (family === 4 ? 32 : 128);
}

function IsTrustedProxyList(): PropertyDecorator {
  return ValidateBy({
    name: 'isTrustedProxyList',
    validator: {
      validate: (value: unknown) =>
        Array.isArray(value) &&
        value.every(
          (entry) => typeof entry === 'string' && isTrustedProxyEntry(entry),
        ),
      defaultMessage: () =>
        'TRUSTED_PROXIES must be comma-separated IP addresses or CIDR ranges (not /0), or loopback, linklocal, uniquelocal',
    },
  });
}

// Settings every process needs: the API, the standalone worker and the operator CLI.
export class CoreEnvironment {
  @Expose()
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @Expose()
  @IsString()
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL: string;

  // Operator-controlled outcome of the simulated provider; merchants cannot influence it.
  @Expose()
  @IsEnum(SimulatorOutcome)
  PAYMENT_SIMULATOR_OUTCOME: SimulatorOutcome = SimulatorOutcome.Succeeded;

  @Expose()
  @StrictBoolean()
  @IsBoolean()
  PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: boolean = false;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  @Max(60_000)
  OUTBOX_POLL_INTERVAL_MS: number = 1000;

  // Must comfortably exceed a job's worst case: a lookup plus a resubmission, each bounded by the
  // provider call timeout. A lease shorter than that lets a second worker take over a live job.
  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3600)
  OUTBOX_LEASE_SECONDS: number = 60;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  OUTBOX_MAX_RUNS: number = 10;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(86_400)
  OUTBOX_BACKOFF_MAX_SECONDS: number = 300;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(86_400)
  RECONCILIATION_DELAY_SECONDS: number = 60;

  // Recorded as the actor of operator CLI actions; defaults to the OS user and host.
  @Expose()
  @IsOptional()
  @Matches(/^[\x20-\x7E]{1,200}$/, {
    message: 'PAYGUARD_OPERATOR must be 1-200 printable ASCII characters',
  })
  PAYGUARD_OPERATOR?: string;

  // Shared secret for simulator webhook signatures: the API verifies with it, the operator CLI's
  // simulator command signs with it. Unset disables the webhook endpoint. It must be a dedicated
  // secret, never a merchant API key.
  @Expose()
  @EmptyAsUnset()
  @IsOptional()
  @Matches(/^(?!pgsk_)[\x21-\x7E]{32,256}$/, {
    message:
      'SIMULATOR_WEBHOOK_SECRET must be 32-256 visible ASCII characters and must not be an API key',
  })
  SIMULATOR_WEBHOOK_SECRET?: string;
}

// Settings of the HTTP API process only.
export class ApiEnvironment extends CoreEnvironment {
  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @Expose()
  @StrictBoolean()
  @IsBoolean()
  SWAGGER_ENABLED: boolean = false;

  // Comma-separated exact origins. Empty means no CORS: secret API keys belong on servers,
  // not in browsers. Wildcards and paths are rejected.
  @Expose()
  @CommaSeparated()
  @IsArray()
  @Matches(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, {
    each: true,
    message:
      'CORS_ALLOWED_ORIGINS must be comma-separated origins like https://app.example.com',
  })
  CORS_ALLOWED_ORIGINS: string[] = [];

  // Runs the outbox worker inside the API process. Disable when standalone workers
  // (node dist/worker.js) do the processing.
  @Expose()
  @StrictBoolean()
  @IsBoolean()
  OUTBOX_WORKER_ENABLED: boolean = true;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  RATE_LIMIT_IP_PER_MINUTE: number = 300;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  RATE_LIMIT_PAYMENT_CREATES_PER_MINUTE: number = 60;

  // Addresses of reverse proxies allowed to set X-Forwarded-For. The header is ignored unless the
  // connecting peer is on this list, so a directly exposed API cannot be fooled by spoofed
  // headers. Empty: the socket address is the client.
  @Expose()
  @CommaSeparated()
  @IsArray()
  @IsTrustedProxyList()
  TRUSTED_PROXIES: string[] = [];

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(10)
  @Max(86_400)
  HEALTH_QUEUE_BACKLOG_SECONDS: number = 120;

  // Workers refresh their heartbeat every 10 seconds, so this must leave room for missed beats.
  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(20)
  @Max(3600)
  HEALTH_WORKER_TIMEOUT_SECONDS: number = 30;

  // How far a webhook's signed timestamp may be from this server's clock, in either direction.
  // Bounds how long a captured delivery can be replayed; deduplication covers replays within it.
  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(900)
  WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: number = 300;
}

export function validateCoreEnvironment(
  config: Record<string, unknown>,
): CoreEnvironment {
  return validateAs(CoreEnvironment, config);
}

export function validateApiEnvironment(
  config: Record<string, unknown>,
): ApiEnvironment {
  return validateAs(ApiEnvironment, config);
}

function validateAs<T extends object>(
  schema: new () => T,
  config: Record<string, unknown>,
): T {
  const environment = plainToInstance(schema, config, {
    excludeExtraneousValues: true,
    exposeDefaultValues: true,
  });

  // Report variable names only, never values: DATABASE_URL carries credentials.
  const errors = validateSync(environment, {
    validationError: { target: false, value: false },
  });

  if (errors.length > 0) {
    const details = errors
      .map(
        (error) =>
          `  - ${error.property}: ${Object.values(error.constraints ?? {}).join('; ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return environment;
}
