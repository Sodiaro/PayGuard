import { ConfigModule } from '@nestjs/config';
import {
  validateApiEnvironment,
  validateCoreEnvironment,
} from './environment.js';

export const ApiConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  validate: validateApiEnvironment,
});

// For processes without an HTTP server: the standalone worker and the operator CLI.
export const CoreConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  validate: validateCoreEnvironment,
});
