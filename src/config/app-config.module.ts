import { ConfigModule } from '@nestjs/config';
import {
  validateApiEnvironment,
  validateOperatorEnvironment,
  validateProcessingEnvironment,
} from './environment.js';

// Each process validates only its own settings. These are functions, not constants:
// ConfigModule.forRoot validates when called, so building every variant on import would make one
// process fail on another's requirements (the CLI on PAYMENT_PROVIDER, for example).

export function apiConfigModule() {
  return ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    validate: validateApiEnvironment,
  });
}

// The standalone worker.
export function workerConfigModule() {
  return ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    validate: validateProcessingEnvironment,
  });
}

// The operator CLI.
export function operatorConfigModule() {
  return ConfigModule.forRoot({
    isGlobal: true,
    cache: true,
    validate: validateOperatorEnvironment,
  });
}
