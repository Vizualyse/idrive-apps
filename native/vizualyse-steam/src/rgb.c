// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
#include "rgb.h"

/* BT.601 full range, 8-bit fixed point (JFIF's coefficients). */
static inline uint8_t clamp8(int v) { return (uint8_t)(v < 0 ? 0 : v > 255 ? 255 : v); }

void xrgb_to_i420(const uint32_t *src, int stride, int w, int h, uint8_t *dst) {
    uint8_t *Y = dst, *U = dst + (long)w * h, *V = U + (long)(w / 2) * (h / 2);
    for (int r = 0; r < h; r += 2) {
        const uint32_t *p0 = src + (long)r * stride, *p1 = p0 + stride;
        uint8_t *y0 = Y + (long)r * w, *y1 = y0 + w;
        uint8_t *u = U + (long)(r / 2) * (w / 2), *v = V + (long)(r / 2) * (w / 2);
        for (int c = 0; c < w; c += 2) {
            int rs = 0, gs = 0, bs = 0;
            const uint32_t px[4] = { p0[c], p0[c + 1], p1[c], p1[c + 1] };
            uint8_t *yo[4] = { &y0[c], &y0[c + 1], &y1[c], &y1[c + 1] };
            for (int k = 0; k < 4; k++) {
                int R = (px[k] >> 16) & 0xff, G = (px[k] >> 8) & 0xff, B = px[k] & 0xff;
                *yo[k] = clamp8((77 * R + 150 * G + 29 * B + 128) >> 8);
                rs += R; gs += G; bs += B;
            }
            /* sums of four: the >> 10 is the average's / 4 and the coefficients' / 256 */
            u[c / 2] = clamp8(((-43 * rs - 85 * gs + 128 * bs + 512) >> 10) + 128);
            v[c / 2] = clamp8(((128 * rs - 107 * gs - 21 * bs + 512) >> 10) + 128);
        }
    }
}
