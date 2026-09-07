import { INestApplication } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { createTestApp, resetDb, seedGymWithTrainer, seedMember } from './setup';

describe('Session capacity race (spec §7 / §17 checklist)', () => {
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

  it('lets exactly one of five concurrent enrollments win the last open seat', async () => {
    const { gym, trainer } = await seedGymWithTrainer(prisma);
    const session = await prisma.session.create({
      data: { gymId: gym.id, trainerId: trainer.id, name: 'Last Seat Class', capacity: 1 },
    });

    const contenders = await Promise.all(Array.from({ length: 5 }, () => seedMember(prisma, gym.id)));

    const results = await Promise.allSettled(
      contenders.map((c) => sessions.enrollMember(session.id, c.member.id, 'member_self_book')),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);

    // The DB itself must agree — this is the actual assertion that
    // matters, independent of what the application layer observed.
    const rowCount = await prisma.sessionMember.count({ where: { sessionId: session.id } });
    expect(rowCount).toBe(1);
  });

  it('rejects enrollment past capacity with the SESSION_FULL error code', async () => {
    const { gym, trainer } = await seedGymWithTrainer(prisma);
    const session = await prisma.session.create({ data: { gymId: gym.id, trainerId: trainer.id, name: 'Full Class', capacity: 1 } });
    const a = await seedMember(prisma, gym.id);
    const b = await seedMember(prisma, gym.id);

    await sessions.enrollMember(session.id, a.member.id, 'member_self_book');

    await expect(sessions.enrollMember(session.id, b.member.id, 'member_self_book')).rejects.toMatchObject({
      code: 'SESSION_FULL',
    });
  });

  it('rejects the same member enrolling twice with a conflict, not a duplicate row', async () => {
    const { gym, trainer } = await seedGymWithTrainer(prisma);
    const session = await prisma.session.create({ data: { gymId: gym.id, trainerId: trainer.id, name: 'Class', capacity: 10 } });
    const m = await seedMember(prisma, gym.id);

    await sessions.enrollMember(session.id, m.member.id, 'member_self_book');
    await expect(sessions.enrollMember(session.id, m.member.id, 'member_self_book')).rejects.toThrow();

    const rowCount = await prisma.sessionMember.count({ where: { sessionId: session.id, memberId: m.member.id } });
    expect(rowCount).toBe(1);
  });
});
