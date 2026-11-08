// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * vizualyse-steam: Windows games from the owner's Steam library on the iDrive
 * 7 head unit, through Proton (WineD3D on the unit's own Mesa 19, Wine's
 * Wayland driver into wl-sink), on the central screen while parked.
 * Controlled from a phone page (Steam sign-in and Steam Guard, installing by
 * app id, the library: play, stop, the program to start and its options)
 * and from the iDrive app (vizualyse_steam: play, stop, show, hide, the
 * page's link as a QR code).
 *
 * - The bundles (runtime.tgz, proton.tgz, prefix.tgz: tools/bundle.sh) are
 *   unpacked once into /var/opt/vizualyse-steam (unpack.js); the Windows
 *   prefix only when it is missing (the games' saves live in it).
 * - Downloads: DepotDownloader as the tool's uid 12996 (steam.js).
 * - A game (game.js): wl-sink and Wine as uid 12996 in the render node's
 *   group (the unit's own GPU driver), Wine in a memory cgroup capped at the
 *   memory setting; its pictures go into mgu-render's frame file, shown in
 *   the app area (screen.js); its sound into SmartXbar (pcm_play.py).
 * - Only while parked: the iDrive app sends the speed; above 3 km/h the game
 *   is hidden and can't be shown (it keeps running; Stop ends it).
 * - Nothing starts by itself: a game runs only when asked. While one runs,
 *   state/game-running says which; found at start, the unit restarted
 *   during a game, and the phone page and app say so.
 *
 *   node server.js     (root: the renderer, nftables, the cgroup, the frame file)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { URL } = require('url');
const env = require('./env.js');
const unpack = require('./unpack.js');
const steam = require('./steam.js');
const { Game } = require('./game.js');
const usb = require('./usb.js');
const { Screen } = require('./screen.js');
const firewall = require('./firewall.js');
const { startControl } = require('./control.js');

const HERE = __dirname;
const PORT = Number(process.env.STEAM_PORT) || 8494;           /* the phone page, on the uplink's Wi-Fi */
const IFNAME = 'wlan0';
const LEASE = process.env.STEAM_LEASE || '/run/mgu-uplink/lease.json';
const UPLINK_STATUS = '/run/mgu-uplink/status.json';
const NO_FIREWALL = process.env.STEAM_NO_FIREWALL === '1';
/* The tool's uplink uid (component.json "uids"): downloads and games run as it */
const UID = Number(process.env.STEAM_UID) || 12996;
/* the render node's group (/dev/dri/renderD128): Wine and wl-sink draw on the GPU */
const VIDEO_GID = Number(process.env.STEAM_VIDEO_GID) || 44;
/* Where the game goes: mgu-render's app area on the car (knowledge/central-screen.md) */
const VIEW = (function () {
    const m = /^(\d+)x(\d+)\+(\d+)\+(\d+)$/.exec(process.env.STEAM_VIEW || '1790x638+108+82');
    return { w: Number(m[1]) & ~1, h: Number(m[2]) & ~1, x: Number(m[3]), y: Number(m[4]) };
})();
/* The size the game draws at (Wine's screen: the game goes full screen at it);
 * mgu-render fits it to the app area, aspect kept. 16:9 leaves bars at the
 * sides; the screen's shape fills it (a game may not offer that shape). */
const RESOLUTIONS = [
    { id: '1280x720', w: 1280, h: 720, name: '1280x720 (16:9)' },
    { id: '1344x480', w: 1344, h: 480, name: '1344x480 (the screen\'s shape)' },
    { id: '960x540', w: 960, h: 540, name: '960x540 (16:9, lighter)' },
    { id: '1792x640', w: 1792, h: 640, name: '1792x640 (the screen, full size)' },
];
const FPS_CHOICES = [30, 60];
const CGROUP_ROOT = process.env.STEAM_CGROUP_ROOT || '/sys/fs/cgroup/memory';
/* The game's memory cap: more lets bigger games run, but leaves less to the
 * HMI (the unit has ~5.6 GB in all; the browser's notes: knowledge/browser.md) */
const MEM_CHOICES = [2048, 2560, 3072, 3584];
const MEM_DEFAULT = 2560;
const MAX_KMH = 3;
const GAME_RUNNING = path.join(env.STATE_DIR, 'game-running');

const log = (s) => console.log(new Date().toISOString() + ' ' + s);

/* ---- small helpers ------------------------------------------------------- */

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJson(f, obj, mode) { unpack.mkdirp(path.dirname(f), 0o700); fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1) + '\n', { mode: mode || 0o600 }); fs.renameSync(f + '.tmp', f); }
/* a folder of the tool's uid */
function userDir(d) {
    unpack.mkdirp(d, 0o755);
    fs.chownSync(d, UID, UID);
    return d;
}

function token() {
    const f = path.join(env.STATE_DIR, 'token');
    try { const t = fs.readFileSync(f, 'utf8').trim(); if (/^[0-9a-f]{16}$/.test(t)) return t; } catch (e) { /* new */ }
    const t = crypto.randomBytes(8).toString('hex');
    unpack.mkdirp(env.STATE_DIR, 0o700);
    fs.writeFileSync(f, t + '\n', { mode: 0o600 });
    return t;
}

function uplinkIp() {
    const l = readJson(LEASE);
    if (l && l.ip) return l.ip;
    const ifs = os.networkInterfaces()[IFNAME] || [];
    const v4 = ifs.filter((a) => a.family === 'IPv4' && !a.internal)[0];
    return v4 ? v4.address : (process.env.STEAM_LINK_IP || null);
}

/* The phone's DNS servers, for the runtime's resolver (libc.so.6 reads
 * env.DNS_FILE instead of /etc/resolv.conf: tools/bundle.sh). */
let dnsWritten = null;
function phoneDns() {
    const l = readJson(LEASE) || {};
    return (l.dns && l.dns.length ? l.dns : [l.router]).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(String(x || '')));
}
function writeDns() {
    const servers = phoneDns();
    const text = servers.map((s) => 'nameserver ' + s + '\n').join('') + 'options timeout:3 attempts:2\n';
    if (text === dnsWritten) return;
    try {
        fs.writeFileSync(env.DNS_FILE + '.tmp', text, { mode: 0o644 });
        fs.renameSync(env.DNS_FILE + '.tmp', env.DNS_FILE);
        dnsWritten = text;
        log('dns: ' + (servers.length ? servers.join(', ') : 'no uplink DNS yet'));
    } catch (e) { log('dns: ' + e.message); }
}

/* free MB on the file system of a folder (BusyBox df), or null */
function freeMb(dir, cb) {
    execFile('df', ['-k', dir], { timeout: 5000 }, (err, out) => {
        if (err) return cb(null);
        const l = String(out).trim().split('\n').pop().trim().split(/\s+/);
        const avail = Number(l[l.length - 3]);
        cb(isFinite(avail) ? Math.round(avail / 1024) : null);
    });
}

