// src/server/configLoader.ts
// Single source of truth for config/accounts.json. Both the CLI path (runner.ts
// and scheduler.ts) and the server path (bookingEngine.ts) import from here so
// the config shape has one place to update.
//
// Schema:
//   {
//     "COURT_PRIORITY": ["แบดมินตัน2", "แบดมินตัน1"],
//     "accounts": [{ "username": "...", "password": "...", "slot": "17:30_18:30" }, ...]
//   }
//
// COURT_PRIORITY drives the booking order: every account tries COURTS[0] first
// with their own slot, then COURTS[1], then any remaining badminton courts as a
// safety net. Per-account `court` field is no longer consulted for priority.

import * as fs from 'fs';
import * as path from 'path';

const CONFIG_PATH = path.resolve(__dirname, '..', '..', 'config', 'accounts.json');

export interface AppConfig {
  COURT_PRIORITY: string[];
  accounts: Array<{
    username: string;
    password: string;
    /** @deprecated Use COURT_PRIORITY at top-level. Kept for backward compat
     *  with running accounts that still have the field set. */
    court?: string;
    slot: string;
  }>;
}

let cache: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cache) return cache;
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`accounts.json not found at ${CONFIG_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as AppConfig;
  if (!Array.isArray(raw.COURT_PRIORITY) || raw.COURT_PRIORITY.length === 0) {
    throw new Error('config/accounts.json: COURT_PRIORITY must be a non-empty string[]');
  }
  if (!Array.isArray(raw.accounts)) {
    throw new Error('config/accounts.json: accounts must be an array');
  }
  cache = raw;
  return cache;
}

/** Ordered list of courts every account will try first. The booking loop appends
 *  remaining badminton courts (in dropdown order) as a safety net after this list. */
export const COURTS = (() => getConfig().COURT_PRIORITY)();

/** Test helper — clear the in-memory cache so file edits are picked up. */
export function reload(): void {
  cache = null;
}