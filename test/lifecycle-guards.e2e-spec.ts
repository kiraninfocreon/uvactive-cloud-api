import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { GymsService } from '../src/gyms/gyms.service';
import { TrainersService } from '../src/trainers/trainers.service';
import { createTestApp, resetDb, seedGymWithTrainer, seedMember } from './setup';

describe('Lifecycle guards (spec §17 checklist)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gyms: GymsService;
  let trainers: TrainersService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    gyms = app.get(GymsService);
    trainers = app.get(TrainersService);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  afterEach(async () => {
    await resetDb(prisma);
  });

  it('blocks gym deletion while members remain assigned', async () => {
    const { gym } = await seedGymWithTrainer(prisma);
    await seedMember(prisma, gym.id);

    await expect(gyms.remove(gym.id, 'test-admin-id')).rejects.toThrow(/member\(s\) still assigned/);

    const stillThere = await prisma.gym.findUnique({ where: { id: gym.id } });
    expect(stillThere?.status).toBe('active');
  });

  it('soft-deletes (status=deleted) once the roster is empty, never a hard DELETE', async () => {
    const { gym } = await seedGymWithTrainer(prisma);
    await gyms.remove(gym.id, 'test-admin-id');
    const row = await prisma.gym.findUnique({ where: { id: gym.id } });
    expect(row).not.toBeNull(); // row still exists
    expect(row?.status).toBe('deleted');
  });

  it('flags every future scheduled session needs_reassignment=true when its trainer is suspended', async () => {
    const { gym, trainer } = await seedGymWithTrainer(prisma);
    const future = new Date(Date.now() + 24 * 3600 * 1000);
    const past = new Date(Date.now() - 24 * 3600 * 1000);

    const futureSession = await prisma.session.create({ data: { gymId: gym.id, trainerId: trainer.id, name: 'Tomorrow', scheduledAt: future } });
    const pastSession = await prisma.session.create({ data: { gymId: gym.id, trainerId: trainer.id, name: 'Yesterday', scheduledAt: past } });

    await trainers.setStatus(trainer.id, 'suspended', 'staff', 'test-manager-id', gym.id);

    const refreshedFuture = await prisma.session.findUnique({ where: { id: futureSession.id } });
    const refreshedPast = await prisma.session.findUnique({ where: { id: pastSession.id } });
    expect(refreshedFuture?.needsReassignment).toBe(true);
    expect(refreshedPast?.needsReassignment).toBe(false); // already in the past — not a candidate for reassignment

    const branchAlert = await prisma.notification.findFirst({ where: { recipientType: 'branch', recipientId: gym.id, type: 'reassignment_needed' } });
    expect(branchAlert).not.toBeNull();
  });
});
