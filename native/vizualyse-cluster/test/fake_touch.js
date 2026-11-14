// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* A stand-in for touch_reader.py in the picker's off-car test (the unit's
 * reader needs mgu-python and an AF_PACKET socket): it says ready, then
 * whenever the file named on its command line appears, prints its lines
 * (touch events, as the reader prints them) with "wait" lines as pauses in
 * ms, and deletes it. It ends when its stdin closes, as the reader does. */
'use strict';
const fs = require('fs');
const file = process.argv[2];
process.stdout.write(JSON.stringify({ ev: 'ready', touch: true, uid: 0 }) + '\n');
let busy = false;
setInterval(() => {
    if (busy || !fs.existsSync(file)) return;
    busy = true;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    fs.unlinkSync(file);
    (function next() {
        const l = lines.shift();
        if (l === undefined) { busy = false; return; }
        const m = /^wait (\d+)$/.exec(l);
        if (m) { setTimeout(next, Number(m[1])); return; }
        process.stdout.write(l + '\n');
        setTimeout(next, 8);
    })();
}, 30);
process.stdin.on('end', () => process.exit(0));
process.stdin.resume();