unpack.mkdirp(env.ROOT, 0o755);
try { fs.chmodSync(env.ROOT, 0o755); } catch (e) { /* not ours */ }
const TOKEN = token();
function link() { const ip = uplinkIp(); return ip ? 'http://' + ip + ':' + PORT + '/?t=' + TOKEN : null; }

/* ---- settings, library ---------------------------------------------------- */

const SETTINGS_FILE = path.join(env.STATE_DIR, 'settings.json');
const settings = Object.assign({ enabled: true, username: '', where: 'internal', resolution: '1280x720', fps: 30,
    memMb: MEM_DEFAULT, sound: true, volume: 100, cellId: 0 }, readJson(SETTINGS_FILE) || {});
/* where downloads come from: 0 Steam's choice by the car's location, or a
 * Steam cell (DepotDownloader -cellid): when that region's servers fail */
const REGIONS = [{ id: 0, name: 'Automatic' }, { id: 15, name: 'Amsterdam' }, { id: 5, name: 'Frankfurt' },
    { id: 14, name: 'Paris' }, { id: 4, name: 'London' }];
if (!RESOLUTIONS.some((r) => r.id === settings.resolution)) settings.resolution = '1280x720';
if (FPS_CHOICES.indexOf(settings.fps) < 0) settings.fps = 30;
if (MEM_CHOICES.indexOf(settings.memMb) < 0) settings.memMb = MEM_DEFAULT;
function saveSettings() { try { writeJson(SETTINGS_FILE, settings); } catch (e) { log('settings: ' + e.message); } }

/* the library: { appId: { name, dir, exe, args, engine, sizeMb, installedAt } } */
const LIBRARY_FILE = path.join(env.STATE_DIR, 'library.json');
const library = readJson(LIBRARY_FILE) || {};
function saveLibrary() { try { writeJson(LIBRARY_FILE, library); } catch (e) { log('library: ' + e.message); } }
/* settings.where: 'internal', 'disk' or 'usb:<stick id>' (usb.js) */
function gamesDir() { return settings.where === 'disk' ? env.DISK_GAMES : env.INTERNAL_GAMES; }
function whereUsb() { return /^usb:/.test(settings.where) ? settings.where.slice(4) : null; }
function diskAvailable() { try { return fs.statSync(env.DISK).isDirectory(); } catch (e) { return false; } }

const space = { internalMb: null, diskMb: null, usbMb: {} };
function checkSpace() {
    freeMb(env.ROOT, (v) => { space.internalMb = v; });
    if (diskAvailable()) freeMb(env.DISK, (v) => { space.diskMb = v; });
    const now = {};
    usb.sticks().forEach((s) => { now[s.id] = space.usbMb[s.id] === undefined ? null : space.usbMb[s.id]; freeMb(s.media, (v) => { space.usbMb[s.id] = v; }); });
    space.usbMb = now;
}
setInterval(checkSpace, 30000);
checkSpace();

/* the stick a game is on; and whether it is plugged in */
function gameStick(g) { return g && usb.idOfPath(g.dir); }
function present(g) { const id = gameStick(g); return !id || !!usb.find(id); }

/* sticks plugged in or pulled: a game or download on a pulled one ends */
let stickIds = '';
setInterval(() => {
    let gone = [];
    try { gone = usb.sweep(log); } catch (e) { log('usb: ' + e.message); }
    gone.forEach((id) => {
        if (game && game.state !== 'ended' && usb.idOfPath(game.o.dir) === id) stopGame('the USB stick ' + id + ' was removed');
        if (download && usb.idOfPath(download.o.dir) === id && ['done', 'failed', 'stopped'].indexOf(download.state) < 0) download.stop();
    });
    const ids = usb.sticks().map((s) => s.id + ':' + s.fs).join(' ');
    if (ids !== stickIds) {
        stickIds = ids;
        log('usb: sticks ' + (ids || 'none'));
        checkSpace();
        if (control) control.broadcast();
    }
}, 3000);

/* the stick read-write with our exec view (usb.js), its games found */
function attachStick(id) {
    const root = usb.attach(id, UID, UID, log);
    rescan(root);
    return root;
}

/* ---- the bundles ----------------------------------------------------------- */

let bundle = { state: 'checking' };       /* checking | unpacking | ready | failed */
let launch = null;
let prefixNote = null;
function ensureBundles(done) {
    bundle = { state: 'unpacking' };
    const steps = [
        ['runtime.tgz', env.RUNTIME, {}],
        ['proton.tgz', env.PROTON, {}],
        ['prefix.tgz', env.PREFIX, { keep: true }],
        ['vulkan.tgz', env.VULKAN, {}],
    ];
    const next = (i) => {
        if (i === steps.length) return done(null);
        const s = steps[i];
        unpack.ensure(process.env['STEAM_' + s[0].replace('.tgz', '').toUpperCase() + '_ARCHIVE'] || path.join(HERE, s[0]), s[1], log, s[2], (err, r) => {
            if (err) return done(new Error(s[0] + ': ' + err.message));
            if (s[1] === env.PREFIX) {
                if (r.unpacked) {
                    /* Wine wants the prefix to be its user's own */
                    try { unpack.chownR(env.PREFIX, UID, UID); } catch (e) { return done(new Error('the prefix: ' + e.message)); }
                } else if (r.kept) {
                    prefixNote = 'the Windows prefix is kept from an earlier version (saves are in it)';
                    log('prefix: kept (' + String(r.kept).slice(0, 12) + '); this release\'s is ' + r.sha.slice(0, 12));
                }
            }
            next(i + 1);
        });
    };
    next(0);
}

/* ---- the memory cgroup ----------------------------------------------------- */

let cgroupDir = null;
function cgroup() {
    const dir = path.join(CGROUP_ROOT, 'vizualyse-steam');
    try {
        if (!fs.existsSync(CGROUP_ROOT)) return null;
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'memory.limit_in_bytes'), String(settings.memMb * 1024 * 1024));
        fs.chownSync(path.join(dir, 'cgroup.procs'), UID, UID);
        return dir;
    } catch (e) {
        log('cgroup: ' + e.message + ' (the game runs without a memory cap)');
        return null;
    }
}
const mem = { usedMb: null, peakMb: null, ooms: null, oomAt: null, note: null };
function readCg(f) { try { return fs.readFileSync(path.join(cgroupDir, f), 'utf8'); } catch (e) { return null; } }
setInterval(() => {
    if (!cgroupDir || !game) return;
    const used = readCg('memory.usage_in_bytes'), peak = readCg('memory.max_usage_in_bytes'), oc = readCg('memory.oom_control');
    if (used !== null) mem.usedMb = Math.round(Number(used) / 1048576);
    if (peak !== null) mem.peakMb = Math.round(Number(peak) / 1048576);
    const m = oc && /oom_kill (\d+)/.exec(oc);
    if (!m) return;
    const n = Number(m[1]);
    if (mem.ooms !== null && n > mem.ooms) {
        mem.oomAt = new Date().toISOString();
        mem.note = 'out of memory: the game needed more than the ' + settings.memMb + ' MB cap';
        log('memory: the game hit its ' + settings.memMb + ' MB cap; the kernel ended one of its processes');
    }
    mem.ooms = n;
}, 2000);

