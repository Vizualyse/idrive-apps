// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Video on the central display (media console) through mgu-render
 * (robertnisipeanu/mgu-store native/mgu-render, PROTOCOL.md "Video"): the
 * frames go into a shared-memory frame file, /dev/shm/mgu-video-<name> (a
 * 64-byte MGVF header, then 3 slots of I420), and an mgu-render client in
 * layer mode draws the file's newest frame in the screen's app area,
 * letterboxed. Root, so the renderer's foreground gate does not apply: the
 * picture stays up until stop().
 */
'use strict';

const fs = require('fs');

const CLIENT = '/var/opt/mgu-render/current/mgu_render_client.js';
const NAME = 'vizualyse_cast';
const FILE = '/dev/shm/mgu-video-' + NAME;
const MAGIC = 0x4656474d, NSLOT = 3, HEADER = 64;
const VIDEO_ID = 1;

function available() { try { return fs.statSync(CLIENT).isFile(); } catch (e) { return false; } }

class ConsoleVideo {
    constructor(log) {
        this.log = log;
        this.fd = null;
        this.gpu = null;
        this.box = null;
        this.seq = 0;
        this.slot = 0;
    }

    /* Frames of w x h I420 at fps. */
    start(w, h, fps) {
        this.stop();
        this.w = w; this.h = h; this.frameSize = w * h * 3 / 2;
        try { fs.unlinkSync(FILE); } catch (e) { /* none */ }
        this.fd = fs.openSync(FILE, 'w', 0o644);
        fs.ftruncateSync(this.fd, HEADER + NSLOT * this.frameSize);
        this.seq = 0; this.slot = 0;
        this._header();

        const { RenderClient, videoOp } = require(CLIENT);
        this.videoOp = videoOp;
        const say = (s) => this.log('console: ' + s);
        const gpu = new RenderClient(NAME, { info: say, warn: say, error: say }, { mode: 'layer' });
        this.gpu = gpu;
        gpu.on('ready', (screen, info) => {
            const area = info && info.appArea && info.appArea.w ? info.appArea : { x: 0, y: 0, w: screen.w, h: screen.h };
            const s = Math.min(area.w / w, area.h / h), bw = Math.round(w * s / 2) * 2, bh = Math.round(h * s / 2) * 2;
            this.box = { x: area.x + Math.round((area.w - bw) / 2), y: area.y + Math.round((area.h - bh) / 2), w: bw, h: bh };
            say('ready: modes ' + (info ? info.modes.join(',') : '?') + ', video ' + !!(info && info.video) +
                ', app area ' + area.w + 'x' + area.h + '+' + area.x + '+' + area.y + ', video at ' +
                this.box.w + 'x' + this.box.h + '+' + this.box.x + '+' + this.box.y);
            gpu.mode('layer');
            gpu.place({ x: this.box.x, y: this.box.y, w: this.box.w, h: this.box.h, scale: 1, ox: 0, oy: 0 });
            gpu.video(VIDEO_ID, FILE);
            if (fps) gpu.fps(fps);
            gpu.show(true);
            this._draw();
        });
        gpu.on('renderer-error', (e) => say('renderer error: ' + e));
        gpu.on('state', (st) => say('state: ' + st.mode + (st.onScreen ? ', on screen' : ', off screen') + (st.front ? ', in front' : '')));
        gpu.connect();
        /* The renderer hides an app silent for 3 s: draw at least once a second. */
        this.keepAlive = setInterval(() => this._draw(), 1000);
    }

    _header() {
        const b = Buffer.alloc(HEADER);
        [MAGIC, 1, this.w, this.h, this.seq, this.slot, NSLOT, 0 /* BT.601 */, 0 /* limited */]
            .forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
        fs.writeSync(this.fd, b, 0, HEADER, 0);
    }

    _draw() {
        if (this.gpu && this.box) this.gpu.frameWords(this.videoOp(VIDEO_ID, 0, 0, this.box.w, this.box.h, 0));
    }

    /* One I420 frame: fill the next slot, then publish slot, then seq. */
    frame(i420) {
        if (this.fd === null || i420.length < this.frameSize) return;
        const next = (this.slot + 1) % NSLOT;
        fs.writeSync(this.fd, i420, 0, this.frameSize, HEADER + next * this.frameSize);
        const w = Buffer.alloc(4);
        this.slot = next;
        w.writeUInt32LE(next, 0); fs.writeSync(this.fd, w, 0, 4, 20);
        this.seq++;
        w.writeUInt32LE(this.seq >>> 0, 0); fs.writeSync(this.fd, w, 0, 4, 16);
        this._draw();
    }

    stop() {
        if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
        if (this.gpu) {
            try { this.gpu.show(false); this.gpu.video(VIDEO_ID, null); this.gpu.close(); } catch (e) { /* gone */ }
            this.gpu = null;
        }
        this.box = null;
        if (this.fd !== null) {
            try { fs.closeSync(this.fd); } catch (e) { /* gone */ }
            this.fd = null;
            try { fs.unlinkSync(FILE); } catch (e) { /* gone */ }
        }
    }
}

module.exports = { ConsoleVideo, available };
