import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { Express } from 'express';
import helmet from 'helmet';
import { ErrorResponse } from './common/http/error-response.js';
import { HttpExceptionFilter } from './common/http/http-exception.filter.js';
import { requestIdMiddleware } from './common/http/request-id.middleware.js';
import { createValidationPipe } from './common/http/validation.js';
import { requestLoggingMiddleware } from './common/logging/request-logging.middleware.js';
import { ApiEnvironment } from './config/environment.js';
import {
  WEBHOOK_PATH_PREFIX,
  webhookRawBody,
} from './webhooks/webhook-raw-body.js';

// Shared by main.ts and the e2e tests so tests run the exact HTTP pipeline clients hit.
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<ApiEnvironment, true>>(ConfigService);

  // Trusting by address rather than hop count: X-Forwarded-For is honoured only when the peer is a
  // listed proxy, so clients that reach the API directly cannot choose their own IP.
  const trustedProxies = config.get('TRUSTED_PROXIES', { infer: true });
  if (trustedProxies.length > 0) {
    (app.getHttpAdapter().getInstance() as Express).set(
      'trust proxy',
      trustedProxies,
    );
  }

  app.use(helmet());
  app.use(requestIdMiddleware);
  app.use(requestLoggingMiddleware);
  // Must be registered before app.init(), which installs the JSON parser behind it.
  app.use(WEBHOOK_PATH_PREFIX, webhookRawBody());

  const allowedOrigins = config.get('CORS_ALLOWED_ORIGINS', { infer: true });
  if (allowedOrigins.length > 0) {
    app.enableCors({
      origin: allowedOrigins,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
      allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      exposedHeaders: ['X-Request-Id'],
      credentials: false,
      maxAge: 600,
    });
  }

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(new HttpExceptionFilter());
}

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('PayGuard API')
    .setDescription('Payment Processing & Transaction Reliability API')
    .setVersion('0.3.0')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description: 'Merchant API key: Authorization: Bearer pgsk_...',
    })
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorResponse],
  });
  SwaggerModule.setup('docs', app, document);
}
