import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { createTestApp, resetDb, seedGymWithTrainer, seedMember } from './setup';

describe('Idempotent session-end (spec §7, §13 / §17 checklist)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let sessions: SessionsService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    sessions = app.get(SessionsService);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  afterEach(async () => {
    await resetDb(prisma);
  });

  it('never creates a duplicate session_members row on a retried end payload', async () => {
    const { gym, trainer } = await seedGymWithTrainer(prisma);
    const { member } = await seedMember(prisma, gym.id);
    const session = await prisma.session.create({ data: { gymId: gym.id, trainerId: trainer.id, name: 'Class', capacity: 10 } });

    await sessions.enrollMember(session.id, member.id, 'trainer');
    await sessions.start(session.id, trainer.id);

    const payload = { results: [{ memberId: member.id, avgHr: 140, maxHr: 170, calories: 300, score: 88 }] };

    await sessions.end(session.id, payload, trainer.id);
    // Simulate the trainer app's offline outbox retrying the exact same upload.
    await sessions.end(session.id, payload, trainer.id);

    const rows = await prisma.sessionMember.findMany({ where: { sessionId: session.id, memberId: member.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].avgHr).toBe(140);
    expect(rows[0].score).toBe(88);

    const finalSession = await prisma.session.findUnique({ where: { id: session.id } });
    expect(finalSession?.status).toBe('completed');
  });

  it('rejects a result for a member who was never enrolled', async () => {
    const { gym, trainer } = await seedGymWithTrainer(prisma);
    const { member: notEnrolled } = await seedMember(prisma, gym.id);
    const session = await prisma.session.create({ data: { gymId: gym.id, trainerId: trainer.id, name: 'Class', capacity: 10 } });
    await sessions.start(session.id, trainer.id);

    await expect(
      sessions.end(session.id, { results: [{ memberId: notEnrolled.id, avgHr: 120 }] }, trainer.id),
    ).rejects.toThrow(/never enrolled/);
  });

  it('rejects ending a session that was never started', async () => {
    const { gym, trainer } = await seedGymWithTrainer(prisma);
    const session = await prisma.session.create({ data: { gymId: gym.id, trainerId: trainer.id, name: 'Class', capacity: 10 } });

    await expect(sessions.end(session.id, { results: [] }, trainer.id)).rejects.toThrow(/never started/);
  });
});
