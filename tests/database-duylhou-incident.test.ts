/**
 * =============================================================================
 * Unit tests — duylhouIncident index round-trip
 *
 * Verifies that:
 *   1  recordDuylhouIncident writes to the in-memory index.
 *   2  The incident survives a flush → reload cycle (atomic write + parse).
 *   3  The leaderboard counter increments correctly across multiple incidents.
 *   4  cleanupOldIncidents removes only stale entries from the index.
 *   5  getStats reflects the current index size, not a stale array.
 *
 * Uses a temporary directory for the database file so nothing touches the
 * real `data/` folder.  The temp dir is removed after every test.
 * =============================================================================
 */

import * as fs   from 'fs/promises';
import * as path from 'path';
import * as os   from 'os';
import { createDatabase } from '../src/database/database';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a fresh, empty database in an isolated temp directory.
 *
 * @returns A tuple of [database instance, path to the temp dir].
 */
/**
 * Waits for a database instance's internal async init() to finish.
 *
 * init() is fire-and-forget inside the constructor.  When the DB file
 * already exists on disk (reload path) init reads + parses it, sets
 * `initialized = true`, and calls rebuildIndexes — all inside one
 * microtask chain that we cannot await from outside.  A fixed 500 ms
 * wait is more than sufficient for local-disk I/O and is the simplest
 * reliable approach without modifying the Database internals.
 *
 * @param _db     - (unused, kept for call-site clarity)
 * @param _tmpDir - (unused)
 */
async function waitForInit(_db: unknown, _tmpDir: string) {
  await new Promise((r) => setTimeout(r, 500));
}

async function makeTempDb() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'duylhou-test-'));
  const [err, db] = createDatabase({
    dataDir: tmpDir,
    persistIntervalMs: 999_999,
    linkExpiryMs: 24 * 60 * 60 * 1000,
    conversationMaxMessages: 10,
    leaderboardRetentionDays: 30,
    cleanupIntervalMs: 999_999,
  });

  if (err || !db) throw new Error(`DB init failed: ${err?.message}`);
  await waitForInit(db, tmpDir);
  return { db, tmpDir };
}

/**
 * Reads the raw JSON file that flush() produced and returns the parsed object.
 *
 * @param tmpDir - The temp directory where database.json lives.
 */
async function readRawJson(tmpDir: string) {
  const raw = await fs.readFile(path.join(tmpDir, 'database.json'), 'utf-8');
  return JSON.parse(raw);
}

/**
 * Removes the temp directory and all its contents.
 *
 * @param tmpDir - The temp directory to clean up.
 */
async function cleanup(tmpDir: string) {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Test runner (no external framework — just assertions + exit code)
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

/**
 * Runs a single named test case.  Catches and reports any thrown error.
 *
 * @param name - Human-readable test label.
 * @param fn   - Async test body.
 */
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (e: unknown) {
    console.error(`  ❌  ${name}`);
    console.error(`       ${(e as Error).message}`);
    failed++;
  }
}

/**
 * Throws when the condition is falsy.
 *
 * @param cond    - Value to check.
 * @param message - Error message when `cond` is falsy.
 */
