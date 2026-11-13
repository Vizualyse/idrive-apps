// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The built themes as a table: id, title, family, mode, layers, assets,
 * what a start uploads (and what a switch within its family keeps), what
 * the KOMBI draws a frame. Markdown by default, --json for tools.
 *   node tools/theme_table.js [--json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'themes', 'built');
const themes = fs.readdirSync(OUT).filter((n) => /\.theme\.json$/.test(n))
    .map((n) => JSON.parse(fs.readFileSync(path.join(OUT, n), 'utf8'))).filter((t) => t.ship !== false)
    .sort((a, b) => (a.family + (a.mode === 'comfort' ? 1 : 0)).localeCompare(b.family + (b.mode === 'comfort' ? 1 : 0)));
const raw = {};
const size = (f) => raw[f] || (raw[f] = zlib.gunzipSync(fs.readFileSync(path.join(OUT, f))).length);
const rows = themes.map((t) => {
    const files = Object.keys(t.assets).map((k) => t.assets[k].file);
    const sibling = themes.filter((o) => o.family === t.family && o.id !== t.id)[0];
    const shared = sibling ? files.filter((f) => Object.keys(sibling.assets).some((k) => sibling.assets[k].file === f)) : [];
    return { id: t.id, title: t.title, family: t.family, mode: t.mode, layers: t.layers.length, assets: files.length,
        mb: files.reduce((n, f) => n + size(f), 0) / 1048576,
        switchMb: files.filter((f) => shared.indexOf(f) < 0).reduce((n, f) => n + size(f), 0) / 1048576,
        mpx: (t.fill || t.layers.reduce((n, l) => n + l.w * l.h, 0)) / 1e6 };
});
if (process.argv.indexOf('--json') > 0) { console.log(JSON.stringify(rows, null, 1)); process.exit(0); }
console.log('| Theme | Id | Mode | Layers | Textures | MB at start | MB on a mode switch | Mpx a frame |');
console.log('|---|---|---|---|---|---|---|---|');
rows.forEach((r) => console.log('| ' + r.title + ' | `' + r.id + '` | ' + r.mode + ' | ' + r.layers + ' | ' + r.assets + ' | ' +
    r.mb.toFixed(2) + ' | ' + r.switchMb.toFixed(2) + ' | ' + r.mpx.toFixed(2) + ' |'));
const kit = fs.readdirSync(OUT).filter((n) => themes.some((t) => n.indexOf(t.id + '.') === 0)).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
console.log('\n' + rows.length + ' themes; the built files the kit ships: ' + (kit / 1048576).toFixed(1) + ' MB (gzipped)');
