// SQLite-based state management for Claude Code Bugbot Autofix.
// Tracks which Cursor Bugbot bug IDs have been processed
// to prevent duplicate fix attempts, and how many times a failed
// bug has been retried so retries can be capped and backed off.
// Limitations: Single-process only; no concurrent access support.

import Database from "better-sqlite3";
import { dirname } from "path";
import { mkdirSync } from "fs";

import { logger } from "./logger.js";
import type { ProcessedBugRecord } from "./types.js";

// Values stored in fix_commit_sha. Anything other than FAILED is terminal:
// the bug is never picked up again.
export const BUG_STATUS = {
  FAILED: "FAILED",
  FAILED_PERMANENT: "FAILED_PERMANENT",
  SKIPPED_NO_CHANGES: "SKIPPED_NO_CHANGES",
  SKIPPED_PR_CLOSED: "SKIPPED_PR_CLOSED",
  SKIPPED_RESOLVED: "SKIPPED_RESOLVED",
} as const;

// A bug that keeps failing is given up on after this many counted attempts.
// Without a cap, an unfixable bug re-runs a full fix generation every cycle.
export const MAX_FIX_ATTEMPTS = 3;

// Minimum wait before retrying a failed bug, indexed by attempts already
// counted. Transient failures don't count an attempt, so they land on the
// first entry and simply stop the every-cycle hammering.
const RETRY_BACKOFF_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000];

