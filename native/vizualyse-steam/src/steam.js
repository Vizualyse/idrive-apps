// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Steam: downloading a game the account owns with DepotDownloader (SteamRE,
 * GPL-2.0, on the runtime's .NET), and what a downloaded game is.
 *
 * DepotDownloader runs as the tool's uid (mgu-uplink routes it; names resolve
 * through the phone's DNS: env.DNS_FILE) with HOME in the tool's folder,
 * where it keeps the login token (-remember-password: the password is asked
 * for once; never stored by us, never on a command line, only written to its
 * stdin when it asks). Steam Guard as it asks on its stderr:
 *
 *   "Enter account password for "NAME": "            -> state 'password'
 *   "STEAM GUARD! Please enter your 2-factor auth code from your authenticator app: "
 *                                                     -> state 'code' (kind 'app')
 *   "STEAM GUARD! Please enter the auth code sent to the email at X: "
 *                                                     -> state 'code' (kind 'email')
 *   "STEAM GUARD! Use the Steam Mobile App to confirm your sign in..."
 *                                                     -> state 'confirm'
 *
 * and the phone page answers through answer(). Progress: its "  12.34% path"
 * lines. Windows depots only (-os windows -osarch 64): the games run in
 * Proton.
 *
 * Steam's own client doesn't run on the car: a game that insists on it
 * (SteamAPI_Init failing ends some) won't start; most indie games carry on
 * without achievements or cloud saves.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const env = require('./env.js');

/* What a game's folder has that is not the game */
const NOT_GAME = /(unins\d*|setup|install|redist|vc_?redist|directx|dxsetup|dotnet|crash|UnityCrashHandler|CrashReport|EasyAntiCheat|BEService|BattlEye|launcher_?helper|_CommonRedist|steamerrorreporter|QtWebEngineProcess|cefsharp|7za?)/i;
/* games we know something about */
const KNOWN = {
    2868840: { name: 'Slay the Spire 2' },
};

class Download extends EventEmitter {
    /* opts: { appId, username, dir, uid, gid, validate, log } */
    constructor(opts) {
        super();
        this.o = opts;
        this.state = 'starting';   /* starting | password | code | confirm | downloading | done | failed | stopped */
        this.kind = null;          /* code: 'app' | 'email' */
        this.note = null;
        this.percent = 0;
        this.depot = null;
        this.bytes = null;
        this.wrongCode = false;
        this.proc = null;
        this.lines = [];
    }

    status() {
        return { appId: this.o.appId, state: this.state, kind: this.kind, note: this.note, percent: this.percent,
            wrongCode: this.wrongCode, bytes: this.bytes };
    }

    _set(state, note) {
        this.state = state;
        if (note !== undefined) this.note = note;
        this.emit('change', this.status());
    }

