// src/server/telegramSend.ts
//
// Bypass telegraf's outbound sendMessage (which hangs on this network via
// telegraf's internal http.Agent — see bot.ts:683-688 for the gory details)
// by calling the Bot API directly with native fetch + AbortController.
// Mirrors the same trick startPollingLoop() uses for inbound updates.
//
// Behavior contract:
//   - 15s default timeout. On timeout, throws Error with `timed out after Xms`.
//   - On HTTP non-2xx OR Telegram `{ok: false}`, throws Error with Telegram's
//     description (or `HTTP <status>`). Caller's try/catch decides whether to
//     log + swallow, retry, etc.
//   - On success, logs `[telegram-send] ok chat=X ms=N` — operational proof
//     that the DM landed.
//   - On failure, logs `[telegram-send] FAIL chat=X ms=N reason="..."` so we
//     can see WHY the DM didn't land (vs the old behavior which silently
//     hung and produced zero log lines, masking the bug).
//
// Notes:
//   - console.* here will be routed to bot.log by logToFile when this module
//     is loaded from bot.ts (which monkey-patches console.* at module init).
//     When loaded standalone, console.* falls through to stdout — fine.
//   - No new dependencies. Uses Node's built-in fetch (Node 18+).

const DEFAULT_TIMEOUT_MS = 15_000;

export interface SendOpts {
  /** Override the 15s default timeout. */
  timeoutMs?: number;
  /** Telegram parse_mode. Optional — most messages don't need it. */
  parseMode?: 'HTML' | 'MarkdownV2' | 'Markdown';
}

/**
 * Send a text DM via the Telegram Bot API.
 * Throws on timeout, network failure, HTTP non-2xx, or Telegram `{ok:false}`.
 */
export async function sendTelegramMessage(
  chatId: number,
  text: string,
  opts: SendOpts = {}
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error('TELEGRAM_BOT_TOKEN is not set');
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Don't keep the process alive past the timer — graceful shutdown
  // shouldn't have to wait for an idle setTimeout.
  timer.unref?.();

  const t0 = Date.now();
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body: Record<string, unknown> = { chat_id: chatId, text };
    if (opts.parseMode) body.parse_mode = opts.parseMode;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const ms = Date.now() - t0;
    // Telegram returns parseable JSON even for 4xx — parse once and reuse.
    const raw = await res.text();
    let data: { ok: boolean; description?: string } | null = null;
    try {
      data = JSON.parse(raw);
    } catch {
      /* non-JSON body — fall through to "HTTP <status>" reason */
    }

    if (!res.ok || !data || data.ok !== true) {
      const reason = data?.description ?? `HTTP ${res.status}`;
      console.warn(
        `[telegram-send] FAIL chat=${chatId} ms=${ms} reason="${reason}"`
      );
      throw new Error(`sendMessage failed: ${reason}`);
    }

    console.log(`[telegram-send] ok chat=${chatId} ms=${ms}`);
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.warn(
        `[telegram-send] timeout chat=${chatId} after ${timeoutMs}ms`
      );
      throw new Error(`sendMessage timed out after ${timeoutMs}ms`);
    }
    // Re-throw network errors and our own throws above.
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
