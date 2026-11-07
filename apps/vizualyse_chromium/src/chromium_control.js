// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The app's side of the vizualyse-chromium tool's control socket:
 * /dev/shm/vizualyse-chromium/ctl.sock, a Unix stream socket,
 * newline-delimited JSON. The tool sends {"ev":"status", ...} on connect,
 * after every command and once a second, and {"ev":"error","error":...} for
 * a failed command; the app sends {"cmd":"enable"} / {"cmd":"disable"} (the
 * browser runs or not), {"cmd":"show"} / {"cmd":"hide"} (the page on the
 * central screen), {"cmd":"home"}, {"cmd":"reload"}, {"cmd":"back"},
 * {"cmd":"gpu","on":true|false} (the GPU mode, experimental),
 * {"cmd":"scale","scale":1|0.75|0.5|1/3|0.25} (the resolution),
 * {"cmd":"game","on":true|false} (game mode, experimental),
 * {"cmd":"room","on":true|false} (pause Moonlight and Cast while browsing) and
 * {"cmd":"speed","kmh":...} (the car's speed, about once a second, for "only
 * while parked"). Connected while the app runs (the speed goes on while the
 * browser covers the page), retried once a second; the tool keeps running
 * without it. As vizualyse_moonlight's.
 *
 * Texts are plain ASCII: RHMI Text is not a reliable Unicode transport on
 * this firmware (knowledge/idrive-app-ui.md).
 */
'use strict';

const net = require('net');
const EventEmitter = require('events');

const SOCKET = process.env.CHROMIUM_CTL_SOCKET || '/dev/shm/vizualyse-chromium/ctl.sock';
const RETRY_MS = 1000;
/* how long a failed command's error stays on the status line */
const ERROR_MS = 10000;
/* how long running out of memory stays on the status line */
const OOM_MS = 120000;

class BrowserControl extends EventEmitter {
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
    show() { return this._send({ cmd: 'show' }); }
    home() { return this._send({ cmd: 'home' }); }
    reload() { return this._send({ cmd: 'reload' }); }
    back() { return this._send({ cmd: 'back' }); }
    /* the GPU mode (experimental): the tool restarts Chromium on the unit's own
     * GPU driver; never kept over a restart of the tool */
    gpu(on) { return this._send({ cmd: 'gpu', on: !!on }); }
    /* the resolution: the tool's device scale factor, 1 down to 0.25 */
    scale(s) { return this._send({ cmd: 'scale', scale: s }); }
    /* game mode (experimental): the tool restarts Chromium with WebGPU's checks
     * off, for trusted games; never kept over a restart of the tool */
    game(on) { return this._send({ cmd: 'game', on: !!on }); }
    gameMode() { return !!(this.status && this.status.gameMode); }
    /* make room: the tool pauses the Moonlight and Cast tools while the browser is on */
    room(on) { return this._send({ cmd: 'room', on: !!on }); }
    roomOn() { return !!(this.status && this.status.room && this.status.room.on); }
    roomText() {
        const r = this.status && this.status.room;
        if (!r || !r.on) return 'Make room: off';
        const names = (r.paused || []).map((u) => u.replace(/^vizualyse-/, '')).map((n) => n[0].toUpperCase() + n.slice(1));
        return 'Make room: on' + (names.length ? ' (' + names.join(', ') + ' paused)' : '');
    }
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
    running() { return !!(this.status && this.status.browser === 'running'); }
    shown() { return !!(this.status && this.status.shown); }
    gpuMode() { return !!(this.status && this.status.gpuMode); }
    scaleNow() { return (this.status && this.status.scale) || 1; }
    /* the next resolution, round: full, 3/4, 1/2, 1/3, 1/4 (the tool's list) */
    nextScale() {
        const all = ((this.status && this.status.resolutions) || []).map((r) => r.scale);
        const list = all.length ? all : [1, 0.75, 0.5];
        return list[(list.indexOf(this.scaleNow()) + 1) % list.length];
    }
    resolutionText() {
        const s = this.status, now = this.scaleNow();
        const r = s && (s.resolutions || []).filter((x) => x.scale === now)[0];
        return 'Resolution: ' + ({ 1: 'full', 0.75: '3/4', 0.5: '1/2', [1 / 3]: '1/3', 0.25: '1/4' }[now] || now) + (r ? ' (' + r.w + 'x' + r.h + ')' : '');
    }
    moving() { return !!(this.status && this.status.moving); }
    link() { return (this.status && this.status.link) || ''; }

