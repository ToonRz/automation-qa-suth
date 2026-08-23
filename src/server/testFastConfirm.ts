import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { bookOneAccount } from '../bookingFlow';
import { waitUntilLocalTimestamp } from '../localClock';
import { computeSlotRotations, rotateCourts } from './bookingEngine';

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
  // This test exercises the CLICK submit path (the SUBMIT_VIA=click rollback).
  process.env.SUBMIT_VIA = 'click';
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

async function testFetchModeDispatchesSubmitSynchronously(): Promise<void> {
  // Default mode (SUBMIT_VIA unset → fetch): the noon submit is ONE
  // page.evaluate that serializes and POSTs the form. It must be dispatched
  // synchronously when bookOneAccount is called — that is what lets
  // Promise.all fire all N accounts in the same JavaScript tick.
  delete process.env.SUBMIT_VIA;
  const events: string[] = [];
  let newContextCalls = 0;

  const page = {
    url: () => 'https://susport.sc.su.ac.th/booking.php',
    evaluate: (_fn: unknown, _args?: unknown) => {
      events.push('evaluate-submit');
      return Promise.resolve({
        ok: true,
        status: 200,
        url: 'https://susport.sc.su.ac.th/reservations.php',
        text:
          '<h2>การจองสนามในวันที่ 2026-08-22</h2>' +
          '<table><tr><td>fetch-test</td><td>แบดมินตัน2</td><td>18:30_19:30</td></tr></table>',
      });
    },
    goto: async () => {
      events.push('goto-proof');
    },
    screenshot: async () => {
      events.push('screenshot');
    },
  } as unknown as Page;

  const browser = {
    newContext: async () => {
      newContextCalls += 1;
      throw new Error('fetch fast path must not create a dummy context');
    },
  } as unknown as Browser;

  const booking = bookOneAccount(
    {
      username: 'fetch-test',
      password: 'unused',
      slot: '18:30_19:30',
    },
    {
      browser,
      courtPriority: ['แบดมินตัน2', 'แบดมินตัน1'],
      prewarmedBookingPage: page,
      prewarmedCourtLabel: 'แบดมินตัน2',
      prewarmedCourtValue: '14',
      screenshotsDir: '/tmp/court-booking-fast-confirm-test',
    }
  );

  assert.equal(events[0], 'evaluate-submit', 'fetch submit must dispatch in the same tick');
  assert.equal(newContextCalls, 0);

  const result = await booking;
  assert.equal(result.status, 'PASS');
  assert.equal(result.court_booked, 'แบดมินตัน2');
  // Success on the fetch path parks the page on reservations.php for the
  // proof screenshot (the fetch itself never navigates).
  assert.equal(events.includes('goto-proof'), true);
  assert.equal(events.includes('screenshot'), true);
}

function testSlotDeconflictionMath(): void {
  const P = ['แบด3', 'แบด2', 'แบด1', 'แบด4', 'แบด5', 'แบด6'];
  const acc = (username: string, slot: string) => ({ username, password: 'x', slot });

  // Same-slot accounts get consecutive rotations, per-slot groups independent,
  // input order preserved (2026-08-23 incident: 5 accounts × 20:30 all fired
  // at แบด3 — with this, they start at 5 DIFFERENT courts).
  const rotations = computeSlotRotations([
    acc('a', '20:30_21:30'),
    acc('b', '19:30_20:30'),
    acc('c', '20:30_21:30'),
    acc('d', '20:30_21:30'),
    acc('e', '19:30_20:30'),
  ]);
  assert.deepEqual(rotations, [0, 0, 1, 2, 1]);

  // Rotation is the full list starting at k — coverage never shrinks.
  assert.deepEqual(rotateCourts(P, 0), P);
  assert.deepEqual(rotateCourts(P, 2), ['แบด1', 'แบด4', 'แบด5', 'แบด6', 'แบด3', 'แบด2']);
  assert.deepEqual(rotateCourts(P, 6), P); // wraps past the court count
  assert.deepEqual(rotateCourts(P, 7), rotateCourts(P, 1));
  assert.deepEqual(rotateCourts([], 3), []);
  for (let k = 0; k < 8; k++) {
    assert.deepEqual([...rotateCourts(P, k)].sort(), [...P].sort(), `k=${k} keeps full coverage`);
  }

  // First targets of a 6-member same-slot group are 6 DISTINCT courts.
  const sameSlot = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'].map((u) => acc(u, '21:30_22:30'));
  const firsts = computeSlotRotations(sameSlot).map((k) => rotateCourts(P, k)[0]);
  assert.equal(new Set(firsts).size, 6);
}

async function main(): Promise<void> {
  await testWaitUsesInjectedLocalClock();
  testSlotDeconflictionMath();
  await testDeepPrewarmClicksBeforeAnyOtherBrowserWork();
  await testFetchModeDispatchesSubmitSynchronously();
  console.log('fast-confirm regression tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
