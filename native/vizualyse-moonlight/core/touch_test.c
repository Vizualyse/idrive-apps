// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The touch decode and the hold (touch.c) against the PDUs captured on the
 * car (test/fixtures/id7-touch-capture.txt: "t_ms src:port len hex" lines; a
 * tap, a 1.25 s hold, a tap), and synthetic holds. Built and run by build.sh.
 *
 *   touch_test <capture file> */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "touch.h"

static int fails = 0, checks = 0;
#define OK(what, cond) do { checks++; if (!(cond)) { fails++; printf("FAIL %s\n", what); } } while (0)

static int unhex(const char *h, unsigned char *out, int max) {
    int n = 0;
    while (h[0] && h[1] && n < max) { unsigned v; if (sscanf(h, "%2x", &v) != 1) break; out[n++] = (unsigned char)v; h += 2; }
    return n;
}

int main(int argc, char **argv) {
    FILE *f = fopen(argc > 1 ? argv[1] : "test/fixtures/id7-touch-capture.txt", "r");
    if (!f) { perror("capture"); return 1; }
    char line[1024], src[64], hex[600];
    unsigned char p[300];
    int t, len, gestures = 0, downs = 0, ups = 0, pdus = 0, holds = 0;
    int gx[8], gy[8], gms[8];
    long g0 = 0;
    struct touch_hold h = { 0 };
    while (fgets(line, sizeof line, f)) {
        if (sscanf(line, "%d %63s %d %599s", &t, src, &len, hex) != 4) continue;
        int n = unhex(hex, p, sizeof p), ph, x, y;
        if (!touch_decode(p, n, &ph, &x, &y)) continue;
        pdus++;
        if (touch_step(&h, ph, x, y, t)) holds++;
        if (ph == TOUCH_DOWN) { downs++; g0 = t; if (gestures < 8) { gx[gestures] = x; gy[gestures] = y; } }
        if (ph == TOUCH_UP) { ups++; if (gestures < 8) gms[gestures] = (int)(t - g0); gestures++; }
    }
    fclose(f);
    OK("all 216 captured PDUs decode", pdus == 216);
    OK("three gestures end", ups == 3);
    OK("two downs (the first tap went down before the capture)", downs == 2);
    OK("the hold went down at 1280,274", gestures >= 2 && gx[1] == 1280 && gy[1] == 274);
    OK("the hold lasted 1251 ms", gestures >= 2 && gms[1] == 1251);
    OK("the last tap at 534,165", gestures >= 3 && gx[2] == 534 && gy[2] == 165);
    OK("a 1.25 s hold is not 2 s: no stop", holds == 0);

    unsigned char other[112] = { 0 };
    int ph, x, y;
    OK("another PDU id is not touch", !touch_decode(other, sizeof other, &ph, &x, &y));
    OK("a short packet is not touch", !touch_decode(p, 40, &ph, &x, &y));

    /* synthetic: a still finger 2 s */
    struct touch_hold s = { 0 };
    bool fired = touch_step(&s, TOUCH_DOWN, 900, 300, 1000);
    for (long ms = 1008; ms < 2992; ms += 8) fired |= touch_step(&s, TOUCH_MOVE, 900 + (ms % 3), 301, ms);
    OK("held 1.99 s: not yet", !fired);
    OK("held 2 s: stop", touch_step(&s, TOUCH_MOVE, 901, 300, 3000));
    OK("held on: once only", !touch_step(&s, TOUCH_MOVE, 901, 300, 3500) && !touch_tick(&s, 3600));
    touch_step(&s, TOUCH_UP, 901, 300, 3700);
    fired = touch_step(&s, TOUCH_DOWN, 100, 100, 4000);
    for (long ms = 4008; ms < 6000; ms += 8) fired |= touch_step(&s, TOUCH_MOVE, 100, 100, ms);
    OK("let go, held again: a new hold", !fired && touch_step(&s, TOUCH_MOVE, 100, 100, 6000));

    /* a swipe is not a hold */
    struct touch_hold w = { 0 };
    fired = touch_step(&w, TOUCH_DOWN, 100, 300, 0);
    for (long ms = 8; ms <= 2500; ms += 8) fired |= touch_step(&w, TOUCH_MOVE, 100 + (int)ms / 2, 300, ms);
    OK("a slow 2.5 s swipe across the screen: no stop", !fired);

    /* a lost up */
    struct touch_hold u = { 0 };
    touch_step(&u, TOUCH_DOWN, 500, 500, 0);
    OK("no PDU for over a second: not a hold", !touch_tick(&u, 1100) && !touch_tick(&u, 2500));

    printf("touch_test: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
