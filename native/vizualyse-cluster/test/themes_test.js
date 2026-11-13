// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Every built theme, off the car, as the tool runs it:
 *   - theme_core.check (the strip at y 646, the layer, asset and uniform limits);
 *   - every file it names is there, its textures the size its JSON says and
 *     the pixels it was built with (sha1);
 *   - its logic through the bench drive of its own mode (both laps), then
 *     with the car giving nothing but its speed, then nothing at all: never
 *     throws, never names a layer the theme lacks, and every text it shows
 *     is made of its font's glyphs (an unknown character would show blank);
 *   - the uniform traffic while driving (reported; at most 30 KB/s).
 *   node test/themes_test.js      (Node 8 or later)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const core = require('../src/theme_core.js');
const sim = require('../src/sim.js');

const OUT = path.join(__dirname, '..', 'themes', 'built');
let bad = 0;
const fail = (id, m) => { console.log('FAIL ' + id + ': ' + m); bad++; };

fs.readdirSync(OUT).filter((n) => /\.theme\.json$/.test(n)).sort().forEach((n) => {
    const theme = JSON.parse(fs.readFileSync(path.join(OUT, n), 'utf8'));
    const id = theme.id;
    core.check(theme).forEach((p) => fail(id, p));
    Object.keys(theme.assets).forEach((k) => {
        const a = theme.assets[k];
        const f = path.join(OUT, a.file);
        if (!fs.existsSync(f)) return fail(id, 'asset ' + k + ': ' + a.file + ' is missing');
        const px = zlib.gunzipSync(fs.readFileSync(f));
        if (px.length !== a.w * a.h * (a.format === 'r8' ? 1 : 4)) fail(id, 'asset ' + k + ' is ' + px.length + ' bytes');
        if (!a.sha1) fail(id, 'asset ' + k + ' has no sha1 (rebuild)');
        else if (crypto.createHash('sha1').update(px).digest('hex') !== a.sha1) fail(id, 'asset ' + k + ' (' + a.file + ') is not what it was built with');
    });
    const logicFile = path.join(OUT, id + '.logic.js');
    if (!fs.existsSync(logicFile)) return fail(id, 'no logic');
    const logic = require(logicFile);
    const names = {};
    theme.layers.forEach((l) => { names[l.name] = l; });
    const differ = new core.Differ(theme);
    let bytes = 0, ticks = 0;
    const run = (sig, ctx, what) => {
        let said;
        try { said = logic.update(sig, ctx) || {}; } catch (e) { fail(id, what + ': the logic threw ' + e.message); return; }
        Object.keys(said).forEach((k) => {
            const l = names[k];
            if (!l) return fail(id, what + ': the logic names a layer ' + k + ' the theme lacks');
            if (l.shader === 'text' && said[k].text != null) {
                const s = String(said[k].text);
                for (let i = 0; i < s.length; i++) {
                    if (l.glyphs.indexOf(s[i]) < 0) { fail(id, what + ': layer ' + k + ' shows "' + s + '", and "' + s[i] + '" is not in its font'); break; }
                }
            }
        });
        differ.changes(said).forEach((c) => Object.keys(c.uniforms).forEach((u) => { bytes += 40 + u.length + c.uniforms[u].length * 7; }));
        ticks++;
    };
    const mode = theme.mode === 'comfort' ? 'comfort' : 'sport';
    const ctx = { params: theme.params || {}, fonts: theme.fonts || {}, core: core, state: {}, t: 0, dt: 0 };
    const laps = sim.length(mode) * 2;
    for (let t = 0; t < laps; t += 0.04) {
        ctx.t = t; ctx.dt = 0.04;
        run(Object.assign({ source: 'demo' }, sim.at(t, mode)), ctx, 'the ' + mode + ' drive at t ' + t.toFixed(2));
        if (bad > 20) break;
    }
    const rate = bytes / 1024 / laps;
    if (rate > 30) fail(id, (rate).toFixed(1) + ' KB/s of uniforms');
    const ctx2 = { params: theme.params || {}, fonts: theme.fonts || {}, core: core, state: {}, t: 0, dt: 0.04 };
    for (let i = 0; i < 20; i++) { ctx2.t = i * 0.04; run({ source: 'car', kmh: 50 + i, clock: '12:00' }, ctx2, 'the car with only its speed'); }
    const ctx3 = { params: theme.params || {}, fonts: theme.fonts || {}, core: core, state: {}, t: 0, dt: 0.04 };
    for (let i = 0; i < 5; i++) { ctx3.t = i * 0.04; run({ source: 'car' }, ctx3, 'the car with nothing'); }
    console.log((bad ? '     ' : 'ok   ') + id.padEnd(8) + ' ' + theme.mode.padEnd(8) + theme.layers.length + ' layers, ' +
        Object.keys(theme.assets).length + ' assets, ' + rate.toFixed(1) + ' KB/s of uniforms on its drive');
});
process.exit(bad ? 1 : 0);
