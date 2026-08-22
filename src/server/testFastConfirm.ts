import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { bookOneAccount } from '../bookingFlow';
import { waitUntilLocalTimestamp } from '../localClock';

async function testWaitUsesInjectedLocalClock(): Promise<void> {
  let now = 1_000;
  const sleeps: number[] = [];

  await waitUntilLocalTimestamp(
    1_003,
    () => now,
    async (ms) => {
      sleeps.push(ms);
      now += 1;
    }
  );

  assert.deepEqual(sleeps, [1, 1, 1]);
  assert.equal(now, 1_003);

  now = 0;
  sleeps.length = 0;
  await waitUntilLocalTimestamp(
    5_000,
    () => now,
    async (ms) => {
      sleeps.push(ms);
      now += ms;
    }
  );
  assert.equal(sleeps[0], 1_000);
  assert.equal(sleeps.at(-1), 1);
  assert.equal(now, 5_000);
  assert.equal(sleeps.length < 100, true, 'long waits must not poll every millisecond');
}

async function testDeepPrewarmClicksBeforeAnyOtherBrowserWork(): Promise<void> {
  const events: string[] = [];
  let releaseClick: (() => void) | undefined;
  let newContextCalls = 0;

  const page = {
    url: () => 'https://susport.sc.su.ac.th/booking.php',
    // Dialog capture is registered/removed around the submit — silent no-ops.
    on: () => page,
    off: () => page,
    // The booking POST response — the universal "server answered" signal the
    // submit now waits on instead of blocking the click on navigation.
    waitForResponse: async () => {
      events.push('arm-booking-response');
      return { request: () => ({ method: () => 'POST' }), url: () => 'book_court.php' };
    },
    // No redirect to reservations.php in this mock — resolves to the caller's
    // `.catch(() => null)`; classification then falls back to the page body.
    waitForURL: async () => {
      throw new Error('no reservations redirect (mock)');
    },
    waitForLoadState: async () => {
      events.push('wait-load-state');
    },
    locator: (selector: string) => {
      if (selector.includes('button:has-text("จอง")')) {
        events.push('locate-submit');
        return {
          first: () => ({
            click: () =>
              new Promise<void>((resolve) => {
                events.push('click-submit');
                releaseClick = resolve;
              }),
          }),
        };
      }
      if (selector === 'body') {
        events.push('read-result-body');
        return {
          textContent: async () => 'จองสำเร็จ',
        };
      }
      throw new Error(`unexpected locator before fast-confirm: ${selector}`);
    },
    screenshot: async () => {
      events.push('screenshot');
    },
  } as unknown as Page;

  const browser = {
    newContext: async () => {
      newContextCalls += 1;
      throw new Error('deep-prewarm must not create a dummy context');
    },
  } as unknown as Browser;

  const booking = bookOneAccount(
    {
      username: 'fast-confirm-test',
      password: 'unused',
      slot: '18:30_19:30',
    },
    {
      browser,
      courtPriority: ['แบดมินตัน2', 'แบดมินตัน1'],
      prewarmedBookingPage: page,
      prewarmedCourtLabel: 'แบดมินตัน2',
      screenshotsDir: '/tmp/court-booking-fast-confirm-test',
    }
  );

  // The click must be dispatched synchronously when bookOneAccount is called.
  // This is what lets Promise.all map all 9 accounts before awaiting any one.
  // (The submit now arms the POST-response observer just before clicking, but
  // that arming is still synchronous — no navigation/context work precedes it.)
  assert.deepEqual(events.slice(0, 3), [
    'locate-submit',
    'arm-booking-response',
    'click-submit',
  ]);
  assert.equal(newContextCalls, 0);

  releaseClick?.();
  const result = await booking;

  assert.equal(result.status, 'PASS');
  assert.equal(result.court_booked, 'แบดมินตัน2');
  assert.equal(newContextCalls, 0);
  assert.equal(events.includes('screenshot'), true);
}

async function main(): Promise<void> {
  await testWaitUsesInjectedLocalClock();
  await testDeepPrewarmClicksBeforeAnyOtherBrowserWork();
  console.log('fast-confirm regression tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