    _commandError() {
        const e = this.lastError;
        return e && Date.now() - e.at < ERROR_MS ? e.text : null;
    }

    statusText() {
        const s = this.status;
        if (!s) return 'The Browser tool is not running - install Browser (the tool) from the Store';
        if (s.enabled === false) return 'Off - turn the browser on to use it';
        const failed = this._commandError();
        if (failed) return 'Error: ' + failed;
        if (s.bundle === 'unpacking') return 'Installing the browser (about a minute, once)...';
        if (s.bundle === 'failed' || s.error) return 'Error: ' + (s.error || 'the browser could not be installed');
        if (s.browser === 'starting' || s.browser === 'crashed') return 'Starting the browser' + (s.gpuMode ? ' on the GPU' : '') + '...';
        if (s.browser !== 'running') return 'The browser is not running';
        const m = s.memory;
        if (m && m.note && m.oomAt && Date.now() - Date.parse(m.oomAt) < OOM_MS) {
            return 'Out of memory - the page needed more than ' + m.capMb + ' MB (phone page: Memory)';
        }
        if (s.moving) return 'Only while parked - the car is moving (' + s.speed + ' km/h)';
        if (s.shown) return 'On the screen - the back arrow on the left returns here';
        if (!s.link) return 'Ready - Show puts it on the screen (phone page: waiting for the hotspot, uplink ' + (s.uplink || 'unknown') + ')';
        return 'Ready - Show puts it on the screen; scan the QR code to type addresses';
    }

    pageText() {
        const s = this.status;
        if (!s || s.browser !== 'running') return '';
        return (s.title ? s.title + ' - ' : '') + (s.url || '');
    }

    /* what the probe found (WebGL 2 on the GPU in the GPU mode, SwiftShader
     * otherwise), or what became of the GPU mode; one row */
    gpuText() {
        const s = this.status;
        if (s && s.gpuNote) return 'GPU mode: ' + s.gpuNote;
        const g = s && s.gpu;
        if (!g || (s.gpuMode && g.mode !== 'gpu')) return s && s.browser === 'running' ? 'GPU: checking...' : '';
        const soft = g.webgpuFallback && /swiftshader/i.test(g.webgpu || '');
        /* the GPU mode's WebGPU: compatibility mode on Dawn's GLES backend */
        const compat = g.webgpuBackend === 'openGLES' ? 'GLES compat' + (g.webgpuFallback ? ' (CPU)' : '') : null;
        const webgpu = !g.webgpu || /^no |error/.test(g.webgpu) ? 'WebGPU: ' + (g.webgpu || 'none')
            : 'WebGPU: ' + (compat || (soft ? 'CPU (SwiftShader)' : g.webgpu + (g.webgpuFallback ? ' (software)' : ''))) + (g.webgpuCompute === 'ok' ? '' : ', compute ' + g.webgpuCompute);
        return webgpu + ' | WebGL 2: ' + glName(g.webgl2) + ' | JSPI: ' + (g.jspi || '?');
    }
}

/* ANGLE's renderer string, short enough for one row: SwiftShader (ANGLE on
 * Vulkan on the CPU) -> "CPU (SwiftShader)"; on the unit's GLES (the GPU
 * mode) "ANGLE (Intel Open Source Technology Center, Mesa DRI Intel(R) HD
 * Graphics 505 (APL 3) , OpenGL ES 3.2 Mesa 19.0.6)" -> "GLES 3.2, Intel HD
 * Graphics 505 (APL 3)"; others "ANGLE (Intel, Vulkan 1.3 (Intel(R) HD
 * Graphics 505 (APL 3)), Intel open-source Mesa driver)" -> "Vulkan, Intel HD
 * Graphics 505 (APL 3)" */
function glName(s) {
    const t = String(s || 'none');
    if (/SwiftShader/i.test(t)) return 'CPU (SwiftShader)';
    const clean = (x) => x.replace(/ \(0x[0-9A-Fa-f]+\)$/, '').replace(/\((R|TM)\)/g, '').replace(/^Mesa (DRI )?/, '').replace(/\s+/g, ' ').trim();
    const gles = /^ANGLE \([^,]+, (.+?)\s*, OpenGL( ES)? ([\d.]+)/.exec(t);
    if (gles) return (gles[2] ? 'GLES ' : 'GL ') + gles[3] + ', ' + clean(gles[1]);
    const m = /^ANGLE \(([^,]+), (\S+)[^(]*\((.+)\), [^,]+\)$/.exec(t);
    return m ? m[2] + ', ' + clean(m[3]) : t;
}

module.exports = { BrowserControl, SOCKET, glName };
