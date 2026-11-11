// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* src/wine_log.js: Wine's lines without their floods, on a fake clock.
 *   node test/wine_log_test.js */
'use strict';
const assert = require('assert');
const { WineLog, FIRST, EVERY_MS, PER_S } = require('../src/wine_log.js');

let t = 5000;
const out = [];
const w = new WineLog((s) => out.push(s), () => t);

/* different messages pass as they are */
w.line('0024:err:steamclient:steamclient_init unable to load native steamclient library');
w.line('0188:err:mscoree:LoadLibraryShim error reading registry key for installroot');
assert.strictEqual(out.length, 2);
assert.strictEqual(out[0], '0024:err:steamclient:steamclient_init unable to load native steamclient library');

/* a message said again and again, by any thread and with any number in it:
 * its first lines, then nothing until the count is due */
out.length = 0;
for (let i = 0; i < 100000; i++) w.line((i % 2 ? '01c8' : '01b4') + ':err:d3d:wined3d_fence_test glClientWaitSync returned 0x' + (0x501 + i % 3).toString(16) + '.');
assert.strictEqual(out.length, FIRST, 'only its first lines: ' + out.length);
t += EVERY_MS;
w.line('01c8:err:d3d:wined3d_fence_test glClientWaitSync returned 0x501.');
assert.strictEqual(out.length, FIRST + 1);
assert.ok(/^\(99996 more, 100001 in all\) err:d3d:wined3d_fence_test glClientWaitSync returned #\.$/.test(out[FIRST]), out[FIRST]);

/* the count is said once: nothing new, nothing more */
out.length = 0;
t += EVERY_MS;
w.report();
assert.strictEqual(out.length, 0);

/* many different messages in one second: PER_S of them, the rest counted */
out.length = 0;
for (let i = 0; i < 3 * PER_S; i++) w.line('0100:err:test:msg ' + 'abcdefghijklmnopqrstuvwxyz'[i % 26] + String.fromCharCode(97 + Math.floor(i / 26)) + ' happened');
assert.strictEqual(out.length, PER_S, 'a second holds ' + PER_S + ': ' + out.length);
t += EVERY_MS;
w.report();
assert.ok(out.some((l) => l === '(' + (2 * PER_S) + ' more lines left out: over ' + PER_S + ' a second)'), out.slice(-2).join(' | '));

/* the end says what is still counted */
out.length = 0;
for (let i = 0; i < 20; i++) w.line('0100:fixme-like:thing again and again');
assert.strictEqual(out.length, FIRST);
w.end();
assert.strictEqual(out[out.length - 1], '(15 more, 20 in all) fixme-like:thing again and again');

/* a long line is cut */
out.length = 0;
w.line('0100:err:long:' + 'x'.repeat(1000));
assert.strictEqual(out[0].length, 300);

console.log('wine_log: all passed');