/* ---- the vehicle, the screen ------------------------------------------------- */

const vehicle = { kmh: null, at: 0 };
function moving() { return vehicle.kmh !== null && vehicle.kmh > MAX_KMH && Date.now() - vehicle.at < 10000; }
const screen = new Screen(log);
let wantShown = false;

/* Winston output: the game's pictures straight onto the centre screen as a
 * client of Winston, the unit's compositor (wl-sink's own connection,
 * platform native/winston_out), in full colour, instead of the I420 frame
 * file through mgu-render. The default (seen on the car 2026-11-08); turned
 * off, compatibility mode (mgu-render), kept in settings.winston; the next
 * show uses it; back on mgu-render by itself when wl-sink has no connection
 * to Winston or loses it. */
let winstonOut = settings.winston !== false;
let winstonNote = null;

function via() { return winstonOut && game && game.state !== 'ended' && game.winston ? 'winston' : 'mgu-render'; }

function setWinston(on) {
    on = !!on;
    if (on === winstonOut) return null;
    winstonOut = on;
    winstonNote = null;
    settings.winston = on;
    saveSettings();
    log('winston: ' + (on ? 'on: pictures straight onto the screen through Winston (from the next show)' : 'off: compatibility mode, through mgu-render'));
    if (screen.shown()) { hide('the output changed'); show(); }
    if (control) control.broadcast();
    return null;
}

function show() {
    if (moving()) return 'not while driving';
    if (!game || game.state === 'ended') return 'no game is running';
    wantShown = true;
    if (screen.shown()) return null;
    const e = screen.show(VIEW, via(), game);
    if (e) { wantShown = false; return e; }
    log('screen: shown (' + screen.via + ')');
    startTouch();
    return null;
}

function hide(why) {
    wantShown = false;
    stopTouch();
    if (screen.shown()) { screen.hide(); log('screen: hidden (' + why + ')'); }
}

/* ---- touch: the display's touches on the shown game become its pointer ----
 * steam-touch (vizualyse-chromium's helper) reads a passive copy of the
 * display's touch PDUs on vlan73 while the game is shown: the HMI still gets
 * every one, nothing is claimed (a claim restarted the unit,
 * knowledge/central-screen.md). A touch on the picture (mgu-render fits it to
 * VIEW, aspect kept, centred) goes to wl-sink in the game's own pixels: a tap
 * is a left click, a drag moves with the button held. One that starts on the
 * bars or outside the picture is ignored, to its end. */
const TOUCH_IFACE = process.env.STEAM_TOUCH_IFACE !== undefined ? process.env.STEAM_TOUCH_IFACE : 'vlan73';
const TOUCH_SRC = process.env.STEAM_TOUCH_SRC || '160.48.199.115';
const TOUCH_FILE = process.env.STEAM_TOUCH_FILE || '';
let touch = null, touching = false, lastTouch = { x: 0, y: 0 };