function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log('\n── duylhouIncident index round-trip ──\n');

  // -----------------------------------------------------------------------
  // 1. Single incident writes to index and appears in stats
  // -----------------------------------------------------------------------
  await test('single incident → stats.incidents === 1', async () => {
    const { db, tmpDir } = await makeTempDb();
    try {
      const incident = db.recordDuylhouIncident(
        100,   // offenderId
        200,   // originalUserId
        -1234, // chatId
        'youtube.com/watch?v=abc123',
      );

      assert(incident.id === 1, `expected id 1, got ${incident.id}`);
      assert(incident.offenderId === 100, 'offenderId mismatch');
      assert(incident.originalUserId === 200, 'originalUserId mismatch');

      const stats = db.getStats();
      assert(stats.incidents === 1, `expected 1 incident in stats, got ${stats.incidents}`);
    } finally {
      await db.shutdown();
      await cleanup(tmpDir);
    }
  });

  // -----------------------------------------------------------------------
  // 2. Flush writes incidents to disk; reload recovers them
  // -----------------------------------------------------------------------
  await test('flush → disk → reload preserves incidents', async () => {
    const { db, tmpDir } = await makeTempDb();
    try {
      db.recordDuylhouIncident(100, 200, -1234, 'youtube.com/watch?v=aaa');
      db.recordDuylhouIncident(101, 200, -1234, 'youtube.com/watch?v=bbb');

      // Force flush to disk
      const flushErr = await db.flush();
      assert(!flushErr, `flush returned error: ${flushErr?.message}`);

      // Read raw JSON — incidents array must have 2 entries
      const raw = await readRawJson(tmpDir);
      assert(
        Array.isArray(raw.duylhouIncidents) && raw.duylhouIncidents.length === 2,
        `expected 2 incidents on disk, got ${raw.duylhouIncidents?.length}`,
      );

      // Now create a SECOND database instance pointing at the same dir — simulates restart.
      // Shut down the first instance first so its timers don't race with the reload.
      await db.shutdown();

      const [err2, db2] = createDatabase({
        dataDir: tmpDir,
        persistIntervalMs: 999_999,
        linkExpiryMs: 24 * 60 * 60 * 1000,
        conversationMaxMessages: 10,
        leaderboardRetentionDays: 30,
        cleanupIntervalMs: 999_999,
      });
      assert(!err2 && db2, 'second DB instance failed to init');
      await waitForInit(db2, tmpDir);

      const stats2 = db2!.getStats();
      assert(stats2.incidents === 2, `reloaded DB has ${stats2.incidents} incidents, expected 2`);

      await db2!.shutdown();
    } finally {
      await db.shutdown();
      await cleanup(tmpDir);
    }
  });

  // -----------------------------------------------------------------------
  // 3. Leaderboard increments correctly across multiple incidents
  // -----------------------------------------------------------------------
  await test('leaderboard count increments for repeated offender', async () => {
    const { db, tmpDir } = await makeTempDb();
    try {
      // Same offender, three different URLs
      db.recordDuylhouIncident(42, 99, -5000, 'instagram.com/p/aaa');
      db.recordDuylhouIncident(42, 99, -5000, 'instagram.com/p/bbb');
      db.recordDuylhouIncident(42, 99, -5000, 'instagram.com/p/ccc');

      const board = db.getDuylhouLeaderboard(undefined, 10);
      assert(board.length === 1, `expected 1 leaderboard entry, got ${board.length}`);
      assert(board[0].count === 3, `expected count 3, got ${board[0].count}`);
      assert(board[0].userId === 42, `expected userId 42, got ${board[0].userId}`);
    } finally {
      await db.shutdown();
      await cleanup(tmpDir);
    }
  });

  // -----------------------------------------------------------------------
  // 4. cleanupOldIncidents removes only stale entries
  // -----------------------------------------------------------------------
  await test('cleanupOldIncidents removes old, keeps current month', async () => {
    const { db, tmpDir } = await makeTempDb();
    try {
      // Record one incident in the current month (normal path)
      db.recordDuylhouIncident(10, 20, -9999, 'tiktok.com/@x/video/111');

      // Manually inject an OLD incident (3 months ago) directly via flush trickery:
      // We flush first, then patch the JSON on disk, then reload.
      await db.flush();

      const raw = await readRawJson(tmpDir);
      const oldDate = new Date();
      oldDate.setMonth(oldDate.getMonth() - 3);
      const oldMonth = `${oldDate.getFullYear()}-${String(oldDate.getMonth() + 1).padStart(2, '0')}`;

      raw.duylhouIncidents.push({
        id: 9999,
        offenderId: 77,
        originalUserId: 88,
        chatId: -9999,
        normalizedUrl: 'reddit.com/r/test/comments/old',
        createdAt: oldDate.getTime(),
        month: oldMonth,
      });
      raw.meta.duylhouIncidentNextId = 10000;

      // Write patched JSON back
      await fs.writeFile(
        path.join(tmpDir, 'database.json'),
        JSON.stringify(raw, null, 2),
        'utf-8',
      );

      // Shut down the first instance before reloading so timers don't race.
      await db.shutdown();

      // Reload with a very high retention so the automatic startup
      // cleanup does NOT remove our injected 3-month-old incident.
      // We test cleanupOldIncidents(1) explicitly below.
      const [err2, db2] = createDatabase({
        dataDir: tmpDir,
        persistIntervalMs: 999_999,
        linkExpiryMs: 24 * 60 * 60 * 1000,
        conversationMaxMessages: 10,
        leaderboardRetentionDays: 999,   // ← disable auto-cleanup of old incidents
        cleanupIntervalMs: 999_999,
      });
      assert(!err2 && db2, 'reload failed');
      await waitForInit(db2, tmpDir);

      // Before cleanup: 2 incidents (1 current + 1 old)
      const statsBefore = db2!.getStats();
      assert(statsBefore.incidents === 2, `pre-cleanup expected 2, got ${statsBefore.incidents}`);

      // Run cleanup with monthsToKeep = 1  (keeps current month only)
      db2!.cleanupOldIncidents(1);

      const statsAfter = db2!.getStats();
      assert(statsAfter.incidents === 1, `post-cleanup expected 1, got ${statsAfter.incidents}`);

      await db2!.shutdown();
    } finally {
      await db.shutdown();
      await cleanup(tmpDir);
    }
  });

  // -----------------------------------------------------------------------
  // 5. No .tmp file lingers after a successful flush
  // -----------------------------------------------------------------------
  await test('no stale .tmp file after successful flush', async () => {
    const { db, tmpDir } = await makeTempDb();
    try {
      db.recordDuylhouIncident(1, 2, -111, 'x.com/user/status/12345');
      await db.flush();

      const files = await fs.readdir(tmpDir);
      const tmpFiles = files.filter((f) => f.endsWith('.tmp'));
      assert(tmpFiles.length === 0, `found stale .tmp files: ${tmpFiles.join(', ')}`);
    } finally {
      await db.shutdown();
      await cleanup(tmpDir);
    }
  });

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error('Test runner crashed:', e);
  process.exit(1);
});
