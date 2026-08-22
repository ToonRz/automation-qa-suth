// src/courtIdCache.ts
// Persistent court-label → dropdown-value cache (config/court-ids.json).
//
// Why: the booking page renders the #court dropdown server-side and OMITS
// courts that are fully booked in the data it sees. During the 11:55 prewarm
// that data is YESTERDAY's (the server clears bookings at 12:00), so on busy
// days the target court has no <option> — and without its value id the noon
// submit would first have to reload booking.php while the server is being
// hammered. Court ids are stable database ids, so we cache every (label,
// value) pair we ever see; at noon a login-ready page can then inject the
// option and POST immediately, no reload.
//
// The cache is merged opportunistically from every fresh dropdown read (deep
// prewarm + the noon fallback loop, which sees the full post-reset dropdown).
// A wrong/stale id is harmless: the server rejects the POST and the account
// falls into the normal retry loop, which reads the live dropdown.
//
// Seeded from reports/slots-discovered.json (2026-07-13):
//   แบดมินตัน3=15, แบดมินตัน4=16, แบดมินตัน6=18

import * as fs from 'fs';
import * as path from 'path';

// COURT_IDS_PATH override exists for test harnesses so they never write mock
// ids into the production cache file.
const CACHE_PATH =
  process.env.COURT_IDS_PATH ?? path.resolve(__dirname, '..', 'config', 'court-ids.json');

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8')) as Record<string, string>;
    cache = typeof raw === 'object' && raw !== null ? raw : {};
  } catch {
    cache = {}; // missing or corrupt file — start empty, first merge recreates it
  }
  return cache;
}

/** Dropdown value id for a court label, or undefined if never seen. */
export function getCourtId(label: string): string | undefined {
  return load()[label];
}

/**
 * Merge freshly-observed (label, value) pairs into the cache and persist if
 * anything new/changed. Safe to call on every dropdown read — it no-ops when
 * nothing changed. Never throws (a failed persist only costs tomorrow's
 * fast path, and the in-memory copy is already updated).
 */
export function updateCourtIds(courts: Array<{ label: string; value: string }>): void {
  const data = load();
  let dirty = false;
  for (const c of courts) {
    if (!c.label || !c.value) continue;
    if (data[c.label] !== c.value) {
      data[c.label] = c.value;
      dirty = true;
    }
  }
  if (!dirty) return;
  try {
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.warn(`[courtIdCache] persist failed (in-memory copy still updated): ${err}`);
  }
}

/** Test helper — drop the in-memory cache so file edits are picked up. */
export function reloadCourtIds(): void {
  cache = null;
}
