// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * One game running: the frame file (root's), wl-sink (started as root, maps
 * the frame file, then runs as the tool's uid in the render node's group),
 * Wine as Proton starts it (build/launch.json: wine-preloader, wine,
 * steam.exe, the game) as the tool's uid in the render node's group, in the
 * memory cgroup, and the sound: Wine's ALSA writes raw PCM into a FIFO
 * (the runtime's asound.conf) that this side holds open read-write (so Wine
 * never blocks opening it, with or without a player) and hands to
 * pcm_play.py (mgu-python), which plays it into SmartXbar as Moonlight does.
 *
 * Events: 'state' ('starting' | 'running' | 'ended'), 'stats' (wl-sink's),
 * 'toplevel' {title}, 'log' line.
 *
 * Ending: the game's Wine exits, or stop(): wineserver -k as the uid, then
 * SIGKILL to whatever is left in the cgroup (or the process group without
 * one), wl-sink and the player stopped, the frame file removed.
 */
'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const EventEmitter = require('events');
const env = require('./env.js');
const screen = require('./screen.js');

const DISPLAY = 'wayland-vzs';
const PYTHON = process.env.STEAM_PYTHON || '/var/opt/mgu-python/current/bin/python3';

function mkfifo(p, uid, gid) {
    try { fs.unlinkSync(p); } catch (e) { /* none */ }
    try {
        execFileSync('mkfifo', ['-m', '0600', p]);
    } catch (e) {
        /* no mkfifo on the path: Python's */
        execFileSync(fs.existsSync(PYTHON) ? PYTHON : 'python3', ['-c', 'import os,sys; os.mkfifo(sys.argv[1], 0o600)', p]);
    }
    fs.chownSync(p, uid, gid);
}

/* Linear volume on S16LE samples, in place (the phone page's slider: the car's
 * own volume may not reach SmartXbar's CarPlay input, knowledge/sound.md). */
function scale(buf, pct) {
    if (pct === 100) return buf;
    const g = pct / 100;
    for (let i = 0; i + 1 < buf.length; i += 2) {
        const v = Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * g)));
        buf.writeInt16LE(v, i);
    }
    return buf;
}

class Game extends EventEmitter {
    /* opts: { appId, name, dir (the game's folder), exe (relative), args [],
     *   launch (launch.json), frame {w, h}, fps, uid, gid, cgroup (dir or
     *   null), sound (bool), volume () -> %, log } */
    constructor(opts) {
        super();
        this.o = opts;
        this.state = 'starting';
        this.sink = null;
        this.wine = null;
        this.py = null;
        this.pcm = null;
        this.stats = { pictures: 0, fps: 0, drm: 0, shm: 0, ms: 0 };
        this.title = null;
        this.note = null;
        this.since = Date.now();
    }

    _log(s) { this.o.log(s); }

    start() {
        const o = this.o;
        try {
            [env.RUN_DIR, env.XDG_DIR].forEach((d) => { try { fs.mkdirSync(d, 0o755); } catch (e) { /* there */ } });
            fs.chmodSync(env.RUN_DIR, 0o755);
            fs.chownSync(env.XDG_DIR, o.uid, o.gid);
            fs.chmodSync(env.XDG_DIR, 0o700);
            [DISPLAY, DISPLAY + '.lock'].forEach((n) => { try { fs.unlinkSync(path.join(env.XDG_DIR, n)); } catch (e) { /* none */ } });
            ['tmp', '.cache', '.cache/mesa'].forEach((d) => {
                const p = path.join(env.HOME, d);
                try { fs.mkdirSync(p, 0o700); } catch (e) { /* there */ }
                fs.chownSync(p, o.uid, o.gid);
            });
            /* wineserver keeps its socket in /tmp/.wine-<uid>, a fixed place */
            const tmp = fs.statSync('/tmp');
            if ((tmp.mode & 0o1777) !== 0o1777) this._log('game: /tmp is ' + (tmp.mode & 0o7777).toString(8) + ', not 1777: Wine\'s server may not start');
            screen.frameFile(o.frame.w, o.frame.h);
        } catch (e) {
            return this._end('could not prepare: ' + e.message);
        }
        this._startSink();
    }