    start() {
        const o = this.o;
        const dd = process.env.STEAM_DD_CMD ? process.env.STEAM_DD_CMD.split(' ')
            : [env.RUNTIME + '/dotnet/dotnet', env.RUNTIME + '/depotdownloader/DepotDownloader.dll'];
        const args = dd.slice(1).concat(['-app', String(o.appId), '-os', 'windows', '-osarch', '64', '-dir', o.dir,
            '-username', o.username, '-remember-password']);
        if (o.validate) args.push('-validate');
        /* the content servers' region (Steam's cell id): Steam picks one by
         * the car's location; its London cluster served other servers'
         * certificates (every manifest "SSL connection could not be
         * established", 2026-11-08), Amsterdam worked */
        if (o.cellId) args.push('-cellid', String(o.cellId));
        try {
            env.userDirs(o.uid, o.gid);
        } catch (err) {
            o.log('steam: ' + err.message);
            this._set('failed', 'could not prepare its folders: ' + err.message);
            return;
        }
        const e = env.dotnetEnv();
        /* the test's stand-in runs on the unit's own Node and glibc */
        if (process.env.STEAM_DD_CMD) delete e.LD_LIBRARY_PATH;
        this.proc = spawn(dd[0], args, { env: e, cwd: env.HOME, uid: o.uid, gid: o.gid, stdio: ['pipe', 'pipe', 'pipe'] });
        o.log('steam: DepotDownloader for app ' + o.appId + ' as ' + o.username + ' into ' + o.dir);
        let out = '', err = '';
        const take = (which, d) => {
            let s = (which === 'out' ? out : err) + d;
            let i;
            while ((i = s.search(/[\r\n]/)) >= 0) {
                this._line(s.slice(0, i));
                s = s.slice(i + 1);
            }
            /* prompts end without a newline */
            this._prompt(s);
            if (which === 'out') out = s; else err = s;
        };
        this.proc.stdout.setEncoding('utf8');
        this.proc.stderr.setEncoding('utf8');
        this.proc.stdout.on('data', (d) => take('out', d));
        this.proc.stderr.on('data', (d) => take('err', d));
        this.proc.stdin.on('error', () => { /* it exited */ });
        this.proc.on('error', (e2) => this._set('failed', 'DepotDownloader did not start: ' + e2.message));
        this.proc.on('exit', (code, sig) => {
            this.proc = null;
            o.log('steam: DepotDownloader exited (' + (sig || code) + ')');
            if (this.state === 'stopped') return this.emit('end', this.status());
            if (this.state !== 'failed') {
                if (code === 0 && this.sawTotal) { this.percent = 100; this._set('done', null); }
                else this._set('failed', this.note || this._lastError() || 'DepotDownloader exited (' + (sig || code) + ')');
            }
            this.emit('end', this.status());
        });
    }

    _lastError() {
        for (let i = this.lines.length - 1; i >= 0; i--) {
            if (/error|fail|denied|not available|invalid/i.test(this.lines[i])) return this.lines[i].slice(0, 200);
        }
        return null;
    }

    _prompt(s) {
        const t = s.trim();
        if (!t) return;
        if (/^Enter account password for/.test(t)) {
            if (this.state !== 'password') { this.o.log('steam: asks for the password'); this._set('password', 'Steam asks for the password'); }
        } else if (/STEAM GUARD! Please enter your 2.factor auth code/.test(t)) {
            this.kind = 'app';
            if (this.state !== 'code') { this.o.log('steam: asks for a Steam Guard code (authenticator)'); this._set('code', 'Steam Guard: the code from the Steam app'); }
        } else if (/STEAM GUARD! Please enter the auth code sent to the email at (.*):/.test(t)) {
            this.kind = 'email';
            const m = /sent to the email at (.*):/.exec(t);
            if (this.state !== 'code') { this.o.log('steam: asks for a Steam Guard code (email)'); this._set('code', 'Steam Guard: the code sent to ' + (m ? m[1] : 'your email')); }
        }
    }

