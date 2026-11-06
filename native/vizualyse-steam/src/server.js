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
const { execFile } = require('child_process');
const { URL } = require('url');
const env = require('./env.js');
const unpack = require('./unpack.js');
const steam = require('./steam.js');
const { Game } = require('./game.js');
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
    memMb: MEM_DEFAULT, sound: true, volume: 100 }, readJson(SETTINGS_FILE) || {});
if (!RESOLUTIONS.some((r) => r.id === settings.resolution)) settings.resolution = '1280x720';
if (FPS_CHOICES.indexOf(settings.fps) < 0) settings.fps = 30;
if (MEM_CHOICES.indexOf(settings.memMb) < 0) settings.memMb = MEM_DEFAULT;
function saveSettings() { try { writeJson(SETTINGS_FILE, settings); } catch (e) { log('settings: ' + e.message); } }

/* the library: { appId: { name, dir, exe, args, engine, sizeMb, installedAt } } */
const LIBRARY_FILE = path.join(env.STATE_DIR, 'library.json');
const library = readJson(LIBRARY_FILE) || {};
function saveLibrary() { try { writeJson(LIBRARY_FILE, library); } catch (e) { log('library: ' + e.message); } }
function gamesDir() { return settings.where === 'disk' ? env.DISK_GAMES : env.INTERNAL_GAMES; }
function diskAvailable() { try { return fs.statSync(env.DISK).isDirectory(); } catch (e) { return false; } }

const space = { internalMb: null, diskMb: null };
function checkSpace() {
    freeMb(env.ROOT, (v) => { space.internalMb = v; });
    if (diskAvailable()) freeMb(env.DISK, (v) => { space.diskMb = v; });
}
setInterval(checkSpace, 30000);
checkSpace();

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

function show() {
    if (moving()) return 'not while driving';
    if (!game || game.state === 'ended') return 'no game is running';
    wantShown = true;
    if (screen.shown()) return null;
    const e = screen.show(VIEW);
    if (e) { wantShown = false; return e; }
    log('screen: shown');
    return null;
}

function hide(why) {
    wantShown = false;
    if (screen.shown()) { screen.hide(); log('screen: hidden (' + why + ')'); }
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
    let dir;
    try {
        userDir(env.HOME);
        unpack.mkdirp(gamesDir(), 0o755);
        if (settings.where === 'disk') fs.chownSync(path.dirname(gamesDir()), 0, 0);
        dir = userDir(path.join(gamesDir(), String(appId)));
        userDir(path.join(env.HOME, 'tmp'));
    } catch (e) { return 'the games folder: ' + e.message; }
    writeDns();
    const d = new steam.Download({ appId: appId, username: settings.username, dir: dir, uid: UID, gid: UID, validate: !!validate, log: log });
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
        sizeMb: Math.round(steam.du(dir) / 1048576), installedAt: old.installedAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    saveLibrary();
    log('library: ' + name + ' (' + appId + '): ' + (exe || 'no program found') + (eng ? ', ' + eng : '') + ', ' + library[appId].sizeMb + ' MB');
}

function removeGame(appId) {
    const g = library[appId];
    if (!g) return 'not in the library';
    if (game && game.o.appId === Number(appId) && game.state !== 'ended') return 'stop the game first';
    if (download && download.o.appId === Number(appId) && ['done', 'failed', 'stopped'].indexOf(download.state) < 0) return 'its download is running';
    delete library[appId];
    saveLibrary();
    /* only a folder of ours */
    if (g.dir && (g.dir.indexOf(env.INTERNAL_GAMES + '/') === 0 || g.dir.indexOf(env.DISK_GAMES + '/') === 0)) {
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
    }
    if (b.args !== undefined) {
        const a = String(b.args).trim();
        if (a.length > 300) return 'too long';
        g.args = a ? a.split(/\s+/) : [];
    }
    saveLibrary();
    return null;
}

/* ---- the game ------------------------------------------------------------------- */

