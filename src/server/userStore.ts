// src/server/userStore.ts
// Load and persist config/users.json (the bot's source of truth for registered
// users and their accounts). Atomic write: temp file + rename, so a crash
// mid-write cannot corrupt the file.
//
// Runtime state (pending_booking, last_result) is persisted alongside the
// config so it survives bot restarts. Don't put credentials in .env — keep
// them in users.json on the server.

import * as fs from 'fs';
import * as path from 'path';

const USERS_PATH = path.resolve(__dirname, '..', '..', 'config', 'users.json');

export interface Account {
  username: string;
  password: string;
  /** @deprecated Use COURT_PRIORITY in config/accounts.json. Kept for backward
   *  compat with running accounts that still have the field set; loaders
   *  tolerate undefined and the booking flow does not consume it. */
  court?: string;
  slot: string;
}

export type UserRole = 'owner' | 'friend';

export interface AccountResult {
  username: string;
  court: string;
  slot: string;
  status: 'PASS' | 'FAIL' | 'ERROR' | 'DRY-RUN';
  fail_reason: string | null;
  court_booked: string | null;
  duration_ms: number;
}

export interface User {
  telegram_id: number;
  chat_id: number;
  display_name: string;
  role: UserRole;
  accounts: Account[];
  // Runtime state — mutated by bot commands and scheduler.
  pending_booking?: boolean;
  // Per-user noon-cron opt-out. `undefined` and `true` both mean "booked at
  // 12:00 normally"; only an explicit `false` (set via /cron off) skips the
  // user at fire time. Defaults to undefined on disk so older users.json
  // files keep working without migration.
  cron_enabled?: boolean;
  last_result?: {
    triggered_at: string;
    accounts: AccountResult[];
  };
}

interface UsersFile {
  users: User[];
}

let cache: UsersFile | null = null;
// mtimeMs of the file contents currently in `cache`. Recorded only after a
// successful parse (and after our own save()), so a torn read can't latch a
// bad mtime and leave the cache stale for the rest of the process's life.
let cachedMtimeMs = 0;

function load(): UsersFile {
  if (!fs.existsSync(USERS_PATH)) {
    throw new Error(
      `users.json not found at ${USERS_PATH}. Copy config/users.example.json to config/users.json and fill in credentials.`
    );
  }
  // The bot runs for days under launchd, so hand-edits to users.json have to
  // be picked up without a restart: re-read whenever the file's mtime differs
  // from the one that produced the cache. This also stops the mutators below
  // (markPending, setCronEnabled, ...) from writing a stale cache back over a
  // hand-edit — they are all load-modify-save, and load() now refreshes first.
  // Deadline is still the 11:55 cron fire, which snapshots the account list.
  const st = fs.statSync(USERS_PATH);
  if (cache && st.mtimeMs === cachedMtimeMs) return cache;

  try {
    const raw = fs.readFileSync(USERS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as UsersFile;
    if (!Array.isArray(parsed.users)) {
      throw new Error(`users.json: top-level "users" must be an array`);
    }
    cache = parsed;
    cachedMtimeMs = st.mtimeMs;
    return cache;
  } catch (err) {
    // First load has nothing to fall back to — fail loudly, as before.
    if (!cache) throw err;
    // Read landed mid-write, or someone saved broken JSON. Keep serving the
    // previous cache and deliberately do NOT record the mtime, so the next
    // call retries. Throwing here would take out the noon path.
    console.warn(
      `[userStore] users.json unreadable (${
        err instanceof Error ? err.message : String(err)
      }) — keeping previous cache`
    );
    return cache;
  }
}

function save(data: UsersFile): void {
  // Atomic write: write to temp, rename. fs.renameSync is atomic on POSIX.
  const temp = USERS_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, USERS_PATH);
  // chmod to owner-only since this file contains passwords
  fs.chmodSync(USERS_PATH, 0o600);
  cache = data;
  // Record the mtime we just wrote so load() doesn't re-read our own write.
  // Stat after rename+chmod: chmod moves ctime, not mtime.
  cachedMtimeMs = fs.statSync(USERS_PATH).mtimeMs;
}

export function getUserByChatId(chatId: number): User | undefined {
  return load().users.find((u) => u.chat_id === chatId);
}

export function getUserById(telegramId: number): User | undefined {
  return load().users.find((u) => u.telegram_id === telegramId);
}

export function getOwner(): User | undefined {
  return load().users.find((u) => u.role === 'owner');
}

export function getAllUsers(): User[] {
  return load().users;
}