function startTouch() {
    if (touch) return;
    const bin = process.env.STEAM_TOUCH || path.join(env.RUNTIME, 'steam-touch');
    if (!fs.existsSync(bin)) { log('touch: no ' + bin); return; }
    const args = TOUCH_FILE ? ['--touch-file', TOUCH_FILE] : ['--touch-iface', TOUCH_IFACE, '--touch-src', TOUCH_SRC];
    let t;
    try { t = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { log('touch: ' + e.message); return; }
    touch = t;
    touching = false;
    let rest = '';
    t.stdout.on('data', (d) => {
        const lines = (rest + d).split('\n');
        rest = lines.pop();
        lines.forEach((l) => {
            let e;
            try { e = JSON.parse(l); } catch (x) { return; }
            if (e.ev === 'touch') onTouch(e);
            else if (e.ev === 'ready') log('touch: ready (' + (e.touch ? 'reading' : 'no touch') + ')');
            else if (e.ev === 'error') log('touch: ' + e.error);
        });
    });
    t.stderr.on('data', (d) => log('touch: ' + String(d).trim()));
    t.stdin.on('error', () => { /* it exited */ });
    t.on('error', (e) => log('touch: ' + e.message));
    t.on('exit', (code, sig) => { if (touch === t) { touch = null; log('touch: exited (' + (sig || code) + ')'); } });
}

function stopTouch() {
    if (!touch) return;
    const t = touch;
    touch = null;
    if (touching && game) game.input('u', lastTouch.x, lastTouch.y);   /* the button is not left held */
    touching = false;
    try { t.stdin.end(); } catch (e) { /* gone */ }
    setTimeout(() => { try { t.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1000);
}

/* screen pixels -> the game's frame pixels (null: not on the picture) */
function toFrame(sx, sy) {
    const f = game && game.o.frame;
    if (!f) return null;
    const s = Math.min(VIEW.w / f.w, VIEW.h / f.h);
    const ox = VIEW.x + (VIEW.w - f.w * s) / 2, oy = VIEW.y + (VIEW.h - f.h * s) / 2;
    const x = (sx - ox) / s, y = (sy - oy) / s;
    return { x: x, y: y, on: x >= 0 && y >= 0 && x < f.w && y < f.h, w: f.w, h: f.h };
}

/* A tap's finger wobbles a few pixels between down and up: with the button
 * held each wobble is a drag, and a game that drags on any motion (Slay the
 * Spire 2's map, 2026-11-08) scrolled instead of clicking. So moves count only
 * once the finger has gone TAP_SLOP screen pixels from where it went down;
 * a touch that never did is a click where it went down. */
const TAP_SLOP = 14;
let touchDown = null;      /* { sx, sy (screen), x, y (frame), dragging } */

function onTouch(e) {
    if (!game || game.state === 'ended' || !screen.shown()) return;
    const p = toFrame(e.x, e.y);
    if (!p) return;
    const cx = Math.max(0, Math.min(p.w - 1, p.x)), cy = Math.max(0, Math.min(p.h - 1, p.y));
    lastTouch = { x: cx, y: cy };
    if (e.p === 1) {            /* down */
        if (!p.on) return;
        touching = true;
        touchDown = { sx: e.x, sy: e.y, x: p.x, y: p.y, dragging: false };
        game.input('d', p.x, p.y);
    } else if (e.p === 2) {     /* move */
        if (!touching) return;
        if (touchDown && !touchDown.dragging) {
            if (Math.abs(e.x - touchDown.sx) < TAP_SLOP && Math.abs(e.y - touchDown.sy) < TAP_SLOP) return;
            touchDown.dragging = true;
        }
        game.input('m', cx, cy);
    } else if (e.p === 3) {     /* up */
        if (touching) {
            if (touchDown && !touchDown.dragging) { game.input('u', touchDown.x, touchDown.y); lastTouch = { x: touchDown.x, y: touchDown.y }; }
            else game.input('u', cx, cy);
        }
        touching = false;
        touchDown = null;
    }
}

function setSpeed(kmh) {
    const v = Number(kmh);
    vehicle.kmh = isFinite(v) ? v : null;
    vehicle.at = Date.now();
    if (moving() && (wantShown || screen.shown())) hide('driving (' + v.toFixed(0) + ' km/h)');
}

/* ---- downloads ------------------------------------------------------------------- */

let download = null;      /* the Download running, or the last one */

function install(appId, validate) {
    appId = Number(appId);
    if (!(appId > 0 && appId < 1e8)) return 'type a Steam app id (the number in the game\'s store address)';
    if (!settings.username) return 'sign in first: your Steam account name';
    if (bundle.state !== 'ready') return 'the tool is still installing itself';
    if (download && ['done', 'failed', 'stopped'].indexOf(download.state) < 0) return 'a download is running';
    if (settings.where === 'disk' && !diskAvailable()) return 'this car has no hard disk at ' + env.DISK;
    const stick = whereUsb();
    if (stick && !usb.find(stick)) return 'the USB stick ' + stick + ' is not plugged in (or pick another place)';
    /* a game already installed elsewhere is updated where it is */
    const old = library[appId] && library[appId].dir;
    let dir;
    try {
        userDir(env.HOME);
        if (old && usb.idOfPath(old)) {
            if (!present(library[appId])) return 'it is on the USB stick ' + usb.idOfPath(old) + ': plug it in';
            attachStick(usb.idOfPath(old));
            dir = old;
        } else if (old && fs.existsSync(old)) {
            dir = userDir(old);
        } else if (stick) {
            attachStick(stick);
            dir = usb.gameDir(stick, appId, UID, UID);
        } else {
            unpack.mkdirp(gamesDir(), 0o755);
            if (settings.where === 'disk') fs.chownSync(path.dirname(gamesDir()), 0, 0);
            dir = userDir(path.join(gamesDir(), String(appId)));
        }
        userDir(path.join(env.HOME, 'tmp'));
    } catch (e) { return 'the games folder: ' + e.message; }
    writeDns();
    const d = new steam.Download({ appId: appId, username: settings.username, dir: dir, uid: UID, gid: UID, validate: !!validate, cellId: settings.cellId || 0, log: log });
    download = d;
    d.on('change', () => { if (control) control.broadcast(); });
    d.on('end', (st) => {
        if (st.state === 'done') added(appId, dir);
        if (control) control.broadcast();
    });
    d.start();
    if (!library[appId] || !library[appId].name) {
        steam.storeName(appId, phoneDns()[0], UID, UID, (name) => {
            if (!name) return;
            if (library[appId]) { library[appId].name = name; saveLibrary(); }
            names[appId] = name;
            if (control) control.broadcast();
        });
    }
    return null;
}
const names = {};

/* a finished download: its program found, the game in the library */
function added(appId, dir) {
    const old = library[appId] || {};
    const name = old.name || names[appId] || (steam.KNOWN[appId] && steam.KNOWN[appId].name) || 'App ' + appId;
    const exes = steam.findExes(dir, name);
    const exe = old.exe && exes.some((x) => x.rel === old.exe) ? old.exe : (exes[0] && exes[0].rel) || null;
    const eng = exe ? steam.engine(dir, exe) : null;
    library[appId] = { name: name, dir: dir, exe: exe, args: old.args || steam.defaultArgs(eng), engine: eng,
        sizeMb: Math.round(steam.du(dir) / 1048576), installedAt: old.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString(),
        noSteam: !!old.noSteam, steamApi: steamApiFiles(dir).length, arch: exe ? steam.arch(dir, exe) : null };
    /* Vulkan: a choice made by hand stays; none, the default (vulkanOn) */
    if (old.vulkan === true || old.vulkan === false) library[appId].vulkan = old.vulkan;
    saveLibrary();
    log('library: ' + name + ' (' + appId + '): ' + (exe || 'no program found') + (eng ? ', ' + eng : '') + ', ' + library[appId].sizeMb + ' MB');
    /* an update or a check put Steam's own steam_api back: the emulator again */
    if (old.noSteam) { const e = noSteam(appId, true); if (e) log('no-steam: ' + e); }
}

/* ---- Run without Steam: gbe_fork (Goldberg's Steam emulator) ----------------
 * For a game that quits without the Steam client (which doesn't run here):
 * its steam_api64.dll / steam_api.dll are swapped for gbe_fork's (the
 * runtime's goldberg/, LGPL-3.0), each original kept beside it as
 * <name>.vzs-orig, with a steam_settings folder (gbe_fork reads it beside
 * its DLL): the app id, the account's name, no networking (no LAN
 * broadcasts on the car's network). Off: the originals back, our settings
 * gone. Achievements and cloud saves stay local; a game wrapped in Steam's
 * DRM (SteamStub) still won't start. Off by default, per game. */
const GBE = path.join(env.RUNTIME, 'goldberg');
const API_DLLS = { 'steam_api64.dll': 'x64/steam_api64.dll', 'steam_api.dll': 'x86/steam_api.dll' };
const ORIG = '.vzs-orig';
const MARK = '.vizualyse-steam';

/* the game's Steam API DLLs (paths), a few folders deep */
function steamApiFiles(dir, depth) {
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { return out; }
    names.forEach((n) => {
        const p = path.join(dir, n);
        let st;
        try { st = fs.lstatSync(p); } catch (e) { return; }
        if (st.isDirectory() && (depth || 0) < 4 && n !== 'steam_settings' && n !== '.DepotDownloader') out.push.apply(out, steamApiFiles(p, (depth || 0) + 1));
        else if (st.isFile() && API_DLLS[n.toLowerCase()]) out.push(p);
    });
    return out;
}

function sameFile(a, b) {
    try {
        const sa = fs.statSync(a), sb = fs.statSync(b);
        return sa.size === sb.size && fs.readFileSync(a).equals(fs.readFileSync(b));
    } catch (e) { return false; }
}

/* owners where the filesystem has them (FAT / exFAT / NTFS: none) */
function ownIfCan(p) { try { fs.chownSync(p, UID, UID); } catch (e) { /* no owners */ } }

function noSteam(appId, on) {
    const g = library[appId];
    if (!g) return 'not in the library';
    if (game && game.o.appId === Number(appId) && game.state !== 'ended') return 'stop the game first';
    const stick = gameStick(g);
    if (stick) {
        if (!present(g)) return 'it is on the USB stick ' + stick + ': plug it in';
        try { attachStick(stick); } catch (e) { return 'the USB stick: ' + e.message; }
    }
    const files = steamApiFiles(g.dir);
    if (on && !files.length) return 'this game has no steam_api DLL: it doesn\'t use the Steam API this way';
    try {
        files.forEach((f) => {
            const gbe = path.join(GBE, API_DLLS[path.basename(f).toLowerCase()]);
            const d = path.dirname(f), sd = path.join(d, 'steam_settings');
            if (on) {
                if (!fs.existsSync(gbe)) throw new Error('no ' + gbe + ' (an older bundle)');
                /* Steam's own (new, or put back by an update): kept as the original */
                if (!sameFile(f, gbe)) fs.renameSync(f, f + ORIG);
                fs.copyFileSync(gbe, f);
                ownIfCan(f);
                if (!fs.existsSync(sd)) fs.mkdirSync(sd, 0o755);
                if (fs.existsSync(path.join(sd, MARK)) || fs.readdirSync(sd).length === 0) {
                    const acct = (settings.username || 'Player').replace(/[^\w.@ -]/g, '');
                    fs.writeFileSync(path.join(sd, MARK), 'written by vizualyse-steam: Run without Steam\n');
                    fs.writeFileSync(path.join(sd, 'steam_appid.txt'), String(appId) + '\n');
                    fs.writeFileSync(path.join(sd, 'configs.user.ini'), '[user::general]\naccount_name=' + acct + '\nlanguage=english\n');
                    fs.writeFileSync(path.join(sd, 'configs.main.ini'), '[main::connectivity]\ndisable_networking=1\n');
                    ownIfCan(sd);
                    fs.readdirSync(sd).forEach((n) => ownIfCan(path.join(sd, n)));
                }
            } else {
                if (fs.existsSync(f + ORIG)) {
                    fs.unlinkSync(f);
                    fs.renameSync(f + ORIG, f);
                }
                if (fs.existsSync(path.join(sd, MARK))) unpack.rmrf(sd);
            }
        });
    } catch (e) { return 'Run without Steam: ' + e.message; }
    g.noSteam = !!on;
    g.steamApi = files.length;
    saveLibrary();
    log('no-steam: ' + g.name + ' (' + appId + '): ' + (on ? 'gbe_fork in place of ' : 'Steam\'s own ') + files.length + ' steam_api DLL' + (files.length === 1 ? '' : 's'));
    return null;
}

function removeGame(appId) {
    const g = library[appId];
    if (!g) return 'not in the library';
    if (game && game.o.appId === Number(appId) && game.state !== 'ended') return 'stop the game first';
    if (download && download.o.appId === Number(appId) && ['done', 'failed', 'stopped'].indexOf(download.state) < 0) return 'its download is running';
    const stick = gameStick(g);
    if (stick) {
        if (!present(g)) return 'it is on the USB stick ' + stick + ': plug it in to remove it';
        try { attachStick(stick); } catch (e) { return 'the USB stick: ' + e.message; }
    }
    delete library[appId];
    saveLibrary();
    /* only a folder of ours */
    if (g.dir && (g.dir.indexOf(env.INTERNAL_GAMES + '/') === 0 || g.dir.indexOf(env.DISK_GAMES + '/') === 0
        || (stick && g.dir.indexOf(path.join(usb.USB_DIR, stick, usb.GAMES_SUB) + '/') === 0))) {
        try { unpack.rmrf(g.dir); } catch (e) { log('remove: ' + e.message); }
    }
    log('library: removed ' + g.name + ' (' + appId + ')');
    checkSpace();
    return null;
}

function setGameOptions(appId, b) {
    const g = library[appId];
    if (!g) return 'not in the library';
    if (b.exe !== undefined) {
        const exes = steam.findExes(g.dir, g.name);
        if (!exes.some((x) => x.rel === b.exe)) return 'no such program in the game\'s folder';
        g.exe = b.exe;
        g.engine = steam.engine(g.dir, g.exe);
        g.arch = steam.arch(g.dir, g.exe);
    }
    if (b.args !== undefined) {
        const a = String(b.args).trim();
        if (a.length > 300) return 'too long';
        g.args = a ? a.split(/\s+/) : [];
    }
    if (b.vulkan !== undefined) {
        if (b.vulkan) {
            const m = env.vulkanMissing();
            if (m.length) return 'no Vulkan driver here (' + m[0] + ' is missing)';
        }
        if (!!b.vulkan !== vulkanOn(g)) log('vulkan: ' + g.name + ' ' + (b.vulkan ? 'on (from its next start)' : 'off (OpenGL, WineD3D)'));
        g.vulkan = !!b.vulkan;
    }
    saveLibrary();
    if (b.noSteam !== undefined && !!b.noSteam !== !!g.noSteam) return noSteam(appId, !!b.noSteam);
    return null;
}

/* ---- the game ------------------------------------------------------------------- */

let game = null;          /* the Game running, or the last one */
let restartNote = null;
(function () {
    const t = readJson(GAME_RUNNING);
    if (!t) return;
    restartNote = 'the unit restarted while ' + (t.name || 'a game') + ' ran (' + (t.at || '?') + ')';
    /* a restart during a game on Vulkan: that game's Vulkan goes off (a GPU
     * hang may have caused it; turning it on again is by hand) */
    if (t.vulkan && library[t.appId] && vulkanOn(library[t.appId])) {
        library[t.appId].vulkan = false;
        saveLibrary();
        restartNote += ' on Vulkan: Vulkan is off for it now (its last DRM calls: state/vulkan-crumbs.log)';
    }
    log('game: ' + restartNote);
    try { fs.unlinkSync(GAME_RUNNING); } catch (e) { /* gone */ }
})();

/* ---- Vulkan (per game) -------------------------------------------------------
 * DXVK 1.9.4 for Direct3D 9-11, a Godot 4 game's own Vulkan renderer, on
 * Mesa 19.0.6's ANV (vulkan.tgz, env.VK). The default for 64-bit games (seen
 * on the car 2026-11-08: Direct3D 9 / 11 test programs, Slay the Spire 2 on
 * Forward+); 32-bit games stay on OpenGL (WineD3D) until 32-bit Vulkan
 * through WoW64 has been seen working. A choice made on the phone page stays
 * (g.vulkan); a restart of the unit during a game on Vulkan turns it off for
 * that game. While one runs: ANV's ICD in RUN_DIR (tmpfs: gone at any
 * restart), removed at its end; DXVK in the prefix (native only with Vulkan
 * on: other games keep WineD3D, env.wineEnv); the game's DRM calls in
 * VK.crumbsLog. */
let vulkanCrumbs = null;

/* a game's bitness, read once from its program */
function gameArch(g) {
    if (g.arch === undefined && g.exe) { g.arch = steam.arch(g.dir, g.exe); saveLibrary(); }
    return g.arch || null;
}
function vulkanDefault(g) { return gameArch(g) === 'x64' && env.vulkanMissing().length === 0; }
function vulkanOn(g) { return g.vulkan === true || g.vulkan === false ? g.vulkan : vulkanDefault(g); }

function vulkanPrepare() {
    const m = env.vulkanMissing();
    if (m.length) throw new Error('no Vulkan driver here: ' + m[0] + ' is missing');
    try { fs.mkdirSync(env.RUN_DIR, 0o755); } catch (e) { /* there */ }
    fs.writeFileSync(env.VK.icd, JSON.stringify({ file_format_version: '1.0.0', ICD: { library_path: env.VK.driver, api_version: '1.1.102' } }) + '\n');
    fs.chmodSync(env.VK.icd, 0o644);
    /* DXVK into the prefix, where it differs (Proton does the same for its own) */
    const win = path.join(env.PREFIX, 'pfx', 'drive_c', 'windows');
    [['x64', 'system32'], ['x32', 'syswow64']].forEach((a) => {
        if (!fs.existsSync(path.join(win, a[1]))) return;
        env.VK.dlls.forEach((d) => {
            const src = path.join(env.VK.dxvk, a[0], d + '.dll'), dst = path.join(win, a[1], d + '.dll');
            const same = (() => { try { return fs.readFileSync(src).equals(fs.readFileSync(dst)); } catch (e) { return false; } })();
            if (same) return;
            try { if (fs.lstatSync(dst).isSymbolicLink()) fs.unlinkSync(dst); } catch (e) { /* none */ }
            fs.writeFileSync(dst, fs.readFileSync(src));
            fs.chownSync(dst, UID, UID);   /* a regular file we just wrote: no link to follow */
        });
    });
    vulkanCrumbs = fs.openSync(env.VK.crumbsLog, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_DSYNC, 0o600);
}

function vulkanEnd() {
    try { fs.unlinkSync(env.VK.icd); } catch (e) { /* gone */ }
    if (vulkanCrumbs !== null) { try { fs.closeSync(vulkanCrumbs); } catch (e) { /* closed */ } vulkanCrumbs = null; }
}

/* A Godot 4 game's default options pick its OpenGL renderer: with Vulkan,
 * its Vulkan driver instead, with the game's own rendering method (Slay the
 * Spire 2: Forward+, on the car 2026-11-08). Adding --rendering-method mobile
 * made its Godot (MegaDot 4.5.1) take Direct3D 12, which Wine's vkd3d can't do
 * on ANV 19. Options edited by hand stay. */
function vulkanArgs(g) {
    const a = (g.args || []).slice();
    const i = a.indexOf('--rendering-driver');
    if (g.engine === 'godot' && i >= 0 && a[i + 1] === 'opengl3') a[i + 1] = 'vulkan';
    return a;
}

function play(appId) {
    appId = Number(appId);
    const g = library[appId];
    if (!settings.enabled) return 'the tool is off';
    if (!g) return 'not installed';
    if (!g.exe) return 'no program found in its folder (the phone page lists them)';
    if (bundle.state !== 'ready' || !launch) return 'the tool is still installing itself';
    if (game && game.state !== 'ended') return game.o.appId === appId ? null : 'another game is running: stop it first';
    if (download && download.o.appId === appId && ['done', 'failed', 'stopped'].indexOf(download.state) < 0) return 'it is still downloading';
    if (moving()) return 'not while driving';
    const stick = gameStick(g);
    if (stick) {
        if (!present(g)) return 'it is on the USB stick ' + stick + ': plug it in';
        try { attachStick(stick); } catch (e) { return 'the USB stick: ' + e.message; }
    }
    let missing;
    try { missing = env.gpuLibs(); } catch (e) { return 'the GPU libraries: ' + e.message; }
    if (missing.length) return 'this unit has no ' + missing.join(', ');
    const res = RESOLUTIONS.filter((r) => r.id === settings.resolution)[0];
    try { userDir(env.HOME); writeDns(); } catch (e) { return e.message; }
    const vulkan = vulkanOn(g);
    if (vulkan) { try { vulkanPrepare(); } catch (e) { vulkanEnd(); return 'Vulkan: ' + e.message; } }
    cgroupDir = cgroup();
    mem.ooms = null; mem.note = null; mem.oomAt = null; mem.peakMb = null;
    restartNote = null;
    /* written (fsynced) before Wine opens the GPU: found at the next start, the unit restarted during it */
    try { writeJson(GAME_RUNNING, { appId: appId, name: g.name, at: new Date().toISOString(), vulkan: vulkan }); } catch (e) { log('game: ' + e.message); }
    const args = vulkan ? vulkanArgs(g) : g.args;
    const x = new Game({ appId: appId, name: g.name, dir: g.dir, exe: g.exe, args: args, launch: launch,
        frame: { w: res.w, h: res.h }, fps: settings.fps, uid: UID, gid: VIDEO_GID, cgroup: cgroupDir,
        sound: settings.sound, volume: () => settings.volume, log: log,
        vulkan: vulkan, crumbsFd: vulkan ? vulkanCrumbs : undefined });
    log('vulkan: ' + g.name + (vulkan ? ' on Vulkan (DXVK 1.9.4 / ANV 19.0.6)' + (args !== g.args ? ', ' + args.join(' ') : '')
        : ' on OpenGL (WineD3D)') + ' (' + (g.vulkan === true || g.vulkan === false ? 'chosen' : 'the default for ' + (gameArch(g) || 'an unknown') + ' program') + ')');
    game = x;
    x.on('winston-lost', () => {
        winstonNote = 'the connection to Winston was lost: back on mgu-render';
        log('winston: ' + winstonNote);
        if (game === x && screen.shown() && screen.via === 'winston') { hide('Winston went'); show(); }
        if (control) control.broadcast();
    });
    x.on('state', (st) => {
        if (st === 'ended') {
            if (vulkan) vulkanEnd();
            try { fs.unlinkSync(GAME_RUNNING); } catch (e) { /* gone */ }
            if (game === x) hide('the game ended');
        }
        if (control) control.broadcast();
    });
    x.start();
    log('game: ' + g.name + ' (' + appId + ') at ' + res.w + 'x' + res.h + ', ' + settings.fps + ' fps, ' + settings.memMb + ' MB cap');
    return null;
}

function stopGame(why) {
    if (!game || game.state === 'ended') return 'no game is running';
    hide('the game is stopping');
    game.stop(why || 'stopped');
    return null;
}

/* ---- settings from the phone or the app --------------------------------------------- */

function setResolution(id) {
    if (id === 'next') {
        const i = RESOLUTIONS.findIndex((r) => r.id === settings.resolution);
        id = RESOLUTIONS[(i + 1) % RESOLUTIONS.length].id;
    }
    if (!RESOLUTIONS.some((r) => r.id === id)) return 'unknown resolution';
    settings.resolution = id;
    saveSettings();
    log('settings: resolution ' + id + ' (from the next game)');
    return null;
}

function setSetting(b) {
    if (b.where !== undefined) {
        b.where = String(b.where);
        if (b.where !== 'internal' && b.where !== 'disk' && !/^usb:[A-Za-z0-9_.-]+$/.test(b.where)) return 'internal, disk or usb:<stick>';
        if (b.where === 'disk' && !diskAvailable()) return 'this car has no hard disk at ' + env.DISK;
        if (/^usb:/.test(b.where) && !usb.find(b.where.slice(4))) return 'the USB stick ' + b.where.slice(4) + ' is not plugged in';
        settings.where = b.where;
    }
    if (b.fps !== undefined) { if (FPS_CHOICES.indexOf(Number(b.fps)) < 0) return 'fps: ' + FPS_CHOICES.join(' or '); settings.fps = Number(b.fps); }
    if (b.memMb !== undefined) {
        if (MEM_CHOICES.indexOf(Number(b.memMb)) < 0) return 'memory: one of ' + MEM_CHOICES.join(', ') + ' MB';
        settings.memMb = Number(b.memMb);
        if (cgroupDir) { try { fs.writeFileSync(path.join(cgroupDir, 'memory.limit_in_bytes'), String(settings.memMb * 1048576)); } catch (e) { /* from the next game */ } }
    }
    if (b.sound !== undefined) settings.sound = !!b.sound;
    if (b.cellId !== undefined) {
        if (!REGIONS.some((r) => r.id === Number(b.cellId))) return 'region: ' + REGIONS.map((r) => r.id + ' ' + r.name).join(', ');
        settings.cellId = Number(b.cellId);
        log('settings: downloads from ' + REGIONS.filter((r) => r.id === settings.cellId)[0].name + ' (from the next download)');
    }
    if (b.volume !== undefined) { const v = Number(b.volume); if (!(v >= 0 && v <= 150)) return 'volume 0-150'; settings.volume = Math.round(v); }
    if (b.resolution !== undefined) { const e = setResolution(String(b.resolution)); if (e) return e; }
    saveSettings();
    return null;
}

function setUser(name) {
    const n = String(name || '').trim();
    if (!/^[A-Za-z0-9_.@-]{2,64}$/.test(n)) return 'a Steam account name (letters, digits, _ . @ -)';
    settings.username = n;
    saveSettings();
    log('steam: account ' + n);
    return null;
}

/* ---- status ---------------------------------------------------------------------- */

function status() {
    const up = readJson(UPLINK_STATUS) || {};
    const g = game && game.state !== 'ended' ? game : null;
    return {
        enabled: settings.enabled, link: link(), uplink: up.state || 'unknown', bundle: bundle.state,
        error: bundle.error || null, prefixNote: prefixNote, restartNote: restartNote, vulkanAvailable: env.vulkanMissing().length === 0,
        account: { username: settings.username || null, remembered: settings.username ? steam.remembered() : false },
        download: download ? Object.assign(download.status(), { name: (library[download.o.appId] && library[download.o.appId].name) || names[download.o.appId] || null }) : null,
        library: Object.keys(library).map((id) => {
            const x = library[id];
            return { appId: Number(id), name: x.name, exe: x.exe, args: (x.args || []).join(' '), engine: x.engine, sizeMb: x.sizeMb,
                usb: gameStick(x), present: present(x),
                /* steamApi: its steam_api DLLs (unknown for a game added before 0.1.4) */
                noSteam: !!x.noSteam, steamApi: x.steamApi === undefined ? null : x.steamApi,
                vulkan: vulkanOn(x), vulkanDefault: vulkanDefault(x), arch: gameArch(x) };
        }).sort((a, b) => a.name.localeCompare(b.name)),
        game: game ? { appId: game.o.appId, name: game.o.name, state: game.state, title: game.title, since: new Date(game.since).toISOString(),
            pictures: game.stats.pictures, fps: game.stats.fps, gpuBuffers: !!game.gpuBuffers, sinkMs: game.stats.ms,
            buffers: { drm: game.stats.drm, shm: game.stats.shm, fwd: game.stats.fwd || 0 }, note: game.note,
            /* the controllers in use: [{ player, name }] (steam-pads) */
            pads: Object.keys(game.pads || {}).map((k) => ({ player: Number(k) + 1, name: game.pads[k] })) } : null,
        running: !!g, shown: screen.shown(), speed: vehicle.kmh, moving: moving(),
        winston: { on: winstonOut, connected: !!(g && g.winston), via: screen.via, note: winstonNote },
        settings: { where: settings.where, resolution: settings.resolution, fps: settings.fps, memMb: settings.memMb, sound: settings.sound, volume: settings.volume, cellId: settings.cellId || 0 },
        choices: { resolutions: RESOLUTIONS.map((r) => ({ id: r.id, name: r.name })), fps: FPS_CHOICES, memMb: MEM_CHOICES, regions: REGIONS, disk: diskAvailable(),
            usb: usb.sticks().map((s) => ({ id: s.id, fs: s.fs, fat32: s.fat32 })) },
        space: space, memory: { capMb: settings.memMb, usedMb: g ? mem.usedMb : null, peakMb: mem.peakMb, note: mem.note, oomAt: mem.oomAt },
    };
}

/* ---- the phone page ------------------------------------------------------------------ */

const PAGE = fs.readFileSync(path.join(HERE, 'page.html'), 'utf8');

function send(res, code, type, body) {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
}
function json(res, code, obj) { send(res, code, 'application/json', JSON.stringify(obj)); }
function readBody(req, cb) {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 16384) req.destroy(); });
    req.on('end', () => { try { cb(null, b ? JSON.parse(b) : {}); } catch (e) { cb(e); } });
}
function authorised(req, u) {
    const t = req.headers['x-steam-token'] || u.searchParams.get('t') || '';
    return t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

const ROUTES = {
    '/api/user': (b) => setUser(b.username),
    '/api/install': (b) => install(b.appId, false),
    '/api/validate': (b) => install(b.appId, true),
    '/api/answer': (b) => (download ? download.answer(b.text) : 'nothing is asking'),
    '/api/cancel': () => { if (!download) return 'no download'; download.stop(); return null; },
    '/api/play': (b) => play(b.appId),
    '/api/stop': () => stopGame('stopped from the phone'),
    '/api/show': () => show(),
    '/api/hide': () => { hide('hidden from the phone'); return null; },
    '/api/remove': (b) => removeGame(b.appId),
    '/api/game': (b) => setGameOptions(b.appId, b),
    '/api/settings': (b) => setSetting(b),
    '/api/winston': (b) => setWinston(b.on),
};

const web = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (!authorised(req, u)) return send(res, 403, 'text/plain', 'Scan the QR code on the iDrive Steam page to open this page.\n');
    if (!settings.enabled) return send(res, 503, 'text/plain', 'Steam is off: turn it on on the iDrive Steam page.\n');
    if (req.method === 'GET' && u.pathname === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
    if (req.method === 'GET' && u.pathname === '/api/status') return json(res, 200, status());
    if (req.method === 'GET' && u.pathname === '/api/exes') {
        const g = library[u.searchParams.get('appId')];
        return json(res, g ? 200 : 404, g ? steam.findExes(g.dir, g.name) : { error: 'not installed' });
    }
    if (req.method !== 'POST' || !ROUTES[u.pathname]) return json(res, 404, { error: 'not found' });
    readBody(req, (err, b) => {
        if (err) return json(res, 400, { error: 'bad JSON' });
        let e;
        try { e = ROUTES[u.pathname](b); } catch (x) { e = x.message; }
        if (control) control.broadcast();
        if (e) return json(res, 400, { error: e, status: status() });
        json(res, 200, status());
    });
});

