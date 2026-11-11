// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * Wine's lines for the tool's log, without their floods. A game can say
 * one thing without end: WineD3D on iris wrote 8.7 million
 * "wined3d_fence_test glClientWaitSync returned 0x501" lines in 45 s on the
 * bench (2026-11-11), each one through this tool's Node into the journal.
 * So a message (the same but for its thread id and its numbers) is logged
 * its first FIRST times, then only counted, and the counts are said every
 * EVERY_MS; and whatever the messages, no more than PER_S lines a second.
 *
 *   const w = new WineLog((s) => log('wine: ' + s));
 *   w.line(l);  w.report();  w.end();
 */
'use strict';

const FIRST = 5;          /* a message's first lines, as they are */
const EVERY_MS = 10000;   /* how often the counts of the rest are said */
const PER_S = 100;        /* lines a second in all */
const KEYS = 400;         /* messages remembered */

class WineLog {
    /* log (line), now () -> ms */
    constructor(log, now) {
        this.log = log;
        this.now = now || Date.now;
        this.seen = new Map();      /* message -> { n: lines so far, more: counted since last said } */
        this.lastRaw = null;
        this.lastKey = null;
        this.said = this.now();
        this.second = 0;
        this.inSecond = 0;
        this.dropped = 0;           /* over PER_S, since last said */
    }

    /* the message of a line: no thread id ("0188:"), its numbers as # */
    key(l) {
        const raw = l.replace(/^[0-9a-f]{4}:/, '');
        if (raw === this.lastRaw) return this.lastKey;
        this.lastRaw = raw;
        this.lastKey = raw.replace(/\b(0x[0-9a-f]+|\d+)\b/gi, '#').slice(0, 200);   /* whole numbers: not the 3 of d3d */
        return this.lastKey;
    }

    line(l) {
        const t = this.now();
        const k = this.key(l);
        let e = this.seen.get(k);
        if (!e) {
            if (this.seen.size >= KEYS) { this.report(true); this.seen.clear(); }
            e = { n: 0, more: 0 };
            this.seen.set(k, e);
        }
        e.n++;
        if (e.n > FIRST) e.more++;
        else {
            const s = Math.floor(t / 1000);
            if (s !== this.second) { this.second = s; this.inSecond = 0; }
            if (++this.inSecond > PER_S) this.dropped++;
            else this.log(l.slice(0, 300));
        }
        if (t - this.said >= EVERY_MS) this.report();
    }

    /* the counts since they were last said (all: whatever the time) */
    report(all) {
        const t = this.now();
        if (!all && t - this.said < EVERY_MS) return;
        this.said = t;
        this.seen.forEach((e, k) => {
            if (!e.more) return;
            this.log('(' + e.more + ' more, ' + e.n + ' in all) ' + k);
            e.more = 0;
        });
        if (this.dropped) { this.log('(' + this.dropped + ' more lines left out: over ' + PER_S + ' a second)'); this.dropped = 0; }
    }

    end() { this.report(true); }
}

module.exports = { WineLog, FIRST, EVERY_MS, PER_S };
