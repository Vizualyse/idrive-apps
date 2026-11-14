// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A built theme on the cluster through cluster-render (THEMES.md): its
 * assets (fields, glyph atlases) and art uploaded once, its effect layers
 * made with the shared shaders, then only the uniforms that changed on each
 * tick. Checks the theme (theme_core.check) before anything is sent.
 *
 *   const rt = new ThemeRuntime(cr, __dirname, log);
 *   rt.start('g20i1');            // throws on a theme that may not run
 *   rt.tick(signals, dt, t);      // 25 a second
 *   rt.stop();                    // its layers, then its assets
 *
 * The client (cluster_render_client.js) keeps every asset, image, uniform
 * and bind and makes them again after cluster-render restarts, so a running
 * theme needs nothing more from here.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const core = require('./theme_core.js');

const TARGET = 'panel';

class ThemeRuntime {
    constructor(cr, dir, log) {
        this.cr = cr;
        this.dir = dir;
        this.log = log || (() => {});
        this.theme = null;
        this.refs = { layers: {}, assets: {} };
        this.keys = {};           /* asset name -> its pixels' key (kept across a theme switch) */
        this.logic = null;
        this.differ = null;
        this.ctx = null;
        this.sent = 0;
    }

    list() {
        return fs.readdirSync(this.dir).filter((n) => /^[a-z0-9]+\.theme\.json$/.test(n)).map((n) => {
            const t = JSON.parse(fs.readFileSync(path.join(this.dir, n), 'utf8'));
            return { id: t.id, title: t.title, family: t.family || t.id, mode: t.mode || 'sport', signals: t.signals || [], upload: t.upload || 0 };
        });
    }

    _read(name) { return zlib.gunzipSync(fs.readFileSync(path.join(this.dir, name))); }

    /* Switching themes (Sport and Comfort of a family) keeps every asset
     * whose pixels and shape the new theme has too: only the rest go over
     * the link again. */
    start(id) {
        const keep = this._release();
        if (!/^[a-z0-9]+$/.test(id || '')) { this._dropAll(keep); throw new Error('no theme ' + id); }
        let theme, logic;
        const shaders = {}, pixels = {};
        try {
            theme = JSON.parse(fs.readFileSync(path.join(this.dir, id + '.theme.json'), 'utf8'));
            const problems = core.check(theme);
            if (problems.length) throw new Error('theme ' + id + ' may not run: ' + problems.join('; '));
            const logicFile = path.join(this.dir, id + '.logic.js');
            delete require.cache[require.resolve(logicFile)];
            logic = require(logicFile);
            theme.layers.forEach((l) => {
                if (l.kind === 'effect' && !shaders[l.shader]) shaders[l.shader] = fs.readFileSync(path.join(this.dir, 'fs_' + l.shader + '.frag'), 'utf8');
            });
            Object.keys(theme.assets).forEach((k) => {
                const a = theme.assets[k];
                const px = this._read(a.file);
                if (px.length !== a.w * a.h * (a.format === 'r8' ? 1 : 4)) throw new Error('asset ' + k + ' is ' + px.length + ' bytes');
                const hash = crypto.createHash('sha1').update(px).digest('hex');
                /* a file shared with another theme of the family and since rebuilt: not this theme's pixels */
                if (a.sha1 && a.sha1 !== hash) throw new Error('asset ' + k + ' (' + a.file + ') is not the one ' + id + ' was built with: rebuild ' + id);
                pixels[k] = { px: px, key: [a.format, a.w, a.h, a.sampling || 'nearest', hash].join(':') };
            });
        } catch (e) { this._dropAll(keep); throw e; }
        /* everything read and checked: now the cluster */
        const cr = this.cr;
        let sent = 0, kept = 0;
        Object.keys(theme.assets).forEach((k) => {
            const a = theme.assets[k], p = pixels[k];
            if (keep[p.key]) { this.refs.assets[k] = keep[p.key]; this.keys[k] = p.key; delete keep[p.key]; kept += p.px.length; return; }
            const ref = cr.asset({ target: TARGET, format: a.format, w: a.w, h: a.h, sampling: a.sampling || 'nearest' });
            if (!ref) throw new Error('asset ' + k + ' refused by the client');
            cr.pixels(ref, null, p.px);
            this.refs.assets[k] = ref;
            this.keys[k] = p.key;
            sent += p.px.length;
        });
        this._dropAll(keep);
        theme.layers.forEach((l) => {
            let ref;
            if (l.kind === 'image') {
                ref = cr.image({ target: TARGET, klass: 'content', z: l.z || 0, x: l.x, y: l.y, w: l.w, h: l.h, iw: l.w, ih: l.h, fps: 1 });
                if (ref) cr.pixels(ref, null, this._read(l.file));
            } else {
                ref = cr.effect({ target: TARGET, klass: 'content', z: l.z || 0, x: l.x, y: l.y, w: l.w, h: l.h, fs: shaders[l.shader] });
                if (ref) {
                    Object.keys(l.binds || {}).forEach((s) => cr.bind(ref, s, this.refs.assets[l.binds[s]]));
                    Object.keys(l.uniforms || {}).forEach((k) => this._uniform(ref, k, l.uniforms[k]));
                }
            }
            if (!ref) throw new Error('layer ' + l.name + ' refused by the client');
            this.refs.layers[l.name] = ref;
        });
        /* The bottom cover (setting "cover"): black over the car's own strip,
         * y bottom..720, so nothing of BMW's cluster shows below the theme.
         * The panel is under the KOMBI's telltales, so warning lights still
         * show over it; the strip's own readings (range, clock, road) do not. */
        if (this.cover) {
            const h = 720 - (theme.bottom || core.LIMITS.bottom);
            const ref = cr.effect({ target: TARGET, klass: 'content', z: 999, x: 0, y: 720 - h, w: 1920, h: h, fs: shaders.rect ||
                fs.readFileSync(path.join(this.dir, 'fs_rect.frag'), 'utf8') });
            if (ref) {
                this._uniform(ref, 'u_color', [0, 0, 0, 1]);
                this._uniform(ref, 'u_shape', [1920, h, 0, 0]);
                this._uniform(ref, 'u_ring', [0, 0, 0, 0]);
                this.refs.layers.__cover = ref;
            }
        }
        this.theme = theme;
        this.logic = logic;
        this.differ = new core.Differ(theme);
        this.ctx = { params: theme.params || {}, fonts: theme.fonts || {}, core: core, state: {}, t: 0, dt: 0 };
        this.log('theme: ' + theme.title + ' (' + theme.layers.length + ' layers, ' + Object.keys(theme.assets).length +
            ' assets, ' + (sent / 1048576).toFixed(1) + ' MB to upload' + (kept ? ', ' + (kept / 1048576).toFixed(1) + ' MB kept from the last theme' : '') + ')');
        this.lastUpload = sent;
        return theme;
    }