    _line(l) {
        const t = l.trim();
        if (!t) return;
        this.lines.push(t);
        if (this.lines.length > 50) this.lines.shift();
        /* never log a line that could carry what was typed (DepotDownloader doesn't echo, but be sure) */
        const m = /^(\d+(?:\.\d+)?)%\s/.exec(t);
        if (m) {
            this.percent = Math.min(99.9, Number(m[1]));
            if (this.state !== 'downloading') this._set('downloading', null);
            else if (!this._lastEmit || Date.now() - this._lastEmit > 1000) { this._lastEmit = Date.now(); this.emit('change', this.status()); }
            return;
        }
        this.o.log('steam: ' + t.slice(0, 300));
        if (/STEAM GUARD! Use the Steam Mobile App to confirm/.test(t)) { this._set('confirm', 'Steam Guard: approve the sign-in in the Steam app on your phone'); return; }
        if (/previous 2-factor auth code you have provided is incorrect|previous.*code.*incorrect/i.test(t)) { this.wrongCode = true; this.emit('change', this.status()); return; }
        if (/^Logging '.*' into Steam3/.test(t) || /^Connecting to Steam3/.test(t)) { if (this.state === 'starting') this._set('starting', 'Signing in to Steam...'); return; }
        if (/^Downloading depot/.test(t) || /^Pre-allocating/.test(t) || /^Validating/.test(t)) { this._set('downloading', null); return; }
        if (/^Total downloaded:/.test(t)) { this.sawTotal = true; const b = /Total downloaded: (\d+) bytes/.exec(t); if (b) this.bytes = Number(b[1]); return; }
        if (/^Failed to authenticate with Steam: (.*)/.test(t)) { this._set('failed', 'Steam sign-in failed: ' + /: (.*)$/.exec(t)[1]); this.stop(true); return; }
        if (/is not available from this account/.test(t)) { this._set('failed', 'This account does not own app ' + this.o.appId); return; }
        /* EFBIG: a file over 4 GB on a FAT32 stick */
        if (/File too large|EFBIG/i.test(t)) { this.note = 'a file of this game is over 4 GB, more than a FAT32 stick holds: reformat the stick as exFAT (or install elsewhere)'; return; }
        /* ENOSPC */
        if (/No space left on device|ENOSPC|Disk full/i.test(t)) { this.note = 'the install location is full'; return; }
        if (/^Error:|InvalidPassword|RateLimitExceeded|AccountLoginDeniedThrottle/.test(t)) this.note = t.slice(0, 200);
    }

    /* the phone's answer to the current question (the password or a code) */
    answer(text) {
        if (!this.proc || (this.state !== 'password' && this.state !== 'code')) return 'Steam is not asking for anything';
        const v = String(text || '').replace(/[\r\n]/g, '').trim();
        if (!v) return 'type it first';
        if (v.length > 128) return 'too long';
        this.wrongCode = false;
        this.proc.stdin.write(v + '\n');
        this._set('starting', this.state === 'password' ? 'Signing in to Steam...' : 'Checking the code...');
        return null;
    }

    stop(failed) {
        if (!failed && this.state !== 'done' && this.state !== 'failed') this._set('stopped', 'stopped');
        if (this.proc) {
            const p = this.proc;
            try { p.kill('SIGTERM'); } catch (e) { /* gone */ }
            setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 3000);
        }
    }
}

/* The .exe files of a game's folder that could be the game, best first:
 * [{ rel, size }]. Up to 3 folders deep; installers, redistributables and
 * crash reporters left out; the top folder and bigger files first. */
function findExes(dir, name) {
    const found = [];
    const walk = (d, depth) => {
        let names = [];
        try { names = fs.readdirSync(d); } catch (e) { return; }
        names.forEach((n) => {
            if (n === '.DepotDownloader') return;
            const p = path.join(d, n);
            let st;
            try { st = fs.lstatSync(p); } catch (e) { return; }
            if (st.isDirectory()) { if (depth < 3 && !NOT_GAME.test(n)) walk(p, depth + 1); return; }
            if (st.isFile() && /\.exe$/i.test(n) && !NOT_GAME.test(n)) found.push({ rel: path.relative(dir, p), size: st.size, depth: depth });
        });
    };
    walk(dir, 0);
    const words = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const score = (x) => {
        const base = path.basename(x.rel, '.exe').toLowerCase().replace(/[^a-z0-9]/g, '');
        return (words && (base === words || words.indexOf(base) >= 0 || base.indexOf(words) >= 0) ? 4 : 0) - x.depth + (x.size > 1e6 ? 1 : 0);
    };
    found.sort((a, b) => score(b) - score(a) || b.size - a.size);
    return found.map((x) => ({ rel: x.rel.split(path.sep).join('/'), size: x.size }));
}

/* What the game is built with, for its default launch options: Godot 4 has a
 * .pck next to its exe and runs on Vulkan or Direct3D 12 by default, neither
 * of which the car has: its OpenGL 3 renderer then (WineD3D isn't involved). */
