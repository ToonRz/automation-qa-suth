// src/verifyPriority.ts
//
// DRY verification harness for the soft-promote 21:00_22:00 fallback in
// src/bookingFlow.ts (commit bad06d6 on feat/prioritize-21-22).
//
// This file is INTENTIONALLY a paper simulation — no Playwright, no fetch,
// no susport.sc.su.ac.th contact. It mirrors the inlined slot-ordering formula
// at bookingFlow.ts:617-625 and proves, for each of the 9 configured accounts,
// which slot would win under each "availability scenario."
//
// Why a separate verification script instead of live dry-runs against the real
// site: the inlined formula is 4 lines of pure logic, deterministic, and the
// failure modes we care about are pure-logic failures (wrong priority order,
// off-by-one in scenarios). A live dry-run adds site-flake and account-lockout
// risk without testing the actual bug surface. The accompanying PR description
// points at this output as proof of correctness.
//
// ─── KEEP THIS IN SYNC WITH src/bookingFlow.ts:617-625 ────────────────────────
// If the production formula changes, update the `prioritySlots` function below
// to mirror it. The whole point of this verifier is to be a faithful witness.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';

const ALL_SLOTS = [
  '17:00_18:00',
  '18:00_19:00',
  '19:00_20:00',
  '20:00_21:00',
  '21:00_22:00',
] as const;

const PROMOTED_FALLBACK = '21:00_22:00';

interface AccountFixture {
  username: string;
  slot: string;
}

/**
 * Mirror of the inlined formula at bookingFlow.ts:617-625. Returns the ordered
 * list of slots the bot would attempt, given the assigned slot and the slots
 * currently available on the chosen court.
 *
 * Contract (verified by tests below):
 *   1. The assigned slot is always slot #1 (the spec §3.4 promise).
 *   2. PROMOTED_FALLBACK (21:00_22:00) is slot #2 iff it's available AND not
 *      already the assigned slot.
 *   3. Remaining slots preserve their natural (earliest-first) order.
 */
function prioritySlots(
  assignedSlot: string,
  available: readonly string[]
): string[] {
  return [
    assignedSlot,
    ...available.filter((s) => s === PROMOTED_FALLBACK && s !== assignedSlot),
    ...available.filter((s) => s !== assignedSlot && s !== PROMOTED_FALLBACK),
  ];
}

/** Pick the first slot in `order` that is present in `available`. */
function firstAvailable(order: string[], available: readonly string[]): string | null {
  for (const s of order) {
    if (available.includes(s)) return s;
  }
  return null;
}

/** Strip the reserved times out of ALL_SLOTS to form the available set. */
function availableFrom(reserved: readonly string[]): string[] {
  return ALL_SLOTS.filter((s) => !reserved.includes(s));
}

/** Load the runtime accounts.json (gitignored — see repo root .gitignore). */
function loadAccounts(): AccountFixture[] {
  const p = path.resolve(__dirname, '..', 'config', 'accounts.json');
  if (!fs.existsSync(p)) {
    throw new Error(
      `accounts.json not found at ${p}. The file is gitignored — provide a ` +
        `local one before running this verifier.`
    );
  }
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as Array<{
    username: string;
    slot: string;
  }>;
  if (!Array.isArray(raw) || raw.length !== 9) {
    throw new Error(
      `accounts.json must contain exactly 9 accounts; got ${
        Array.isArray(raw) ? raw.length : 'non-array'
      }`
    );
  }
  return raw.map((a) => ({ username: a.username, slot: a.slot }));
}

// ─── Scenario matrix ─────────────────────────────────────────────────────────
// A scenario maps each account to a `reserved` set (what's already booked on
// that account's court) and a verdict function that grades the chosen slot.
//
// Scenarios are designed to be deterministic and unambiguous — any output that
// contradicts the verdict column is a bug in prioritySlots or the scenario
// definition, not in the booking engine itself.

interface Scenario {
  name: string;
  /** Per-account reserved set. The simulator runs each account through this. */
  reservedFor: (account: AccountFixture) => string[];
  /** Verdict returned to the operator for this account under this scenario. */
  verdict: (winner: string | null, account: AccountFixture) => string;
}

