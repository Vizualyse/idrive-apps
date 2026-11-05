// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
#include "decode.h"

#include <stdio.h>
#include <string.h>

struct decoder *decoder_open(const char *which, int out_w, int out_h, char *err, size_t n) {
    if (out_w < 16 || out_h < 16 || (out_w | out_h) & 1) { snprintf(err, n, "bad output size %dx%d", out_w, out_h); return NULL; }
    if (!which || !*which) which = "auto";
    if (strcmp(which, "msdk") == 0) return msdk_open(1, out_w, out_h, err, n);
    if (strcmp(which, "msdk-sw") == 0) return msdk_open(0, out_w, out_h, err, n);
    if (strcmp(which, "av") == 0) return av_open(out_w, out_h, err, n);
    if (strcmp(which, "auto") != 0) { snprintf(err, n, "no decoder \"%s\" (auto, msdk, msdk-sw, av)", which); return NULL; }
    char why[256];
    struct decoder *d = msdk_open(1, out_w, out_h, why, sizeof(why));
    if (d) return d;
    d = av_open(out_w, out_h, err, n);
    if (d) {
        /* the name says why it isn't the GPU */
        size_t l = strlen(d->name);
        snprintf(d->name + l, sizeof(d->name) - l, "; no GPU: %.80s", why);
    } else {
        char av[256];
        snprintf(av, sizeof(av), "%s", err);
        snprintf(err, n, "GPU: %s; libavcodec: %s", why, av);
    }
    return d;
}

int decoder_decode(struct decoder *d, const uint8_t *au, size_t len, uint8_t *pic, char *err, size_t n) {
    return d->decode(d, au, len, pic, err, n);
}

const char *decoder_name(const struct decoder *d) { return d->name; }

void decoder_close(struct decoder *d) { if (d) d->close(d); }

/* Bilinear, 16.16 fixed point, centres aligned. */
void scale_plane(const uint8_t *src, int sstride, int sw, int sh, uint8_t *dst, int dw, int dh) {
    if (sw == dw && sh == dh) {
        for (int y = 0; y < dh; y++) memcpy(dst + (size_t)y * dw, src + (size_t)y * sstride, (size_t)dw);
        return;
    }
    const long fx = ((long)sw << 16) / dw, fy = ((long)sh << 16) / dh;
    for (int y = 0; y < dh; y++) {
        long sy = (long)y * fy + fy / 2 - 32768;
        if (sy < 0) sy = 0;
        int y0 = (int)(sy >> 16), y1 = y0 + 1 < sh ? y0 + 1 : y0;
        unsigned wy = (unsigned)(sy & 0xffff) >> 8;
        const uint8_t *r0 = src + (size_t)y0 * sstride, *r1 = src + (size_t)y1 * sstride;
        uint8_t *o = dst + (size_t)y * dw;
        for (int x = 0; x < dw; x++) {
            long sx = (long)x * fx + fx / 2 - 32768;
            if (sx < 0) sx = 0;
            int x0 = (int)(sx >> 16), x1 = x0 + 1 < sw ? x0 + 1 : x0;
            unsigned wx = (unsigned)(sx & 0xffff) >> 8;
            unsigned top = r0[x0] * (256 - wx) + r0[x1] * wx, bot = r1[x0] * (256 - wx) + r1[x1] * wx;
            o[x] = (uint8_t)((top * (256 - wy) + bot * wy + 32768) >> 16);
        }
    }
}