    /* The running theme's layers dropped; its assets handed back by key, to
     * be kept by the next theme or dropped. */
    _release() {
        Object.keys(this.refs.layers).forEach((k) => this.cr.drop(this.refs.layers[k]));
        const keep = {};
        Object.keys(this.refs.assets).forEach((k) => {
            const key = this.keys[k];
            if (key && !keep[key]) keep[key] = this.refs.assets[k];
            else this.cr.drop(this.refs.assets[k]);
        });
        if (this.theme) this.log('theme: ' + this.theme.title + ' stopped');
        this.refs = { layers: {}, assets: {} };
        this.keys = {};
        this.theme = null;
        this.logic = null;
        this.differ = null;
        return keep;
    }
    _dropAll(keep) { Object.keys(keep).forEach((k) => this.cr.drop(keep[k])); }

    _uniform(ref, name, v) {
        if (v.length > 4) this.cr.uniform(ref, name, v, { type: 'vec4' });
        else this.cr.uniform(ref, name, v);
        this.sent += 40 + name.length + v.length * 7;
    }

    /* One tick: the logic's word on the signals, and only what changed goes. */
    tick(signals, dt, t) {
        if (!this.theme) return 0;
        this.ctx.dt = dt;
        this.ctx.t = t;
        let said;
        try { said = this.logic.update(signals, this.ctx) || {}; }
        catch (e) { this.log('theme: logic: ' + e.message); return 0; }
        const changes = this.differ.changes(said);
        changes.forEach((c) => {
            const ref = this.refs.layers[c.layer.name];
            Object.keys(c.uniforms).forEach((k) => this._uniform(ref, k, c.uniforms[k]));
            if (c.set) this.cr.set(ref, c.set);
        });
        return changes.length;
    }

    stop() {
        if (!this.theme && !Object.keys(this.refs.assets).length && !Object.keys(this.refs.layers).length) return;
        this._dropAll(this._release());
    }
}

module.exports = { ThemeRuntime };
