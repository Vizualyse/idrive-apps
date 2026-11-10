// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The game on the central display through mgu-render (as vizualyse-chromium's
 * screen.js): the frame file /dev/shm/mgu-video-vizualyse_steam (64-byte MGVF
 * header, 3 I420 slots, root's as the renderer wants), which wl-sink fills
 * with the game's pictures, and an mgu-render client in layer mode that shows
 * it in the app area (1790x638 at +108+82 of 1920x720 on the car), so the
 * HMI's top bar and left strip stay visible and usable: its back arrow leaves
 * the iDrive page, and the app then hides the game. mgu-render's VIDEO op
 * fits the picture to the area, aspect kept. Root, so the renderer's
 * foreground gate does not apply; the renderer hides layer apps itself while
 * the reversing camera shows. A draw once a second keeps it up.
 *
 * Or through Winston (via 'winston', the experimental output): wl-sink puts
 * the pictures straight onto the centre screen itself, as a client of the
 * unit's compositor (platform native/winston_out), fitted into the same
 * place; mgu-render isn't asked. Winston hides them while the reversing
 * camera shows, as mgu-render does.
 *
 * The frame file exists while a game runs (server.js makes it before
 * wl-sink, removes it after); showing is separate: a game keeps running
 * hidden.
 */
'use strict';

const fs = require('fs');
const EventEmitter = require('events');

const CLIENT = process.env.STEAM_RENDER_CLIENT || '/var/opt/mgu-render/current/mgu_render_client.js';
const NAME = 'vizualyse_steam';
const FILE = process.env.STEAM_VIDEO_FILE || '/dev/shm/mgu-video-' + NAME;
const MAGIC = 0x4656474d, NSLOT = 3, HEADER = 64;
const VIDEO_ID = 1;

function available() { try { return fs.statSync(CLIENT).isFile(); } catch (e) { return false; } }

/* A fresh frame file, w x h (even), black: Y 0 and U / V 128 (a zeroed file
 * would show green until the game's first picture). */
function frameFile(w, h) {
    try { fs.unlinkSync(FILE); } catch (e) { /* none */ }
    const fd = fs.openSync(FILE, 'w', 0o644);
    try {
        const slot = w * h * 3 / 2;
        fs.ftruncateSync(fd, HEADER + NSLOT * slot);
        const b = Buffer.alloc(HEADER);
        [MAGIC, 1, w, h, 0, 0, NSLOT, 0, 1].forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
        fs.writeSync(fd, b, 0, HEADER, 0);
        const uv = Buffer.alloc(w * h / 2, 128);
        for (let s = 0; s < NSLOT; s++) fs.writeSync(fd, uv, 0, uv.length, HEADER + s * slot + w * h);
    } finally {
        fs.closeSync(fd);
    }
    return FILE;
}

function removeFrameFile() { try { fs.unlinkSync(FILE); } catch (e) { /* none */ } }

/* A message on the screen, white on black, while no game picture is there
 * (calibrating the pointer: the game restarting). Drawn into the frame
 * file's next slot and published as wl-sink publishes (slot, then seq): the
 * game's first picture replaces it. A 5x7 pixel font, capitals only, so
 * nothing to ship or load. */
const FONT = {
    A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110',
    C: '01110100011000010000100001000101110', E: '11111100001000011110100001000011111',
    G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001',
    I: '01110001000010000100001000010001110', L: '10000100001000010000100001000011111',
    M: '10001110111010110101100011000110001', N: '10001110011010110011100011000110001',
    O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
    R: '11110100011000111110101001001010001', S: '01111100001000001110000010000111110',
    T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
    Y: '10001100010101000100001000010000100', '.': '00000000000000000000000000110001100',
    ' ': '00000000000000000000000000000000000'
};
function message(lines) {
    let fd;
    try { fd = fs.openSync(FILE, 'r+'); } catch (e) { return false; }
    try {
        const hdr = Buffer.alloc(HEADER);
        fs.readSync(fd, hdr, 0, HEADER, 0);
        if (hdr.readUInt32LE(0) !== MAGIC) return false;
        const w = hdr.readUInt32LE(8), h = hdr.readUInt32LE(12), seq = hdr.readUInt32LE(16);
        const nslot = hdr.readUInt32LE(24) || NSLOT, slot = hdr.readUInt32LE(20) % nslot;
        const frame = Buffer.alloc(w * h * 3 / 2, 128);
        frame.fill(0, 0, w * h);
        const cols = Math.max.apply(null, lines.map((l) => l.length)) * 6 - 1, rows = lines.length * 9 - 2;
        const s = Math.max(1, Math.floor(Math.min(w * 0.8 / cols, h * 0.4 / rows)));
        const top = Math.floor((h - rows * s) / 2);
        lines.forEach((line, li) => {
            const left = Math.floor((w - (line.length * 6 - 1) * s) / 2);
            line.split('').forEach((ch, ci) => {
                const g = FONT[ch] || FONT[' '];
                for (let r = 0; r < 7; r++) {
                    for (let c = 0; c < 5; c++) {
                        if (g[r * 5 + c] !== '1') continue;
                        const x0 = left + (ci * 6 + c) * s, y0 = top + (li * 9 + r) * s;
                        for (let y = y0; y < y0 + s && y < h; y++) frame.fill(235, y * w + x0, y * w + Math.min(x0 + s, w));
                    }
                }
            });
        });
        const next = (slot + 1) % nslot;
        fs.writeSync(fd, frame, 0, frame.length, HEADER + next * frame.length);
        const words = Buffer.alloc(8);
        words.writeUInt32LE(next, 0);
        fs.writeSync(fd, words, 0, 4, 20);                      /* the slot, then the sequence */
        words.writeUInt32LE((seq + 1) >>> 0, 4);
        fs.writeSync(fd, words, 4, 4, 16);
        return true;
    } catch (e) {
        return false;
    } finally {
        fs.closeSync(fd);
    }
}

/* Events: 'state' (the renderer's), 'error'-free (renderer errors are logged). */
class Screen extends EventEmitter {
    constructor(log) {
        super();
        this.log = log;
        this.gpu = null;
        this.view = null;
        this.via = null;
        this.game = null;
    }

    shown() { return !!this.gpu || this.via === 'winston'; }

    /* view: { x, y, w, h } on the screen; via 'winston' (game: the Game, its
     * wl-sink connected to Winston) or 'mgu-render' (the default) */
    show(view, via, game) {
        this.hide();
        if (via === 'winston') {
            if (!fs.existsSync(FILE)) return 'no game is running';
            this.view = view;
            this.via = 'winston';
            this.game = game;
            game.showWinston(view);
            this.log('screen: through Winston, game ' + view.w + 'x' + view.h + '+' + view.x + '+' + view.y);
            return null;
        }
        if (!available()) { this.log('screen: no mgu-render client at ' + CLIENT); return 'mgu-render is not installed'; }
        if (!fs.existsSync(FILE)) return 'no game is running';
        this.view = view;
        const { RenderClient, videoOp } = require(CLIENT);
        this.videoOp = videoOp;
        const say = (s) => this.log('screen: ' + s);
        const gpu = new RenderClient(NAME, { info: say, warn: say, error: say }, { mode: 'layer' });
        this.gpu = gpu;
        this.via = 'mgu-render';
        gpu.on('ready', (screenInfo, info) => {
            const a = info && info.appArea;
            say('ready: screen ' + screenInfo.w + 'x' + screenInfo.h + (a ? ', app area ' + a.w + 'x' + a.h + '+' + a.x + '+' + a.y : '') +
                ', game ' + view.w + 'x' + view.h + '+' + view.x + '+' + view.y);
            gpu.mode('layer');
            gpu.place({ x: view.x, y: view.y, w: view.w, h: view.h, scale: 1, ox: 0, oy: 0 });
            gpu.video(VIDEO_ID, FILE);
            gpu.fps(0);
            gpu.show(true);
            this._draw();
        });
        gpu.on('renderer-error', (e) => say('renderer error: ' + e));
        gpu.on('state', (st) => { say('state: ' + st.mode + (st.onScreen ? ', on screen' : ', off screen')); this.emit('state', st); });
        gpu.connect();
        this.keepAlive = setInterval(() => this._draw(), 1000);
        return null;
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
        if (this.via === 'winston' && this.game) this.game.hideWinston();
        this.game = null;
        this.via = null;
        this.view = null;
    }
}

module.exports = { Screen, available, frameFile, removeFrameFile, message, FILE };
