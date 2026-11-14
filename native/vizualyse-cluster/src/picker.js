// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The theme picker on the central screen: a preview of every theme, chosen
 * by touch, while the iDrive app's screen state is open under it (the app
 * asks: {"cmd":"picker","on":true}). The look is picker_view.js's.
 *
 * - The picture: one opaque pixmap the size of mgu-render's app area,
 *   drawn here (ui_draw.js) from the previews and fonts tools/picker_build.js
 *   made off the car (picker.*), in layer mode. Only the regions that
 *   changed are sent again; an IMAGE op at least once a second keeps the
 *   app shown (three silent seconds and mgu-render hides it).
 * - Touch: read passively (touch_reader.py, mgu-python, an AF_PACKET copy of
 *   the display's PDUs on vlan73), never claimed: a claim through mgu-render
 *   restarted the head unit (knowledge/central-screen.md). The HMI gets every
 *   touch too; the app's screen state under the picture has nothing to press.
 *   A tap is a down and an up on the same target within SLOP px; a swipe
 *   across the large preview goes to the next or previous family.
 * - It only shows: choosing a theme, Sport or Comfort, trying one and
 *   turning themes off are the tool's (the actions server.js hands in).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const EventEmitter = require('events');
const { spawn } = require('child_process');
const { readPng } = require('./png.js');
const { Canvas } = require('./ui_draw.js');
const view = require('./picker_view.js');

const NAME = 'vizualyse_cluster';
const PIXMAP = 1;
const DEFAULT_AREA = { x: 108, y: 82, w: view.AREA.w, h: view.AREA.h };
const SLOP = 24;
const SWIPE = 80;
const ERROR_MS = 6000;
const HEROES_KEPT = 4;
const BAND = 32;

/* ---- the previews and fonts ---- */
function loadAssets(dir) {
    const read = (n) => fs.readFileSync(path.join(dir, n));
    const meta = JSON.parse(read('picker.fonts.json'));
    const fonts = {};
    Object.keys(meta).forEach((k) => {
        const f = meta[k], index = {};
        f.glyphs.split('').forEach((c, i) => { index[c] = i; });
        fonts[k] = { w: f.w, h: f.h, top: f.top, cell: f.cell, lineH: f.lineH, adv: f.adv, index: index, r8: zlib.gunzipSync(read(f.file)) };
    });
    const thumbs = {}, heroes = [];
    const png = (n) => { try { return readPng(read(n)); } catch (e) { return null; } };
    return {
        fonts: fonts,
        thumb: (id) => {
            if (!id) return null;
            if (!(id in thumbs)) thumbs[id] = png('picker.' + id + '.thumb.png');
            return thumbs[id];
        },
        hero: (id) => {
            if (!id) return null;
            const have = heroes.filter((h) => h.id === id)[0];
            if (have) return have.img;
            const img = png('picker.' + id + '.png');
            heroes.unshift({ id: id, img: img });
            if (heroes.length > HEROES_KEPT) heroes.pop();
            return img;
        },
    };
}

/* the families in the order of THEMES (picker_view's tiles), each with its
 * Sport and Comfort theme ids */
function families(themes) {
    const order = [], by = {};
    themes.slice().sort((a, b) => (a.family < b.family ? -1 : a.family > b.family ? 1 : 0)).forEach((t) => {
        if (!by[t.family]) { by[t.family] = { family: t.family, title: null, sport: null, comfort: null }; order.push(by[t.family]); }
        const f = by[t.family];
        f[t.mode === 'comfort' ? 'comfort' : 'sport'] = t.id;
        if (!f.title || t.mode !== 'comfort') f.title = t.title;
    });
    return order;
}

/* changed regions between two pictures of the same size: per band of rows,
 * the span of columns that differ */
function dirty(a, b, w, h) {
    const rects = [];
    for (let y0 = 0; y0 < h; y0 += BAND) {
        const y1 = Math.min(h, y0 + BAND);
        let x0 = w, x1 = -1;
        for (let y = y0; y < y1; y++) {
            const row = y * w * 4;
            if (a.compare(b, row, row + w * 4, row, row + w * 4) === 0) continue;
            for (let x = 0; x < w; x++) {
                const i = row + x * 4;
                if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
            }
        }
        if (x1 >= 0) rects.push({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 });
    }
    return rects;
}

class Picker extends EventEmitter {
    /* opts: dir (the kit), log, state() (the tool's side of the model:
     * themes, enabled, theme, mode, trying, canTry, line, lineWarn),
     * actions { use(family), try(id), mode(m), off() } (each returns an
     * error string or null), clientPath (mgu-render's client), touch
     * { python, iface, src, file } */
    constructor(opts) {
        super();
        this.o = opts;
        this.log = opts.log || console.log;
        this.assets = null;
        this.gpu = null;
        this.area = null;
        this.cv = null;
        this.sent = null;
        this.keepAlive = null;
        this.touch = null;
        this.sel = -1;
        this.look = null;
        this.pressed = null;
        this.gesture = null;
        this.error = null;
    }

    shown() { return !!this.gpu; }

    model() {
        const s = this.o.state(), fams = families(s.themes || []);
        if (this.sel < 0 || this.sel >= fams.length) {
            /* first show: the family in use, as the cluster shows it */
            this.sel = Math.max(0, fams.map((f) => f.family).indexOf(s.theme));
            this.look = s.look || 'sport';
        }
        const err = this.error && Date.now() - this.error.at < ERROR_MS ? this.error.text : null;
        return { families: fams, sel: this.sel, look: this.look, enabled: s.enabled, inUse: s.theme, mode: s.mode,
            trying: s.trying, canTry: s.canTry, line: err ? 'Error: ' + err : s.line, lineWarn: !!err || !!s.lineWarn, pressed: this.pressed };
    }

    show() {
        if (this.gpu) return null;
        let client;
        try {
            if (!this.assets) this.assets = loadAssets(this.o.dir);
            client = require(this.o.clientPath);
        } catch (e) { return 'the picker cannot start: ' + e.message; }
        const say = (s) => this.log('picker: ' + s);
        const gpu = new client.RenderClient(NAME, { info: say, warn: say, error: say }, { mode: 'layer' });
        this.gpu = gpu;
        this.imageOp = client.imageOp;
        this.cv = new Canvas(view.AREA.w, view.AREA.h);
        this.sent = null;
        gpu.on('ready', (screen, info) => {
            if (this.gpu !== gpu) return;
            const a = info && info.appArea && info.appArea.w ? info.appArea : DEFAULT_AREA;
            /* the picture is drawn at its own size, placed at the area's corner */
            this.area = { x: a.x, y: a.y, w: view.AREA.w, h: view.AREA.h };
            if (a.w !== view.AREA.w || a.h !== view.AREA.h) say('app area ' + a.w + 'x' + a.h + '+' + a.x + '+' + a.y + ': drawn at ' + view.AREA.w + 'x' + view.AREA.h);
            gpu.mode('layer');
            gpu.place({ x: this.area.x, y: this.area.y, w: this.area.w, h: this.area.h, scale: 1, ox: 0, oy: 0 });
            gpu.pixmap(PIXMAP, view.AREA.w, view.AREA.h, 'rgbx', 'nearest');
            this.sent = null;
            this.refresh();
            gpu.show(true);
            say('shown at ' + this.area.w + 'x' + this.area.h + '+' + this.area.x + '+' + this.area.y);
        });
        gpu.on('renderer-error', (e) => say('renderer error: ' + e));
        gpu.connect();
        this.keepAlive = setInterval(() => this._op(), 1000);
        this._startTouch();
        return null;
    }

    hide(why) {
        if (!this.gpu) return;
        const gpu = this.gpu;
        this.gpu = null;
        clearInterval(this.keepAlive);
        this.keepAlive = null;
        this._stopTouch();
        try { gpu.show(false); gpu.close(); } catch (e) { /* gone */ }
        this.area = null;
        this.sent = null;
        this.pressed = null;
        this.gesture = null;
        this.sel = -1;
        this.log('picker: hidden' + (why ? ' (' + why + ')' : ''));
    }

    /* draw the model; send what changed */
    refresh() {
        if (!this.gpu || !this.area) return;
        view.render(this.cv, this.model(), this.assets);
        const px = this.cv.px;
        const rects = this.sent ? dirty(this.sent, px, view.AREA.w, view.AREA.h) : [{ x: 0, y: 0, w: view.AREA.w, h: view.AREA.h }];
        if (!rects.length) return;
        this.gpu.pixels(PIXMAP, rects, px);
        this.sent = Buffer.from(px);
        this._op();
    }

    _op() { if (this.gpu && this.area) this.gpu.frameWords(this.imageOp(PIXMAP, 0, 0, view.AREA.w, view.AREA.h, 0)); }

    /* ---- touch ---- */
    _startTouch() {
        const t = this.o.touch || {};
        /* t.cmd: a stand-in reader (the tests) */
        const cmd = t.cmd || [t.python, path.join(this.o.dir, 'touch_reader.py')].concat(t.file ? ['--file', t.file] : ['--iface', t.iface, '--src', t.src]);
        if (!t.cmd && (!t.python || !fs.existsSync(t.python))) { this.log('picker: touch: no ' + t.python); return; }
        let p;
        try { p = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { this.log('picker: touch: ' + e.message); return; }
        this.touch = p;
        let rest = '';
        p.stdout.on('data', (d) => {
            const lines = (rest + d).split('\n');
            rest = lines.pop();
            lines.forEach((l) => {
                let e;
                try { e = JSON.parse(l); } catch (x) { return; }
                if (e.ev === 'touch') this.onTouch(e.p, e.x, e.y);
                else if (e.ev === 'ready') this.log('picker: touch ready (' + (e.touch ? 'reading' : 'no touch') + ')');
                else if (e.ev === 'error') this.log('picker: touch: ' + e.error);
            });
        });
        p.stderr.on('data', (d) => this.log('picker: touch: ' + String(d).trim().slice(0, 300)));
        p.stdin.on('error', () => { /* it exited */ });
        p.on('error', (e) => this.log('picker: touch: ' + e.message));
        p.on('exit', (code, sig) => { if (this.touch === p) { this.touch = null; this.log('picker: touch exited (' + (sig || code) + ')'); } });
    }

    _stopTouch() {
        if (!this.touch) return;
        const p = this.touch;
        this.touch = null;
        try { p.stdin.end(); } catch (e) { /* gone */ }
        setTimeout(() => { try { p.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1000);
    }

    /* phase 1 down, 2 move, 3 up; x, y screen pixels (-1 when the up was lost) */
    onTouch(phase, sx, sy) {
        if (!this.gpu || !this.area) return;
        const x = sx - this.area.x, y = sy - this.area.y;
        const m = this.model();
        if (phase === 1 || (phase === 2 && !this.gesture)) {
            const id = view.hit(m, x, y);
            const on = id && view.layout(m).filter((r) => r.id === id)[0].on;
            this.gesture = { x: x, y: y, id: id, moved: false };
            this.pressed = on && id !== 'hero' ? id : null;
            this.refresh();
            return;
        }
        const g = this.gesture;
        if (!g) return;
        if (phase === 2) {
            if (!g.moved && (Math.abs(x - g.x) > SLOP || Math.abs(y - g.y) > SLOP)) {
                g.moved = true;
                if (this.pressed) { this.pressed = null; this.refresh(); }
            }
            return;
        }
        /* up */
        this.gesture = null;
        this.pressed = null;
        if (sx < 0) { this.refresh(); return; }
        const inHero = g.x >= view.HERO.x && g.x < view.HERO.x + view.HERO.w && g.y >= view.HERO.y && g.y < view.HERO.y + view.HERO.h;
        if ((g.moved || Math.abs(x - g.x) > SLOP) && inHero && Math.abs(x - g.x) > SWIPE && Math.abs(x - g.x) > Math.abs(y - g.y)) {
            this.act(x < g.x ? 'next' : 'prev');
        } else if (!g.moved && g.id && view.hit(m, x, y) === g.id) {
            this.act(g.id);
        }
        this.refresh();
    }

    /* a target's action (a tap, or the iDrive app's) */
    act(id) {
        const m = this.model(), n = m.families.length, f = m.families[m.sel];
        const r = view.layout(m).filter((t) => t.id === id)[0];
        if (!r || (!r.on && id !== 'hero')) return;
        this.log('picker: ' + id);
        let err = null;
        if (/^tile:/.test(id)) this.sel = Number(id.slice(5));
        else if (id === 'prev') this.sel = (m.sel + n - 1) % n;
        else if (id === 'next') this.sel = (m.sel + 1) % n;
        else if (id === 'look:sport' || id === 'look:comfort') this.look = id.slice(5);
        else if (id === 'use') err = this.o.actions.use(f.family);
        else if (id === 'try') err = this.o.actions.try(m.look === 'comfort' ? f.comfort || f.sport : f.sport || f.comfort);
        else if (/^mode:/.test(id)) err = this.o.actions.mode(id.slice(5));
        else if (id === 'off') err = this.o.actions.off();
        this.error = err ? { text: err, at: Date.now() } : null;
        this.emit('change');
    }
}

module.exports = { Picker, loadAssets, families, dirty };