function engine(dir, exeRel) {
    const d = path.join(dir, path.dirname(exeRel));
    let names = [], top = [];
    try { names = fs.readdirSync(d); } catch (e) { return null; }
    try { top = fs.readdirSync(dir); } catch (e) { /* none */ }
    const base = path.basename(exeRel).replace(/\.exe$/i, '');
    if (names.some((n) => /\.pck$/i.test(n))) return 'godot';
    /* Unity 5+ has UnityPlayer.dll; Unity 4 (Teslagrad) only <exe>_Data */
    if (names.indexOf('UnityPlayer.dll') >= 0 || names.indexOf(base + '_Data') >= 0) return 'unity';
    if (names.some((n) => /^data\.win$/i.test(n))) return 'gamemaker';
    /* Unreal 4 / 5: <Game>/Binaries/Win64/<Game>-Win64-Shipping.exe, or the launcher beside Engine/ */
    if (/-Win(64|32)-Shipping$/i.test(base) || (top.indexOf('Engine') >= 0 && top.some((n) => {
        try { return fs.statSync(path.join(dir, n, 'Binaries')).isDirectory(); } catch (e) { return false; }
    }))) return 'unreal';
    /* Source: hl2.exe, or bin/engine.dll beside the exe */
    if (/^hl2$/i.test(base) || fs.existsSync(path.join(d, 'bin', 'engine.dll'))) return 'source';
    return null;
}

/* The Steam interface versions a game's own steam_api DLL was built with
 * (buf: its bytes), for gbe_fork's steam_settings/steam_interfaces.txt, as
 * gbe's generate_interfaces finds them: without it gbe hands out its newest
 * ISteamClient, and an older game calls through the wrong slots. Teslagrad
 * (Steamworks 2013, SteamClient012) asked GetISteamUnifiedMessages and
 * reached gbe's GetISteamController: "Missing interface" (the car,
 * 2026-11-08). */
function steamInterfaces(buf) {
    const s = buf.toString('latin1');
    const re = /(^|[^A-Za-z0-9_])((?:Steam[A-Za-z]+|STEAM[A-Z_]+)[0-9]{3})(?![0-9])/g;
    const seen = {};
    let m;
    while ((m = re.exec(s)) !== null) seen[m[2]] = true;
    return Object.keys(seen).sort();
}

/* The smallest screen a game's engine takes, or null. Unity 4 lists only
 * display modes of at least 640x480, and Wine's Wayland driver offers only
 * modes that fit inside its screen: at 896x320 Teslagrad's Unity 4 found "no
 * video modes" and quit; at 960x540 it started (the car, 2026-11-08). Unity
 * 4 by the version in the head of <exe>_Data's mainData or
 * globalgamemanagers (Teslagrad "4.6.2f1", Vampire Survivors "6000.0.62f1"):
 * UnityPlayer.dll's absence alone also fits Unity 5.0 to 2017.1. */
function unityMajor(dataDir) {
    for (const n of ['mainData', 'globalgamemanagers']) {
        let fd;
        try {
            fd = fs.openSync(path.join(dataDir, n), 'r');
            const h = Buffer.alloc(256);
            const len = fs.readSync(fd, h, 0, h.length, 0);
            const m = /(\d{1,4})\.\d{1,3}\.\d{1,3}[abfpx]\d{1,3}/.exec(h.toString('latin1', 0, len));
            if (m) return Number(m[1]);
        } catch (e) { /* not this one */ } finally {
            if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ }
        }
    }
    return null;
}
function minScreen(dir, exeRel) {
    if (!exeRel) return null;
    const base = path.basename(exeRel).replace(/\.exe$/i, '');
    const major = unityMajor(path.join(dir, path.dirname(exeRel), base + '_Data'));
    if (major !== null && major <= 4) return { w: 640, h: 480, why: 'Unity ' + major };
    return null;
}

