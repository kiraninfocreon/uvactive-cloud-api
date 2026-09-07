#!/usr/bin/env node
/**
 * Serializes `prisma migrate deploy` across the UV Active backends that
 * share one Postgres database (admin-panel, branch-portal, cloud-api).
 *
 * All three run migrations on every deploy, so without coordination two
 * simultaneous deploys can race on the same migration — one applies it,
 * the other crashes with "relation already exists" (42P07), gets recorded
 * as a failed migration in _prisma_migrations, and blocks every later
 * deploy with P3009 until it is manually resolved.
 *
 * This wrapper takes a Postgres session-level advisory lock before running
 * `prisma migrate deploy`, so only one deployer applies DDL at a time and
 * the rest wait their turn. Migrations are still applied automatically on
 * every deploy of every backend; nothing about the schema or data changes.
 *
 * Requirements:
 *  - DATABASE_URL must be set (the same variable prisma migrate deploy
 *    already uses).
 *  - Use the DIRECT (non-pooled) connection string for migrations.
 *    Session-level advisory locks are tied to a single connection and do
 *    not survive PgBouncer/Neon pooled sessions bouncing between backends.
 */
'use strict';

const { Client } = require('pg');
const { spawnSync } = require('child_process');

// App-wide advisory lock key. MUST be identical in admin-panel,
// branch-portal and cloud-api so all three contend on the same lock.
const MIGRATION_LOCK_KEY = 791530001;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate-deploy] DATABASE_URL is not set — cannot run prisma migrate deploy.');
    process.exit(1);
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  console.log('[migrate-deploy] waiting for the shared migration lock...');
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
  console.log('[migrate-deploy] lock acquired — applying migrations');

  let exitCode = 0;
  try {
    // npx resolves the locally installed prisma CLI (same as the
    // project's own npm scripts). On Windows the npx shim is a .cmd
    // file, so run the whole command through a shell there.
    const isWin = process.platform === 'win32';
    const result = isWin
      ? spawnSync('npx prisma migrate deploy', { stdio: 'inherit', shell: true })
      : spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit' });
    if (result.error) throw result.error;
    exitCode = result.status ?? 1;
  } finally {
    // Always release the lock — even if migrate deploy failed — so the
    // other deployers do not wait forever.
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    await client.end().catch(() => {});
  }

  console.log('[migrate-deploy] done');
  if (exitCode !== 0) process.exit(exitCode);
}

main().catch((err) => {
  console.error('[migrate-deploy] failed:', err.message);
  process.exit(1);
});
