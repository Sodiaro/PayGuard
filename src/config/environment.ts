import { Expose, plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsString,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';
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

export class EnvironmentVariables {
  @Expose()
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT: number = 3000;

  @Expose()
  @IsString()
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL: string;

  @Expose()
  @StrictBoolean()
  @IsBoolean()
  SWAGGER_ENABLED: boolean = false;

  // Comma-separated exact origins. Empty means no CORS: secret API keys belong on servers,
  // not in browsers. Wildcards and paths are rejected.
  @Expose()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string'
      ? value
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean)
      : value,
  )
  @IsArray()
  @Matches(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, {
    each: true,
    message:
      'CORS_ALLOWED_ORIGINS must be comma-separated origins like https://app.example.com',
  })
  CORS_ALLOWED_ORIGINS: string[] = [];

  // Operator-controlled outcome of the simulated provider; merchants cannot influence it.
  @Expose()
  @IsEnum(SimulatorOutcome)
  PAYMENT_SIMULATOR_OUTCOME: SimulatorOutcome = SimulatorOutcome.Succeeded;

  @Expose()
  @StrictBoolean()
  @IsBoolean()
  PAYMENT_SIMULATOR_AMBIGUOUS_SUBMISSIONS: boolean = false;

  // Disable to run an instance that serves HTTP only; any number of instances may run workers.
  @Expose()
  @StrictBoolean()
  @IsBoolean()
  OUTBOX_WORKER_ENABLED: boolean = true;

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

  // Number of reverse proxies in front of the API. 0 trusts no X-Forwarded-For header, so
  // per-IP limits key on the socket address; set it to the real hop count behind a load balancer.
  @Expose()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  TRUST_PROXY_HOPS: number = 0;
}

export function validateEnvironment(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const environment = plainToInstance(EnvironmentVariables, config, {
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
