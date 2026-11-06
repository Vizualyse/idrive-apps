// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The browser on the central display through mgu-render (as
 * vizualyse-moonlight's console_out.js): a frame file
 * /dev/shm/mgu-video-vizualyse_chromium (64-byte MGVF header, 3 I420 slots)
 * that the browser's display (chromium-wl, browser.js) fills, and an
 * mgu-render client in layer mode that shows it in the app area (1790x638
 * at +108+82 of 1920x720 on the car), so the HMI's top bar and left strip
 * stay visible and usable: its back arrow leaves the iDrive page, and the
 * app then hides the browser. Root, so the renderer's foreground gate does
 * not apply; the renderer hides layer apps itself while the reversing camera
 * shows. A draw once a second keeps it up (the renderer redraws the last
 * frame for each new picture).
 *
 * The frame file is nobody's: chromium-wl runs as nobody (mgu-render takes
 * a file of the app's uid, root or nobody).
 *
 * chromium-touch reads the display's touches while shown (passively,
 * nothing claimed: knowledge/central-screen.md) and says them as events;
 * server.js turns those inside the area into the page's touches.
 */
'use strict';

const fs = require('fs');
const { spawn } = require('child_process');
const EventEmitter = require('events');

const CLIENT = process.env.CHROMIUM_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const NAME = 'vizualyse_chromium';
const FILE = process.env.CHROMIUM_VIDEO_FILE || '/dev/shm/mgu-video-' + NAME;
const MAGIC = 0x4656474d, NSLOT = 3, HEADER = 64;
const VIDEO_ID = 1;
const NOBODY = 65534;

function available() { try { return fs.statSync(CLIENT).isFile(); } catch (e) { return false; } }

function frameFile(file, w, h) {
    try { fs.unlinkSync(file); } catch (e) { /* none */ }
    const fd = fs.openSync(file, 'w', 0o644);
    try {
        fs.ftruncateSync(fd, HEADER + NSLOT * w * h * 3 / 2);
        const b = Buffer.alloc(HEADER);
        /* BT.601, full range (chromium-wl's libyuv J420; it sets them too) */
        [MAGIC, 1, w, h, 0, 0, NSLOT, 0, 1].forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
        fs.writeSync(fd, b, 0, HEADER, 0);
        /* chromium-wl writes it as nobody */
        if (process.getuid && process.getuid() === 0) fs.fchownSync(fd, NOBODY, NOBODY);
    } finally {
        fs.closeSync(fd);
    }
}

/* touchPath: chromium-touch. show(): view { x, y, w, h } on the screen;
 * touch: { iface, src } or { file } or null; frame: { w, h } of the pictures
 * when smaller than the view (the resolution setting: mgu-render's VIDEO op
 * fits them to the view, aspect kept, linear filtering); display: what fills
 * the frame file ({ show(file), hide() }: the browser). Events: 'touch'
 * {p, x, y} (screen pixels), 'touch-error', 'ready' (chromium-touch's). */
class Screen extends EventEmitter {
    constructor(log, touchPath) {
        super();
        this.log = log;
        this.touchPath = touchPath;
        this.gpu = null;
        this.touch = null;
        this.view = null;
        this.display = null;
    }

    shown() { return !!this.view; }

    show(view, touch, frame, display) {
        this.hide();
        this.view = view;
        const f = frame || view;
        frameFile(FILE, f.w, f.h);
        this.display = display;
        display.show(FILE);
        if (touch) this._touch(touch);

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

    /* chromium-touch: touches while shown; losing it loses touch, not the picture */
    _touch(touch) {
        const args = touch.iface ? ['--touch-iface', touch.iface, '--touch-src', touch.src] : ['--touch-file', touch.file];
        const t = spawn(this.touchPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
        this.touch = t;
        let rest = '';
        t.stdout.setEncoding('utf8');
        t.stdout.on('data', (d) => {
            rest += d;
            let i;
            while ((i = rest.indexOf('\n')) >= 0) {
                const l = rest.slice(0, i);
                rest = rest.slice(i + 1);
                let e;
                try { e = JSON.parse(l); } catch (x) { this.log('touch: ' + l); continue; }
                /* 'error' would throw without a listener */
                this.emit(e.ev === 'error' ? 'touch-error' : e.ev, e);
            }
        });
        t.stderr.on('data', (d) => this.log('touch: ' + String(d).trim()));
        t.stdin.on('error', () => { /* it exited: 'exit' says so */ });
        t.on('exit', (code, sig) => {
            if (this.touch === t) { this.log('touch: exited (' + (sig || code) + ')'); this.touch = null; }
        });
    }

    _draw() {
        if (!this.gpu || !this.view) return;
        const op = this.videoOp(VIDEO_ID, 0, 0, this.view.w, this.view.h, 0);
        this.gpu.frameWords(op instanceof Uint32Array ? op : Uint32Array.from(op));
    }

    hide() {
        if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
        if (this.gpu) {
            try { this.gpu.show(false); this.gpu.video(VIDEO_ID, null); this.gpu.close(); } catch (e) { /* gone */ }
            this.gpu = null;
        }
        if (this.display) { this.display.hide(); this.display = null; }
        if (this.touch) {
            const t = this.touch;
            this.touch = null;
            try { t.stdin.end(); } catch (e) { /* gone */ }
            setTimeout(() => { try { t.kill('SIGKILL'); } catch (e) { /* gone */ } }, 2000);
        }
        this.view = null;
        try { fs.unlinkSync(FILE); } catch (e) { /* none */ }
    }
}

module.exports = { Screen, available, frameFile, FILE };