let game = null;          /* the Game running, or the last one */
let restartNote = null;
(function () {
    const t = readJson(GAME_RUNNING);
    if (!t) return;
    restartNote = 'the unit restarted while ' + (t.name || 'a game') + ' ran (' + (t.at || '?') + ')';
    log('game: ' + restartNote);
    try { fs.unlinkSync(GAME_RUNNING); } catch (e) { /* gone */ }
})();

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
    let missing;
    try { missing = env.gpuLibs(); } catch (e) { return 'the GPU libraries: ' + e.message; }
    if (missing.length) return 'this unit has no ' + missing.join(', ');
    const res = RESOLUTIONS.filter((r) => r.id === settings.resolution)[0];
    try { userDir(env.HOME); writeDns(); } catch (e) { return e.message; }
    cgroupDir = cgroup();
    mem.ooms = null; mem.note = null; mem.oomAt = null; mem.peakMb = null;
    restartNote = null;
    try { writeJson(GAME_RUNNING, { appId: appId, name: g.name, at: new Date().toISOString() }); } catch (e) { log('game: ' + e.message); }
    const x = new Game({ appId: appId, name: g.name, dir: g.dir, exe: g.exe, args: g.args, launch: launch,
        frame: { w: res.w, h: res.h }, fps: settings.fps, uid: UID, gid: VIDEO_GID, cgroup: cgroupDir,
        sound: settings.sound, volume: () => settings.volume, log: log });
    game = x;
    x.on('state', (st) => {
        if (st === 'ended') {
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
        if (b.where !== 'internal' && b.where !== 'disk') return 'internal or disk';
        if (b.where === 'disk' && !diskAvailable()) return 'this car has no hard disk at ' + env.DISK;
        settings.where = b.where;
    }
    if (b.fps !== undefined) { if (FPS_CHOICES.indexOf(Number(b.fps)) < 0) return 'fps: ' + FPS_CHOICES.join(' or '); settings.fps = Number(b.fps); }
    if (b.memMb !== undefined) {
        if (MEM_CHOICES.indexOf(Number(b.memMb)) < 0) return 'memory: one of ' + MEM_CHOICES.join(', ') + ' MB';
        settings.memMb = Number(b.memMb);
        if (cgroupDir) { try { fs.writeFileSync(path.join(cgroupDir, 'memory.limit_in_bytes'), String(settings.memMb * 1048576)); } catch (e) { /* from the next game */ } }
    }
    if (b.sound !== undefined) settings.sound = !!b.sound;
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
        error: bundle.error || null, prefixNote: prefixNote, restartNote: restartNote,
        account: { username: settings.username || null, remembered: settings.username ? steam.remembered() : false },
        download: download ? Object.assign(download.status(), { name: (library[download.o.appId] && library[download.o.appId].name) || names[download.o.appId] || null }) : null,
        library: Object.keys(library).map((id) => {
            const x = library[id];
            return { appId: Number(id), name: x.name, exe: x.exe, args: (x.args || []).join(' '), engine: x.engine, sizeMb: x.sizeMb };
        }).sort((a, b) => a.name.localeCompare(b.name)),
        game: game ? { appId: game.o.appId, name: game.o.name, state: game.state, title: game.title, since: new Date(game.since).toISOString(),
            pictures: game.stats.pictures, fps: game.stats.fps, gpuBuffers: !!game.gpuBuffers, sinkMs: game.stats.ms,
            buffers: { drm: game.stats.drm, shm: game.stats.shm }, note: game.note } : null,
        running: !!g, shown: screen.shown(), speed: vehicle.kmh, moving: moving(),
        settings: { where: settings.where, resolution: settings.resolution, fps: settings.fps, memMb: settings.memMb, sound: settings.sound, volume: settings.volume },
        choices: { resolutions: RESOLUTIONS.map((r) => ({ id: r.id, name: r.name })), fps: FPS_CHOICES, memMb: MEM_CHOICES, disk: diskAvailable() },
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
    bundle = { state: 'ready' };
    try { log('bundle: ' + fs.readFileSync(path.join(env.RUNTIME, 'VERSION'), 'utf8').split('\n').slice(1, 3).join(', ')); } catch (e) { /* old */ }
    /* games found in the folders but not in the library (a library lost, a manual copy) */
    [env.INTERNAL_GAMES, env.DISK_GAMES].forEach((root) => {
        let ids = [];
        try { ids = fs.readdirSync(root).filter((n) => /^\d+$/.test(n)); } catch (e) { return; }
        ids.forEach((id) => {
            if (!library[id] && fs.existsSync(path.join(root, id, '.DepotDownloader'))) added(Number(id), path.join(root, id));
        });
    });
    if (control) control.broadcast();
});
