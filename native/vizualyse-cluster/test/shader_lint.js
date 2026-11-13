// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * The rules every cluster shader keeps (THEMES.md "The shaders"), checked on
 * the source: GLSL ES 1.00, at most 12 uniform vectors, at most 2 texture
 * reads, no discard, no derivatives, loops only of constant bounds up to 4
 * (16 in text.frag, whose layers are small: one compare a glyph), no clock
 * (u_time). The preview compiles them for real (WebGL 1).
 *   node test/shader_lint.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'src', 'shaders');
const SIZE = { float: 1, vec2: 1, vec3: 1, vec4: 1, mat4: 4, int: 1, bool: 1 };
let bad = 0;
fs.readdirSync(DIR).filter((n) => /\.frag$/.test(n)).sort().forEach((n) => {
    const src = fs.readFileSync(path.join(DIR, n), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const problems = [];
    if (!/^#version 100\b/.test(src)) problems.push('not #version 100 on the first line');
    let vectors = 0;
    code.replace(/uniform\s+(\w+)\s+(\w+)\s*(?:\[(\d+)\])?\s*;/g, (m, type, name, n) => {
        if (type !== 'sampler2D') vectors += (SIZE[type] || 4) * (n ? Number(n) : 1);
        if (name === 'u_time') problems.push('reads the clock (u_time)');
    });
    if (vectors > 12) problems.push(vectors + ' uniform vectors (at most 12)');
    const reads = (code.match(/texture2D\s*\(/g) || []).length;
    if (reads > 2) problems.push(reads + ' texture reads (at most 2)');
    if (/\bdiscard\b/.test(code)) problems.push('discard');
    if (/\b(dFdx|dFdy|fwidth)\b/.test(code)) problems.push('derivatives');
    code.replace(/for\s*\(([^)]*)\)/g, (m, head) => {
        const k = /int\s+\w+\s*=\s*(\d+)\s*;\s*\w+\s*<\s*(\d+)\s*;/.exec(head);
        const most = n === 'text.frag' ? 16 : 4;
        if (!k || Number(k[2]) - Number(k[1]) > most) problems.push('a loop that is not constant and at most ' + most + ' steps: for (' + head + ')');
    });
    if (/\bwhile\b/.test(code)) problems.push('a while loop');
    console.log((problems.length ? 'FAIL ' : 'ok   ') + n + ' (' + vectors + ' uniform vectors, ' + reads + ' texture reads)' +
        (problems.length ? ': ' + problems.join('; ') : ''));
    bad += problems.length;
});
process.exit(bad ? 1 : 0);
