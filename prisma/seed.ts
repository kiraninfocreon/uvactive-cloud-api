// Run with: npm run seed
// Bootstraps the FIRST super_admin account. There is deliberately no
// public API route that can create the first admin — every subsequent
// admin is created via POST /admin/admins by an existing super_admin
// (see src/admins/admins.service.ts). This script is meant to run once,
// against production, from a trusted operator's machine or a one-off
// deploy-time job — never left runnable from an exposed endpoint.
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import * as readline from 'readline';

const prisma = new PrismaClient();

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans); }));
}

async function main() {
  const existingCount = await prisma.admin.count();
  if (existingCount > 0) {
    console.log(`There are already ${existingCount} admin account(s). Refusing to seed again — use POST /admin/admins instead.`);
    process.exit(1);
  }

  const name = (await ask('Super admin name: ')).trim();
  const email = (await ask('Super admin email: ')).trim().toLowerCase();
  const password = (await ask('Super admin password (min 12 chars): ')).trim();

  if (password.length < 12) {
    console.error('Password too short — use at least 12 characters for the first super_admin.');
    process.exit(1);
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const admin = await prisma.admin.create({
    data: { name, email, passwordHash, role: 'super_admin' },
  });

  console.log(`\nCreated super_admin ${admin.email} (${admin.id}).`);
  console.log('TOTP is not yet set up — the first POST /auth/admin/login with this password will return');
  console.log('{ setupRequired: true, setupToken }. Use that token with /auth/admin/totp/setup and');
  console.log('/auth/admin/totp/confirm to finish onboarding before this account can fully log in.\n');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
