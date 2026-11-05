// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Video on the central display (media console) through mgu-render
 * (robertnisipeanu/mgu-store native/mgu-render, PROTOCOL.md "Video"): the
 * frames go into a shared-memory frame file, /dev/shm/mgu-video-<name> (a
 * 64-byte MGVF header, then 3 slots of I420), and an mgu-render client in
 * layer mode covers the screen in black and draws the file's newest frame
 * over it, fitted and centred (black bars where the shapes differ: a 16:9
 * game on the 8:3 screen has them at the sides). Root, so the renderer's
 * foreground gate does not apply: the picture stays up until stop().
 *
 * This side makes the file (root's, as the renderer wants) and draws; the
 * pictures are written into it by moonlight-core itself, which decodes the
 * stream (core/frame_out.h). The renderer redraws the app's last frame for
 * every new video frame, so nothing here runs per frame: a draw once a
 * second keeps the app shown.
 *
 * The stop hint: a picture drawn once at build time (build/hint.rgba,
 * tools/make_hint.py), an IMAGE at the bottom centre over the video for the
 * first HINT_SECONDS.
 *
 * Also frameFile() / FrameReader: the same file format for the cluster and
 * the HUD, where moonlight-core writes small frames that server.js packs
 * for cluster-render.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* MOONLIGHT_RENDER_CLIENT / MOONLIGHT_VIDEO_FILE: a stand-in renderer for the off-car tests. */
const CLIENT = process.env.MOONLIGHT_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const NAME = 'vizualyse_moonlight';
const FILE = process.env.MOONLIGHT_VIDEO_FILE || '/dev/shm/mgu-video-' + NAME;
const HINT_FILE = path.join(__dirname, 'hint.rgba');
const MAGIC = 0x4656474d, NSLOT = 3, HEADER = 64;
const VIDEO_ID = 1;
const BLACK_ID = 2;   /* a 4x4 black pixmap, stretched over the area: the bars */
const HINT_ID = 3;
const HINT_SECONDS = 10;
const HINT_MARGIN = 40;   /* px above the screen's bottom edge */

function available() { try { return fs.statSync(CLIENT).isFile(); } catch (e) { return false; } }

/* A frame file of w x h, empty (seq 0, BT.601, limited): moonlight-core
 * fills it. Replaces one that is there. */
function frameFile(file, w, h) {
    try { fs.unlinkSync(file); } catch (e) { /* none */ }
    const fd = fs.openSync(file, 'w', 0o644);
    try {
        fs.ftruncateSync(fd, HEADER + NSLOT * w * h * 3 / 2);
        const b = Buffer.alloc(HEADER);
        [MAGIC, 1, w, h, 0, 0, NSLOT, 0, 0].forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
        fs.writeSync(fd, b, 0, HEADER, 0);
    } finally {
        fs.closeSync(fd);
    }
}

/* The newest picture of a frame file, when its seq has moved on. */
class FrameReader {
    constructor(file) {
        this.fd = fs.openSync(file, 'r');
        this.head = Buffer.alloc(HEADER);
        this.seq = 0;
        fs.readSync(this.fd, this.head, 0, HEADER, 0);
        this.w = this.head.readUInt32LE(8);
        this.h = this.head.readUInt32LE(12);
        this.size = this.w * this.h * 3 / 2;
        this.buf = Buffer.alloc(this.size);
    }

    /* The I420 picture (this reader's buffer), or null when none is new. */
    next() {
        if (this.fd === null) return null;
        fs.readSync(this.fd, this.head, 0, 24, 0);
        const seq = this.head.readUInt32LE(16), slot = this.head.readUInt32LE(20) % NSLOT;
        if (seq === this.seq) return null;
        this.seq = seq;
        fs.readSync(this.fd, this.buf, 0, this.size, HEADER + slot * this.size);
        return this.buf;
    }

    close() { if (this.fd !== null) { try { fs.closeSync(this.fd); } catch (e) { /* gone */ } this.fd = null; } }
}

/* The hint picture: { w, h, data } or null. */
function loadHint(log) {
    try {
        const b = fs.readFileSync(HINT_FILE);
        if (b.toString('latin1', 0, 4) !== 'MLHI') throw new Error('not a hint picture');
        const w = b.readUInt32LE(4), h = b.readUInt32LE(8);
        if (b.length < 12 + w * h * 4) throw new Error('short');
        return { w: w, h: h, data: b.slice(12, 12 + w * h * 4) };
    } catch (e) {
        log('console: no stop hint (' + HINT_FILE + ': ' + e.message + ')');
        return null;
    }
}

/* No touch claim (mgu-render CLAIM): the head unit restarted twice as a
 * console stream that had claimed touch was stopped (2026-11-05). The
 * ways out of a full-screen picture are holding the screen (read
 * passively), the controller's quit combo and the phone page's Stop; the
 * hint says so. */

class ConsoleVideo {
    constructor(log) {
        this.log = log;
        this.gpu = null;
        this.box = null;
        this.file = FILE;
    }

    /* A stream of w x h at fps: the frame file, made now; the renderer
     * shows it once it is connected. */
    start(w, h, fps) {
        this.stop();
        this.w = w; this.h = h;
        frameFile(FILE, w, h);
        this.hint = loadHint(this.log);
        this.hintUntil = Date.now() + HINT_SECONDS * 1000;

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
            this.box = { x: 0, y: 0, w: screen.w, h: screen.h };
            const s = Math.min(this.box.w / w, this.box.h / h);
            say('ready: screen ' + screen.w + 'x' + screen.h + ', modes ' + (info ? info.modes.join(',') : '?') + ', video ' + !!(info && info.video) +
                (info && info.appArea ? ', app area ' + info.appArea.w + 'x' + info.appArea.h + '+' + info.appArea.x + '+' + info.appArea.y : '') +
                ', video ' + Math.round(w * s) + 'x' + Math.round(h * s) + ' centred, black around it' + (this.hint ? ', stop hint ' + this.hint.w + 'x' + this.hint.h : ''));
            gpu.mode('layer');
            gpu.place({ x: this.box.x, y: this.box.y, w: this.box.w, h: this.box.h, scale: 1, ox: 0, oy: 0 });
            gpu.pixmap(BLACK_ID, 4, 4, 'rgbx', 'nearest');
            const black = Buffer.alloc(4 * 4 * 4);
            for (let i = 3; i < black.length; i += 4) black[i] = 255;
            gpu.pixels(BLACK_ID, [{ x: 0, y: 0, w: 4, h: 4 }], black);
            if (this.hint) {
                gpu.pixmap(HINT_ID, this.hint.w, this.hint.h, 'rgba', 'nearest');
                gpu.pixels(HINT_ID, [{ x: 0, y: 0, w: this.hint.w, h: this.hint.h }], this.hint.data);
            }
            gpu.video(VIDEO_ID, FILE);
            if (fps) gpu.fps(fps);
            gpu.show(true);
            this._draw();
        });
        gpu.on('renderer-error', (e) => say('renderer error: ' + e));
        gpu.on('state', (st) => say('state: ' + st.mode + (st.onScreen ? ', on screen' : ', off screen') + (st.front ? ', in front' : '')));
        gpu.connect();
        /* The renderer hides an app silent for 3 s: draw at least once a second
         * (that also takes the hint away after its time). */
        this.keepAlive = setInterval(() => this._draw(), 1000);
    }

    /* [bars][video][hint while it is due]: the renderer paints them in order. */
    _draw() {
        if (!this.gpu || !this.box) return;
        const ops = [this.imageOp(BLACK_ID, 0, 0, this.box.w, this.box.h, 0), this.videoOp(VIDEO_ID, 0, 0, this.box.w, this.box.h, 0)];
        if (this.hint && Date.now() < this.hintUntil) {
            const x = Math.round((this.box.w - this.hint.w) / 2), y = this.box.h - this.hint.h - HINT_MARGIN;
            ops.push(this.imageOp(HINT_ID, x, y, this.hint.w, this.hint.h, 0));
        }
        const words = new Uint32Array(ops.reduce((n, o) => n + o.length, 0));
        let at = 0;
        ops.forEach((o) => { words.set(o, at); at += o.length; });
        this.gpu.frameWords(words);
    }

    /* Whether the hint is still drawn (for the tests and the status). */
    hintShown() { return !!(this.hint && this.gpu && Date.now() < this.hintUntil); }

    stop() {
        if (this.keepAlive) { clearInterval(this.keepAlive); this.keepAlive = null; }
        if (this.gpu) {
            try { this.gpu.show(false); this.gpu.video(VIDEO_ID, null); this.gpu.close(); } catch (e) { /* gone */ }
            this.gpu = null;
        }
        this.box = null;
        try { fs.unlinkSync(FILE); } catch (e) { /* none */ }
    }
}

module.exports = { ConsoleVideo, FrameReader, frameFile, available, FILE };
