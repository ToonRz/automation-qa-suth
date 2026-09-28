// src/courtIdCache.ts
// Persistent court-label → dropdown-value cache (config/court-ids.json).
//
// Why: the booking page renders the #court dropdown server-side and OMITS
// courts that are fully booked in the data it sees. During the 11:55 prewarm
// that data is YESTERDAY's (the server clears bookings at 12:00), so on busy
// days the target court has no <option> — and without its value id the noon
// submit would first have to reload booking.php while the server is being
// hammered. We cache every (label, value) pair we ever see; at noon a
// login-ready page can then inject the option and POST immediately, no reload.
//
// Ids are NOT permanently stable: the site renumbers courts from time to time
// (July: แบดมินตัน3=15; September: แบดมินตัน3=18). A stale id is NOT harmless —
// if the id now belongs to another court, the POST books THAT court. On
// 2026-09-28 แบดมินตัน5 and แบดมินตัน6 both cached "21", so "court5" bookings
// landed on court6 and the real court5 was never tried. Hence: one id maps to
// at most one label, and a freshly observed pair evicts any other label still
// holding that id.
//
// The cache is merged opportunistically from every fresh dropdown read (deep
// prewarm + the noon fallback loop) and from the reservations.php proof row
// after a PASS (the label the server actually booked for the submitted id).
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
 * anything new/changed. A fresh observation wins: any OTHER label still
 * holding the same value is evicted (its id was reassigned). Safe to call on
 * every dropdown read — it no-ops when nothing changed. Never throws (a failed
 * persist only costs tomorrow's fast path, and the in-memory copy is already
 * updated).
 */
export function updateCourtIds(courts: Array<{ label: string; value: string }>): void {
  const data = load();
  let dirty = false;
  for (const c of courts) {
    if (!c.label || !c.value) continue;
    for (const [label, value] of Object.entries(data)) {
      if (label !== c.label && value === c.value) {
        console.warn(
          `[courtIdCache] id ${value} now belongs to ${c.label} — evicting stale ${label}`
        );
        delete data[label];
        dirty = true;
      }
    }
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
