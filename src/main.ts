import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp, setupSwagger } from './app.setup.js';
import { AppLogger } from './common/logging/app-logger.js';
import { EnvironmentVariables, NodeEnvironment } from './config/environment.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config =
    app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);

  app.useLogger(
    new AppLogger({
      json:
        config.get('NODE_ENV', { infer: true }) !== NodeEnvironment.Development,
    }),
  );
  configureApp(app);
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    setupSwagger(app);
  }
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  Logger.log(`PayGuard API listening on port ${port}`, 'Bootstrap');
}

await bootstrap();
