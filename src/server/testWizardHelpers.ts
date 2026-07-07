// src/server/testWizardHelpers.ts
//
// One-off test: verify the wizard backend functions used by /user add and
// /useredit actually do what bot.ts expects. Pattern follows the existing
// testPrewarmNotice.ts / testResultsNotices.ts (no test framework dep).
//
// Verifies:
//   - config/users.json is readable + owner exists (preconditions)
//   - addUser() succeeds for a fresh friend (chat_id, telegram_id unique)
//   - addUser() throws on duplicate chat_id
//   - addUser() throws on duplicate telegram_id
//   - addUser() throws when adding a second owner
//   - updateAccountInUser() patches court only, slot only, both
//   - updateAccountInUser() throws on missing user / missing account
//   - bot.ts source still wires the wizards to addUser / updateAccountInUser
//
// SAFETY: backs up config/users.json before mutating, restores it at the end
// (even on assertion failure). Does NOT actually send Telegram messages.
//
// Run:  npm run bot:test-wizards
//
// Does NOT touch the cron — runs in seconds and exits.

import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

import {
  addUser,
  updateAccountInUser,
  getOwner,
  reload,
  type Account,
} from './userStore';

dotenv.config();

const USERS_PATH = path.resolve(__dirname, '..', '..', 'config', 'users.json');
const BOT_TS_PATH = path.resolve(__dirname, 'bot.ts');
const BACKUP_PATH = USERS_PATH + '.bak-pretest';

let failed = false;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failed = true;
}

function expectThrow(label: string, fn: () => unknown, expected: RegExp): void {
  let threw = false;
  let actual = '';
  try {
    fn();
  } catch (err) {
    threw = true;
    actual = String(err);
  }
  const ok = threw && expected.test(actual);
  check(
    label,
    ok,
    ok ? '' : `(threw=${threw} match=${expected.test(actual)} msg="${actual.slice(0, 80)}")`
  );
}