// A live bug resolves within an hour (3 attempts, 30 min of backoff at most).
// A FAILED row older than this is one whose comment discovery never returned
// again — deleted, or aged out of the lookback window. Left alone it would
// keep the repo on the widened scan window forever, so it is retired instead.
const STALE_FAILURE_MS = 24 * 60 * 60 * 1000;

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initializeSchema();

    logger.debug("State store initialized.", { dbPath });
  }

  // ============================================================
  // Schema initialization
  // ============================================================

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_bugs (
        bug_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        processed_at TEXT NOT NULL,
        fix_commit_sha TEXT,
        attempts INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_processed_bugs_repo_pr
        ON processed_bugs (repo, pr_number);
    `);

    this.migrateAttemptsColumn();
  }

  // Databases created before retry capping lack the attempts column.
  private migrateAttemptsColumn(): void {
    const columns = this.db
      .prepare("PRAGMA table_info(processed_bugs)")
      .all() as Array<{ name: string }>;

    if (columns.some((column) => column.name === "attempts")) return;

    this.db.exec(
      "ALTER TABLE processed_bugs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0"
    );
    logger.info("Migrated state DB: added processed_bugs.attempts column.");
  }

  // ============================================================
  // Bug tracking
  // ============================================================

  isBugProcessed(bugId: string): boolean {
    const row = this.db
      .prepare("SELECT fix_commit_sha FROM processed_bugs WHERE bug_id = ?")
      .get(bugId) as { fix_commit_sha: string | null } | undefined;
    // Only FAILED bugs should be retried; every other status is terminal
    return row !== undefined && row.fix_commit_sha !== BUG_STATUS.FAILED;
  }

  // True while a failed bug is still inside its backoff window. Keeps a
  // repeatedly failing bug from re-running a fix generation every cycle.
  isInRetryBackoff(bugId: string, now: number = Date.now()): boolean {
    const row = this.db
      .prepare(
        "SELECT processed_at, attempts, fix_commit_sha FROM processed_bugs WHERE bug_id = ?"
      )
      .get(bugId) as
      | { processed_at: string; attempts: number; fix_commit_sha: string | null }
      | undefined;

    if (!row || row.fix_commit_sha !== BUG_STATUS.FAILED) return false;

    const lastAttempt = Date.parse(row.processed_at);
    if (Number.isNaN(lastAttempt)) return false;

    const index = Math.min(
      Math.max(row.attempts, 0),
      RETRY_BACKOFF_MS.length - 1
    );
    return now - lastAttempt < RETRY_BACKOFF_MS[index];
  }

  // Retire FAILED rows that discovery has stopped surfacing, so they cannot
  // hold a repo on the widened scan window indefinitely. Returns the number
  // of rows retired.
  expireStaleFailures(now: number = Date.now()): number {
    const cutoff = new Date(now - STALE_FAILURE_MS).toISOString();
    const result = this.db
      .prepare(
        `UPDATE processed_bugs SET fix_commit_sha = ?
         WHERE fix_commit_sha = ? AND processed_at < ?`
      )
      .run(BUG_STATUS.FAILED_PERMANENT, BUG_STATUS.FAILED, cutoff);

    if (result.changes > 0) {
      logger.info(
        `Retired ${result.changes} stale failed bug(s) that were never re-discovered.`,
        { cutoff }
      );
    }

    return result.changes;
  }

  hasRetryableBugsForRepo(repo: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM processed_bugs WHERE fix_commit_sha = ? AND repo = ? LIMIT 1"
      )
      .get(BUG_STATUS.FAILED, repo);
    return row !== undefined;
  }

  recordProcessedBug(
    bugId: string,
    repo: string,
    prNumber: number,
    fixCommitSha: string | null
  ): void {
    this.recordProcessedBugs([{ bugId, repo, prNumber }], fixCommitSha);
  }

  recordProcessedBugs(
    bugs: Array<{ bugId: string; repo: string; prNumber: number }>,
    fixCommitSha: string | null
  ): void {
    // Upsert rather than INSERT OR REPLACE so the attempt counter survives.
    const upsert = this.db.prepare(
      `INSERT INTO processed_bugs
       (bug_id, repo, pr_number, processed_at, fix_commit_sha, attempts)
       VALUES (?, ?, ?, ?, ?, 0)
       ON CONFLICT(bug_id) DO UPDATE SET
         repo = excluded.repo,
         pr_number = excluded.pr_number,
         processed_at = excluded.processed_at,
         fix_commit_sha = excluded.fix_commit_sha`
    );

    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      for (const bug of bugs) {
        upsert.run(bug.bugId, bug.repo, bug.prNumber, now, fixCommitSha);
      }
    });

    transaction();

    logger.debug(`Recorded ${bugs.length} processed bug(s).`, {
      fixCommitSha,
      bugIds: bugs.map((b) => b.bugId),
    });
  }

  // Record a retryable failure. countAttempt is false for transient failures
  // (usage limits, expired auth, network errors) so an outage that is not the
  // bug's fault cannot exhaust its retry budget. Returns the attempt count
  // per bug so the caller can give up once the cap is reached.
  recordFailedBugs(
    bugs: Array<{ bugId: string; repo: string; prNumber: number }>,
    options: { countAttempt: boolean }
  ): Array<{ bugId: string; attempts: number }> {
    const increment = options.countAttempt ? 1 : 0;

    const upsert = this.db.prepare(
      `INSERT INTO processed_bugs
       (bug_id, repo, pr_number, processed_at, fix_commit_sha, attempts)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(bug_id) DO UPDATE SET
         repo = excluded.repo,
         pr_number = excluded.pr_number,
         processed_at = excluded.processed_at,
         fix_commit_sha = excluded.fix_commit_sha,
         attempts = processed_bugs.attempts + ?`
    );
    const readAttempts = this.db.prepare(
      "SELECT attempts FROM processed_bugs WHERE bug_id = ?"
    );

    const now = new Date().toISOString();
    const transaction = this.db.transaction(() => {
      const results: Array<{ bugId: string; attempts: number }> = [];
      for (const bug of bugs) {
        upsert.run(
          bug.bugId,
          bug.repo,
          bug.prNumber,
          now,
          BUG_STATUS.FAILED,
          increment,
          increment
        );
        const row = readAttempts.get(bug.bugId) as
          | { attempts: number }
          | undefined;
        results.push({ bugId: bug.bugId, attempts: row?.attempts ?? increment });
      }
      return results;
    });

    const results = transaction();

    logger.debug(`Recorded ${bugs.length} failed bug attempt(s).`, {
      countAttempt: options.countAttempt,
      results,
    });

    return results;
  }

  getProcessedBugsForPr(
    repo: string,
    prNumber: number
  ): ProcessedBugRecord[] {
    const rows = this.db
      .prepare(
        "SELECT bug_id, repo, pr_number, processed_at, fix_commit_sha FROM processed_bugs WHERE repo = ? AND pr_number = ?"
      )
      .all(repo, prNumber) as Array<{
        bug_id: string;
        repo: string;
        pr_number: number;
        processed_at: string;
        fix_commit_sha: string | null;
      }>;

    return rows.map((row) => ({
      bugId: row.bug_id,
      repo: row.repo,
      prNumber: row.pr_number,
      processedAt: row.processed_at,
      fixCommitSha: row.fix_commit_sha,
    }));
  }

  // ============================================================
  // Cleanup
  // ============================================================

  close(): void {
    this.db.close();
    logger.debug("State store closed.");
  }
}