/* ---- the iDrive app -------------------------------------------------------------------- */

function addFirewall() {
    if (NO_FIREWALL) return;
    try { log('firewall: ' + firewall.add(PORT, IFNAME) + ' rule for ' + IFNAME + ' tcp ' + PORT); } catch (e) { log('firewall: ' + e.message); }
}
function removeFirewall() {
    if (NO_FIREWALL) return;
    try { log('firewall: removed ' + firewall.remove() + ' rule(s)'); } catch (e) { log('firewall: ' + e.message); }
}

function setEnabled(on) {
    if (settings.enabled === on) return;
    settings.enabled = on;
    saveSettings();
    if (on) addFirewall();
    else {
        stopGame('Steam was turned off');
        if (download) download.stop();
        removeFirewall();
    }
    log('steam: ' + (on ? 'on' : 'off'));
}

let control = null;
function command(c) {
    if (c.cmd === 'speed') { setSpeed(c.kmh); return null; }
    if (c.cmd === 'enable') { setEnabled(true); return null; }
    if (c.cmd === 'disable') { setEnabled(false); return null; }
    if (!settings.enabled) return 'Steam is off';
    if (c.cmd === 'show') return show();
    if (c.cmd === 'hide') { hide('hidden on the iDrive page'); return null; }
    if (c.cmd === 'play') return play(c.appId);
    if (c.cmd === 'stop') return stopGame('stopped on the iDrive page');
    if (c.cmd === 'resolution') return setResolution('next');
    if (c.cmd === 'winston') return setWinston(c.on);
    return 'unknown command';
}

