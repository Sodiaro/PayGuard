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

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
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

  // Only "true"/"false" are accepted; implicit conversion would turn "false" into true.
  @Expose()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
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
