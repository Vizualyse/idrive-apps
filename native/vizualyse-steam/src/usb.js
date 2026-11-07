// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
'use strict';
/*
 * USB sticks as an install location, shared with the HMI.
 *
 * The HMI (udisks2) mounts a stick at /media/<label or uuid>: read-only,
 * noexec, nosuid, nodev; a FAT32 one owned by con_2010 with every file 0777
 * (fmask=0000). Games need to write there (DepotDownloader) and to run from
 * there (Wine maps a game's .exe and .dll with PROT_EXEC). So, when a stick is
 * used for games:
 *  - its filesystem is made read-write in place (remount of the HMI's mount,
 *    its own nosuid / nodev / noexec / atime flags kept: the HMI's view
 *    changes only from ro to rw, and the stick stays in its media player);
 *  - our own view of it, a bind mount at USB_DIR/<id>, allows exec (still
 *    nosuid, nodev). Games live in <stick>/vizualyse-steam/games/<app id>.
 * When the stick goes (udisks unmounts /media/<id>), our bind mount would keep
 * the dead filesystem referenced: watch() lazily unmounts it.
 *
 * FAT32 holds no file over 4 GB and has no owners: works, with a warning.
 * exFAT / NTFS (the unit's Tuxera texfat / tntfs) and ext4 work too; on ext4
 * the games folder is chowned to the tool's uid.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const env = require('./env.js');

const MEDIA = process.env.STEAM_USB_MEDIA || '/media';
const MOUNTS = process.env.STEAM_USB_MOUNTS || '/proc/self/mounts';
const SYS_BLOCK = process.env.STEAM_USB_SYS || '/sys/block';
/* off the car only (test/unit_test.js): a tmpfs at MEDIA/<id> stands in */
const TEST_DEV = process.env.STEAM_USB_TEST_DEV || null;
const USB_DIR = env.ROOT + '/usb';
const GAMES_SUB = 'vizualyse-steam/games';
/* mount flags of the HMI's mount kept on the remount (the rest is its data) */
const KEEP_FLAGS = ['nosuid', 'nodev', 'noexec', 'noatime', 'nodiratime', 'relatime', 'strictatime'];
const UNIX_FS = ['ext2', 'ext3', 'ext4', 'f2fs', 'btrfs', 'xfs'];

function unoctal(s) { return s.replace(/\\([0-7]{3})/g, (m, o) => String.fromCharCode(parseInt(o, 8))); }

function mounts() {
    let t = '';
    try { t = fs.readFileSync(MOUNTS, 'utf8'); } catch (e) { /* none */ }
    return t.split('\n').filter(Boolean).map((l) => {
        const f = l.split(' ');
        return { dev: unoctal(f[0]), dir: unoctal(f[1]), fs: f[2], opts: (f[3] || '').split(',') };
    });
}

/* a removable disk (the unit's hard disk, sda, is not) */
function removable(dev) {
    if (TEST_DEV && dev === TEST_DEV) return true;
    const m = /^\/dev\/(sd[a-z]+)\d*$/.exec(dev);
    if (!m) return false;
    try { return fs.readFileSync(path.join(SYS_BLOCK, m[1], 'removable'), 'utf8').trim() === '1'; } catch (e) { return false; }
}

function idOf(media) { return path.basename(media).replace(/[^A-Za-z0-9_.-]/g, '_'); }

/* the sticks the HMI has mounted: { id, dev, media, fs, ro, fat32, unix, dir, games, attached } */
function sticks() {
    const all = mounts();
    const seen = {};
    return all.filter((m) => path.dirname(m.dir) === MEDIA && removable(m.dev)).map((m) => {
        const id = idOf(m.dir);
        const dir = path.join(USB_DIR, id);
        return { id: id, dev: m.dev, media: m.dir, fs: m.fs, ro: m.opts.indexOf('ro') >= 0,
            fat32: m.fs === 'vfat' || m.fs === 'msdos', unix: UNIX_FS.indexOf(m.fs) >= 0,
            dir: dir, games: path.join(dir, GAMES_SUB), attached: all.some((x) => x.dir === dir) };
    }).filter((s) => (seen[s.id] ? false : (seen[s.id] = true)));
}

function find(id) { return sticks().filter((s) => s.id === id)[0] || null; }

function mount(args) { execFileSync('mount', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 }); }

/* The stick, read-write, with our exec view: returns its games folder. */
function attach(id, uid, gid, log) {
    const s = find(id);
    if (!s) throw new Error('the USB stick ' + id + ' is not plugged in');
    if (s.ro) {
        const m = mounts().filter((x) => x.dir === s.media)[0];
        const keep = m ? m.opts.filter((o) => KEEP_FLAGS.indexOf(o) >= 0) : [];
        mount(['-o', ['remount', 'rw'].concat(keep).join(','), s.media]);
        log('usb: ' + id + ' (' + s.fs + ', ' + s.dev + ') read-write for games');
    }
    if (!s.attached) {
        if (!fs.existsSync(USB_DIR)) fs.mkdirSync(USB_DIR, 0o755);
        if (!fs.existsSync(s.dir)) fs.mkdirSync(s.dir, 0o755);
        mount(['-o', 'bind', s.media, s.dir]);
        mount(['-o', 'remount,bind,rw,exec,nosuid,nodev', s.dir]);
        log('usb: ' + id + ' at ' + s.dir);
    }
    mkdirp(s.games);
    own(s, path.dirname(s.games), 0, 0);
    own(s, s.games, uid, gid);
    return s.games;
}

/* Owners where the filesystem has them; FAT, exFAT, NTFS as the HMI mounts
 * them have one for all (every file 0777): chown fails there, harmlessly. */
function own(s, p, uid, gid) {
    try { fs.chownSync(p, uid, gid); } catch (e) { if (s.unix) throw e; }
}

function mkdirp(d) {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    fs.mkdirSync(d, 0o755);
}

/* A folder for one game on the stick (the tool's uid's where there are owners). */
function gameDir(id, appId, uid, gid) {
    const s = find(id);
    const d = path.join(USB_DIR, id, GAMES_SUB, String(appId));
    mkdirp(d);
    if (s) own(s, d, uid, gid);
    return d;
}

/* The stick a path is on (USB_DIR/<id>/...), or null. */
function idOfPath(p) {
    if (!p || p.indexOf(USB_DIR + '/') !== 0) return null;
    return p.slice(USB_DIR.length + 1).split('/')[0];
}

/* Our views of sticks the HMI no longer has: unmounted (lazily: a game may
 * still hold files). Returns the ids gone. */
function sweep(log) {
    const all = mounts();
    const gone = [];
    all.filter((m) => path.dirname(m.dir) === USB_DIR).forEach((m) => {
        const id = path.basename(m.dir);
        if (sticks().some((s) => s.id === id)) return;
        try { execFileSync('umount', ['-l', m.dir], { stdio: 'ignore', timeout: 15000 }); } catch (e) { /* gone */ }
        log('usb: ' + id + ' removed');
        gone.push(id);
    });
    return gone;
}

/* The games folders on the attached sticks (the library's rescan). */
function gameRoots() { return sticks().filter((s) => s.attached).map((s) => s.games); }

module.exports = { USB_DIR, GAMES_SUB, sticks, find, attach, gameDir, idOfPath, sweep, gameRoots };