/* ---- start and stop ---------------------------------------------------------------------- */

let stopping = false;
function shutdown(sig) {
    if (stopping) return;
    stopping = true;
    log('stopping (' + sig + ')');
    hide('the tool stops');
    if (download) download.stop();
    removeFirewall();
    if (control) control.close();
    web.close();
    const done = () => process.exit(0);
    if (game && game.state !== 'ended') { game.on('end', () => setTimeout(done, 200)); game.stop('the tool stopped'); }
    else setTimeout(done, 200);
    setTimeout(done, 12000);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (settings.enabled) addFirewall();
web.listen(PORT, '0.0.0.0', () => log('web: listening on port ' + PORT));
control = startControl({ app: 'vizualyse_steam', status: status, command: command, log: log });
setInterval(writeDns, 10000);
writeDns();

ensureBundles((err) => {
    if (err) {
        bundle = { state: 'failed', error: 'installing: ' + err.message };
        log('bundle: ' + err.message);
        return;
    }
    launch = readJson(process.env.STEAM_LAUNCH || path.join(HERE, 'launch.json'));
    if (!launch || !Array.isArray(launch.argv)) { bundle = { state: 'failed', error: 'launch.json is missing' }; return; }
    try {
        userDir(env.HOME);
        userDir(env.INTERNAL_GAMES);
    } catch (e) { log('folders: ' + e.message); }
    noPrefixUpdate();
    installXInput();
    bundle = { state: 'ready' };
    try { log('bundle: ' + fs.readFileSync(path.join(env.RUNTIME, 'VERSION'), 'utf8').split('\n').slice(1, 3).join(', ')); } catch (e) { /* old */ }
    /* games found in the folders but not in the library (a library lost, a manual copy) */
    [env.INTERNAL_GAMES, env.DISK_GAMES].concat(usb.gameRoots()).forEach(rescan);
    if (control) control.broadcast();
});

/* No Wine prefix update, ever: the prefix is kept over the tool's updates
 * (the games' saves live in it), so one unpacked by 0.1.0 / 0.1.1 still had
 * a time in .update-timestamp. A new proton.tgz (its wine.inf dated 0) then
 * made Wine run wineboot --update at the next start, which with mscoree on
 * offered Wine Mono's installer in a window nobody can press (FTL on the car,
 * 2026-11-07). The prefix is made by the same Wine (bundle.sh). */
function noPrefixUpdate() {
    const f = path.join(env.PREFIX, 'pfx', '.update-timestamp');
    try {
        if (fs.readFileSync(f, 'utf8').trim() === 'disable') return;
    } catch (e) { if (e.code !== 'ENOENT') { log('prefix: ' + e.message); return; } }
    try {
        fs.writeFileSync(f, 'disable\n');
        fs.chownSync(f, UID, UID);
        log('prefix: updates disabled');
    } catch (e) { log('prefix: ' + e.message); }
}

/* Our XInput (src/xinput.c, the runtime's xinput/) in the kept prefix under
 * every XInput name, 64-bit in system32, 32-bit in syswow64, in place of the
 * links to Wine's own (env.js overrides them "=n"): Wine's reads its
 * winebus, which has nothing to read on the car; ours reads steam-pads'
 * pads file. Written only when different (the prefix outlives updates). */
const XINPUT_NAMES = ['xinput1_1.dll', 'xinput1_2.dll', 'xinput1_3.dll', 'xinput1_4.dll', 'xinput9_1_0.dll'];
function installXInput() {
    const win = path.join(env.PREFIX, 'pfx', 'drive_c', 'windows');
    let n = 0;
    [['x64', 'system32'], ['x86', 'syswow64']].forEach((a) => {
        const src = path.join(env.RUNTIME, 'xinput', a[0], 'xinput1_4.dll');
        const dir = path.join(win, a[1]);
        if (!fs.existsSync(src) || !fs.existsSync(dir)) return;
        const want = fs.readFileSync(src);
        XINPUT_NAMES.forEach((name) => {
            const dst = path.join(dir, name);
            try {
                let same = false;
                try { same = !fs.lstatSync(dst).isSymbolicLink() && fs.readFileSync(dst).equals(want); } catch (e) { /* none */ }
                if (same) return;
                try { fs.unlinkSync(dst); } catch (e) { /* none */ }
                fs.writeFileSync(dst, want, { mode: 0o644 });
                fs.chownSync(dst, UID, UID);
                n++;
            } catch (e) { log('xinput: ' + dst + ': ' + e.message); }
        });
    });
    if (n) log('xinput: ours in the prefix (' + n + ' files)');
}

/* games found in a games folder but not in the library (a library lost, a
 * manual copy, a stick from another car) */
function rescan(root) {
    let ids = [];
    try { ids = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)); } catch (e) { return; }
    ids.forEach((id) => {
        if (!library[id] && fs.existsSync(path.join(root, id, '.DepotDownloader'))) added(Number(id), path.join(root, id));
    });
}
