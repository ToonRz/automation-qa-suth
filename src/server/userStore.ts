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
  court: string;
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
  last_result?: {
    triggered_at: string;
    accounts: AccountResult[];
  };
}

interface UsersFile {
  users: User[];
}

let cache: UsersFile | null = null;

function load(): UsersFile {
  if (cache) return cache;
  if (!fs.existsSync(USERS_PATH)) {
    throw new Error(
      `users.json not found at ${USERS_PATH}. Copy config/users.example.json to config/users.json and fill in credentials.`
    );
  }
  const raw = fs.readFileSync(USERS_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as UsersFile;
  if (!Array.isArray(parsed.users)) {
    throw new Error(`users.json: top-level "users" must be an array`);
  }
  cache = parsed;
  return cache;
}

function save(data: UsersFile): void {
  // Atomic write: write to temp, rename. fs.renameSync is atomic on POSIX.
  const temp = USERS_PATH + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(temp, USERS_PATH);
  // chmod to owner-only since this file contains passwords
  fs.chmodSync(USERS_PATH, 0o600);
  cache = data;
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

/** Test helper — clear in-memory cache so file edits are picked up. */
export function reload(): void {
  cache = null;
}
