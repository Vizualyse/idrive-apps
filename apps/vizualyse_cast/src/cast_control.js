// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The app's side of the vizualyse-cast tool's control socket:
 * /dev/shm/vizualyse-cast/ctl.sock, a Unix stream socket (group tm_oap_app),
 * newline-delimited JSON. The tool sends {"ev":"status", ...} on connect,
 * after every command and once a second; the app sends {"cmd":"stop"},
 * {"cmd":"replay","output":"map"|"hud"|"console"|"none"},
 * {"cmd":"carplay","output":"map"|"hud"} (the CarPlay second screen),
 * {"cmd":"hook111","mode":"off"|"alt"} (the second screen's switch),
 * {"cmd":"carplayView","view":"cluster"|"map"|"card"} (its cluster view),
 * {"cmd":"carplayShape","shape":"wide"|"taller"|"tall"}, {"cmd":"carplayVignette","on":…},
 * {"cmd":"enable"}, {"cmd":"disable"} and {"cmd":"qr","show":true|false}. Connected while the page is visible,
 * retried once a second; the tool keeps running without it.
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.CAST_CTL_SOCKET || '/dev/shm/vizualyse-cast/ctl.sock';
const RETRY_MS = 1000;

const TITLES = { map: 'the cluster map', hud: 'the HUD', console: 'this screen', none: 'the speakers only' };

class CastControl extends EventEmitter {
    constructor(opts) {
        super();
        this.log = (opts && opts.log) || console;
        this.path = (opts && opts.socket) || SOCKET;
        this.sock = null;
        this.wanted = false;
        this.timer = null;
        this.buf = '';
        this.status = null;
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
                if (ev && ev.ev === 'status') { this.status = ev; this.emit('change'); }
            }
        });
        s.on('error', () => { /* close follows */ });
        s.on('close', () => {
            if (this.sock === s) this.sock = null;
            this.buf = '';
            if (this.status !== null) { this.status = null; this.emit('change'); }
            if (this.wanted && !this.timer) this.timer = setTimeout(() => this._connect(), RETRY_MS);
        });
    }

    _send(obj) {
        if (!this.sock || !this.status) return false;
        this.sock.write(JSON.stringify(obj) + '\n');
        return true;
    }

    stop() { return this._send({ cmd: 'stop' }); }
    enable() { return this._send({ cmd: 'enable' }); }
    disable() { return this._send({ cmd: 'disable' }); }
    carplay(output) { return this._send({ cmd: 'carplay', output: output }); }
    setCarplayOn(on) { return this._send({ cmd: 'hook111', mode: on ? 'alt' : 'off' }); }
    /* the next cluster view: map and directions -> map only -> directions only -> ... */
    nextCarplayView() {
        const order = ['cluster', 'map', 'card'], cur = this.carplayView().wanted;
        return this._send({ cmd: 'carplayView', view: order[(order.indexOf(cur) + 1) % order.length] });
    }
    replay(output) { return this._send({ cmd: 'replay', output: output }); }
    setQr(show) { return this._send({ cmd: 'qr', show: !!show }); }

    connected() { return !!this.status; }
    enabled() { return !(this.status && this.status.enabled === false); }
    /* the tool sees hook111 armed and streaming-ready this start */
    canCarplay() { return !!(this.status && this.status.carplay && this.status.carplay.ready && this.enabled()); }
    /* the second screen's switch: { installed, on, pending } (hook111's mode) */
    carplaySwitch() { return (this.status && this.status.carplay && this.status.carplay.switch) || { installed: false, on: false, pending: null }; }
    switchText() {
        if (!this.status) return 'CarPlay second screen: —';
        const w = this.carplaySwitch();
        if (!w.installed) return 'CarPlay second screen: hook111 not installed';
        return 'CarPlay second screen: ' + (w.on ? 'on' : 'off') + (w.pending ? ' (' + w.pending + ')' : '');
    }
    /* the next shape: normal -> taller -> tall -> ...; the vignette on / off */
    nextCarplayShape() {
        const order = ['wide', 'taller', 'tall'], cur = this.carplayShape().wanted;
        return this._send({ cmd: 'carplayShape', shape: order[(order.indexOf(cur) + 1) % order.length] });
    }
    setCarplayVignette(on) { return this._send({ cmd: 'carplayVignette', on: !!on }); }
    carplayShape() { return (this.status && this.status.carplay && this.status.carplay.shape) || { wanted: 'wide', title: null, pending: null }; }
    carplayVignette() { return !!(this.status && this.status.carplay && this.status.carplay.vignette); }
    shapeText() {
        const s = this.carplayShape();
        if (!this.status || !s.title) return 'CarPlay shape: —';
        return 'CarPlay shape: ' + s.title + (s.pending ? ' (' + s.pending + ')' : '');
    }
    vignetteText() { return 'CarPlay vignette: ' + (this.status ? (this.carplayVignette() ? 'on' : 'off') : '—'); }
    /* the cluster view: { wanted, title, offered, pending } */
    carplayView() { return (this.status && this.status.carplay && this.status.carplay.view) || { wanted: 'cluster', title: null, pending: null }; }
    viewText() {
        const v = this.carplayView();
        if (!this.status || !v.title) return 'CarPlay cluster view: —';
        return 'CarPlay cluster view: ' + v.title + (v.pending ? ' (' + v.pending + ')' : '');
    }
    link() { return (this.status && this.status.link) || ''; }
    canReplay() { return !!(this.status && this.status.canReplay); }
    playing() { return !!(this.status && this.status.state === 'playing'); }
    hasOutput(id) { return !!(this.status && (this.status.outputs || []).some((o) => o.id === id)); }
    qrOnCluster() { return !(this.status && this.status.qr === false); }

    statusText() {
        const s = this.status;
        if (!s) return 'Cast service not running — install Cast to cluster in the Store';
        if (s.enabled === false) return 'Off — turn Cast to cluster on to use it';
        const where = TITLES[s.output] || s.output || '';
        if (s.state === 'playing') return 'Playing on ' + where + (s.audio ? ', with sound' : '') + ' — ' + (s.seconds || 0) + ' s';
        if (s.state === 'error') return 'Error: ' + (s.error || 'the stream failed');
        if (s.state === 'ended') return 'Ended' + (where ? ' on ' + where : '');
        if (!s.link) return 'Waiting for the phone’s hotspot (uplink ' + (s.uplink || 'unknown') + ')';
        return 'Ready — scan the QR code with your phone';
    }

    infoText() {
        const s = this.status;
        if (!s) return '';
        return 'Uplink ' + (s.uplink || 'unknown') + ' · cluster renderer ' + (s.render || 'unknown') +
            (s.url ? ' · last: ' + s.url : '');
    }
}

module.exports = { CastControl, SOCKET, TITLES };
