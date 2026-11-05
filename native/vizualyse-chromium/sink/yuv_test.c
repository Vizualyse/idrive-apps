// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* yuv.c: sizes equal, smaller (black around), bigger (cut), 4:2:0 / 4:2:2 /
 * 4:4:4 / grey, and a subsampling it refuses. */
#include "yuv.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int fails = 0;
#define CHECK(c, ...) do { if (!(c)) { fprintf(stderr, "yuv_test: " __VA_ARGS__); fputc('\n', stderr); fails++; } } while (0)

static uint8_t px(int x, int y, int k) { return (uint8_t)(x * 7 + y * 13 + k * 31); }

/* a source of w x h with chroma subsampled sx x sy, chroma constant per 2x2 block so every layout averages the same */
static void make(struct yuv_src *s, int w, int h, int sx, int sy) {
    int cw = (w + sx - 1) / sx, ch = (h + sy - 1) / sy;
    uint8_t *y = malloc((size_t)w * h), *u = malloc((size_t)cw * ch), *v = malloc((size_t)cw * ch);
    for (int r = 0; r < h; r++) for (int c = 0; c < w; c++) y[r * w + c] = px(c, r, 0);
    for (int r = 0; r < ch; r++) for (int c = 0; c < cw; c++) {
        int bx = c * sx / 2, by = r * sy / 2;
        u[r * cw + c] = px(bx, by, 1); v[r * cw + c] = px(bx, by, 2);
    }
    s->y = y; s->u = u; s->v = v; s->ys = w; s->cs = cw; s->w = w; s->h = h; s->sx = sx; s->sy = sy;
}

static void check(int sw, int sh, int sx, int sy, int dw, int dh) {
    struct yuv_src s;
    make(&s, sw, sh, sx, sy);
    uint8_t *d = malloc((size_t)dw * dh * 3 / 2);
    memset(d, 0x55, (size_t)dw * dh * 3 / 2);
    CHECK(yuv_to_i420(&s, d, dw, dh) == 0, "%dx%d %dx%d refused", sw, sh, sx, sy);
    const uint8_t *U = d + dw * dh, *V = U + (dw / 2) * (dh / 2);
    for (int r = 0; r < dh; r++) for (int c = 0; c < dw; c++) {
        int want = (c < sw && r < sh) ? px(c, r, 0) : 0;
        if (d[r * dw + c] != want) { CHECK(0, "%dx%d %d:%d -> %dx%d: Y(%d,%d) %d, want %d", sw, sh, sx, sy, dw, dh, c, r, d[r * dw + c], want); goto out; }
    }
    for (int r = 0; r < dh / 2; r++) for (int c = 0; c < dw / 2; c++) {
        int in = c * 2 < sw && r * 2 < sh;
        int wu = in ? px(c, r, 1) : 128, wv = in ? px(c, r, 2) : 128;
        if (U[r * (dw / 2) + c] != wu || V[r * (dw / 2) + c] != wv) {
            CHECK(0, "%dx%d %d:%d -> %dx%d: UV(%d,%d) %d %d, want %d %d", sw, sh, sx, sy, dw, dh, c, r, U[r * (dw / 2) + c], V[r * (dw / 2) + c], wu, wv);
            goto out;
        }
    }
out:
    free(d); free((void *)s.y); free((void *)s.u); free((void *)s.v);
}

int main(void) {
    int sub[3][2] = { { 2, 2 }, { 2, 1 }, { 1, 1 } };
    for (int i = 0; i < 3; i++) {
        check(64, 32, sub[i][0], sub[i][1], 64, 32);
        check(48, 20, sub[i][0], sub[i][1], 64, 32);
        check(80, 40, sub[i][0], sub[i][1], 64, 32);
    }
    /* grey: chroma 128 everywhere */
    struct yuv_src g;
    make(&g, 16, 16, 2, 2);
    const uint8_t *keep_u = g.u, *keep_v = g.v;
    g.u = g.v = NULL;
    uint8_t d[16 * 16 * 3 / 2];
    CHECK(yuv_to_i420(&g, d, 16, 16) == 0, "grey refused");
    for (int i = 256; i < 384; i++) CHECK(d[i] == 128, "grey chroma %d at %d", d[i], i);
    /* 4:4:0 is refused */
    g.u = keep_u; g.v = keep_v; g.sx = 1; g.sy = 2;
    CHECK(yuv_to_i420(&g, d, 16, 16) == -1, "4:4:0 accepted");
    free((void *)g.y); free((void *)keep_u); free((void *)keep_v);
    if (fails) return 1;
    printf("yuv_test: ok\n");
    return 0;
}
