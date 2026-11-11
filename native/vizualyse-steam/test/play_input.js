// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Seeing and steering a game on the play bench (test/run_play.sh runs this
 * inside its container; Node 8, the unit's):
 *
 *   node play_input.js shot              the newest picture of the frame file, as a PNG on stdout
 *   node play_input.js tap X Y [MS]      a tap at X,Y of the picture (the game's own pixels), held MS (60)
 *   node play_input.js drag X1 Y1 X2 Y2 [MS]   a drag over MS (400)
 *   node play_input.js pad BUTTONS [MS]  a controller's buttons (XInput's bits, 0x1000 = A) held MS (120)
 *   node play_input.js stick LX LY [MS]  its left stick (-32768..32767, up positive) held MS (1000), then centred
 *
 * Touches go the tool's own way: the display's touch PDUs as steam-touch
 * reads them (its --touch-file replay, STEAM_TOUCH_FILE: the unit test's),
 * so server.js maps them from the screen onto the picture and times the tap;
 * the game must be shown (run_play.sh api /api/show). The controller is the
 * pads file our xinput1_4.dll reads (src/vzs_pads.h), slot 0.
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');

const FRAME = '/dev/shm/mgu-video-vizualyse_steam';
const TOUCH = '/dev/shm/touch.txt';
const PADS = '/dev/shm/vizualyse-steam/pads';
const VIEW = { x: 108, y: 82, w: 1790, h: 638 };   /* the app area (server.js VIEW) */

function frame() {
    const f = fs.readFileSync(FRAME);
    const w = f.readUInt32LE(8), h = f.readUInt32LE(12), slot = f.readUInt32LE(20), full = f.readUInt32LE(32);
    return { f: f, w: w, h: h, at: 64 + slot * (w * h * 3 / 2), full: full };
}

function crc32(buf) {
    let c, crc = 0xffffffff;
    if (!crc32.t) { crc32.t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc32.t[n] = c >>> 0; } }
    for (let i = 0; i < buf.length; i++) crc = crc32.t[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4), t = Buffer.from(type, 'ascii'), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
    return Buffer.concat([len, t, data, crc]);
}

/* I420 (BT.601, limited range unless the header says full) to an RGB PNG */
function shot() {
    const fr = frame(), w = fr.w, h = fr.h, f = fr.f;
    const Y = fr.at, U = Y + w * h, V = U + (w / 2) * (h / 2);
    const raw = Buffer.alloc((w * 3 + 1) * h);
    const c8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let y = 0; y < h; y++) {
        let o = y * (w * 3 + 1);
        raw[o++] = 0;
        for (let x = 0; x < w; x++) {
            const cy = f[Y + y * w + x], cu = f[U + (y >> 1) * (w / 2) + (x >> 1)] - 128, cv = f[V + (y >> 1) * (w / 2) + (x >> 1)] - 128;
            const l = fr.full ? cy : 1.164 * (cy - 16);
            const k = fr.full ? [1.402, 0.344, 0.714, 1.772] : [1.596, 0.392, 0.813, 2.017];
            raw[o++] = c8(Math.round(l + k[0] * cv));
            raw[o++] = c8(Math.round(l - k[1] * cu - k[2] * cv));
            raw[o++] = c8(Math.round(l + k[3] * cu));
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    process.stdout.write(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]));
}

/* the display's touch PDU (as test/unit_test.js makes it): ev 1 down, 2 move, 3 up */
function pdu(sx, sy, ev) {
    const b = Buffer.alloc(112);
    b.writeUInt32BE(0xB0048002, 0); b.writeUInt32BE(96, 4);
    b[28] = 0x80; b[53] = 1; b.writeUInt16BE(sx, 54); b.writeUInt16BE(sy, 60); b[62] = 50; b[63] = ev << 4;
    return b.toString('hex');
}
/* the picture's X,Y on the screen (mgu-render fits the picture into VIEW, aspect kept, centred) */
function screen(px, py) {
    const fr = frame(), s = Math.min(VIEW.w / fr.w, VIEW.h / fr.h);
    return [Math.round(VIEW.x + (VIEW.w - fr.w * s) / 2 + px * s), Math.round(VIEW.y + (VIEW.h - fr.h * s) / 2 + py * s)];
}
/* steam-touch replays the file as soon as it finds it, then again and again:
 * it has dropped to nobody and can't remove a file of root's. So the replay
 * is made to last (a second "up" 700 ms after the last touch, which
 * steam-touch ignores) and the file is taken away while it still reads it. */
function touches(list) {   /* [ms, x, y, ev] in the picture's pixels */
    const last = list[list.length - 1];
    list = list.concat([[last[0] + 700, last[1], last[2], 3]]);
    const lines = list.map((t) => { const p = screen(t[1], t[2]); return (300 + t[0]) + ' 160.48.199.115 112 ' + pdu(p[0], p[1], t[3]); });
    fs.writeFileSync(TOUCH + '.tmp', lines.join('\n') + '\n');
    fs.chmodSync(TOUCH + '.tmp', 0o644);
    fs.renameSync(TOUCH + '.tmp', TOUCH);
    setTimeout(() => { try { fs.unlinkSync(TOUCH); } catch (e) { /* gone */ } }, 350);
}

function padWrite(buttons, lx, ly) {
    let b;
    try { b = fs.readFileSync(PADS); } catch (e) { b = Buffer.alloc(0); }
    if (b.length !== 144) { b = Buffer.alloc(144); b.writeUInt32LE(0x31505a56, 0); b.writeUInt32LE(1, 4); b.writeUInt32LE(4, 8); }
    const o = 16;
    b.writeUInt32LE((b.readUInt32LE(o) + 1) >>> 0, o);   /* packet */
    b.writeUInt32LE(1, o + 4);                            /* connected */
    b.writeUInt16LE(buttons & 0xffff, o + 8);
    b.writeInt16LE(lx, o + 12); b.writeInt16LE(ly, o + 14);
    const fd = fs.openSync(PADS, fs.existsSync(PADS) ? 'r+' : 'w+');
    fs.writeSync(fd, b, 0, 144, 0);
    fs.closeSync(fd);
}

const a = process.argv.slice(2), n = (i, d) => (a[i] !== undefined ? Number(a[i]) : d);
if (a[0] === 'shot') shot();
else if (a[0] === 'clear') { try { fs.unlinkSync(TOUCH); } catch (e) { /* none */ } }
else if (a[0] === 'tap') touches([[0, n(1), n(2), 1], [n(3, 60), n(1), n(2), 3]]);
else if (a[0] === 'drag') {
    const ms = n(5, 400), steps = 12, list = [[0, n(1), n(2), 1]];
    for (let i = 1; i <= steps; i++) list.push([Math.round(ms * i / steps), n(1) + (n(3) - n(1)) * i / steps, n(2) + (n(4) - n(2)) * i / steps, 2]);
    list.push([ms + 40, n(3), n(4), 3]);
    touches(list);
} else if (a[0] === 'pad') { padWrite(n(1), 0, 0); setTimeout(() => padWrite(0, 0, 0), n(2, 120)); }
else if (a[0] === 'stick') { padWrite(0, n(1), n(2)); setTimeout(() => padWrite(0, 0, 0), n(3, 1000)); }
else { console.error('usage: play_input.js shot | tap X Y [MS] | drag X1 Y1 X2 Y2 [MS] | pad BUTTONS [MS] | stick LX LY [MS]'); process.exit(2); }
