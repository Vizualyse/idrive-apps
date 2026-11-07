// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A stand-in for DepotDownloader 3.4.0 (test/unit_test.js; no network in the
 * test): the same prompts and output lines as the real one (its
 * Program.cs, ConsoleAuthenticator.cs, ContentDownloader.cs), so steam.js's
 * reading of them is tested. The password is "hunter2", the Steam Guard code
 * 12345 (the first code tried, 99999, is wrong on purpose). A login remembered
 * (-remember-password) is HOME/.local/share/IsolatedStorage/t/account.config.
 * The "game" is GAME_EXE copied in as TestGame.exe.
 *
 *   node fake_dd.js GAME_EXE -app N -os windows -osarch 64 -dir D -username U -remember-password
 */
'use strict';
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const GAME_EXE = process.argv[2];
const a = process.argv.slice(3);
const arg = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const dir = arg('-dir'), user = arg('-username'), app = arg('-app');
const store = path.join(process.env.HOME, '.local', 'share', 'IsolatedStorage', 't');
const token = path.join(store, 'account.config');
const rl = readline.createInterface({ input: process.stdin });
const lines = [];
let waiting = null;
rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else lines.push(l); });
const mkdirp = (d) => { if (fs.existsSync(d)) return; mkdirp(path.dirname(d)); fs.mkdirSync(d); };
const ask = () => new Promise((r) => { if (lines.length) r(lines.shift()); else waiting = r; });

function download() {
    console.log('Got AppInfo for ' + app);
    console.log('Downloading depot ' + (Number(app) + 1) + ' - TestGame');
    mkdirp(path.join(dir, '.DepotDownloader'));
    const n = 5;
    let i = 0;
    const t = setInterval(() => {
        i++;
        console.log(' ' + (i * 100 / n).toFixed(2) + '% ' + dir + '/part' + i);
        if (i < n) return;
        clearInterval(t);
        fs.copyFileSync(GAME_EXE, path.join(dir, 'TestGame.exe'));
        /* the DLLs beside it too (a real game's, copied off the car: T_GAME) */
        fs.readdirSync(path.dirname(GAME_EXE)).filter((n) => /\.dll$/i.test(n))
            .forEach((n) => fs.copyFileSync(path.join(path.dirname(GAME_EXE), n), path.join(dir, n)));
        mkdirp(path.join(dir, 'redist'));
        fs.writeFileSync(path.join(dir, 'redist', 'vcredist_x64.exe'), 'MZ');
        console.log('Depot ' + (Number(app) + 1) + ' - Downloaded 1234 bytes (5678 bytes uncompressed)');
        console.log('Total downloaded: 1234 bytes (5678 bytes uncompressed) from 1 depots');
        process.exit(0);
    }, 300);
}

(async () => {
    process.stdout.write('Connecting to Steam3...');
    console.log(' Done!');
    if (!fs.existsSync(token)) {
        process.stdout.write('Enter account password for "' + user + '": ');
        const pw = await ask();
        console.log('Logging \'' + user + '\' into Steam3...');
        if (pw !== 'hunter2') { console.error('Failed to authenticate with Steam: InvalidPassword'); process.exit(1); }
        let wrong = false;
        for (;;) {
            if (wrong) console.error('The previous 2-factor auth code you have provided is incorrect.');
            process.stderr.write('STEAM GUARD! Please enter your 2-factor auth code from your authenticator app: ');
            const code = await ask();
            if (code === '12345') break;
            wrong = true;
        }
        mkdirp(store);
        fs.writeFileSync(token, 'token');
    } else {
        console.log('Logging \'' + user + '\' into Steam3...');
    }
    download();
})();
