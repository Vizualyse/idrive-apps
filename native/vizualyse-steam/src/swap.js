// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A swap file on the car's hard disk for games, behind the unit's own
 * compressed swap (zram, 3 GB at priority 75). A game near its memory cap
 * pushed the HMI's and the other apps' memory into zram until it was full
 * and the game stalled (Slay the Spire 2, 2026-11-08); the disk takes what
 * zram can't. A spinning disk is slow, so it only takes the overflow
 * (priority 10), and only while a game runs: on() at a game's start, off()
 * at its end, when the RAM is free again.
 *
 * ensure() makes the file once in the background (the tool's start): 4 GB
 * of zeros, mkswap, then renamed into place, so a half-made file is never
 * used. A file of another size is made again. The tool's deactivate
 * (deactivate.js) turns it off and deletes it.
 *
 *   node swap.js show|remove
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const DISK = process.env.STEAM_DISK || '/var/opt/hdshare';
const FILE = process.env.STEAM_SWAP_FILE || path.join(DISK, 'vizualyse-steam', 'swapfile');
const MB = process.env.STEAM_SWAP_MB !== undefined ? Number(process.env.STEAM_SWAP_MB) : 4096;
const PRIO = 10;
const PROC = process.env.STEAM_PROC || '/proc';
/* BusyBox's, where zram.service runs them from; the bench's fakes */
const BIN = process.env.STEAM_SWAP_BIN || '/sbin';
const KEEP_FREE_MB = 2048;   /* left on the disk for games after the file */

let state = 'none';          /* none, making, ready, failed, off (no disk / MB 0) */
let note = '';
let busy = Promise.resolve();   /* swapon / swapoff, one at a time */

function sizeOk() {
    try { return fs.statSync(FILE).size === MB * 1048576; } catch (e) { return false; }
}

/* is the file one of the kernel's swap areas now, and its use (MB) */
function active() {
    let t = '';
    try { t = fs.readFileSync(process.env.STEAM_SWAPS || path.join(PROC, 'swaps'), 'utf8'); } catch (e) { return null; }
    const l = t.split('\n').filter((x) => x.split(/\s+/)[0] === FILE)[0];
    if (!l) return null;
    const f = l.split(/\s+/);
    return { sizeMb: Math.round(Number(f[2]) / 1024), usedMb: Math.round(Number(f[3]) / 1024) };
}

function run(cmd, args, cb) {
    execFile(path.join(BIN, cmd), args, { timeout: 10 * 60000 }, (err, out, errOut) =>
        cb(err ? new Error(cmd + ': ' + (String(errOut || '').trim() || err.message)) : null));
}

/* free MB on the disk (BusyBox df), or null */
function freeMb(cb) {
    execFile('df', ['-k', DISK], { timeout: 5000 }, (err, out) => {
        if (err) return cb(null);
        const l = String(out).trim().split('\n').pop().trim().split(/\s+/);
        const avail = Number(l[l.length - 3]);
        cb(isFinite(avail) ? Math.round(avail / 1024) : null);
    });
}

function ensure(log) {
    if (!(MB > 0)) { state = 'off'; note = 'no swap file (STEAM_SWAP_MB 0)'; return; }
    try { if (!fs.statSync(DISK).isDirectory()) throw new Error('not a folder'); } catch (e) { state = 'off'; note = 'no hard disk at ' + DISK; return; }
    if (sizeOk()) { state = 'ready'; note = ''; return; }
    if (state === 'making') return;
    freeMb((free) => {
        const have = (() => { try { return Math.round(fs.statSync(FILE).size / 1048576); } catch (e) { return 0; } })();
        if (free !== null && free + have < MB + KEEP_FREE_MB) {
            const was = note;
            state = 'failed'; note = 'not made: ' + free + ' MB free on the disk, it needs ' + (MB + KEEP_FREE_MB);
            if (note !== was) log('swap: ' + note);   /* tried again every 10 minutes: said once */
            return;
        }
        state = 'making';
        log('swap: making ' + FILE + ' (' + MB + ' MB) in the background');
        try { if (active()) execFileSync(path.join(BIN, 'swapoff'), [FILE]); } catch (e) { /* in use: made next start */ }
        try { fs.unlinkSync(FILE); } catch (e) { /* none */ }
        require('./unpack').mkdirp(path.dirname(FILE), 0o755);
        const part = FILE + '.part';
        /* dd at the lowest priority where there's a nice: the disk is the games' too */
        execFile('sh', ['-c', 'if command -v nice >/dev/null; then exec nice -n 19 dd "$@"; else exec dd "$@"; fi', 'dd',
            'if=/dev/zero', 'of=' + part, 'bs=1M', 'count=' + MB], { timeout: 30 * 60000 }, (err) => {
            const fail = (m) => { state = 'failed'; note = m; log('swap: ' + m); try { fs.unlinkSync(part); } catch (e) { /* gone */ } };
            if (err) return fail('dd: ' + err.message);
            try { fs.chmodSync(part, 0o600); } catch (e) { return fail(e.message); }
            run('mkswap', [part], (e2) => {
                if (e2) return fail(e2.message);
                try { fs.renameSync(part, FILE); } catch (e) { return fail(e.message); }
                state = 'ready'; note = '';
                log('swap: ' + FILE + ' ready (' + MB + ' MB)');
            });
        });
    });
}

/* at a game's start: the file behind zram */
function on(log) {
    busy = busy.then(() => new Promise((resolve) => {
        if (state !== 'ready' || active()) return resolve();
        run('swapon', ['-p', String(PRIO), FILE], (err) => {
            if (err) log('swap: ' + err.message); else log('swap: ' + MB + ' MB on the disk on (behind zram) while the game runs');
            resolve();
        });
    }));
    return busy;
}

/* at a game's end: back into RAM what it holds, then off */
function off(log) {
    busy = busy.then(() => new Promise((resolve) => {
        const a = active();
        if (!a) return resolve();
        const t0 = Date.now();
        run('swapoff', [FILE], (err) => {
            if (err) log('swap: ' + err.message);
            else log('swap: the disk\'s off again (' + a.usedMb + ' MB were on it, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
            resolve();
        });
    }));
    return busy;
}

/* for the stats: { state, note, sizeMb, usedMb (while on) } */
function status() {
    const a = active();
    return { state: state, note: note, on: !!a, sizeMb: MB, usedMb: a ? a.usedMb : 0 };
}

/* the tool's deactivate: off, deleted */
function remove() {
    try { if (active()) execFileSync(path.join(BIN, 'swapoff'), [FILE]); } catch (e) { /* not on */ }
    let n = 0;
    [FILE, FILE + '.part'].forEach((f) => { try { fs.unlinkSync(f); n++; } catch (e) { /* none */ } });
    return n;
}

module.exports = { ensure: ensure, on: on, off: off, status: status, remove: remove, active: active, FILE: FILE };

if (require.main === module) {
    const cmd = process.argv[2];
    if (cmd === 'remove') console.log('swap: removed ' + remove() + ' file(s)');
    else if (cmd === 'show') console.log(JSON.stringify(Object.assign({ file: FILE, made: sizeOk() }, active() || { on: false })));
    else { console.error('usage: node swap.js show|remove'); process.exit(2); }
}
