// src/server/runReport.ts
// §7 report for the bot's noon batch (and the rehearsal): one JSON file per
// run under reports/, one `[result]` log line per account, and 30-day
// retention of bot-run reports + dated screenshot folders.
//
// Before this existed only the CLI runner (src/runner.ts) wrote a report; the
// bot — the path that actually books every day — left the per-account result
// only in Telegram DMs, and `<username>.png` was overwritten daily.
//
// Every write here is best-effort: a failure is logged and swallowed, never
// thrown — the report must never get in the way of the results DMs.

import * as fs from 'fs';
import * as path from 'path';
import type { BookingResult } from '../bookingFlow';
import type { EngineResult } from './bookingEngine';

/** Keep bot-run reports and dated screenshot folders this many days. */
export const ARTIFACT_RETENTION_DAYS = 30;

export function reportsDir(): string {
  return process.env.REPORTS_DIR ?? path.resolve(__dirname, '..', '..', 'reports');
}

/** Base screenshot folder; each run writes into `<base>/<YYYY-MM-DD>/`. */
export function screenshotsBaseDir(): string {
  return process.env.SCREENSHOTS_DIR ?? '/app/screenshots'; // overridden via env in deploy
}

/** Calendar date (YYYY-MM-DD) in Asia/Bangkok, independent of the host TZ. */
export function bangkokDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** `[result] <username> <status> court=<booked|-> slot=<slot> <ms>ms reason=<reason|->` */
export function formatResultLine(r: BookingResult, tag = '[result]'): string {
  return (
    `${tag} ${r.username} ${r.status} court=${r.court_booked ?? '-'} slot=${r.slot} ` +
    `${r.duration_ms}ms reason=${r.fail_reason ?? '-'}`
  );
}

function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function countStatuses(results: BookingResult[]): Record<BookingResult['status'], number> {
  const counts = { PASS: 0, FAIL: 0, ERROR: 0, 'DRY-RUN': 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

/**
 * Collects one batch's results and writes `reports/bot-run-<fire ISO>.json`.
 *
 * `settle` is fed from onAccountSettled, so a batch that throws still gets a
 * report of whatever settled. `late` takes results that finished after their
 * settle budget already reported them as ERROR (see bookingEngine): before the
 * report is written they go into its `late` array, afterwards into a separate
 * `bot-run-<fire ISO>.late.json`.
 */
export interface RunReporter {
  settle(index: number, result: BookingResult): void;
  late(index: number, result: BookingResult): void;
  /** Write the report (never throws). Returns the file path, or null on failure. */
  write(engine?: EngineResult, error?: unknown): string | null;
}

export function createRunReporter(opts: {
  fireTime: Date;
  mode: 'prewarm' | 'standard';
  count: number;
}): RunReporter {
  const settled: (BookingResult | undefined)[] = new Array(opts.count);
  const lateResults: BookingResult[] = [];
  const stamp = opts.fireTime.toISOString().replace(/[:.]/g, '-');
  const file = path.join(reportsDir(), `bot-run-${stamp}.json`);
  const lateFile = path.join(reportsDir(), `bot-run-${stamp}.late.json`);
  let written = false;

  const writeLate = (): void => {
    try {
      writeJsonAtomic(lateFile, { fire_time: opts.fireTime.toISOString(), late: lateResults });
      console.log(`[report] late results → ${lateFile}`);
    } catch (err) {
      console.warn(`[report] late write failed: ${err}`);
    }
  };

  return {
    settle(index, result) {
      if (index >= 0 && index < settled.length) settled[index] = result;
    },
    late(_index, result) {
      lateResults.push(result);
      if (written) writeLate();
    },
    write(engine, error) {
      try {
        const accounts = engine
          ? engine.results
          : settled.filter((r): r is BookingResult => r !== undefined);
        const firedAt = engine?.fired_at ?? null;
        const report: Record<string, unknown> = {
          fire_time: opts.fireTime.toISOString(),
          fired_at: firedAt,
          drift_ms:
            engine?.drift_ms ??
            (firedAt ? Date.parse(firedAt) - opts.fireTime.getTime() : null),
          mode: engine?.mode ?? opts.mode,
          prewarm: engine?.prewarm ?? null,
          total_ms: engine?.total_ms ?? null,
          counts: countStatuses(accounts),
          accounts,
        };
        if (lateResults.length > 0) report.late = lateResults;
        if (error !== undefined) report.error = String(error);
        writeJsonAtomic(file, report);
        written = true;
        console.log(`[report] wrote ${file} (${accounts.length} account(s))`);
        pruneOldArtifacts(new Date());
        return file;
      } catch (err) {
        console.warn(`[report] write failed: ${err}`);
        return null;
      }
    },
  };
}

/**
 * Retention: delete `reports/bot-run-*` files and `screenshots/<YYYY-MM-DD>/`
 * folders dated more than ARTIFACT_RETENTION_DAYS before `now` (Bangkok
 * date). Nothing else in either folder is touched — CLI reports, discovery
 * dumps and legacy root-level screenshots stay. Names whose date cannot be
 * parsed are left alone. Never throws.
 */
export function pruneOldArtifacts(
  now: Date,
  dirs: { reports: string; screenshots: string } = {
    reports: reportsDir(),
    screenshots: screenshotsBaseDir(),
  }
): void {
  const cutoff = bangkokDate(new Date(now.getTime() - ARTIFACT_RETENTION_DAYS * 86_400_000));
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dirs.reports)) {
      const m = /^bot-run-(\d{4}-\d{2}-\d{2})T/.exec(name);
      if (!m || m[1] >= cutoff) continue;
      fs.rmSync(path.join(dirs.reports, name), { force: true });
      removed += 1;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[report] retention (reports) failed: ${err}`);
    }
  }
  try {
    for (const entry of fs.readdirSync(dirs.screenshots, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      if (entry.name >= cutoff) continue;
      fs.rmSync(path.join(dirs.screenshots, entry.name), { recursive: true, force: true });
      removed += 1;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[report] retention (screenshots) failed: ${err}`);
    }
  }
  if (removed > 0) {
    console.log(`[report] retention: removed ${removed} item(s) older than ${cutoff}`);
  }
}
