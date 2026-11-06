// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The browser on the central display through mgu-render (as
 * vizualyse-moonlight's console_out.js): a frame file
 * /dev/shm/mgu-video-vizualyse_chromium (64-byte MGVF header, 3 I420 slots)
 * that chromium-sink fills, and an mgu-render client in layer mode that
 * shows it in the app area (1790x638 at +108+82 of 1920x720 on the car), so
 * the HMI's top bar and left strip stay visible and usable: its back arrow
 * leaves the iDrive page, and the app then hides the browser. Root, so the
 * renderer's foreground gate does not apply; the renderer hides layer apps
 * itself while the reversing camera shows. A draw once a second keeps it
 * up (the renderer redraws the last frame for each new picture).
 *
 * The sink also reads the display's touches (passively, nothing claimed:
 * knowledge/central-screen.md) and says them as events; server.js turns
 * those inside the area into the page's touches.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const CLIENT = process.env.CHROMIUM_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const NAME = 'vizualyse_chromium';
const FILE = process.env.CHROMIUM_VIDEO_FILE || '/dev/shm/mgu-video-' + NAME;
const MAGIC = 0x4656474d, NSLOT = 3, HEADER = 64;
const VIDEO_ID = 1;

function available() { try { return fs.statSync(CLIENT).isFile(); } catch (e) { return false; } }

function frameFile(file, w, h) {
    try { fs.unlinkSync(file); } catch (e) { /* none */ }
    const fd = fs.openSync(file, 'w', 0o644);
    try {
        fs.ftruncateSync(fd, HEADER + NSLOT * w * h * 3 / 2);
        const b = Buffer.alloc(HEADER);
        /* JPEG's colours: BT.601, full range (chromium-sink sets them too) */
        [MAGIC, 1, w, h, 0, 0, NSLOT, 0, 1].forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
        fs.writeSync(fd, b, 0, HEADER, 0);
    } finally {
        fs.closeSync(fd);
    }
}

/* view: { x, y, w, h } on the screen; sink: the chromium-sink path;
 * touch: { iface, src } or { file } or null; frame: { w, h } of the pictures
 * when smaller than the view (the resolution setting: mgu-render's VIDEO op
 * fits them to the view, aspect kept, linear filtering). Events: 'touch' {p, x, y}
 * (screen pixels), 'stats', 'sink-error', 'ready', 'gone' (the sink exited). */
class Screen extends EventEmitter {
    constructor(log, sinkPath) {
        super();
        this.log = log;
        this.sinkPath = sinkPath;
        this.gpu = null;
        this.sink = null;
        this.view = null;
        this.pending = 0;
    }

    shown() { return !!this.sink; }

    show(view, touch, frame) {
        this.hide();
        this.view = view;
        const f = frame || view;
        frameFile(FILE, f.w, f.h);
        const args = ['--frame', FILE];
        if (touch && touch.iface) args.push('--touch-iface', touch.iface, '--touch-src', touch.src);
        else if (touch && touch.file) args.push('--touch-file', touch.file);
        const sink = spawn(this.sinkPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.sink = sink;
        this.pending = 0;
        let rest = '';
        sink.stdout.setEncoding('utf8');
        sink.stdout.on('data', (d) => {
            rest += d;
            let i;
            while ((i = rest.indexOf('\n')) >= 0) {
                const l = rest.slice(0, i);
                rest = rest.slice(i + 1);
                let e;
                try { e = JSON.parse(l); } catch (x) { this.log('sink: ' + l); continue; }
                /* 'error' would throw without a listener */
                this.emit(e.ev === 'error' ? 'sink-error' : e.ev, e);
            }
        });
        sink.stderr.on('data', (d) => this.log('sink: ' + String(d).trim()));
        sink.stdin.on('error', () => { /* it exited: 'exit' says so */ });
        sink.on('exit', (code, sig) => {
            if (this.sink === sink) {
                this.log('sink: exited (' + (sig || code) + ')');
                this.sink = null;
                this.emit('gone');
            }
        });

        if (!available()) { this.log('screen: no mgu-render client at ' + CLIENT); return; }
        const { RenderClient, videoOp } = require(CLIENT);
        this.videoOp = videoOp;
        const say = (s) => this.log('screen: ' + s);
        const gpu = new RenderClient(NAME, { info: say, warn: say, error: say }, { mode: 'layer' });
        this.gpu = gpu;
        gpu.on('ready', (screenInfo, info) => {
            const a = info && info.appArea;
            say('ready: screen ' + screenInfo.w + 'x' + screenInfo.h + (a ? ', app area ' + a.w + 'x' + a.h + '+' + a.x + '+' + a.y : '') +
                ', browser ' + view.w + 'x' + view.h + '+' + view.x + '+' + view.y + (f !== view ? ', pictures ' + f.w + 'x' + f.h : ''));
            if (a && (a.w !== view.w || a.h !== view.h || a.x !== view.x || a.y !== view.y)) say('the app area differs from the browser\'s place (CHROMIUM_VIEW sets it)');
            gpu.mode('layer');
            gpu.place({ x: view.x, y: view.y, w: view.w, h: view.h, scale: 1, ox: 0, oy: 0 });
            gpu.video(VIDEO_ID, FILE);
            gpu.fps(0);
            gpu.show(true);
            this._draw();
        });
        gpu.on('renderer-error', (e) => say('renderer error: ' + e));
        gpu.on('state', (st) => say('state: ' + st.mode + (st.onScreen ? ', on screen' : ', off screen')));
        gpu.connect();
        this.keepAlive = setInterval(() => this._draw(), 1000);
    }

    _draw() {
        if (!this.gpu || !this.view) return;
        const op = this.videoOp(VIDEO_ID, 0, 0, this.view.w, this.view.h, 0);
        this.gpu.frameWords(op instanceof Uint32Array ? op : Uint32Array.from(op));
    }

    /* A JPEG for the sink; done() once it has it (the screencast's ack: one
     * picture in flight, so a slow decode drops pictures in Chromium, not here). */
    picture(jpeg, done) {
        if (!this.sink) return done();
        const h = Buffer.alloc(4);
        h.writeUInt32LE(jpeg.length, 0);
        this.sink.stdin.write(h);
        this.sink.stdin.write(jpeg, () => done());
    }

    hide() {
        if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
        if (this.gpu) {
            try { this.gpu.show(false); this.gpu.video(VIDEO_ID, null); this.gpu.close(); } catch (e) { /* gone */ }
            this.gpu = null;
        }
        if (this.sink) {
            const s = this.sink;
            this.sink = null;
            try { s.stdin.end(); } catch (e) { /* gone */ }
            setTimeout(() => { try { s.kill('SIGKILL'); } catch (e) { /* gone */ } }, 2000);
        }
        this.view = null;
        try { fs.unlinkSync(FILE); } catch (e) { /* none */ }
    }
}

module.exports = { Screen, available, frameFile, FILE };