/* The game's screen: the chosen resolution res, or for an engine that needs
 * more (minScreen) the same shape at a size that holds its minimum: one from
 * list (896x320 -> 1344x480, 640x360 -> 848x480), else res scaled up. */
function screenFor(res, min, list) {
    if (!min || (res.w >= min.w && res.h >= min.h)) return res;
    const a = res.w / res.h;
    const fit = list.filter((r) => r.w >= min.w && r.h >= min.h && Math.abs(r.w / r.h - a) / a < 0.02)
        .sort((x, y) => x.w * x.h - y.w * y.h)[0];
    if (fit) return fit;
    const k = Math.max(min.w / res.w, min.h / res.h);
    return { id: 'scaled', w: Math.ceil(res.w * k / 16) * 16, h: Math.ceil(res.h * k / 2) * 2 };
}

function defaultArgs(eng) {
    return eng === 'godot' ? ['--rendering-driver', 'opengl3'] : [];
}

/* A game's Detail (env.js DETAILS) as its engine's own launch options,
 * added at each start after the game's options (never saved into them):
 *   unity   -screen-quality: the quality level by name ("Fast", "Fastest":
 *           Unity's defaults; a game that renamed them keeps its own)
 *   unreal  -ExecCmds with scalability groups at low (shadows, post
 *           processing, effects; potato: foliage, textures, view distance,
 *           motion blur too)
 *   source  console variables: no shadows or bloom; potato: textures at a
 *           quarter (mat_picmip 2), DirectX 9 level
 *   godot, gamemaker, unknown: nothing (env.js's DXVK / WineD3D parts still apply) */
function detailArgs(eng, detail) {
    if (detail !== 'lite' && detail !== 'potato') return [];
    const potato = detail === 'potato';
    if (eng === 'unity') return ['-screen-quality', potato ? 'Fastest' : 'Fast'];
    if (eng === 'unreal') {
        const c = ['sg.ShadowQuality 0', 'sg.PostProcessQuality 0', 'sg.EffectsQuality 0'];
        if (potato) c.push('sg.FoliageQuality 0', 'sg.TextureQuality 0', 'sg.ViewDistanceQuality 0', 'r.MotionBlurQuality 0');
        return ['-ExecCmds=' + c.join(',')];
    }
    if (eng === 'source') {
        const a = ['+r_shadows', '0', '+mat_disable_bloom', '1'];
        return potato ? a.concat(['+mat_picmip', '2', '-dxlevel', '90']) : a;
    }
    return [];
}

/* Bytes in a folder (a game's size), links not followed. */
function du(dir) {
    let n = 0;
    const walk = (d) => {
        let names = [];
        try { names = fs.readdirSync(d); } catch (e) { return; }
        names.forEach((x) => {
            const p = path.join(d, x);
            let st;
            try { st = fs.lstatSync(p); } catch (e) { return; }
            if (st.isDirectory()) walk(p); else n += st.size;
        });
    };
    walk(dir);
    return n;
}

/* The store's name for an app, as the tool's uid through the phone's DNS
 * (root has no internet; the unit's resolver doesn't resolve its names):
 * a short Node child (the unit's Node 8) with its own resolver. cb(name|null). */
