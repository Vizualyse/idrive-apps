// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The app's side of the vizualyse-cluster tool's control socket:
 * /dev/shm/vizualyse-cluster/ctl.sock, a Unix stream socket, newline-delimited
 * JSON. The tool sends {"ev":"status", ...} on connect, after every command
 * and once a second, and {"ev":"error","error":...} for a failed command;
 * the app sends {"cmd":"enable"} / {"cmd":"disable"} (themes on the cluster
 * or the car's own), {"cmd":"theme","id":family}, {"cmd":"mode","mode":
 * "auto"|"sport"|"comfort"}, {"cmd":"cover","on":bool} (black over the
 * car's own strip under the theme), {"cmd":"picker","on":bool} (the theme
 * picker on the central screen), {"cmd":"speed","kmh":...} (the car's
 * speed, about once a second: the picker and Try only while parked) and
 * {"cmd":"signals", ...} (the car's readings for the theme:
 * src/vehicle_signals.js).
 * Connected while the app runs, retried once a second; the tool keeps
 * running without it. As vizualyse_steam's.
 *
 * Texts are plain ASCII: RHMI Text is not a reliable Unicode transport on
 * this firmware (knowledge/idrive-app-ui.md).
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.CLUSTER_CTL_SOCKET || '/dev/shm/vizualyse-cluster/ctl.sock';
const RETRY_MS = 1000;
/* how long a failed command's error stays on the status line */
const ERROR_MS = 10000;
const MODES = ['auto', 'sport', 'comfort'];

/* ASCII only */
function ascii(s) { return String(s === null || s === undefined ? '' : s).replace(/·/g, '-').replace(/[^\x20-\x7e]/g, '?'); }
/* a theme's family title: "G20 inspired 1 . Comfort" -> "G20 inspired 1" */
function familyTitle(t) { return ascii(String(t || '').replace(/\s*·.*$/, '')); }

class ClusterControl extends EventEmitter {
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
    /* a family: on with it, as the picker's Use */
    use(family) { return this._send({ cmd: 'use', id: family }); }
    /* the next of auto, sport, comfort */
    nextMode() { return this._send({ cmd: 'mode', mode: MODES[(MODES.indexOf(this.mode()) + 1) % MODES.length] }); }
    cover(on) { return this._send({ cmd: 'cover', on: !!on }); }
    showPicker() { return this._send({ cmd: 'picker', on: true }); }
    /* not buttons: they leave a button's error on the status line alone */
    hide() {
        if (!this.sock || !this.status || !this.status.picker) return false;
        this.sock.write(JSON.stringify({ cmd: 'picker', on: false }) + '\n');
        return true;
    }
    speed(kmh) {
        if (!this.sock || !this.status) return false;
        this.sock.write(JSON.stringify({ cmd: 'speed', kmh: Math.round(kmh * 10) / 10 }) + '\n');
        return true;
    }

    /* the car's readings for the theme (src/vehicle_signals.js): only what
     * changed, and all of them once a second */
    signals(values) {
        if (!this.sock || !this.status) return false;
        this.sock.write(JSON.stringify(Object.assign({}, values, { cmd: 'signals' })) + '\n');
        return true;
    }

    connected() { return !!this.status; }
    enabled() { return !!(this.status && this.status.enabled); }
    shown() { return !!(this.status && this.status.picker); }
    moving() { return !!(this.status && this.status.moving); }
    mode() { return (this.status && this.status.mode) || 'auto'; }
    covered() { return !!(this.status && this.status.cover); }
    theme() { return this.status && this.status.theme; }

    /* the families, in the tool's order: [{ family, title }] */
    families() {
        const by = {}, out = [];
        ((this.status && this.status.themes) || []).slice()
            .sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0))
            .forEach((t) => {
                if (!by[t.family]) { by[t.family] = { family: t.family, title: familyTitle(t.title) }; out.push(by[t.family]); }
                if (t.mode !== 'comfort') by[t.family].title = familyTitle(t.title);
            });
        return out;
    }

    _commandError() {
        const e = this.lastError;
        return e && Date.now() - e.at < ERROR_MS ? e.text : null;
    }

    statusText() {
        const s = this.status;
        if (!s) return 'The cluster themes tool is not running - install Cluster themes (the tool) from the Store';
        const failed = this._commandError();
        if (failed) return ascii('Error: ' + failed);
        if (s.picker) return 'The picker is on the screen - the back arrow on the left returns here';
        if (s.trying) return 'Trying a theme on the cluster...';
        if (!s.enabled) return "Off - the car's own cluster shows";
        if (s.error) return ascii('The cluster: ' + s.error);
        const t = (s.themes || []).filter((x) => x.id === s.showing)[0];
        if (!t) return 'On - starting the theme...';
        return ascii('On the cluster: ' + familyTitle(t.title) + ' (' + (t.mode === 'comfort' ? 'Comfort' : 'Sport') + ')');
    }

    modeText() {
        return 'Sport or Comfort: ' + ({ auto: 'by the drive mode', sport: 'always Sport', comfort: 'always Comfort' }[this.mode()] || this.mode());
    }
}

module.exports = { ClusterControl, SOCKET, ascii, familyTitle };
