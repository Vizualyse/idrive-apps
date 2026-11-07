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

/* The game's sound as the runtime's asound.conf makes it: S16LE, 48 kHz,
 * stereo (bytes per second), and the FIFO's size: 8 KB, ~43 ms. */
const PCM_RATE = 48000 * 2 * 2;
const PCM_PIPE = 8192;

/* A FIFO's pipe size (F_SETPIPE_SZ, 1031): Node has no fcntl, Python does.
 * Kept while anyone holds the FIFO open (game.js does). Best effort. */
function pipeSize(p, size) {
    try {
        execFileSync(fs.existsSync(PYTHON) ? PYTHON : 'python3', ['-c',
            'import os,fcntl,sys; fd=os.open(sys.argv[1], os.O_RDWR|os.O_NONBLOCK); fcntl.fcntl(fd, 1031, int(sys.argv[2])); os.close(fd)',
            p, String(size)], { stdio: 'ignore', timeout: 5000 });
    } catch (e) { /* the default 64 KB: ~340 ms at most behind */ }
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
            env.userDirs(o.uid, o.gid);
            [DISPLAY, DISPLAY + '.lock'].forEach((n) => { try { fs.unlinkSync(path.join(env.XDG_DIR, n)); } catch (e) { /* none */ } });
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
        /* --input: touches on its stdin (input()) become Wine's pointer */
        const args = ['--socket', DISPLAY, '--frame', screen.FILE, '--fps', String(o.fps), '--device', env.RENDER_NODE,
            '--uid', String(o.uid), '--gid', String(o.gid), '--input'];
        /* connected now, used only when shown that way (showWinston) */
        if (fs.existsSync(env.WINSTON_SOCKET)) args.push('--winston', env.WINSTON_SOCKET);
        const sink = spawn(process.env.STEAM_WL_SINK || env.RUNTIME + '/wl-sink', args, { env: env.sinkEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
        sink.stdin.on('error', () => { /* it exited */ });
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
                    this.winston = !!e.winston;
                    this._startWine();
                } else if (e.ev === 'stats') {
                    this.stats = { pictures: this.stats.pictures + e.pictures, fps: e.pictures, drm: e.drm, shm: e.shm, fwd: e.fwd || 0, ms: e.ms };
                    if (this.state === 'starting' && (e.drm || e.shm)) this._set('running');
                    this.emit('stats', this.stats);
                } else if (e.ev === 'toplevel') {
                    this.title = e.title;
                    this._log('game: window "' + String(e.title || '').slice(0, 80) + '"');
                    this.emit('toplevel', e);
                } else if (e.ev === 'winston') {
                    this._log('wl-sink: winston: ' + e.msg);
                } else if (e.ev === 'winston-lost') {
                    this.winston = false;
                    this._log('wl-sink: the connection to Winston was lost');
                    this.emit('winston-lost');
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
        let fd;
        try {
            mkfifo(env.PCM_FIFO, o.uid, o.gid);
            /* read-write: opening never blocks, nor does Wine's open for
             * writing; non-blocking: read on a timer, EAGAIN when empty */
            fd = fs.openSync(env.PCM_FIFO, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        } catch (e) {
            this._log('sound: ' + e.message + ' (the game is silent)');
            return;
        }
        pipeSize(env.PCM_FIFO, PCM_PIPE);
        this.pcm = { fd: fd, timer: null };
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
        /* Read at the sound's own rate, never faster. Wine's ALSA output has
         * no clock behind it (the runtime's asound.conf: a file plugin over
         * "null"), so Wine wrote as fast as it could, ~3.6x real time on the
         * car, and the player dropped nearly all of it (FTL, 2026-11-07).
         * Read at PCM_RATE the FIFO fills and Wine waits, as on a sound card;
         * the small pipe (PCM_PIPE) keeps that wait short behind the picture.
         * Dropped only when the player itself is behind (SmartXbar's first
         * connect can block for seconds): Wine is never held up by it. */
        let bytes = 0, allow = 0, last = Date.now();
        const buf = Buffer.alloc(PCM_RATE / 5);
        this.pcm.timer = setInterval(() => {
            const now = Date.now();
            allow = Math.min(allow + (now - last) * PCM_RATE / 1000, PCM_RATE / 10);
            last = now;
            const want = Math.floor(allow / 4) * 4;
            if (want <= 0) return;
            let n = 0;
            try { n = fs.readSync(fd, buf, 0, want, null); } catch (e) { if (e.code !== 'EAGAIN') this._log('sound: ' + e.message); }
            if (n <= 0) { allow = 0; return; }     /* nothing waiting: no credit builds up */
            allow -= n;
            bytes += n;
            if (!this.py) return;
            const ws = this.py.stdin._writableState;
            if (ws && ws.length > PCM_RATE / 5) return;
            try { this.py.stdin.write(scale(Buffer.from(buf.slice(0, n)), o.volume ? o.volume() : 100)); } catch (e) { /* gone */ }
        }, 10);
        this.soundBytes = () => bytes;
    }

    _startWine() {
        const o = this.o;
        this._startSound();
        this._startPads();
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

    /* The controllers while the game runs: steam-pads (root: usbfs) claims
     * XInput USB pads and writes their state to env.PADS_FILE, which our
     * xinput1_4.dll reads in Wine. this.pads: { slot: name } of those in. */
    _startPads() {
        const bin = process.env.STEAM_PADS || path.join(env.RUNTIME, 'steam-pads');
        this.pads = {};
        if (!fs.existsSync(bin)) { this._log('pads: no ' + bin); return; }
        let p;
        try { p = spawn(bin, ['--out', env.PADS_FILE], { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { this._log('pads: ' + e.message); return; }
        this.padsProc = p;
        p.stdin.on('error', () => { /* it exited */ });
        let rest = '';
        p.stdout.on('data', (d) => {
            const lines = (rest + d).split('\n');
            rest = lines.pop();
            lines.forEach((l) => {
                let e;
                try { e = JSON.parse(l); } catch (x) { return; }
                if (e.ev === 'pad') {
                    if (e.present) this.pads[e.slot] = e.name; else delete this.pads[e.slot];
                    this._log('pads: ' + (e.present ? 'player ' + (e.slot + 1) + ': ' + e.name : e.name + ' unplugged'));
                    this.emit('state', this.state);
                } else if (e.ev === 'error') this._log('pads: ' + e.error);
            });
        });
        p.stderr.on('data', (d) => this._log('pads: ' + String(d).trim()));
        p.on('error', (e) => this._log('pads: ' + e.message));
        p.on('exit', (c, s) => { if (this.padsProc === p) { this.padsProc = null; this.pads = {}; this._log('pads: exited (' + (s || c) + ')'); } });
    }

    /* A touch on the game's picture (frame pixels, the size it draws at):
     * kind 'd' down, 'm' move, 'u' up; wl-sink makes it Wine's pointer. */
    /* The pictures straight onto the centre screen through Winston, fitted
     * into view { x, y, w, h } (wl-sink's own connection: this.winston), or
     * not (the frame file goes on either way). */
    showWinston(view) { this._sink('winston ' + [view.x, view.y, view.w, view.h].join(',')); }
    hideWinston() { this._sink('hide'); }
    _sink(line) {
        if (!this.sink || !this.sink.stdin.writable) return;
        try { this.sink.stdin.write(line + '\n'); } catch (e) { /* gone */ }
    }

    input(kind, x, y) {
        if (!this.sink || !this.sink.stdin.writable) return;
        try { this.sink.stdin.write(kind + ' ' + Math.round(x) + ' ' + Math.round(y) + '\n'); } catch (e) { /* gone */ }
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
            if (this.padsProc) {
                /* its stdin's end: the slots marked unplugged, the pads released */
                const p = this.padsProc;
                this.padsProc = null;
                try { p.stdin.end(); } catch (e) { /* gone */ }
                setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1500);
            }
            if (this.pcm) {
                clearInterval(this.pcm.timer);
                try { fs.closeSync(this.pcm.fd); } catch (e) { /* gone */ }
                this.pcm = null;
            }
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
