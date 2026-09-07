import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { createServiceScopeMiddleware, ServiceScope } from './common/middleware/service-scope.middleware';
import { GLOBAL_PREFIX } from './config/global-prefix';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: false });
  const config = app.get(ConfigService);

  app.use(helmet());
  app.enableCors({
    origin: config.get<string[]>('corsOrigins')!.includes('*') ? true : config.get<string[]>('corsOrigins'),
    credentials: true,
  });

  // Registered before routing, so an out-of-scope request 404s before it
  // ever reaches a guard/controller — see service-scope.middleware.ts.
  // This deployment is single-instance/single-backend, so the default is
  // 'all' (every route live) — the admin/branch-only scopes stay
  // available for anyone who wants to split this back out later without
  // touching the middleware itself.
  const serviceScope = config.get<ServiceScope>('serviceScope')!;
  app.use(createServiceScopeMiddleware(serviceScope));

  // Strips unknown properties and rejects invalid payloads at the edge —
  // every DTO in every module relies on this being global.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());

  app.setGlobalPrefix(GLOBAL_PREFIX);

  if (config.get('nodeEnv') !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('UV Active Cloud API')
      .setDescription('Sole system of record for gyms, members, trainers, sessions, transfers and admin oversight.')
      .setVersion('2.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, doc);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = config.get<number>('port')!;
  await app.listen(port, '0.0.0.0');
  Logger.log(`UV Active Cloud API listening on :${port} (${config.get('nodeEnv')}, scope=${serviceScope})`, 'Bootstrap');
}

bootstrap();