    _startSink() {
        const o = this.o;
        const args = ['--socket', DISPLAY, '--frame', screen.FILE, '--fps', String(o.fps), '--device', env.RENDER_NODE,
            '--uid', String(o.uid), '--gid', String(o.gid)];
        const sink = spawn(process.env.STEAM_WL_SINK || env.RUNTIME + '/wl-sink', args, { env: env.sinkEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        this.sink = sink;
        let rest = '';
        sink.stdout.setEncoding('utf8');
        sink.stdout.on('data', (d) => {
            rest += d;
            let i;
            while ((i = rest.indexOf('\n')) >= 0) {
                const l = rest.slice(0, i);
                rest = rest.slice(i + 1);
                let e;
                try { e = JSON.parse(l); } catch (x) { this._log('wl-sink: ' + l.slice(0, 300)); continue; }
                if (e.ev === 'ready') {
                    this._log('wl-sink: ready ' + e.size.join('x') + (e.drm ? ', GPU buffers through ' + e.device : ', no GPU buffers (shared memory only)'));
                    this.gpuBuffers = !!e.drm;
                    this._startWine();
                } else if (e.ev === 'stats') {
                    this.stats = { pictures: this.stats.pictures + e.pictures, fps: e.pictures, drm: e.drm, shm: e.shm, ms: e.ms };
                    if (this.state === 'starting' && (e.drm || e.shm)) this._set('running');
                    this.emit('stats', this.stats);
                } else if (e.ev === 'toplevel') {
                    this.title = e.title;
                    this._log('game: window "' + String(e.title || '').slice(0, 80) + '"');
                    this.emit('toplevel', e);
                } else if (e.ev === 'error') {
                    this._log('wl-sink: ' + e.error);
                    if (!this.wine) this._end('the compositor: ' + e.error);
                }
            }
        });
        sink.stderr.on('data', (d) => String(d).split('\n').filter((l) => l.trim()).forEach((l) => this._log('wl-sink: ' + l.slice(0, 300))));
        sink.on('error', (e) => this._end('the compositor did not start: ' + e.message));
        sink.on('exit', (code, sig) => {
            if (this.sink !== sink) return;
            this.sink = null;
            this._log('wl-sink: exited (' + (sig || code) + ')');
            if (this.state !== 'ended') this.stop('the compositor exited');
        });
    }

    _startSound() {
        const o = this.o;
        try {
            mkfifo(env.PCM_FIFO, o.uid, o.gid);
            /* read-write: opening never blocks, nor does Wine's open for writing */
            const fd = fs.openSync(env.PCM_FIFO, 'r+');
            this.pcm = new net.Socket({ fd: fd, readable: true, writable: false });
        } catch (e) {
            this._log('sound: ' + e.message + ' (the game is silent)');
            return;
        }
        let py = null;
        if (o.sound && fs.existsSync(PYTHON)) {
            /* --live: never falls behind (SmartXbar's first connect can block for many seconds) */
            py = spawn(PYTHON, [path.join(__dirname, 'pcm_play.py'), '--file', '-', '--live'], { stdio: ['pipe', 'pipe', 'pipe'] });
            this.py = py;
            py.on('error', (e) => this._log('sound: ' + e.message));
            py.stdin.on('error', () => { /* gone */ });
            py.stdout.on('data', (d) => this._log(String(d).trim()));
            py.stderr.on('data', (d) => this._log(String(d).trim()));
            py.on('exit', (c, s) => { if (this.py === py) { this.py = null; this._log('sound: player exited (' + (s || c) + ')'); } });
        } else if (o.sound) {
            this._log('sound: no mgu-python at ' + PYTHON + ' (the game is silent)');
        }
        let bytes = 0;
        this.pcm.on('data', (d) => {
            bytes += d.length;
            if (!this.py) return;          /* drained and dropped: Wine never waits */
            const ws = this.py.stdin._writableState;
            if (ws && ws.length > 48000 * 4) return;
            try { this.py.stdin.write(scale(d, o.volume ? o.volume() : 100)); } catch (e) { /* gone */ }
        });
        this.pcm.on('error', (e) => this._log('sound: ' + e.message));
        this.soundBytes = () => bytes;
    }

    _startWine() {
        const o = this.o;
        this._startSound();
        const exe = path.join(o.dir, o.exe);
        const e = env.wineEnv(o.launch, o.appId, DISPLAY);
        const libs = e.LD_LIBRARY_PATH;
        delete e.LD_LIBRARY_PATH;
        /* into the memory cgroup first, then exec: every Wine process stays in
         * it; LD_LIBRARY_PATH only on Wine's exec (the shell is the unit's) */
        const cg = o.cgroup ? 'echo $$ > ' + o.cgroup + '/cgroup.procs 2>/dev/null; ' : '';
        const argv = o.launch.argv.concat([exe]).concat(o.args || []);
        this._log('game: ' + o.name + ': ' + argv.slice(2).join(' ') + ' (in ' + path.dirname(exe) + ')');
        const wine = spawn('/bin/sh', ['-c', cg + 'LD_LIBRARY_PATH=' + libs + ' exec "$0" "$@"'].concat(argv), {
            env: e, cwd: path.dirname(exe), uid: o.uid, gid: o.gid, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        this.wine = wine;
        this.wineEnv = Object.assign({}, e, { LD_LIBRARY_PATH: libs });
        const lines = (which) => {
            let rest = '';
            return (d) => {
                rest += d;
                let i;
                while ((i = rest.indexOf('\n')) >= 0) {
                    const l = rest.slice(0, i).trim();
                    rest = rest.slice(i + 1);
                    if (!l || /:fixme:|wayland_process_init Wayland compositor doesn't support|keyboard_handle_keymap/.test(l)) continue;
                    this._log('wine: ' + l.slice(0, 300));
                }
            };
        };
        wine.stdout.setEncoding('utf8');
        wine.stderr.setEncoding('utf8');
        wine.stdout.on('data', lines('out'));
        wine.stderr.on('data', lines('err'));
        wine.on('error', (err) => this._end('Wine did not start: ' + err.message));
        wine.on('exit', (code, sig) => {
            if (this.wine !== wine) return;
            this.wine = null;
            this._log('game: Wine exited (' + (sig || code) + ') after ' + Math.round((Date.now() - this.since) / 1000) + ' s');
            this.stop(this.state === 'starting' ? 'the game ended before it drew anything (exit ' + (sig || code) + ')' : null);
        });
    }

    _set(state) {
        if (this.state === state) return;
        this.state = state;
        this._log('game: ' + state);
        this.emit('state', state);
    }

    /* Ends the game and everything it started; why: a note for the status. */
    stop(why) {
        if (this.stopping) return;
        this.stopping = true;
        if (why) this.note = why;
        const o = this.o;
        const wineDone = new Promise((resolve) => {
            if (!this.wineEnv) return resolve();
            /* wineserver -k ends every Wine process of the prefix */
            const server = path.join(env.PROTON, 'files', 'bin', 'wineserver');
            let k;
            const ke = Object.assign({}, this.wineEnv);
            delete ke.LD_LIBRARY_PATH;
            try {
                k = spawn('/bin/sh', ['-c', 'LD_LIBRARY_PATH=' + this.wineEnv.LD_LIBRARY_PATH + ' exec "$0" -k', server],
                    { env: ke, uid: o.uid, gid: o.gid, stdio: 'ignore' });
            } catch (e) { return resolve(); }
            const t = setTimeout(resolve, 5000);
            k.on('exit', () => { clearTimeout(t); resolve(); });
            k.on('error', () => { clearTimeout(t); resolve(); });
        });
        wineDone.then(() => {
            /* what is left: the cgroup's processes, or the game's process group */
            this._killLeft();
            if (this.sink) { const s = this.sink; this.sink = null; try { s.kill('SIGTERM'); } catch (e) { /* gone */ } setTimeout(() => { try { s.kill('SIGKILL'); } catch (e) { /* gone */ } }, 2000); }
            if (this.py) { const p = this.py; this.py = null; try { p.kill('SIGTERM'); } catch (e) { /* gone */ } setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 500); }
            if (this.pcm) { try { this.pcm.destroy(); } catch (e) { /* gone */ } this.pcm = null; }
            try { fs.unlinkSync(env.PCM_FIFO); } catch (e) { /* none */ }
            screen.removeFrameFile();
            this._end(this.note);
        });
    }

    _killLeft() {
        const o = this.o;
        let pids = [];
        if (o.cgroup) {
            try { pids = fs.readFileSync(path.join(o.cgroup, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number); } catch (e) { /* none */ }
        }
        pids.forEach((p) => { try { process.kill(p, 'SIGKILL'); } catch (e) { /* gone */ } });
        if (this.wine) { try { process.kill(-this.wine.pid, 'SIGKILL'); } catch (e) { /* gone */ } }
        if (pids.length) this._log('game: ended ' + pids.length + ' process(es) left in the cgroup');
    }

    _end(note) {
        if (this.state === 'ended') return;
        if (note) this.note = note;
        if (note) this._log('game: ' + note);
        this.state = 'ended';
        this.emit('state', 'ended');
        this.emit('end', { note: this.note });
    }
}

module.exports = { Game, DISPLAY, PYTHON, scale };
