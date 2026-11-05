// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Video on the central display (media console) through mgu-render
 * (robertnisipeanu/mgu-store native/mgu-render, PROTOCOL.md "Video"): the
 * frames go into a shared-memory frame file, /dev/shm/mgu-video-<name> (a
 * 64-byte MGVF header, then 3 slots of I420), and an mgu-render client in
 * layer mode covers the screen's app area in black and draws the file's
 * newest frame over it, fitted and centred (black bars where the shapes
 * differ: a 16:9 game on the 8:3 screen has them at the sides). Root, so the renderer's foreground gate does not apply: the
 * picture stays up until stop().
 */
'use strict';

const fs = require('fs');

/* MOONLIGHT_RENDER_CLIENT / MOONLIGHT_VIDEO_FILE: a stand-in renderer for the off-car tests. */
const CLIENT = process.env.MOONLIGHT_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const NAME = 'vizualyse_moonlight';
const FILE = process.env.MOONLIGHT_VIDEO_FILE || '/dev/shm/mgu-video-' + NAME;
const MAGIC = 0x4656474d, NSLOT = 3, HEADER = 64;
const VIDEO_ID = 1;
const BLACK_ID = 2;   /* a 4x4 black pixmap, stretched over the area: the bars */

function available() { try { return fs.statSync(CLIENT).isFile(); } catch (e) { return false; } }

/* No touch claim (mgu-render CLAIM): the head unit restarted twice as a
 * console stream that had claimed touch was stopped (2026-11-05). The
 * ways out of a full-screen picture are the controller's quit combo and the
 * phone page's Stop; the burnt-in hint says so. */

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

        const { RenderClient, videoOp, imageOp } = require(CLIENT);
        this.videoOp = videoOp;
        this.imageOp = imageOp;
        const say = (s) => this.log('console: ' + s);
        const gpu = new RenderClient(NAME, { info: say, warn: say, error: say }, { mode: 'layer' });
        this.gpu = gpu;
        gpu.on('ready', (screen, info) => {
            /* The whole screen, not the app area: that leaves out the HMI's top
             * bar and left strip (on the car: 1790x638+108+82 of 1920x720), and
             * the picture should fill the screen's height with black bars at
             * the sides. The video is fitted into it by the VIDEO op. */
            const area = { x: 0, y: 0, w: screen.w, h: screen.h };
            this.box = { x: area.x, y: area.y, w: area.w, h: area.h };
            const s = Math.min(area.w / w, area.h / h);
            this.picture = { w: Math.round(w * s), h: Math.round(h * s) };
            say('ready: screen ' + screen.w + 'x' + screen.h + ', modes ' + (info ? info.modes.join(',') : '?') + ', video ' + !!(info && info.video) +
                ', touch ' + !!(info && info.touch) + (info && info.appArea ? ', app area ' + info.appArea.w + 'x' + info.appArea.h + '+' + info.appArea.x + '+' + info.appArea.y : '') + ', placed ' + area.w + 'x' + area.h +
                (info && info.embedBox ? ', embed box ' + info.embedBox.w + 'x' + info.embedBox.h + '+' + info.embedBox.x + '+' + info.embedBox.y : '') +
                ', video ' + this.picture.w + 'x' + this.picture.h + ' centred, black around it');
            gpu.mode('layer');
            gpu.place({ x: this.box.x, y: this.box.y, w: this.box.w, h: this.box.h, scale: 1, ox: 0, oy: 0 });
            gpu.pixmap(BLACK_ID, 4, 4, 'rgbx', 'nearest');
            const black = Buffer.alloc(4 * 4 * 4);
            for (let i = 3; i < black.length; i += 4) black[i] = 255;
            gpu.pixels(BLACK_ID, [{ x: 0, y: 0, w: 4, h: 4 }], black);
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
        if (!this.gpu || !this.box) return;
        const bars = this.imageOp(BLACK_ID, 0, 0, this.box.w, this.box.h, 0), pic = this.videoOp(VIDEO_ID, 0, 0, this.box.w, this.box.h, 0);
        const ops = new Uint32Array(bars.length + pic.length);
        ops.set(bars, 0); ops.set(pic, bars.length);
        this.gpu.frameWords(ops);
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