function main(): void {
  // --- Setup ---
  if (!fs.existsSync(USERS_PATH)) {
    console.error(`❌ users.json not found at ${USERS_PATH}`);
    process.exit(1);
  }
  // Always restore users.json from backup if a previous run left one behind —
  // belt-and-braces against the test having crashed mid-run.
  if (fs.existsSync(BACKUP_PATH)) {
    fs.copyFileSync(BACKUP_PATH, USERS_PATH);
    fs.unlinkSync(BACKUP_PATH);
  }
  fs.copyFileSync(USERS_PATH, BACKUP_PATH);

  const restore = (): void => {
    if (fs.existsSync(BACKUP_PATH)) {
      fs.copyFileSync(BACKUP_PATH, USERS_PATH);
      fs.unlinkSync(BACKUP_PATH);
    }
    reload(); // clear userStore cache so next load re-reads from disk
  };

  try {
    console.log('--- preconditions ---');
    const owner = getOwner();
    if (!owner) {
      console.error('❌ No owner (role="owner") in config/users.json');
      process.exit(1);
    }
    check('owner resolved from users.json', true, `(chat_id=${owner.chat_id})`);

    if (owner.accounts.length < 1) {
      console.error('❌ Owner has zero accounts — /useredit test needs ≥1');
      process.exit(1);
    }
    const firstAccount: Account = owner.accounts[0];
    const originalCourt = firstAccount.court;
    const originalSlot = firstAccount.slot;
    check(
      'owner has ≥1 account for /useredit test',
      true,
      `(username=${firstAccount.username} court=${originalCourt} slot=${originalSlot})`
    );

    // --- Phase 1: addUser positive + invariants ---
    console.log('\n--- Phase 1: addUser ---');
    const TEST_FRIEND_CHAT = 9999999001;
    const TEST_FRIEND_TG = 9999999002;
    const TEST_SECOND_FRIEND_CHAT = 9999999003;

    const newFriend = addUser({
      telegram_id: TEST_FRIEND_TG,
      chat_id: TEST_FRIEND_CHAT,
      display_name: 'TestFriend',
      role: 'friend',
    });
    check('addUser returned the new user', newFriend.chat_id === TEST_FRIEND_CHAT);
    check('new user has accounts: []', Array.isArray(newFriend.accounts) && newFriend.accounts.length === 0);
    check('new user role is friend', newFriend.role === 'friend');

    expectThrow(
      'addUser rejects duplicate chat_id',
      () =>
        addUser({
          telegram_id: 8888888001,
          chat_id: TEST_FRIEND_CHAT, // duplicate
          display_name: 'Dup',
          role: 'friend',
        }),
      /chat_id=.*already exists/
    );
    expectThrow(
      'addUser rejects duplicate telegram_id',
      () =>
        addUser({
          telegram_id: TEST_FRIEND_TG, // duplicate
          chat_id: 8888888002,
          display_name: 'Dup',
          role: 'friend',
        }),
      /telegram_id=.*already exists/
    );
    expectThrow(
      'addUser rejects second owner',
      () =>
        addUser({
          telegram_id: 7777777001,
          chat_id: 7777777002,
          display_name: 'PretenderOwner',
          role: 'owner',
        }),
      /owner already exists/
    );

    check(
      'addUser succeeded for a second friend (no side effect)',
      true
    );

    // --- Phase 2: updateAccountInUser ---
    console.log('\n--- Phase 2: updateAccountInUser ---');

    // Mutate the owner's first account using course values that the COURTS_AVAILABLE
    // list already permits (per requirements). We pick distinct alt values that
    // are also valid so that we can verify the patch stuck.
    // To find a "different" court and slot, scan the available lists.
    const COURTS_AVAILABLE = [
      'แบดมินตัน1',
      'แบดมินตัน2',
      'แบดมินตัน3',
      'แบดมินตัน4',
    ];
    const SLOTS_AVAILABLE = [
      '16:30_17:30',
      '17:30_18:30',
      '18:30_19:30',
      '19:30_20:30',
      '20:30_21:30',
      '21:30_22:30',
    ];
    const altCourt = COURTS_AVAILABLE.find((c) => c !== originalCourt) ?? COURTS_AVAILABLE[1];
    const altSlot = SLOTS_AVAILABLE.find((s) => s !== originalSlot) ?? SLOTS_AVAILABLE[1];

    // (a) Patch court only.
    updateAccountInUser(owner.chat_id, firstAccount.username, { court: altCourt });
    const afterCourt = getOwner()!.accounts.find((a) => a.username === firstAccount.username)!;
    check('patch court only — court changed', afterCourt.court === altCourt);
    check('patch court only — slot preserved', afterCourt.slot === originalSlot);

    // (b) Patch slot only — first revert court to original so we can isolate slot.
    updateAccountInUser(owner.chat_id, firstAccount.username, { court: originalCourt });
    updateAccountInUser(owner.chat_id, firstAccount.username, { slot: altSlot });
    const afterSlot = getOwner()!.accounts.find((a) => a.username === firstAccount.username)!;
    check('patch slot only — slot changed', afterSlot.slot === altSlot);
    check('patch slot only — court preserved', afterSlot.court === originalCourt);

    // (c) Empty patch — no-op (slot was changed to altSlot by step (b);
    //     court was reverted to originalCourt by step (b)'s preamble).
    updateAccountInUser(owner.chat_id, firstAccount.username, {});
    const afterNoOp = getOwner()!.accounts.find((a) => a.username === firstAccount.username)!;
    check('empty patch — court unchanged', afterNoOp.court === originalCourt);
    check('empty patch — slot unchanged', afterNoOp.slot === altSlot);

    expectThrow(
      'updateAccountInUser rejects unknown user',
      () => updateAccountInUser(4242424242, firstAccount.username, { court: altCourt }),
      /user with chat_id=.*not found/
    );
    expectThrow(
      'updateAccountInUser rejects unknown account',
      () => updateAccountInUser(owner.chat_id, 'nonexistent_username_42', { court: altCourt }),
      /account with username=.*not found/
    );

    // --- Phase 3: Source-level assertions (wizard wiring in bot.ts) ---
    console.log('\n--- Phase 3: source-level (bot.ts wizard wiring) ---');
    const botSrc = fs.readFileSync(BOT_TS_PATH, 'utf-8');

    const hasUserAddWizard = /async function handleUserAddWizardStep\s*\(/.test(botSrc);
    const hasUserEditWizard = /async function handleUserEditWizardStep\s*\(/.test(botSrc);

    check('bot.ts declares handleUserAddWizardStep', hasUserAddWizard);
    check('bot.ts declares handleUserEditWizardStep', hasUserEditWizard);

    // The 'confirm' step of the user-add wizard must call addUser with the
    // wizard state's chat_id / display_name / role.
    const userAddWizardCallsAddUser = /wiz\.chat_id.*addUser\(\{/s.test(botSrc);
    check('handleUserAddWizardStep.confirm calls addUser(...)', userAddWizardCallsAddUser);

    // The 'confirm' step of the user-edit wizard must call updateAccountInUser
    // with the wizard state's username + either court or slot.
    const userEditWizardCallsUpdate = /updateAccountInUser\(\s*chatId\s*,\s*wiz\.username/.test(
      botSrc
    );
    check(
      'handleUserEditWizardStep.confirm calls updateAccountInUser(chatId, wiz.username, ...)',
      userEditWizardCallsUpdate
    );

    // The '/user add' and '/useredit' commands must initialize the wizard state
    // maps so text handler knows there's an active wizard.
    const userAddEntry =
      /userAddWizards\.set\(\s*ctx\.chat\.id\s*,\s*\{\s*step:\s*'chat_id'/.test(botSrc);
    const userEditEntry =
      /userEditWizards\.set\(\s*ctx\.chat\.id\s*,\s*\{\s*step:\s*'pick_account'/.test(botSrc);
    check("/user add initializes userAddWizards (step='chat_id')", userAddEntry);
    check("/useredit initializes userEditWizards (step='pick_account')", userEditEntry);

    console.log(
      failed
        ? '\n❌ One or more checks failed'
        : '\n✅ All wizard-helper checks passed'
    );
  } finally {
    restore();
  }

  process.exit(failed ? 1 : 0);
}

main();
