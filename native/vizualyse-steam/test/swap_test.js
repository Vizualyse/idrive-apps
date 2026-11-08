// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* src/swap.js: the games' swap file on the hard disk, made once (a small one
 * here), on during a game, off after it, removed by the deactivate; with
 * stand-ins for BusyBox's mkswap, swapon and swapoff that keep a fake
 * /proc/swaps.   node test/swap_test.js */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const T = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-'));
const disk = path.join(T, 'hdshare'), bin = path.join(T, 'bin'), swaps = path.join(T, 'swaps'), calls = path.join(T, 'calls');
fs.mkdirSync(disk); fs.mkdirSync(bin);
fs.writeFileSync(swaps, 'Filename\t\t\t\tType\t\tSize\tUsed\tPriority\n/dev/zram0                              partition\t3145724\t2187776\t75\n');
const fake = (name, body) => fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "' + name + ' $*" >> ' + calls + '\n' + body + '\n', { mode: 0o755 });
fake('mkswap', '[ -f "$1" ]');
fake('swapon', 'f=$3; echo "$f file 8188 1024 $2" >> ' + swaps);
fake('swapoff', 'grep -v "^$1 " ' + swaps + ' > ' + swaps + '.n; mv ' + swaps + '.n ' + swaps);
Object.assign(process.env, { STEAM_DISK: disk, STEAM_SWAP_MB: '8', STEAM_SWAP_BIN: bin, STEAM_SWAPS: swaps });
const swap = require('../src/swap.js');
const FILE = path.join(disk, 'vizualyse-steam', 'swapfile');
assert.strictEqual(swap.FILE, FILE);
const lines = [];
const log = (s) => lines.push(s);
const until = (f, ms) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function poll() { if (f()) return resolve(); if (Date.now() - t0 > ms) return reject(new Error('timed out: ' + lines.join(' | '))); setTimeout(poll, 50); })();
});

(async () => {
    /* off while not made: nothing to do, said */
    await swap.on(log);
    assert.strictEqual(swap.status().on, false);
    assert.ok(/^swap: no swap file for this game/.test(lines.pop()));

    /* made in the background: zeros, mkswap on the .part, renamed into place */
    swap.ensure(log);
    await until(() => swap.status().state === 'ready', 20000);
    assert.strictEqual(fs.statSync(FILE).size, 8 * 1048576);
    assert.strictEqual(fs.statSync(FILE).mode & 0o777, 0o600);
    assert.ok(!fs.existsSync(FILE + '.part'));
    assert.ok(/mkswap .*swapfile\.part/.test(fs.readFileSync(calls, 'utf8')));
    console.log('ok   made once in the background: ' + lines.join(' | '));

    /* the next start finds it made */
    const n = lines.length;
    swap.ensure(log);
    assert.strictEqual(swap.status().state, 'ready');
    assert.strictEqual(lines.length, n);
    console.log('ok   found made at the next start, not made again');

    /* a game: on behind zram (priority 10), then off */
    await swap.on(log);
    assert.ok(/swapon -p 10 .*swapfile$/m.test(fs.readFileSync(calls, 'utf8')));
    assert.deepStrictEqual(swap.status(), { state: 'ready', note: '', on: true, sizeMb: 8, usedMb: 1 });
    await swap.on(log);   /* already on: not again */
    assert.strictEqual(fs.readFileSync(calls, 'utf8').split('\n').filter((l) => /^swapon/.test(l)).length, 1);
    console.log('ok   on while a game runs, behind zram: ' + lines[lines.length - 1]);
    await swap.off(log);
    assert.strictEqual(swap.status().on, false);
    assert.ok(/zram0/.test(fs.readFileSync(swaps, 'utf8')));
    console.log('ok   off after it, zram left alone: ' + lines[lines.length - 1]);

    /* the tool just restarted (a new version) and a game starts before
     * ensure() has looked: the file made earlier goes on all the same */
    delete require.cache[require.resolve('../src/swap.js')];
    const fresh = require('../src/swap.js');
    assert.strictEqual(fresh.status().state, 'none');
    await fresh.on(log);
    assert.strictEqual(fresh.status().on, true, lines.slice(-2).join(' | '));
    await fresh.off(log);
    console.log('ok   a game before the first look still gets the file made earlier');

    /* deactivate while on: off and deleted */
    await swap.on(log);
    assert.strictEqual(swap.remove(), 1);
    assert.ok(!fs.existsSync(FILE));
    assert.strictEqual(swap.active(), null);
    console.log('ok   the deactivate turns it off and deletes it');

    /* a disk too full: not made, said once */
    fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\necho "Filesystem 1K-blocks Used Available Use% Mounted"\necho "/dev/sda2 100 90 1024 90% /x"\n', { mode: 0o755 });
    process.env.PATH = bin + ':' + process.env.PATH;
    const m = lines.length;
    swap.ensure(log);
    await until(() => swap.status().state === 'failed', 5000);
    swap.ensure(log);
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(lines.length, m + 1);
    assert.ok(/not made: 1 MB free on the disk/.test(lines[m]));
    console.log('ok   a full disk: not made, said once: ' + lines[m]);

    fs.rmdirSync(path.join(disk, 'vizualyse-steam'));
    console.log('all swap tests passed');
})().catch((e) => { console.error('FAIL ' + e.stack); process.exit(1); });
