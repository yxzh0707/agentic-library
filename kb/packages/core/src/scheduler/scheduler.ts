import cron, { type ScheduledTask } from 'node-cron';
import type { DB } from '../storage/db.js';
import type { LibrarianAgent } from '../agents/librarian.js';
import { CRON_BACKGROUND, CRON_MONTHLY, CRON_WEEKLY, type SchedulerJobName } from '@kb/shared';
import { logger } from '../util/logger.js';
import { nowIso } from '../util/now.js';

const INTERVALS_MS: Record<SchedulerJobName, number> = {
  weekly: 7 * 24 * 3600_000,
  monthly: 30 * 24 * 3600_000,
  background: 15 * 60_000,
};

export interface SchedulerDeps {
  db: DB;
  librarian: LibrarianAgent;
}

export class Scheduler {
  private tasks: ScheduledTask[] = [];

  constructor(private deps: SchedulerDeps) {}

  start() {
    this.catchUp();
    this.tasks.push(
      cron.schedule(CRON_WEEKLY, () => void this.runJob('weekly')),
      cron.schedule(CRON_MONTHLY, () => void this.runJob('monthly')),
      cron.schedule(CRON_BACKGROUND, () => void this.runJob('background')),
    );
    logger.info('scheduler started');
  }

  stop() {
    for (const t of this.tasks) t.stop();
    this.tasks = [];
  }

  private catchUp() {
    const rows = this.deps.db.prepare('SELECT * FROM scheduler_state').all() as {
      job_name: SchedulerJobName;
      last_run_at: string | null;
    }[];
    for (const r of rows) {
      const interval = INTERVALS_MS[r.job_name];
      if (interval === undefined) continue;
      const last = r.last_run_at ? new Date(r.last_run_at).getTime() : 0;
      if (Date.now() - last >= interval) {
        logger.info({ job: r.job_name }, 'catch-up triggered');
        void this.runJob(r.job_name);
      }
    }
  }

  async runJob(name: SchedulerJobName) {
    logger.info({ job: name }, 'job start');
    try {
      if (name === 'weekly') await this.deps.librarian.runOnReview();
      else if (name === 'monthly') await this.deps.librarian.runMonthly();
      else if (name === 'background') await this.deps.librarian.runBackgroundPass();
      this.deps.db
        .prepare(
          `INSERT INTO scheduler_state (job_name, last_run_at, next_run_at, last_status)
           VALUES (?, ?, NULL, 'completed')
           ON CONFLICT(job_name) DO UPDATE SET last_run_at=excluded.last_run_at, last_status='completed'`,
        )
        .run(name, nowIso());
    } catch (err) {
      logger.error({ err, job: name }, 'job failed');
      this.deps.db
        .prepare(
          `INSERT INTO scheduler_state (job_name, last_run_at, next_run_at, last_status)
           VALUES (?, ?, NULL, 'failed')
           ON CONFLICT(job_name) DO UPDATE SET last_run_at=excluded.last_run_at, last_status='failed'`,
        )
        .run(name, nowIso());
    }
  }
}
