// scripts/check-time-sync.ts
// One-off: sample server time vs local, print the diff. No side effects.

import { syncServerTime, getOffsetMs } from '../src/timeSync';

async function main() {
  const localBefore = Date.now();
  const offset = await syncServerTime(5);
  const localAfter = Date.now();
  const localMid = Math.floor((localBefore + localAfter) / 2);
  const serverNow = localMid + offset;

  console.log(JSON.stringify({
    samples_requested: 5,
    offset_ms: offset,
    local_before_ms: localBefore,
    local_after_ms: localAfter,
    local_now_iso: new Date(localMid).toISOString(),
    server_now_iso: new Date(serverNow).toISOString(),
    server_minus_local_seconds: (offset / 1000).toFixed(3),
  }, null, 2));

  // sanity: re-read to confirm cache
  console.log('getOffsetMs() =>', getOffsetMs(), 'ms');
}

main().catch((e) => {
  console.error('FAILED:', e?.message ?? e);
  process.exit(1);
});