function storeName(appId, dns, uid, gid, cb) {
    if (KNOWN[appId]) return cb(KNOWN[appId].name);
    if (!dns) return cb(null);
    const script = `
const dns = require('dns'), https = require('https');
const r = new dns.Resolver(); r.setServers([process.argv[2]]);
const lookup = (h, o, cb) => r.resolve4(h, (e, a) => (typeof o === 'function' ? o : cb)(e, a && a[0], 4));
https.get({ host: 'store.steampowered.com', path: '/api/appdetails?filters=basic&appids=' + process.argv[1], lookup: lookup, timeout: 10000 }, (res) => {
  let b = ''; res.on('data', (d) => { b += d; if (b.length > 2e6) process.exit(1); });
  res.on('end', () => { try { const j = JSON.parse(b)[process.argv[1]]; console.log(j && j.success ? j.data.name : ''); } catch (e) { console.log(''); } });
}).on('error', () => console.log('')).on('timeout', function () { this.abort(); });`;
    let out = '';
    let done = false;
    const end = (v) => { if (!done) { done = true; cb(v); } };
    try {
        const p = spawn(process.execPath, ['-e', script, String(appId), dns], { uid: uid, gid: gid, stdio: ['ignore', 'pipe', 'ignore'] });
        p.stdout.on('data', (d) => { out += d; });
        p.on('exit', () => end(out.trim().slice(0, 80) || null));
        p.on('error', () => end(null));
        setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 15000);
    } catch (e) { end(null); }
}

/* Is a login remembered (DepotDownloader's IsolatedStorage account.config)? */
function remembered() {
    const base = path.join(env.HOME, '.local', 'share', 'IsolatedStorage');
    let found = false;
    const walk = (d, depth) => {
        if (found || depth > 8) return;
        let names = [];
        try { names = fs.readdirSync(d); } catch (e) { return; }
        names.forEach((n) => {
            const p = path.join(d, n);
            if (n === 'account.config') { try { found = fs.statSync(p).size > 0; } catch (e) { /* */ } return; }
            try { if (fs.lstatSync(p).isDirectory()) walk(p, depth + 1); } catch (e) { /* */ }
        });
    };
    walk(base, 0);
    return found;
}

/* Steam's DRM wrapper (SteamStub) on the program: its section table has a
 * .bind section (the stub's code and the encrypted original's key). Such a
 * game asks the Steam client to decrypt itself, which neither gbe_fork nor
 * anything here can stand in for: Castle Crashers quit at once (the car,
 * 2026-11-08). true / false, or null when the header can't be read. */
function steamStub(dir, exeRel) {
    let fd;
    try {
        fd = fs.openSync(path.join(dir, exeRel), 'r');
        const h = Buffer.alloc(4096);
        const n = fs.readSync(fd, h, 0, h.length, 0);
        if (n < 64 || h.readUInt16LE(0) !== 0x5a4d) return null;               /* MZ */
        const pe = h.readUInt32LE(0x3c);
        if (pe + 24 > n || h.readUInt32LE(pe) !== 0x00004550) return null;    /* PE\0\0 */
        const count = h.readUInt16LE(pe + 6), optSize = h.readUInt16LE(pe + 20);
        const table = pe + 24 + optSize;
        for (let i = 0; i < count; i++) {
            const at = table + i * 40;
            if (at + 8 > n) return null;
            if (h.toString('latin1', at, at + 8).replace(/\0+$/, '') === '.bind') return true;
        }
        return false;
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ }
    }
}

/* The program's bitness from its PE header: 'x64', 'x86', or null when it
 * can't be read. Vulkan is the default for 64-bit games only (32-bit Vulkan
 * through Wine's WoW64 is not yet seen working on the car). */
function arch(dir, exeRel) {
    let fd;
    try {
        fd = fs.openSync(path.join(dir, exeRel), 'r');
        const h = Buffer.alloc(4096);
        const n = fs.readSync(fd, h, 0, h.length, 0);
        if (n < 64 || h.readUInt16LE(0) !== 0x5a4d) return null;               /* MZ */
        const pe = h.readUInt32LE(0x3c);
        if (pe + 6 > n || h.readUInt32LE(pe) !== 0x00004550) return null;     /* PE\0\0 */
        const m = h.readUInt16LE(pe + 4);
        return m === 0x8664 ? 'x64' : m === 0x14c ? 'x86' : null;
    } catch (e) {
        return null;
    } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ }
    }
}

module.exports = { Download, findExes, engine, arch, steamStub, minScreen, screenFor, steamInterfaces, defaultArgs, detailArgs, du, storeName, remembered, KNOWN };