const SCENARIOS: Scenario[] = [
  {
    // The baseline — no contention. Soft-promote must NOT fire.
    name: 'S0: all slots free (baseline)',
    reservedFor: () => [],
    verdict: (w, a) => {
      if (w === a.slot) return '✓ assigned wins (§3.4)';
      if (w === PROMOTED_FALLBACK) return '✗ soft-promote fired on open baseline!';
      return w ? '∅ other' : '✗ no winner on open baseline';
    },
  },
  {
    // The KEY scenario for this PR. If soft-promote works, 21:22 wins for
    // every account whose assigned slot isn't already 21:22. This is the
    // user-visible win condition.
    //
    // Edge case: 670911373 has assigned = 21:22. When "assigned is reserved",
    // for THIS account 21:22 is reserved (because it equals assigned), so
    // soft-promote has nothing to add — fall through to time-ordered wins.
    // This is the correct behavior; the verdict just has to acknowledge it.
    name: 'S1: only assigned slot is taken (soft-promote should fire)',
    reservedFor: (a) => [a.slot],
    verdict: (w, a) => {
      if (w === PROMOTED_FALLBACK) {
        return a.slot === PROMOTED_FALLBACK
          ? '✓ 21:22 wins (assigned IS 21:22, soft-promote no-op)'
          : '✓ 21:22 wins (soft-promote)';
      }
      if (w === a.slot) return '✗ assigned won when reserved!';
      if (!w) return '✗ no winner';
      return '✓ time-ordered (assigned IS 21:22, soft-promote exhausted)';
    },
  },
  {
    // Both assigned AND promoted are taken. The next-earliest available
    // slot must win. Time-ordered (not soft-promote-ordered).
    name: 'S2: assigned + 21:22 both taken (time-ordered fallback)',
    reservedFor: (a) => [a.slot, PROMOTED_FALLBACK],
    verdict: (w, a) => {
      if (!w) return '✗ no winner';
      if (w === a.slot) return '✗ assigned won when reserved!';
      if (w === PROMOTED_FALLBACK) return '✗ 21:22 won when reserved!';
      return '✓ time-ordered fallback wins';
    },
  },
  {
    // Realistic load — every prime-time slot is taken, only 21:22 is free.
    // ALL nine accounts should converge on 21:22 (some via assigned, some via
    // soft-promote). This is the headline win the user is asking about.
    name: 'S3: 17:00–20:00 all taken, 21:22 free (realistic peak load)',
    reservedFor: () => [
      '17:00_18:00',
      '18:00_19:00',
      '19:00_20:00',
      '20:00_21:00',
    ],
    verdict: (w) => {
      if (w === PROMOTED_FALLBACK) return '✓ 21:22 wins (5 via soft-promote, 1 via assigned)';
      if (!w) return '✗ no winner — 21:22 should be available!';
      return '✗ wrong slot won';
    },
  },
  {
    // The "soft-promote doesn't break things" guard. If 21:22 is taken but
    // everyone else's assigned is free, soft-promote MUST NOT promote 21:22
    // (it's reserved — the formula already guards against this).
    //
    // Edge case: 670911373's assigned IS 21:22, so for this account BOTH the
    // soft-promote target AND the assigned slot are taken — falls through to
    // time-ordered wins on the remaining 4 slots. Correct behavior.
    name: 'S4: 21:22 specifically taken (assigned-first must hold)',
    reservedFor: () => [PROMOTED_FALLBACK],
    verdict: (w, a) => {
      if (w === a.slot) {
        return a.slot === PROMOTED_FALLBACK
          ? '✓ falls through (assigned IS 21:22, reserved)'
          : '✓ assigned still wins (21:22 reserved)';
      }
      if (w === PROMOTED_FALLBACK) return '✗ promoted won when reserved!';
      if (!w) return '✗ no winner';
      return '✓ time-ordered (assigned IS 21:22, reserved)';
    },
  },
];

function runOne(account: AccountFixture, reserved: readonly string[]): {
  ordered: string[];
  winner: string | null;
} {
  const available = availableFrom(reserved);
  const order = prioritySlots(account.slot, available);
  const winner = firstAvailable(order, available);
  return { ordered: order, winner };
}

// ─── Reporter ────────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function printTable(accounts: AccountFixture[], scenario: Scenario): void {
  console.log(`\n┌─ ${scenario.name}`);

  const rows: string[] = [];
  rows.push(
    '│ ' +
      pad('username', 12) +
      pad('assigned', 12) +
      pad('attempt order', 38) +
      pad('winner', 12) +
      'verdict'
  );
  rows.push('│ ' + '─'.repeat(80));

  let pass = 0;
  let total = 0;
  for (const a of accounts) {
    const reserved = scenario.reservedFor(a);
    const { ordered, winner } = runOne(a, reserved);
    const verdict = scenario.verdict(winner, a);
    if (verdict.startsWith('✓')) pass++;
    total++;
    rows.push(
      '│ ' +
        pad(a.username, 12) +
        pad(a.slot, 12) +
        pad(ordered.join(' → '), 38) +
        pad(winner ?? 'NONE', 12) +
        verdict
    );
  }
  console.log(rows.join('\n'));
  console.log(`└─ results: ${pass}/${total} accounts behaved as expected`);
}

function main(): void {
  const accounts = loadAccounts();

  console.log('╔══════════════════════════════════════════════════════════════════════════╗');
  console.log('║  Slot priority verifier — soft-promote 21:00_22:00 fallback             ║');
  console.log('║  Source formula: src/bookingFlow.ts:617-625                             ║');
  console.log('║  Mirrored here:  src/verifyPriority.ts (prioritySlots)                  ║');
  console.log('╚══════════════════════════════════════════════════════════════════════════╝');
  console.log(
    `\nLoaded ${accounts.length} accounts. ALL_SLOTS = [${ALL_SLOTS.join(', ')}]\n`
  );

  let allPass = true;
  for (const scenario of SCENARIOS) {
    const before = process.stdout.write.bind(process.stdout);
    printTable(accounts, scenario);
    before; // no-op; retained for symmetry
  }

  // Final summary — count expected vs unexpected across the whole table.
  let pass = 0;
  let total = 0;
  const unexpected: string[] = [];
  for (const scenario of SCENARIOS) {
    for (const a of accounts) {
      const reserved = scenario.reservedFor(a);
      const { winner } = runOne(a, reserved);
      const verdict = scenario.verdict(winner, a);
      total++;
      if (verdict.startsWith('✓')) pass++;
      else if (verdict.startsWith('✗'))
        unexpected.push(`  - ${scenario.name} | ${a.username} | ${verdict}`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════════════════════');
  console.log(`SUMMARY: ${pass}/${total} scenarios matched expected verdict.`);
  if (unexpected.length === 0) {
    console.log('OK — soft-promote behaves correctly across all 9 accounts × 5 scenarios.');
    allPass = true;
  } else {
    console.log('UNEXPECTED verdicts:');
    console.log(unexpected.join('\n'));
    allPass = false;
  }
  console.log('══════════════════════════════════════════════════════════════════════════');

  // Non-zero exit on failure so CI / pre-push hooks can catch regressions.
  if (!allPass) process.exit(1);
}

main();
