import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Body, Controller, Get, INestApplication, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsPositive,
  IsString,
  Length,
  ValidateNested,
} from 'class-validator';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import { configureApp, setupSwagger } from '../src/app.setup.js';
import { ErrorResponse } from '../src/common/http/error-response.js';

// Test-only DTOs and controller for exercising the global HTTP conventions end to end.
class ExampleItemDto {
  @IsInt()
  @IsPositive()
  amount: number;
}

class ExampleDto {
  @IsString()
  @Length(3, 3)
  currency: string;

  @ValidateNested({ each: true })
  @Type(() => ExampleItemDto)
  items: ExampleItemDto[];
}

@Controller('conventions')
class ConventionsController {
  @Post()
  create(@Body() body: ExampleDto): ExampleDto {
    return body;
  }

  @Get('boom')
  boom(): never {
    throw new Error('secret internal detail');
  }
}

describe('HTTP conventions', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ConventionsController],
    }).compile();

    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    setupSwagger(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves business routes under /v1', async () => {
    const payload = { currency: 'NGN', items: [{ amount: 500 }] };

    const response = await request(app.getHttpServer())
      .post('/v1/conventions')
      .send(payload)
      .expect(201);

    expect(response.body).toEqual(payload);
  });

  it('returns field-level details for invalid bodies', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/conventions')
      .set('X-Request-Id', 'client-req-1')
      .send({ currency: 'NAIRA', items: [{ amount: -5 }] })
      .expect(400);

    const body = response.body as ErrorResponse;
    expect(body).toMatchObject({
      statusCode: 400,
      error: 'Bad Request',
      message: 'Validation failed',
      path: '/v1/conventions',
      requestId: 'client-req-1',
    });
    expect(body.details?.map((detail) => detail.field)).toEqual([
      'currency',
      'items.0.amount',
    ]);
    expect(response.headers['x-request-id']).toBe('client-req-1');
  });

  it('rejects properties that are not declared on the DTO', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/conventions')
      .send({ currency: 'NGN', items: [], isAdmin: true })
      .expect(400);

    expect((response.body as ErrorResponse).details).toEqual([
      { field: 'isAdmin', messages: ['property isAdmin should not exist'] },
    ]);
  });

  it('rejects malformed JSON with the standard envelope', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/conventions')
      .set('Content-Type', 'application/json')
      .send('{"currency":')
      .expect(400);

    expect(response.body).toMatchObject({ statusCode: 400 });
    expect((response.body as ErrorResponse).requestId).toBeTruthy();
  });

  it('returns the standard envelope for unknown routes', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/does-not-exist')
      .expect(404);

    expect(response.body).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
      path: '/v1/does-not-exist',
    });
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/conventions/boom')
      .expect(500);

    expect(response.body).toMatchObject({
      statusCode: 500,
      message: 'An unexpected error occurred',
    });
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('publishes the OpenAPI document', async () => {
    const response = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);

    const document = response.body as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/health', '/health/live']),
    );
    expect(document.components.schemas).toHaveProperty('ErrorResponse');
  });
});
