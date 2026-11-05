// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
#include "yuv.h"
#include <string.h>

static int min(int a, int b) { return a < b ? a : b; }

int yuv_to_i420(const struct yuv_src *s, uint8_t *dst, int dw, int dh) {
    int grey = !s->u || !s->v;
    if (!grey && !((s->sx == 2 && s->sy == 2) || (s->sx == 2 && s->sy == 1) || (s->sx == 1 && s->sy == 1))) return -1;
    uint8_t *Y = dst, *U = dst + (long)dw * dh, *V = U + (long)(dw / 2) * (dh / 2);
    int cw = min(s->w, dw), chh = min(s->h, dh);
    for (int r = 0; r < dh; r++) {
        uint8_t *o = Y + (long)r * dw;
        if (r < chh) {
            memcpy(o, s->y + (long)r * s->ys, (size_t)cw);
            if (cw < dw) memset(o + cw, 0, (size_t)(dw - cw));
        } else {
            memset(o, 0, (size_t)dw);
        }
    }
    int dcw = dw / 2, dch = dh / 2;
    /* the source's chroma size in its own subsampling */
    int scw = grey ? 0 : (s->w + s->sx - 1) / s->sx, sch = grey ? 0 : (s->h + s->sy - 1) / s->sy;
    for (int r = 0; r < dch; r++) {
        uint8_t *ou = U + (long)r * dcw, *ov = V + (long)r * dcw;
        for (int c = 0; c < dcw; c++) {
            int x = c * 2, y = r * 2;   /* the 2x2 block's top-left luma pixel */
            if (grey || x >= s->w || y >= s->h) { ou[c] = 128; ov[c] = 128; continue; }
            /* source chroma samples covering the block */
            int x0 = x / s->sx, y0 = y / s->sy;
            int x1 = (s->sx == 1) ? min(x0 + 1, scw - 1) : x0;
            int y1 = (s->sy == 1) ? min(y0 + 1, sch - 1) : y0;
            const uint8_t *u0 = s->u + (long)y0 * s->cs, *u1 = s->u + (long)y1 * s->cs;
            const uint8_t *v0 = s->v + (long)y0 * s->cs, *v1 = s->v + (long)y1 * s->cs;
            ou[c] = (uint8_t)((u0[x0] + u0[x1] + u1[x0] + u1[x1] + 2) / 4);
            ov[c] = (uint8_t)((v0[x0] + v0[x1] + v1[x0] + v1[x1] + 2) / 4);
        }
    }
    return 0;
}