/** Users who sent /book and haven't yet had their booking run. */
export function getPendingUsers(): User[] {
  return load().users.filter((u) => u.pending_booking);
}

export function markPending(chatId: number, pending: boolean): void {
  const data = load();
  const user = data.users.find((u) => u.chat_id === chatId);
  if (!user) return;
  user.pending_booking = pending;
  save(data);
}

/** Per-user noon-cron opt-out. Mirrors markPending: read-modify-write without
 *  retry — if a concurrent write (bot handler vs scheduler tick) loses the
 *  toggle, the user re-runs /cron and it sticks. Persisted via the same
 *  atomic temp+rename save() so the file is never partially written. */
export function setCronEnabled(chatId: number, enabled: boolean): void {
  const data = load();
  const user = data.users.find((u) => u.chat_id === chatId);
  if (!user) return;
  user.cron_enabled = enabled;
  save(data);
}

/** Default-on: missing/undefined flag means cron runs. Only an explicit false
 *  (set by /cron off) opts the user out. */
export function isCronEnabled(chatId: number): boolean {
  const user = load().users.find((u) => u.chat_id === chatId);
  if (!user) return true;
  return user.cron_enabled !== false;
}

export function setLastResult(
  chatId: number,
  result: { triggered_at: string; accounts: AccountResult[] }
): void {
  const data = load();
  const user = data.users.find((u) => u.chat_id === chatId);
  if (!user) return;
  user.last_result = result;
  // After the run, clear the pending flag.
  user.pending_booking = false;
  save(data);
}

/** Append a new account to a user's account list. Throws on duplicate username
 *  or if the user is not registered. Used by the /add wizard in bot.ts. */
export function addAccountToUser(chatId: number, account: Account): void {
  const data = load();
  const user = data.users.find((u) => u.chat_id === chatId);
  if (!user) {
    throw new Error(`user with chat_id=${chatId} not found`);
  }
  if (user.accounts.some((a) => a.username === account.username)) {
    throw new Error(`account with username="${account.username}" already exists for this user`);
  }
  user.accounts.push(account);
  save(data);
}

/** Update mutable fields on an existing account (court and/or slot). Throws if
 *  the user or account is not found. Username/password are not editable here
 *  — use /cancel + /add if those need to change. Used by the /useredit wizard
 *  in bot.ts.
 *  Patch is a Partial<Pick<Account, 'court' | 'slot'>>: callers pass only the
 *  fields they want to change, the rest are preserved. */
export function updateAccountInUser(
  chatId: number,
  username: string,
  patch: Partial<Pick<Account, 'court' | 'slot'>>
): void {
  const data = load();
  const user = data.users.find((u) => u.chat_id === chatId);
  if (!user) {
    throw new Error(`user with chat_id=${chatId} not found`);
  }
  const account = user.accounts.find((a) => a.username === username);
  if (!account) {
    throw new Error(`account with username="${username}" not found for this user`);
  }
  if (patch.court !== undefined) account.court = patch.court;
  if (patch.slot !== undefined) account.slot = patch.slot;
  save(data);
}

/** Register a new Telegram user. Throws on duplicate chat_id or telegram_id, or
 *  if there is already an owner when caller tries to add another owner. Used by
 *  the /user add wizard in bot.ts.
 *  Owner-only invariant: at most one owner in the system (the bot wires
 *  owner-only logic around getOwner()). Allowing multiple owners would break
 *  sendPrewarmNoticeToOwner() and the cross-user summary DM. */
export function addUser(input: Omit<User, 'accounts' | 'pending_booking' | 'last_result'>): User {
  const data = load();
  if (data.users.some((u) => u.chat_id === input.chat_id)) {
    throw new Error(`user with chat_id=${input.chat_id} already exists`);
  }
  if (data.users.some((u) => u.telegram_id === input.telegram_id)) {
    throw new Error(`user with telegram_id=${input.telegram_id} already exists`);
  }
  if (input.role === 'owner' && data.users.some((u) => u.role === 'owner')) {
    throw new Error(`owner already exists (chat_id=${data.users.find((u) => u.role === 'owner')!.chat_id}); cannot add a second owner`);
  }
  const newUser: User = {
    telegram_id: input.telegram_id,
    chat_id: input.chat_id,
    display_name: input.display_name,
    role: input.role,
    accounts: [],
  };
  data.users.push(newUser);
  save(data);
  return newUser;
}

/** Test helper — clear in-memory cache so file edits are picked up. */
export function reload(): void {
  cache = null;
  cachedMtimeMs = 0;
}
