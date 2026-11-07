// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The iDrive 7 touch PDU and the hold (touch.h). No I/O here. */
#include "touch.h"
#include <stdlib.h>

#define PDU_ID 0xB0048002u

static unsigned be16(const unsigned char *p) { return (unsigned)p[0] << 8 | p[1]; }
static unsigned be32(const unsigned char *p) { return (unsigned)p[0] << 24 | (unsigned)p[1] << 16 | (unsigned)p[2] << 8 | p[3]; }

int touch_decode(const unsigned char *p, int len, int *phase, int *x, int *y) {
    if (len < 64 || be32(p) != PDU_ID) return 0;
    int ev = p[63] >> 4;
    if (ev < TOUCH_DOWN || ev > TOUCH_UP) return 0;
    *phase = ev;
    *x = (int)be16(p + 54);
    *y = (int)be16(p + 60);
    return 1;
}

static bool reached(struct touch_hold *h, long now_ms) {
    if (!h->down || h->fired || now_ms - h->t0 < TOUCH_HOLD_MS) return false;
    h->fired = true;
    return true;
}

bool touch_step(struct touch_hold *h, int phase, int x, int y, long now_ms) {
    if (phase == TOUCH_UP) { h->down = false; h->fired = false; return false; }
    if (phase == TOUCH_DOWN || !h->down) {
        /* a move without its down (it went down before we listened) starts a hold too */
        h->down = true; h->fired = false; h->t0 = now_ms; h->x0 = x; h->y0 = y;
    } else if (abs(x - h->x0) > TOUCH_SLOP_PX || abs(y - h->y0) > TOUCH_SLOP_PX) {
        /* a swipe, not a hold: start again from here */
        h->t0 = now_ms; h->x0 = x; h->y0 = y; h->fired = false;
    }
    h->last = now_ms;
    return reached(h, now_ms);
}

bool touch_tick(struct touch_hold *h, long now_ms) {
    /* no PDU for a second with the finger "down": the up was lost, not a hold */
    if (h->down && now_ms - h->last > 1000) { h->down = false; return false; }
    return reached(h, now_ms);
}
