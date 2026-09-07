import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { GymsService } from '../src/gyms/gyms.service';
import { createTestApp, resetDb, seedGymWithTrainer } from './setup';

describe('Suspension cascade — mid-session, not just next login (spec §4.4 / §17 checklist)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gyms: GymsService;
  let server: any;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    gyms = app.get(GymsService);
    server = app.getHttpServer();
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  afterEach(async () => {
    await resetDb(prisma);
  });

  it('fails a staff request on the token issued before suspension, without a new login', async () => {
    const { gym, branchManager, password } = await seedGymWithTrainer(prisma);

    const loginRes = await request(server)
      .post('/api/v1/auth/staff/login')
      .send({ email: branchManager.email, password })
      .expect(201);
    const token = loginRes.body.data.accessToken;
    expect(token).toBeTruthy();

    // Token works before suspension.
    await request(server).get('/api/v1/branch/members').set('Authorization', `Bearer ${token}`).expect(200);

    // Suspend the gym — this is what an admin action does mid-day,
    // with the trainer's app already holding a live token.
    await gyms.suspend(gym.id, 'test-admin-id');

    // The SAME token, on its very next request, must now fail —
    // not "eventually when the 15-minute TTL expires."
    const res = await request(server).get('/api/v1/branch/members').set('Authorization', `Bearer ${token}`).expect(401);
    expect(res.body.error.code).toBe('GYM_SUSPENDED');
  });

  it('lets a fresh login through again after the gym is reactivated', async () => {
    const { gym, branchManager, password } = await seedGymWithTrainer(prisma);
    await gyms.suspend(gym.id, 'test-admin-id');

    await request(server).post('/api/v1/auth/staff/login').send({ email: branchManager.email, password }).expect(401);

    await gyms.activate(gym.id, 'test-admin-id');

    const res = await request(server).post('/api/v1/auth/staff/login').send({ email: branchManager.email, password }).expect(201);
    expect(res.body.data.accessToken).toBeTruthy();
  });
});
