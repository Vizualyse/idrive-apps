// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Steam's touch screen on the central screen, in the platform's touch kit
 * (ui_host.js, ui_kit.js: tool/touch_ui), while the iDrive app's screen
 * state is open under it (the app asks: {"cmd":"ui","on":true}). The look
 * is touch_view.js's.
 *
 * One picture at a time: the screen state is shared by the touch screen
 * and the game's picture (screen.js). The game going up hides the touch
 * screen first (gameUp()); the game's picture going (it stops, or is
 * hidden) brings the touch screen back while the app's screen state is
 * still open (gameGone()). Each is its own mgu-render client, never both
 * connected.
 *
 * - Its model comes from the tool's state() once a frame (from memory); the
 *   QR code of the phone page's link is made once a link.
 * - The List corner: 'list' (the server tells the app, which goes back to
 *   its iDrive list, and closes the screen state).
 * - A game's tile opens its start menu (this.open, kept while the touch
 *   screen is hidden: back on it after the game): Play, and its profile
 *   (the tool keeps it in the game's library entry); the back arrow closes
 *   it, and so does the game leaving the library.
 * - A game played here shows by itself once it draws, if the touch screen
 *   is still up (onGame()).
 * - It only shows: Play, Show, Stop, each game's profile and Steam on / off
 *   are the tool's (the actions server.js hands in).
 */
'use strict';
const EventEmitter = require('events');
const { TouchScreen } = require('./ui_host.js');
const { chipW } = require('./ui_kit.js');
const qrcode = require('./qrcode.js');
const view = require('./touch_view.js');

/* mgu-render's client name: the game's is vizualyse_steam (its frame file's) */
const NAME = 'vizualyse_steam_ui';
/* light modules around the QR code (the card is white too) */
const QUIET = 2;

/* the QR code's modules (true: dark), with a light border */
function qrMatrix(text) {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    const n = q.getModuleCount(), out = [];
    for (let r = -QUIET; r < n + QUIET; r++) {
        const row = [];
        for (let c = -QUIET; c < n + QUIET; c++) row.push(r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c));
        out.push(row);
    }
    return out;
}

/* the size of shape `shape` nearest in pixels to the size `id` */
function nearest(resolutions, id, shape) {
    const px = (r) => { const m = /^(\d+)x(\d+)$/.exec(r.id); return m ? Number(m[1]) * Number(m[2]) : 0; };
    const was = resolutions.filter((r) => r.id === id)[0];
    const want = was ? px(was) : 0;
    return resolutions.filter((r) => r.shape === shape).sort((a, b) => Math.abs(px(a) - want) - Math.abs(px(b) - want))[0] || null;
}

class SteamTouch extends EventEmitter {
    /* opts: dir (the kit), clientPath (mgu-render's client), log, touch
     * { python, iface, src, file, cmd }, state() (the tool's side of the
     * model, touch_view.js), gameShown(), actions { show(), stop(),
     * play(appId), game(appId, { resolution, fps, upscale, memMb, detail,
     * vulkan, iris, noDrm, noSteam, reset }) (its profile), enable(on),
     * client(on) } (each returns an error string or null) */
    constructor(opts) {
        super();
        this.o = opts;
        this.log = opts.log || console.log;
        /* the app's screen state is open: the touch screen whenever the game is not up */
        this.wanted = false;
        this.page = 0;
        /* the app id whose start menu is open, or null */
        this.open = null;
        this.autoShow = null;
        this.qr = { text: null, matrix: null };
        this.ui = new TouchScreen({
            name: NAME, dir: opts.dir, clientPath: opts.clientPath, log: this.log, touch: opts.touch,
            state: () => this.model(),
            view: (m, ui) => view.view(m, ui, (t) => chipW(this.ui.F, t)),
            act: (id, value) => this.act(id, value),
        });
        this.ui.on('list', () => {
            this.wanted = false;
            this.autoShow = null;
            this.ui.hide('List');
            this.emit('list');
        });
        this.ui.on('change', () => this.emit('change'));
    }

