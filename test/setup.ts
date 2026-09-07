import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/http-exception.filter';
import { ResponseEnvelopeInterceptor } from '../src/common/interceptors/response-envelope.interceptor';
import { hashSecret } from '../src/common/utils/hash.util';

/**
 * These are real integration tests against a real Postgres instance —
 * intentionally, because the two most safety-critical behaviors in
 * this API (the capacity row-lock and the suspension cascade) are
 * exactly the kind of thing a mocked PrismaService would rubber-stamp
 * without ever exercising the actual transaction/locking semantics
 * that make them correct. Point DATABASE_URL (.env) at a disposable
 * test database — docker-compose's `postgres` service is fine, but
 * NEVER point this at production; these tests delete rows.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseEnvelopeInterceptor());
  app.setGlobalPrefix('api/v1');
  await app.init();
  return app;
}

/** Wipes every table between test files so they don't interfere with each other. Test DB only. */
export async function resetDb(prisma: PrismaService): Promise<void> {
  await prisma.$transaction([
    prisma.sensorReading.deleteMany(),
    prisma.sessionMember.deleteMany(),
    prisma.session.deleteMany(),
    prisma.sensor.deleteMany(), // FK RESTRICT on gymId — must clear before gym.deleteMany()
    prisma.transferRequest.deleteMany(),
    prisma.memberGymHistory.deleteMany(),
    prisma.consent.deleteMany(),
    prisma.memberPinReset.deleteMany(),
    prisma.refreshToken.deleteMany(),
    prisma.member.deleteMany(),
    prisma.trainer.deleteMany(),
    prisma.adminBackupCode.deleteMany(),
    prisma.passwordResetToken.deleteMany(),
    prisma.notification.deleteMany(),
    prisma.auditLog.deleteMany(),
    prisma.admin.deleteMany(),
    prisma.gym.deleteMany(),
  ]);
}

export async function seedGymWithTrainer(prisma: PrismaService, opts: { memberLimit?: number } = {}) {
  const gym = await prisma.gym.create({ data: { name: 'Test Gym', memberLimit: opts.memberLimit ?? 100 } });
  const passwordHash = await hashSecret('TestPassword123!');
  const trainer = await prisma.trainer.create({
    data: { gymId: gym.id, name: 'Test Trainer', email: `trainer-${Date.now()}-${Math.random()}@test.local`, passwordHash, role: 'trainer' },
  });
  const branchManager = await prisma.trainer.create({
    data: { gymId: gym.id, name: 'Test Manager', email: `manager-${Date.now()}-${Math.random()}@test.local`, passwordHash, role: 'branch_manager', isPrimaryManager: true },
  });
  return { gym, trainer, branchManager, password: 'TestPassword123!' };
}

export async function seedMember(prisma: PrismaService, gymId?: string, pin = '123456') {
  const pinHash = await hashSecret(pin);
  const code = `UVA-TEST${Math.floor(Math.random() * 100000)}`;
  const member = await prisma.member.create({ data: { memberCode: code, pinHash, name: 'Test Member', currentGymId: gymId ?? null } });
  if (gymId) {
    await prisma.memberGymHistory.create({ data: { memberId: member.id, gymId } });
  }
  return { member, pin };
}

export async function seedAdmin(prisma: PrismaService, role: 'super_admin' | 'support' = 'support') {
  const passwordHash = await hashSecret('TestPassword123!');
  const admin = await prisma.admin.create({
    data: { name: `Test ${role}`, email: `admin-${role}-${Date.now()}-${Math.random()}@test.local`, passwordHash, role },
  });
  return { admin, password: 'TestPassword123!' };
}
