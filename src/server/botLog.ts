// src/server/botLog.ts
// bot.log writer: append across restarts, rotate to `<file>.1` past 5MB.
//
// The bot used to truncate bot.log on every start, so a crash-loop (launchd
// KeepAlive restarting after a failed getMe, 2026-09-01 and 09-16) erased the
// very lines that explained it. The size is tracked in memory — one stat at
// open, none per line — so logging in the noon dispatch path costs no extra
// syscalls.

import * as fs from 'fs';

export const BOT_LOG_MAX_BYTES = 5 * 1024 * 1024;

/** Returns a line writer for `file`. Never throws (logging must not kill the bot). */
export function openAppendLog(
  file: string,
  maxBytes = BOT_LOG_MAX_BYTES
): (text: string) => void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    /* no log yet */
  }
  return (text: string): void => {
    try {
      if (size >= maxBytes) {
        try {
          fs.renameSync(file, `${file}.1`); // keeps exactly one previous file
        } catch {
          /* file vanished — just start a new one */
        }
        size = 0;
      }
      fs.appendFileSync(file, text);
      size += Buffer.byteLength(text);
    } catch {
      /* ignore log write errors */
    }
  };
}
