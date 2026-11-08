// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The app's side of the vizualyse-steam tool's control socket:
 * /dev/shm/vizualyse-steam/ctl.sock, a Unix stream socket, newline-delimited
 * JSON. The tool sends {"ev":"status", ...} on connect, after every command
 * and once a second, and {"ev":"error","error":...} for a failed command;
 * the app sends {"cmd":"enable"} / {"cmd":"disable"} (Steam on or off),
 * {"cmd":"play","appId":N}, {"cmd":"stop"} (the running game),
 * {"cmd":"show"} / {"cmd":"hide"} (the game on the central screen),
 * {"cmd":"resolution"} (the next picture size), {"cmd":"upscale"} (the next
 * way of scaling it up) and {"cmd":"speed","kmh":...}
 * (the car's speed, about once a second, for "only while parked").
 * Connected while the app runs, retried once a second; the tool keeps
 * running without it. As vizualyse_chromium's.
 *
 * Texts are plain ASCII: RHMI Text is not a reliable Unicode transport on
 * this firmware (knowledge/idrive-app-ui.md).
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.STEAM_CTL_SOCKET || '/dev/shm/vizualyse-steam/ctl.sock';
const RETRY_MS = 1000;
/* how long a failed command's error stays on the status line */
const ERROR_MS = 10000;
/* how long running out of memory stays on the status line */
const OOM_MS = 120000;

/* ASCII only, one row's worth */
function ascii(s) { return String(s === null || s === undefined ? '' : s).replace(/[^\x20-\x7e]/g, '?'); }

class SteamControl extends EventEmitter {
    constructor(opts) {
        super();
        this.log = (opts && opts.log) || console;
        this.path = (opts && opts.socket) || SOCKET;
        this.sock = null;
        this.wanted = false;
        this.timer = null;
        this.buf = '';
        this.status = null;
        this.lastError = null;
    }

    open() {
        this.wanted = true;
        if (!this.sock && !this.timer) this._connect();
    }

    close() {
        this.wanted = false;
        clearTimeout(this.timer);
        this.timer = null;
        if (this.sock) { this.sock.destroy(); this.sock = null; }
    }

    _connect() {
        this.timer = null;
        if (!this.wanted) return;
        const s = net.createConnection(this.path);
        this.sock = s;
        s.setEncoding('utf8');
        s.on('data', (d) => {
            this.buf += d;
            if (this.buf.length > 262144) { s.destroy(); return; }
            let i;
            while ((i = this.buf.indexOf('\n')) >= 0) {
                const line = this.buf.slice(0, i);
                this.buf = this.buf.slice(i + 1);
                let ev = null;
                try { ev = JSON.parse(line); } catch (e) { continue; }
                if (!ev) continue;
                if (ev.ev === 'status') { this.status = ev; this.emit('change'); }
                else if (ev.ev === 'error') {
                    this.lastError = { text: String(ev.error || 'the command failed'), at: Date.now() };
                    this.emit('change');
                }
            }
        });
        s.on('error', () => { /* close follows */ });
        s.on('close', () => {
            if (this.sock === s) this.sock = null;
            this.buf = '';
            this.lastError = null;
            if (this.status !== null) { this.status = null; this.emit('change'); }
            if (this.wanted && !this.timer) this.timer = setTimeout(() => this._connect(), RETRY_MS);
        });
    }

    _send(obj) {
        if (!this.sock || !this.status) return false;
        this.lastError = null;
        this.sock.write(JSON.stringify(obj) + '\n');
        return true;
    }

    enable() { return this._send({ cmd: 'enable' }); }
    disable() { return this._send({ cmd: 'disable' }); }
    show() { return this._send({ cmd: 'show' }); }
    play(appId) { return this._send({ cmd: 'play', appId: appId }); }
    stop() { return this._send({ cmd: 'stop' }); }
    resolution() { return this._send({ cmd: 'resolution' }); }
    upscale() { return this._send({ cmd: 'upscale' }); }
    /* not buttons: they leave a button's error on the status line alone */
    hide() {
        if (!this.sock || !this.status || !this.status.shown) return false;
        this.sock.write(JSON.stringify({ cmd: 'hide' }) + '\n');
        return true;
    }
    speed(kmh) {
        if (!this.sock || !this.status) return false;
        this.sock.write(JSON.stringify({ cmd: 'speed', kmh: Math.round(kmh * 10) / 10 }) + '\n');
        return true;
    }

    connected() { return !!this.status; }
    enabled() { return !(this.status && this.status.enabled === false); }
    ready() { return !!(this.status && this.status.bundle === 'ready'); }
    /* a game running (starting or drawing) */
    running() { return !!(this.status && this.status.running); }
    gameState() { const g = this.status && this.status.game; return g ? g.state : null; }
    gameId() { const g = this.status && this.status.game; return g && g.state !== 'ended' ? g.appId : null; }
    shown() { return !!(this.status && this.status.shown); }
    moving() { return !!(this.status && this.status.moving); }
    link() { return (this.status && this.status.link) || ''; }
    library() { return (this.status && this.status.library) || []; }

    _commandError() {
        const e = this.lastError;
        return e && Date.now() - e.at < ERROR_MS ? e.text : null;
    }

    statusText() {
        const s = this.status;
        if (!s) return 'The Steam tool is not running - install Steam (the tool) from the Store';
        if (s.enabled === false) return 'Off - turn Steam on to use it';
        const failed = this._commandError();
        if (failed) return ascii('Error: ' + failed);
        if (s.bundle === 'unpacking' || s.bundle === 'checking') return 'Installing Steam on the car (a few minutes, once)...';
        if (s.bundle === 'failed' || s.error) return ascii('Error: ' + (s.error || 'the tool could not be installed'));
        const m = s.memory;
        if (m && m.note && m.oomAt && Date.now() - Date.parse(m.oomAt) < OOM_MS) {
            return 'Out of memory - the game needed more than ' + m.capMb + ' MB (phone page: Memory)';
        }
        const g = s.game;
        if (s.running && s.moving) return 'Only while parked - the car is moving (' + Math.round(s.speed) + ' km/h)';
        if (s.running && g.state === 'starting') return ascii('Starting ' + g.name + ' (this can take a minute)...');
        if (s.running && s.shown) return 'On the screen - the back arrow on the left returns here';
        if (s.running) return ascii(g.name + ' is running - Show puts it on the screen');
        if (s.restartNote) return ascii('Note: ' + s.restartNote);
        if (!s.library.length) return 'No games yet - scan the QR code to sign in to Steam and install one';
        return 'Ready - pick a game';
    }

    /* what runs or ran last, one row */
    gameText() {
        const g = this.status && this.status.game;
        if (!g) return '';
        if (g.state === 'starting') return ascii(g.name + ': starting');
        if (g.state === 'running') return ascii(g.name + ': ' + g.fps + ' pictures/s' + (g.gpuBuffers ? '' : ' (no GPU buffers)'));
        return ascii(g.name + ' ended' + (g.note ? ': ' + g.note : ''));
    }

    /* the download, one row (the phone page has the questions) */
    downloadText() {
        const d = this.status && this.status.download;
        if (!d) return '';
        const name = d.name || 'App ' + d.appId;
        const t = {
            starting: 'Steam: ' + (d.note || 'starting...'),
            password: 'Steam asks for the password - answer on the phone page',
            code: 'Steam Guard asks for a code - answer on the phone page',
            confirm: 'Steam Guard: approve the sign-in in the Steam app',
            downloading: 'Downloading ' + name + ': ' + Number(d.percent || 0).toFixed(0) + ' %',
            done: name + ' is installed',
            failed: 'Download failed: ' + (d.note || ''),
            stopped: 'Download cancelled',
        }[d.state] || d.state;
        return ascii(t);
    }

    resolutionText() {
        const s = this.status;
        return 'Picture: ' + ((s && s.settings && s.settings.resolution) || '1280x720') + (s && s.running ? ' (from the next game)' : '');
    }

    /* Upscaling: off / FSR / FSR without sharpening (tool 0.1.11; applies at once) */
    upscaleText() {
        const s = this.status, u = s && s.settings && s.settings.upscale;
        if (!u) return 'Upscaling: not in this Steam tool (update it)';
        return 'Upscaling: ' + ({ off: 'off', fsr: 'FSR', 'fsr-soft': 'FSR, no sharpening' }[u] || u);
    }
}

module.exports = { SteamControl, SOCKET, ascii };