    shown() { return this.ui.shown(); }

    model() {
        const m = this.o.state();
        const n = view.pages(m);
        if (this.page > n - 1) this.page = n - 1;
        m.page = this.page;
        if (this.open !== null && !(m.library || []).some((g) => g.appId === this.open)) this.open = null;
        m.open = this.open;
        if (m.link !== this.qr.text) {
            this.qr.text = m.link;
            try { this.qr.matrix = m.link ? qrMatrix(m.link) : null; } catch (e) { this.qr.matrix = null; this.log('ui: QR code: ' + e.message); }
        }
        m.qr = this.qr.matrix;
        return m;
    }

    /* the app's screen state open (on) or closed: the touch screen, unless the game is up */
    want(on) {
        if (!on) {
            this.wanted = false;
            this.autoShow = null;
            this.ui.hide('the app hid it');
            return null;
        }
        this.wanted = true;
        if (this.o.gameShown()) return null;
        return this.ui.show();
    }

    /* the game goes up over the screen state: the touch screen goes first */
    gameUp() { if (this.ui.shown()) this.ui.hide('the game is shown'); }

    /* the game's picture went: the touch screen again, if the screen state is still open */
    gameGone() {
        if (!this.wanted || this.ui.shown() || this.o.gameShown()) return;
        const e = this.ui.show();
        if (e) this.log('ui: ' + e);
    }

    /* the game's state changed: one played here shows once it draws */
    onGame(g) {
        if (!this.autoShow) return;
        if (!g || g.o.appId !== this.autoShow || g.state === 'ended') { this.autoShow = null; return; }
        if (g.state !== 'running') return;
        this.autoShow = null;
        if (!this.ui.shown()) return;
        this.log('ui: the game draws: showing it');
        const e = this.o.actions.show();
        if (e) this.log('ui: show: ' + e);
    }

    refresh() { this.ui.invalidate(); }

    stop(why) {
        this.wanted = false;
        this.autoShow = null;
        this.ui.hide(why);
    }

    /* a widget's action (a tap) */
    act(id, value) {
        const a = this.o.actions;
        if (id === 'show') return a.show();
        if (id === 'stop') return a.stop();
        if (id === 'prev') { this.page = Math.max(0, this.page - 1); return null; }
        if (id === 'next') { this.page++; return null; }
        const t = /^game:(\d+)$/.exec(id);
        if (t) { this.open = Number(t[1]); return null; }
        if (id === 'close') { this.open = null; return null; }
        if (id === 'play') {
            if (this.open === null) return null;
            const appId = this.open;
            this.autoShow = appId;
            const e = a.play(appId);
            if (e) this.autoShow = null;
            return e;
        }
        const p = /^p:(\w+)$/.exec(id);
        if (p && this.open !== null) {
            const k = p[1], m = this.o.state(), g = (m.library || []).filter((x) => x.appId === this.open)[0];
            if (!g || !a.game) return null;
            if (k === 'shape') {
                const r = nearest(m.resolutions || [], g.resolution, value);
                return r && r.id !== g.resolution ? a.game(this.open, { resolution: r.id }) : null;
            }
            if (k === 'reset') return a.game(this.open, { reset: true });
            if (k === 'resolution' || k === 'upscale' || k === 'detail') return a.game(this.open, { [k]: String(value) });
            if (k === 'fps' || k === 'memMb') return a.game(this.open, { [k]: Number(value) });
            if (k === 'vulkan' || k === 'iris' || k === 'noDrm' || k === 'noSteam') return a.game(this.open, { [k]: !!value });
            return null;
        }
        if (id === 'enabled') return a.enable(!!value);
        if (id === 'client') return a.client ? a.client(!!value) : null;
        return null;
    }
}

module.exports = { SteamTouch, qrMatrix, nearest, NAME };
