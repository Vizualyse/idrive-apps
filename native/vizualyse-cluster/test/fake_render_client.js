// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* A stand-in for mgu-render's client (mgu_render_client.js) in the picker's
 * off-car test: it says ready with the car's screen and app area
 * (2026-11-05), and writes what it is asked to do to CLUSTER_TEST_RENDER_LOG,
 * one JSON object a line; the newest whole picture of each pixmap goes to
 * <log>.<id>.rgba. */
'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const LOG = process.env.CLUSTER_TEST_RENDER_LOG;
function note(o) { if (LOG) fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); }

class RenderClient extends EventEmitter {
    constructor(name) { super(); this.name = name; this.pm = {}; note({ op: 'new', name: name }); }
    connect() {
        setTimeout(() => this.emit('ready', { w: 1920, h: 720 }, { modes: ['layer'], video: true, pixmap: true,
            appArea: { x: 108, y: 82, w: 1790, h: 638 }, embedBox: { x: 104, y: 88, w: 1796, h: 632 } }), 50);
    }
    mode(m) { note({ op: 'mode', mode: m }); }
    place(p) { note({ op: 'place', x: p.x, y: p.y, w: p.w, h: p.h }); }
    show(on) { note({ op: 'show', on: on }); }
    pixmap(id, w, h, format, filter) { this.pm[id] = { w: w, h: h }; note({ op: 'pixmap', id: id, w: w, h: h, format: format, filter: filter }); }
    pixels(id, rects, data) {
        const pm = this.pm[id];
        if (!pm) throw new Error('pixels: no pixmap ' + id);
        if (data.length !== pm.w * pm.h * 4) throw new Error('pixels: the picture is ' + data.length + ' bytes, the pixmap ' + pm.w + 'x' + pm.h);
        rects.forEach((r) => { if (r.x < 0 || r.y < 0 || r.x + r.w > pm.w || r.y + r.h > pm.h) throw new Error('pixels: rect outside the pixmap'); });
        if (LOG) fs.writeFileSync(LOG + '.' + id + '.rgba', data);
        note({ op: 'pixels', id: id, n: rects.length, area: rects.reduce((a, r) => a + r.w * r.h, 0) });
    }
    frameWords(u32) { note({ op: 'frame', words: Array.from(u32).slice(0, 7) }); }
    close() { note({ op: 'close' }); }
}
function imageOp(id, x, y, w, h, r) { const u = new Uint32Array(7); u[0] = 18; u[1] = x; u[2] = y; u[3] = w; u[4] = h; u[5] = r || 0; u[6] = id; return u; }
module.exports = { RenderClient, imageOp };
