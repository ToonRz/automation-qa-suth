// Local wall-clock scheduling per requirements SC-01/SC-04.
//
// HTTP Date headers only have whole-second precision, so they cannot safely
// adjust a millisecond-exact trigger. The host clock (kept in sync by the OS)
// is the source of truth for the required local 12:00:00.000 release.

export type ClockNow = () => number;
export type ClockSleep = (ms: number) => Promise<void>;

const sleep: ClockSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FINAL_PRECISION_WINDOW_MS = 50;
const MAX_COARSE_SLEEP_MS = 1_000;

export async function waitUntilLocalTimestamp(
  targetMs: number,
  now: ClockNow = Date.now,
  wait: ClockSleep = sleep
): Promise<void> {
  while (now() < targetMs) {
    const remaining = targetMs - now();
    const waitMs =
      remaining > FINAL_PRECISION_WINDOW_MS
        ? Math.min(MAX_COARSE_SLEEP_MS, remaining - FINAL_PRECISION_WINDOW_MS)
        : 1;
    await wait(waitMs);
  }
}
