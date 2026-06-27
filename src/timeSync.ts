// src/timeSync.ts
// Server time synchronization for the strict 12:00:00 scheduler (SC-04).
//
// Problem: local system clock can drift from web server clock by tens to hundreds of
// milliseconds. If we fire "on local noon" but server time is 11:59:59.700, the
// booking request may land in the previous minute and be rejected.
//
// Strategy: poll the server's HTTP Date header N times, take the median offset,
// expose getServerNow() as a drop-in for Date.now(). The scheduler compares the
// server-adjusted clock to the target time, so a slow/fast local clock is neutralized.
//
// Note: this fixes skew, not timezone. If local TZ != Asia/Bangkok, targetNoon()
// in scheduler.ts will compute the wrong UTC instant — that's a separate problem
// (and is already correct if the user is in ICT, which the project assumes).

const LOGIN_URL = 'https://susport.sc.su.ac.th/login.php';

let cachedOffsetMs = 0;

async function sampleOffset(): Promise<number> {
  const before = Date.now();
  const res = await fetch(LOGIN_URL, { method: 'HEAD' });
  const after = Date.now();
  const rtt = after - before;
  const dateHeader = res.headers.get('date');
  if (!dateHeader) throw new Error('server response missing Date header');
  const serverTimeAtSend = new Date(dateHeader).getTime();
  // Estimate server clock at our receive moment (assume symmetric RTT).
  return serverTimeAtSend + rtt / 2 - after;
}

export async function syncServerTime(samples = 5): Promise<number> {
  const offsets: number[] = [];
  for (let i = 0; i < samples; i++) {
    try {
      offsets.push(await sampleOffset());
    } catch {
      // skip failed sample
    }
    if (i < samples - 1) await new Promise((r) => setTimeout(r, 200));
  }
  if (offsets.length === 0) {
    throw new Error('timeSync: failed to sample server time (network down?)');
  }
  offsets.sort((a, b) => a - b);
  cachedOffsetMs = offsets[Math.floor(offsets.length / 2)]; // median
  return cachedOffsetMs;
}

// Server-adjusted wall clock in UTC milliseconds (drop-in for Date.now()).
export function getServerNow(): number {
  return Date.now() + cachedOffsetMs;
}

// Current offset (server - local), positive = local clock is behind server.
export function getOffsetMs(): number {
  return cachedOffsetMs;
}