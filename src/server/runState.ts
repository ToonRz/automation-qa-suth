// src/server/runState.ts
// Missed-noon watchdog state (config/run-state.json, gitignored).
//
// Between 2026-09-01 and 09-28 the noon run silently did not happen on 6 days:
// the Mac was asleep at 11:55 (lid closed on battery), node-cron does not fire
// missed schedules on wake, and nothing told anyone. The bot now records when
// the 11:55 cron fired and when the dispatch happened (FIRE, or SKIPPED by the
// drift guard — the user already gets a missed-deadline DM for that), and a
// watchdog DMs the owner once per day if 12:05 passes with no dispatch.
//
// Dates are Asia/Bangkok calendar dates regardless of the host TZ. Every
// write is atomic (tmp + rename) and never throws — like the court-id cache,
// a lost write only costs an alert, never the booking.

import * as fs from 'fs';
import * as path from 'path';
import { bangkokDate } from './runReport';

export interface RunState {
  last_cron_fired_date?: string;
  last_dispatch_date?: string;
  missed_alert_date?: string;
}

/** Earliest Bangkok time-of-day (minutes) the watchdog may alert: 12:05. */
export const MISSED_ALERT_FROM_MINUTES = 12 * 60 + 5;

// RUN_STATE_PATH override exists for test harnesses, like COURT_IDS_PATH.
function statePath(): string {
  return (
    process.env.RUN_STATE_PATH ?? path.resolve(__dirname, '..', '..', 'config', 'run-state.json')
  );
}

/** The state file, or null when it is missing or unreadable. */
export function readRunState(): RunState | null {
  try {
    const raw = JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as unknown;
    return typeof raw === 'object' && raw !== null ? (raw as RunState) : null;
  } catch {
    return null;
  }
}

export function updateRunState(patch: RunState): void {
  const file = statePath();
  try {
    const next = { ...(readRunState() ?? {}), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[watchdog] run-state write failed: ${err}`);
  }
}

export function recordCronFired(now = new Date()): void {
  updateRunState({ last_cron_fired_date: bangkokDate(now) });
}

export function recordDispatch(now = new Date()): void {
  updateRunState({ last_dispatch_date: bangkokDate(now) });
}

/** Bangkok wall-clock pieces for `d`. */
function bangkokClock(d: Date): { date: string; hhmm: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Bangkok',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  return { date: bangkokDate(d), hhmm, minutes: hour * 60 + minute };
}

/**
 * One watchdog check. DMs the owner (via `send`) when, for today's Bangkok
 * date: it is 12:05 or later, a run was due (`shouldRunToday` — some user with
 * cron on and accounts), no dispatch was recorded, and no alert was sent yet.
 * The alert date is persisted only after `send` succeeds, so a Telegram
 * outage retries on the next check; `send` errors propagate to the caller.
 *
 * Never books anything retroactively — past 12:00 there is nothing to win and
 * it would break SC-04.
 *
 * No state file at all (first start of this version) after 12:05: today's
 * noon predates tracking, so the file is created with today marked as
 * handled instead of raising a false alarm; alerts start tomorrow.
 *
 * Returns true when an alert was sent.
 */
export async function checkMissedNoon(opts: {
  shouldRunToday: () => boolean;
  send: (text: string) => Promise<void>;
  now?: Date;
}): Promise<boolean> {
  const now = opts.now ?? new Date();
  const { date, hhmm, minutes } = bangkokClock(now);
  if (minutes < MISSED_ALERT_FROM_MINUTES) return false;

  const state = readRunState();
  if (state === null) {
    updateRunState({ missed_alert_date: date });
    console.log(
      `[watchdog] run-state created at ${hhmm} — today's noon predates tracking, alerts start tomorrow`
    );
    return false;
  }
  if (state.last_dispatch_date === date || state.missed_alert_date === date) return false;
  if (!opts.shouldRunToday()) return false;

  console.warn(`[watchdog] missed noon run (${date}, noticed at ${hhmm})`);
  await opts.send(
    `⚠️ พลาดรอบ 12:00 วันนี้ — bot ไม่ได้ยิง (เครื่องหลับ/ปิดอยู่ช่วง 11:55–12:00?) ตื่นมาเวลา ${hhmm}`
  );
  updateRunState({ missed_alert_date: date });
  return true;
}
