// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* A stand-in for mgu-render's client (mgu_render_client.js) in the off-car
 * tests: it says ready with a 1920x720 screen and an app area, and counts
 * what it is asked to draw in MOONLIGHT_TEST_RENDER_LOG. */
'use strict';
const EventEmitter = require('events');
const fs = require('fs');
const LOG = process.env.MOONLIGHT_TEST_RENDER_LOG;
function note(s) { if (LOG) fs.appendFileSync(LOG, s + '\n'); }
class RenderClient extends EventEmitter {
    constructor(name) { super(); this.name = name; note('new ' + name); }
    connect() { setTimeout(() => this.emit('ready', { w: 1920, h: 720 }, { modes: ['layer'], video: true, appArea: { x: 0, y: 0, w: 1920, h: 720 } }), 50); }
    mode(m) { note('mode ' + m); }
    place(p) { note('place ' + p.w + 'x' + p.h + '+' + p.x + '+' + p.y); }
    video(id, file) { note('video ' + id + ' ' + file); }
    fps(f) { note('fps ' + f); }
    show(on) { note('show ' + on); }
    frameWords() { this.draws = (this.draws || 0) + 1; }
    close() { note('close'); }
}
module.exports = { RenderClient, videoOp: (id, x, y, w, h) => [id, x, y, w, h] };
