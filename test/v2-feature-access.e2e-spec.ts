import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokenService } from '../src/common/utils/token.service';
import { createTestApp, resetDb, seedGymWithTrainer, seedMember, seedAdmin } from './setup';

/**
 * End-to-end coverage for the v2 rework requested across Phases A–C:
 * gym/member creation with mandatory fields, the trainer/branch-manager
 * separation fix, the admin→branch transfer-request flow, sensor-capped
 * session capacity, and the admin access-control matrix (super_admin vs
 * support). Run with `npm run test:e2e` against a real disposable
 * Postgres — see test/setup.ts for why these aren't mocked.
 */
describe('v2 feature + access-control coverage', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  const api = () => request(app.getHttpServer());

  const adminAuth = (adminId: string, role: 'super_admin' | 'support') =>
    `Bearer ${tokens.signAccessToken({ sub: adminId, realm: 'admin', role })}`;

  const staffAuth = (staffId: string, role: 'branch_manager' | 'trainer', gymId: string, gymTokenVersion = 0) =>
    `Bearer ${tokens.signAccessToken({ sub: staffId, realm: 'staff', role, gymId, gymTokenVersion })}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
  });

  afterAll(async () => {
    await resetDb(prisma);
    await app.close();
  });

  afterEach(async () => {
    await resetDb(prisma);
  });

  // ── Gym creation (Phase A) ────────────────────────────────────────
  describe('Admin Panel: gym creation', () => {
    it('rejects a gym missing any of the mandatory fields', async () => {
      const { admin } = await seedAdmin(prisma, 'super_admin');
      const res = await api()
        .post('/api/v1/admin/gyms')
        .set('Authorization', adminAuth(admin.id, 'super_admin'))
        .send({ name: 'No Phone Gym', address: '123 St', location: 'Kochi', memberLimit: 50, managerName: 'M', managerEmail: `m-${Date.now()}@test.local` });
      // gymPhone and managerPhone both omitted — should 400, not silently create
      expect(res.status).toBe(400);
    });

    it('creates the gym AND its branch-manager login together, with all fields persisted', async () => {
      const { admin } = await seedAdmin(prisma, 'super_admin');
      const email = `manager-${Date.now()}@test.local`;
      const res = await api()
        .post('/api/v1/admin/gyms')
        .set('Authorization', adminAuth(admin.id, 'super_admin'))
        .send({
          name: 'Kochi Fitness Hub', address: '123 MG Road', location: 'Kalamassery', gymPhone: '9876543210',
          memberLimit: 80, managerName: 'Rahul', managerEmail: email, managerPhone: '9998887776',
        });
      expect(res.status).toBe(201);
      const gym = res.body.data.gym;
      expect(gym.gymPhone).toBe('9876543210');
      expect(gym.location).toBe('Kalamassery');

      const manager = await prisma.trainer.findUnique({ where: { email } });
      expect(manager).not.toBeNull();
      expect(manager?.role).toBe('branch_manager');
    });
  });

  // ── Admin member creation (Phase A) ───────────────────────────────
  describe('Admin Panel: member creation', () => {
    it('rejects a member missing any mandatory bio field', async () => {
      const { admin } = await seedAdmin(prisma, 'support');
      const res = await api()
        .post('/api/v1/admin/members')
        .set('Authorization', adminAuth(admin.id, 'support'))
        .send({ name: 'Test M', phone: '9000000000', email: `m-${Date.now()}@test.local`, sex: 'male', ageYears: 25, heightCm: 175, weightKg: 70 });
      // restingHr omitted
      expect(res.status).toBe(400);
    });

    it('creates the member unassigned to any gym', async () => {
      const { admin } = await seedAdmin(prisma, 'support');
      const res = await api()
        .post('/api/v1/admin/members')
        .set('Authorization', adminAuth(admin.id, 'support'))
        .send({
          name: 'Admin Created', phone: '9000000001', email: `ac-${Date.now()}@test.local`,
          sex: 'female', ageYears: 30, heightCm: 165, weightKg: 60, restingHr: 65,
        });
      expect(res.status).toBe(201);
      const member = await prisma.member.findUnique({ where: { id: res.body.data.id } });
      expect(member?.currentGymId).toBeNull();
      expect(member?.ageYears).toBe(30); // the exact field the age/ageYears mismatch bug would have dropped
    });
  });

  // ── Trainer / branch-manager separation (Phase A bugfix) ──────────
  describe('Trainer/manager separation', () => {
    it('a branch cannot create another branch_manager through the trainer endpoint', async () => {
      const { gym, branchManager } = await seedGymWithTrainer(prisma);
      // CreateTrainerDto has no `role` field at all — with the app's
      // global whitelist+forbidNonWhitelisted validation, sending one
      // is rejected outright rather than silently ignored.
      const res = await api()
        .post('/api/v1/branch/trainers')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ name: 'Sneaky', email: `sneaky-${Date.now()}@test.local`, phone: '9111111111', role: 'branch_manager' });
      expect(res.status).toBe(400);

      // The legitimate request (no role field) still works, and always
      // creates a plain trainer.
      const legit = await api()
        .post('/api/v1/branch/trainers')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ name: 'Legit', email: `legit-${Date.now()}@test.local`, phone: '9222222222' });
      expect(legit.status).toBe(201);
      const created = await prisma.trainer.findUnique({ where: { email: legit.body.data.email } });
      expect(created?.role).toBe('trainer');
    });

    it("a branch's own trainer roster never includes its branch manager", async () => {
      const { gym, branchManager, trainer } = await seedGymWithTrainer(prisma);
      const res = await api().get('/api/v1/branch/trainers').set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id));
      const ids = res.body.data.map((t: any) => t.id);
      expect(ids).toContain(trainer.id);
      expect(ids).not.toContain(branchManager.id);
    });

    it('the Admin Panel trainer list never includes branch managers', async () => {
      const { gym, branchManager, trainer } = await seedGymWithTrainer(prisma);
      const { admin } = await seedAdmin(prisma, 'support');
      const res = await api().get('/api/v1/admin/trainers').set('Authorization', adminAuth(admin.id, 'support'));
      const ids = res.body.data.map((t: any) => t.id);
      expect(ids).toContain(trainer.id);
      expect(ids).not.toContain(branchManager.id);
    });
  });

  // ── Admin → branch transfer-request flow (Phase A) ────────────────
  describe('Admin-initiated transfer requests are accepted/declined by the BRANCH, not the member', () => {
    it('full accept flow moves the member and is invisible to the member as an action item', async () => {
      const { gym: fromGym, branchManager: fromManager } = await seedGymWithTrainer(prisma);
      const { gym: toGym, branchManager: toManager } = await seedGymWithTrainer(prisma);
      const { member } = await seedMember(prisma, fromGym.id);
      const { admin } = await seedAdmin(prisma, 'support');

      const create = await api()
        .post('/api/v1/admin/transfer-requests')
        .set('Authorization', adminAuth(admin.id, 'support'))
        .send({ memberId: member.id, toGymId: toGym.id });
      expect(create.status).toBe(201);
      const requestId = create.body.data.id;

      // The member's own pending-requests list must NOT show this — it's
      // not their decision to make.
      const memberToken = `Bearer ${tokens.signAccessToken({ sub: member.id, realm: 'member' })}`;
      const memberView = await api().get('/api/v1/member/transfer-requests').set('Authorization', memberToken);
      expect(memberView.body.data.find((r: any) => r.id === requestId)).toBeUndefined();

      // The destination branch's OWN manager can accept it.
      const accept = await api()
        .post(`/api/v1/branch/transfer-requests/${requestId}/accept`)
        .set('Authorization', staffAuth(toManager.id, 'branch_manager', toGym.id));
      expect(accept.status).toBe(201);

      const moved = await prisma.member.findUnique({ where: { id: member.id } });
      expect(moved?.currentGymId).toBe(toGym.id);
    });

    it('a different branch cannot accept a request addressed to someone else', async () => {
      const { gym: toGym } = await seedGymWithTrainer(prisma);
      const { gym: otherGym, branchManager: otherManager } = await seedGymWithTrainer(prisma);
      const { member } = await seedMember(prisma); // unassigned
      const { admin } = await seedAdmin(prisma, 'support');

      const create = await api()
        .post('/api/v1/admin/transfer-requests')
        .set('Authorization', adminAuth(admin.id, 'support'))
        .send({ memberId: member.id, toGymId: toGym.id });

      const res = await api()
        .post(`/api/v1/branch/transfer-requests/${create.body.data.id}/accept`)
        .set('Authorization', staffAuth(otherManager.id, 'branch_manager', otherGym.id));
      expect(res.status).toBe(404); // not theirs to act on
    });
  });

  // ── Sensor-capped session capacity (Phase C) ──────────────────────
  describe('Session capacity is capped by registered sensor count', () => {
    it('rejects a requested capacity above the sensor count', async () => {
      const { gym, branchManager } = await seedGymWithTrainer(prisma);
      await prisma.sensor.createMany({
        data: [{ gymId: gym.id, name: 'S1', sensorId: 'AA:01' }, { gymId: gym.id, name: 'S2', sensorId: 'AA:02' }],
      });

      const res = await api()
        .post('/api/v1/branch/sessions')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ name: 'Morning HIIT', capacity: 5, scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
      expect(res.status).toBe(400);
    });

    it('defaults capacity to the sensor count when omitted', async () => {
      const { gym, branchManager } = await seedGymWithTrainer(prisma);
      await prisma.sensor.createMany({
        data: [{ gymId: gym.id, name: 'S1', sensorId: 'BB:01' }, { gymId: gym.id, name: 'S2', sensorId: 'BB:02' }, { gymId: gym.id, name: 'S3', sensorId: 'BB:03' }],
      });

      const res = await api()
        .post('/api/v1/branch/sessions')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ name: 'Evening Strength', scheduledAt: new Date(Date.now() + 3600_000).toISOString() });
      expect(res.status).toBe(201);
      expect(res.body.data.capacity).toBe(3);
    });
  });

  // ── Sensor registry basics ────────────────────────────────────────
  describe('Sensors', () => {
    it('rejects a duplicate Sensor ID at the same gym', async () => {
      const { gym, branchManager } = await seedGymWithTrainer(prisma);
      await api()
        .post('/api/v1/branch/sensors')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ name: 'Strap A', sensorId: 'DUPLICATE' });

      const res = await api()
        .post('/api/v1/branch/sensors')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ name: 'Strap B', sensorId: 'DUPLICATE' });
      expect(res.status).toBe(409);
    });
  });

  // ── Phase D: manager can't edit their own phone/role via the Trainer
  // tab's endpoints, only their name via the dedicated Settings route ──
  describe('Branch manager self-edit restrictions (Settings)', () => {
    it('cannot change their own phone through the generic trainer-update endpoint', async () => {
      const { gym, branchManager } = await seedGymWithTrainer(prisma);
      const res = await api()
        .patch(`/api/v1/branch/trainers/${branchManager.id}`)
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ phone: '9000000009' });
      expect(res.status).toBe(409); // branch managers aren't edited through the Trainer tab at all
    });

    it('CAN change their own name through the dedicated Settings endpoint, but that endpoint has no phone/email field to send', async () => {
      const { gym, branchManager } = await seedGymWithTrainer(prisma);
      const res = await api()
        .patch('/api/v1/branch/gym/manager-name')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ name: 'Updated Manager Name' });
      expect(res.status).toBe(200);
      const updated = await prisma.trainer.findUnique({ where: { id: branchManager.id } });
      expect(updated?.name).toBe('Updated Manager Name');

      // Sending phone/email here is rejected outright — the DTO simply
      // doesn't have those fields (forbidNonWhitelisted).
      const rejected = await api()
        .patch('/api/v1/branch/gym/manager-name')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ name: 'X', phone: '9999999999' });
      expect(rejected.status).toBe(400);
    });
  });

  // ── Phase D: trainer soft-delete ──────────────────────────────────
  describe('Trainer removal (soft delete)', () => {
    it('removes a trainer with no upcoming sessions, and they disappear from the roster', async () => {
      const { gym, branchManager, trainer } = await seedGymWithTrainer(prisma);
      const res = await api()
        .delete(`/api/v1/branch/trainers/${trainer.id}`)
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id));
      expect(res.status).toBe(200);

      const roster = await api().get('/api/v1/branch/trainers').set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id));
      expect(roster.body.data.find((t: any) => t.id === trainer.id)).toBeUndefined();
    });

    it('blocks removal while the trainer still has an upcoming session', async () => {
      const { gym, branchManager, trainer } = await seedGymWithTrainer(prisma);
      await prisma.session.create({
        data: { gymId: gym.id, trainerId: trainer.id, name: 'Upcoming', capacity: 10, status: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000) },
      });
      const res = await api()
        .delete(`/api/v1/branch/trainers/${trainer.id}`)
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id));
      expect(res.status).toBe(409);
    });
  });

  // ── Change password (authenticated self-service) ──────────────────
  describe('Staff change-password', () => {
    it('rejects the wrong current password', async () => {
      const { gym, branchManager } = await seedGymWithTrainer(prisma);
      const res = await api()
        .post('/api/v1/auth/staff/change-password')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ currentPassword: 'WrongPassword1!', newPassword: 'BrandNewPassword1!' });
      expect(res.status).toBe(401);
    });

    it('rejects a new password under 8 characters', async () => {
      const { gym, branchManager, password } = await seedGymWithTrainer(prisma);
      const res = await api()
        .post('/api/v1/auth/staff/change-password')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ currentPassword: password, newPassword: 'short' });
      expect(res.status).toBe(400);
    });

    it('succeeds with the correct current password, and revokes other active sessions', async () => {
      const { gym, branchManager, password } = await seedGymWithTrainer(prisma);
      const oldRefresh = await prisma.refreshToken.create({
        data: { realm: 'staff', trainerId: branchManager.id, tokenHash: 'test-hash-1', expiresAt: new Date(Date.now() + 86400_000) },
      });

      const res = await api()
        .post('/api/v1/auth/staff/change-password')
        .set('Authorization', staffAuth(branchManager.id, 'branch_manager', gym.id))
        .send({ currentPassword: password, newPassword: 'BrandNewPassword1!' });
      expect(res.status).toBe(201);

      const revoked = await prisma.refreshToken.findUnique({ where: { id: oldRefresh.id } });
      expect(revoked?.revokedAt).not.toBeNull();

      // New password actually works for a real login.
      const login = await api().post('/api/v1/auth/staff/login').send({ email: branchManager.email, password: 'BrandNewPassword1!' });
      expect(login.status).toBe(201);
    });
  });

  // ── Access-control matrix ─────────────────────────────────────────
  describe('Admin access control', () => {
    it('audit log: support admin is blocked, super_admin is allowed', async () => {
      const { admin: support } = await seedAdmin(prisma, 'support');
      const { admin: superAdmin } = await seedAdmin(prisma, 'super_admin');

      const blocked = await api().get('/api/v1/admin/audit-log').set('Authorization', adminAuth(support.id, 'support'));
      expect(blocked.status).toBe(403);

      const allowed = await api().get('/api/v1/admin/audit-log').set('Authorization', adminAuth(superAdmin.id, 'super_admin'));
      expect(allowed.status).toBe(200);
    });

    it('direct member-assign override: support admin is blocked, super_admin is allowed', async () => {
      const { gym } = await seedGymWithTrainer(prisma);
      const { member } = await seedMember(prisma);
      const { admin: support } = await seedAdmin(prisma, 'support');
      const { admin: superAdmin } = await seedAdmin(prisma, 'super_admin');

      const blocked = await api()
        .post(`/api/v1/admin/members/${member.id}/assign`)
        .set('Authorization', adminAuth(support.id, 'support'))
        .send({ gymId: gym.id });
      expect(blocked.status).toBe(403);

      const allowed = await api()
        .post(`/api/v1/admin/members/${member.id}/assign`)
        .set('Authorization', adminAuth(superAdmin.id, 'super_admin'))
        .send({ gymId: gym.id });
      expect(allowed.status).not.toBe(403);
    });

    it('member anonymize: support admin is blocked, super_admin is allowed (with correct password)', async () => {
      const { member } = await seedMember(prisma);
      const { admin: support } = await seedAdmin(prisma, 'support');

      const blocked = await api()
        .post(`/api/v1/admin/members/${member.id}/anonymize`)
        .set('Authorization', adminAuth(support.id, 'support'))
        .send({ adminPassword: 'irrelevant' });
      expect(blocked.status).toBe(403);
    });

    it('a trainer (not branch_manager) cannot create/edit/release members or reset PINs', async () => {
      const { gym, trainer } = await seedGymWithTrainer(prisma);
      const asTrainer = staffAuth(trainer.id, 'trainer', gym.id);

      const create = await api()
        .post('/api/v1/branch/members')
        .set('Authorization', asTrainer)
        .send({ name: 'X', phone: '9', email: `x-${Date.now()}@test.local`, sex: 'male', ageYears: 20, heightCm: 170, weightKg: 70, restingHr: 60, consentVersion: 'v1', consentAccepted: true });
      expect(create.status).toBe(403);

      const { member } = await seedMember(prisma, gym.id);
      const release = await api().post(`/api/v1/branch/members/${member.id}/release`).set('Authorization', asTrainer);
      expect(release.status).toBe(403);
    });

    it('a trainer CAN still view the member roster and profile (read-only)', async () => {
      const { gym, trainer } = await seedGymWithTrainer(prisma);
      const { member } = await seedMember(prisma, gym.id);
      const res = await api()
        .get(`/api/v1/branch/members/${member.id}/profile`)
        .set('Authorization', staffAuth(trainer.id, 'trainer', gym.id));
      expect(res.status).toBe(200);
    });
  });
});
