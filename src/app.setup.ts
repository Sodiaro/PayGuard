import { INestApplication, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponse } from './common/http/error-response.js';
import { HttpExceptionFilter } from './common/http/http-exception.filter.js';
import { requestIdMiddleware } from './common/http/request-id.middleware.js';
import { createValidationPipe } from './common/http/validation.js';

// Shared by main.ts and the e2e tests so tests run the exact HTTP pipeline clients hit.
export function configureApp(app: INestApplication): void {
  app.use(requestIdMiddleware);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
}

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('PayGuard API')
    .setDescription('Payment Processing & Transaction Reliability API')
    .setVersion('0.1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorResponse],
  });
  SwaggerModule.setup('docs', app, document);
}
