import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp, setupSwagger } from './app.setup.js';
import { EnvironmentVariables } from './config/environment.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config =
    app.get<ConfigService<EnvironmentVariables, true>>(ConfigService);

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
