// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/**
 * A touch's mouse button, timed for games that look at the mouse once a
 * frame. Straight through, a quick tap (down and up 40-100 ms apart) can be
 * pressed and released between two of a slow game's frames, and the game
 * never sees it; and a press in the same instant the pointer arrives finds
 * nothing under it yet in a UI that hovers first. Don't Starve at 2.5 and at
 * 20 pictures/s took a tap as a move only (its pad's focus dropped, no
 * click: the car, 2026-11-08 and 09). So:
 *
 *   down   the pointer moves there now; the button goes down a frame later
 *   move   (a drag) the button down first if it isn't yet, then the move
 *   up     a tap's release waits until the button has been down HOLD_MS, or
 *          HOLD_FRAMES frames at the game's rate if that is longer (at most
 *          MAX_HOLD_MS); a drag's release is at once
 *   flush  whatever is waiting, now (a new touch, the game hidden or ended)
 *
 * frameMs(): the game's frame time now (its pictures a second). The clock
 * and timers can be given (test/tap_test.js).
 */
'use strict';

const HOLD_MS = 150, HOLD_FRAMES = 3, MAX_HOLD_MS = 600;
const MIN_PRESS_DELAY_MS = 16, MAX_PRESS_DELAY_MS = 100;

class Tap {
    constructor(o) {
        this.input = o.input;                 /* (kind 'd' | 'm' | 'u', x, y) */
        this.frameMs = o.frameMs || (() => 1000 / 30);
        this.now = o.now || Date.now;
        this.setTimeout = o.setTimeout || setTimeout;
        this.clearTimeout = o.clearTimeout || clearTimeout;
        this.press = null;     /* { x, y, timer }: the button still to go down */
        this.release = null;   /* { x, y, timer }: the button still to come up */
        this.downAt = 0;       /* when it went down */
    }

    holdMs() { return Math.min(MAX_HOLD_MS, Math.max(HOLD_MS, HOLD_FRAMES * this.frameMs())); }
    pressDelayMs() { return Math.min(MAX_PRESS_DELAY_MS, Math.max(MIN_PRESS_DELAY_MS, this.frameMs())); }

    pressNow() {
        if (!this.press) return;
        const p = this.press;
        this.press = null;
        this.clearTimeout(p.timer);
        this.input('d', p.x, p.y);
        this.downAt = this.now();
    }

    releaseNow() {
        if (!this.release) return;
        const r = this.release;
        this.release = null;
        this.clearTimeout(r.timer);
        this.input('u', r.x, r.y);
    }

    flush() { this.pressNow(); this.releaseNow(); }

    down(x, y) {
        this.flush();
        this.input('m', x, y);
        this.press = { x: x, y: y, timer: this.setTimeout(() => this.pressNow(), this.pressDelayMs()) };
    }

    move(x, y) {
        this.pressNow();
        this.input('m', x, y);
    }

    /* tap: a touch that never became a drag (its release is held) */
    up(x, y, tap) {
        this.pressNow();
        if (!tap) { this.input('u', x, y); return; }
        const wait = Math.max(0, this.downAt + this.holdMs() - this.now());
        if (wait === 0) { this.input('u', x, y); return; }
        this.release = { x: x, y: y, timer: this.setTimeout(() => this.releaseNow(), wait) };
    }
}

module.exports = { Tap, HOLD_MS, HOLD_FRAMES, MAX_HOLD_MS };
