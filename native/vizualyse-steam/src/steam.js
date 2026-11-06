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
    let names = [];
    try { names = fs.readdirSync(d); } catch (e) { return null; }
    if (names.some((n) => /\.pck$/i.test(n))) return 'godot';
    if (names.indexOf('UnityPlayer.dll') >= 0) return 'unity';
    if (names.some((n) => /^data\.win$/i.test(n))) return 'gamemaker';
    return null;
}

function defaultArgs(eng) {
    return eng === 'godot' ? ['--rendering-driver', 'opengl3'] : [];
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

module.exports = { Download, findExes, engine, defaultArgs, du, storeName, remembered, KNOWN };
