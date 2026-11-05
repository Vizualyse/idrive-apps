// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * A decoded JPEG's YCbCr planes (in its own subsampling) into an I420 picture
 * of another size: copied into the top-left corner, cut off where it is
 * bigger, black (full range: Y 0, Cb Cr 128) where it is smaller. Chroma
 * subsampled 2x1 or 1x1 is averaged down to 2x2. Pure: yuv_test.c.
 */
#pragma once
#include <stdint.h>

struct yuv_src {
    const uint8_t *y, *u, *v;   /* u, v NULL: greyscale */
    int ys, cs;                 /* strides */
    int w, h;                   /* the picture */
    int sx, sy;                 /* chroma subsampling: 2 2 (4:2:0), 2 1 (4:2:2), 1 1 (4:4:4) */
};

/* 0, or -1 for a subsampling it doesn't take (dst untouched). dw, dh even. */
int yuv_to_i420(const struct yuv_src *s, uint8_t *dst, int dw, int dh);
