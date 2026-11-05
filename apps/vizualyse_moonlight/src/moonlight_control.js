// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The app's side of the vizualyse-moonlight tool's control socket:
 * /dev/shm/vizualyse-moonlight/ctl.sock, a Unix stream socket,
 * newline-delimited JSON. The tool sends {"ev":"status", ...} on connect,
 * after every command and once a second, and {"ev":"error","error":…} for a
 * failed command; the app sends {"cmd":"enable"}, {"cmd":"disable"},
 * {"cmd":"stop"} (stop streaming, the game keeps running on the PC),
 * {"cmd":"quit"} (stop and close the game on the PC), {"cmd":"resume"}
 * (the last host and game again), {"cmd":"output","output":...} (where the
 * picture goes: console, map or hud) and {"cmd":"speed","kmh":...} (the car's
 * speed, about once a second, for "only while parked"). Connected while the
 * app runs (the speed goes on while a stream covers the page), retried once
 * a second; the tool keeps running without it.
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.MOONLIGHT_CTL_SOCKET || '/dev/shm/vizualyse-moonlight/ctl.sock';
const RETRY_MS = 1000;
/* how long a failed command's error stays on the status line */
const ERROR_MS = 10000;

class MoonlightControl extends EventEmitter {
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
            if (this.buf.length > 65536) { s.destroy(); return; }
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
    stop() { return this._send({ cmd: 'stop' }); }
    quit() { return this._send({ cmd: 'quit' }); }
    resume() { return this._send({ cmd: 'resume' }); }
    output(id) { return this._send({ cmd: 'output', output: id }); }
    /* not a button: it leaves a button's error on the status line alone */
    speed(kmh) {
        if (!this.sock || !this.status) return false;
        this.sock.write(JSON.stringify({ cmd: 'speed', kmh: Math.round(kmh * 10) / 10 }) + '\n');
        return true;
    }

    connected() { return !!this.status; }
    enabled() { return !(this.status && this.status.enabled === false); }
    link() { return (this.status && this.status.link) || ''; }
    state() { return (this.status && this.status.state) || 'idle'; }
    /* a stream is up or on its way: Stop and Quit game apply */
    active() { const st = this.state(); return st === 'streaming' || st === 'starting'; }
    canResume() { return !!(this.status && this.status.canResume); }
    /* where the picture goes: 'console', 'map' or 'hud' */
    currentOutput() { return (this.status && this.status.output) || 'console'; }

    _commandError() {
        const e = this.lastError;
        return e && Date.now() - e.at < ERROR_MS ? e.text : null;
    }

    statusText() {
        const s = this.status;
        if (!s) return 'The Moonlight tool is not running — install Moonlight (the tool) from the Store';
        if (s.enabled === false) return 'Off — turn Moonlight on to use it';
        const failed = this._commandError();
        if (failed) return 'Error: ' + failed;
        const host = s.host && s.host.name ? s.host.name : '';
        const game = s.app && s.app.name ? s.app.name : '';
        const what = game + (game && host ? ' from ' : '') + host;
        if (s.state === 'streaming') return 'Streaming ' + (what || 'a game') + ' — ' + (s.seconds || 0) + ' s';
        if (s.state === 'starting') return 'Starting ' + (what || 'the stream') + '…';
        if (s.state === 'error') return 'Error: ' + (s.error || 'the stream failed');
        if (s.state === 'ended') return 'Ended' + (what ? ': ' + what : '') + (s.note ? ' — ' + s.note : '');
        if (s.moving) return 'Only while parked — the car is moving (' + s.speed + ' km/h)';
        if (!s.link) return 'Waiting for the phone’s hotspot (uplink ' + (s.uplink || 'unknown') + ')';
        if (s.note) return s.note;
        return 'Ready — scan the QR code to pair and pick a game';
    }

    infoText() {
        const s = this.status;
        if (!s) return '';
        /* one row (90 characters): the stream's details while there is a
         * host, the uplink, the renderer and the last game otherwise */
        const pads = (s.pads || []).map((p) => p && p.name).filter(Boolean);
        const padText = pads.length ? pads.length + (pads.length === 1 ? ' controller: ' : ' controllers: ') + pads.join(', ') : 'no controllers';
        if (s.host) {
            const parts = [(s.host.name || '?') + (s.host.address ? ' (' + s.host.address + ')' : '')];
            if (s.app) parts.push(s.app.name || '?');
            if (s.state === 'streaming') parts.push((s.fps || 0) + ' fps' + (s.decoder ? (/^msdk \(GPU/.test(s.decoder) ? ' (GPU)' : ' (software)') : ''));
            parts.push(padText);
            return parts.join(' · ');
        }
        const parts = ['Uplink ' + (s.uplink || 'unknown'), 'renderer ' + (s.render || 'unknown'), padText];
        if (s.last) parts.push('last: ' + (s.last.app || '?') + ' on ' + (s.last.host || '?'));
        return parts.join(' · ');
    }
}

module.exports = { MoonlightControl, SOCKET };
