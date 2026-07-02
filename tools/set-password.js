#!/usr/bin/env node
'use strict';
// Set or reset access passwords (stored as scrypt hashes in DATA_DIR/auth.json).
//
//   node tools/set-password.js                  set the listener password (prompts)
//   node tools/set-password.js --admin          set the admin password (prompts)
//   node tools/set-password.js --generate       generate + print a listener password
//   node tools/set-password.js --admin --generate
//   node tools/set-password.js --remove-admin   drop the admin password

const path = require('path');
const os = require('os');
const readline = require('readline');
const { Auth, generatePassword } = require('../lib/auth');

function expandHome(p) {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

const DATA_DIR = path.resolve(expandHome(process.env.DATA_DIR || path.join(__dirname, '..', 'data')));
const auth = new Auth(DATA_DIR);

const args = process.argv.slice(2);
const role = args.includes('--admin') ? 'admin' : 'listener';

if (args.includes('--remove-admin')) {
  const fs = require('fs');
  delete auth.creds.admin;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'auth.json'), JSON.stringify(auth.creds, null, 2), { mode: 0o600 });
  console.log('admin password removed.');
  process.exit(0);
}

function finish(password, generated) {
  auth.setPassword(role, password);
  console.log(`${role} password ${generated ? 'generated' : 'set'}.`);
  if (generated) console.log(`\n  ${password}\n\nStore it somewhere safe — only the hash is kept on disk.`);
  console.log('Restart the server (or it applies on next boot) — existing sessions stay valid.');
}

if (args.includes('--generate')) {
  finish(generatePassword(), true);
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`New ${role} password: `, (answer) => {
    rl.close();
    const password = answer.trim();
    if (password.length < 6) {
      console.error('Password must be at least 6 characters.');
      process.exit(1);
    }
    finish(password, false);
  });
}
