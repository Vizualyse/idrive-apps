// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* src/tap.js: a touch's button timed for games that read the mouse once a
 * frame, on a fake clock and fake timers.   node test/tap_test.js */
'use strict';
const assert = require('assert');
const { Tap, HOLD_MS, MAX_HOLD_MS } = require('../src/tap.js');

function rig(fps) {
    let t = 1000, timers = [], id = 0;
    const log = [];
    const r = {
        log, rate: fps,
        tap: null,
        at: () => t,
        /* the clock forward, timers firing in order */
        run(ms) {
            const end = t + ms;
            for (;;) {
                timers.sort((a, b) => a.at - b.at);
                const n = timers[0];
                if (!n || n.at > end) break;
                timers.shift();
                t = n.at;
                n.fn();
            }
            t = end;
        },
    };
    r.tap = new Tap({
        input: (k, x, y) => log.push({ k, x, y, t }),
        frameMs: () => 1000 / r.rate,
        now: () => t,
        setTimeout: (fn, ms) => { const x = { fn, at: t + ms, id: ++id }; timers.push(x); return x.id; },
        clearTimeout: (i) => { timers = timers.filter((x) => x.id !== i); },
    });
    return r;
}
const kinds = (r) => r.log.map((e) => e.k).join('');
let n = 0;
const it = (name, fn) => { fn(); n++; console.log('  ok   ' + name); };

it('a quick tap: the pointer moves, the button goes down a frame later, up held 150 ms', () => {
    const r = rig(30);
    r.tap.down(100, 50);
    assert.strictEqual(kinds(r), 'm');
    r.run(40);                       /* the finger is up after 40 ms */
    r.tap.up(100, 50, true);
    assert.strictEqual(kinds(r), 'md', 'down at the next frame, before the up');
    const d = r.log[1];
    assert.ok(d.t - r.log[0].t >= 30 && d.t - r.log[0].t <= 40, 'pressed a frame (33 ms) after the move: ' + (d.t - r.log[0].t));
    r.run(1000);
    assert.strictEqual(kinds(r), 'mdu');
    assert.strictEqual(r.log[2].t - d.t, HOLD_MS, 'held HOLD_MS');
    assert.deepStrictEqual([r.log[2].x, r.log[2].y], [100, 50]);
});

it('a slow game: held three of its frames (2.5 pictures/s: 600 ms, the most)', () => {
    const r = rig(2.5);
    r.tap.down(10, 10);
    r.run(20);
    r.tap.up(10, 10, true);
    r.run(5000);
    assert.strictEqual(kinds(r), 'mdu');
    assert.strictEqual(r.log[2].t - r.log[1].t, MAX_HOLD_MS);
    const s = rig(10);               /* 10 pictures/s: 3 frames = 300 ms */
    s.tap.down(1, 1); s.run(5); s.tap.up(1, 1, true); s.run(5000);
    assert.strictEqual(s.log[2].t - s.log[1].t, 300);
});

it('a long press: released when the finger is', () => {
    const r = rig(30);
    r.tap.down(5, 5);
    r.run(500);
    r.tap.up(5, 5, true);
    assert.strictEqual(kinds(r), 'mdu');
    assert.strictEqual(r.log[2].t, r.log[0].t + 500);
});

it('a drag: down before the first move, up at once', () => {
    const r = rig(30);
    r.tap.down(0, 0);
    r.run(5);
    r.tap.move(40, 0);
    assert.strictEqual(kinds(r), 'mdm');
    r.tap.move(80, 0);
    r.tap.up(80, 0, false);
    assert.strictEqual(kinds(r), 'mdmmu');
    assert.strictEqual(r.log[4].t, r.log[3].t);
});

it('a new touch while a tap is held: the old one ends first', () => {
    const r = rig(30);
    r.tap.down(1, 1); r.run(40); r.tap.up(1, 1, true);
    r.run(50);                       /* still held */
    r.tap.down(2, 2);
    assert.strictEqual(kinds(r), 'mdum', 'up (1,1) before the new move');
    assert.deepStrictEqual([r.log[2].x, r.log[3].x], [1, 2]);
    r.run(1000);
    assert.strictEqual(kinds(r), 'mdumd');
});

it('flush: nothing left waiting, the button not left down', () => {
    const r = rig(30);
    r.tap.down(3, 3);
    r.tap.flush();
    assert.strictEqual(kinds(r), 'md');
    r.tap.up(3, 3, true);
    r.tap.flush();
    assert.strictEqual(kinds(r), 'mdu');
    r.run(5000);
    assert.strictEqual(kinds(r), 'mdu', 'nothing fires later');
});

console.log('tap: ' + n + ' passed');
