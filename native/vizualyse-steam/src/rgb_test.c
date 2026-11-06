// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* rgb.c's conversion: known colours, and a block's chroma averaged. */
#include "rgb.h"
#include <stdio.h>
#include <stdlib.h>

static int fails;
static void near(const char *what, int got, int want) {
    if (abs(got - want) > 1) { printf("rgb_test: %s = %d, want %d\n", what, got, want); fails++; }
}

static void one(uint32_t px, int y, int u, int v, const char *name) {
    uint32_t src[4] = { px, px, px, px };
    uint8_t dst[6];
    xrgb_to_i420(src, 2, 2, 2, dst);
    char w[64];
    for (int i = 0; i < 4; i++) { snprintf(w, sizeof w, "%s Y%d", name, i); near(w, dst[i], y); }
    snprintf(w, sizeof w, "%s U", name); near(w, dst[4], u);
    snprintf(w, sizeof w, "%s V", name); near(w, dst[5], v);
}

int main(void) {
    one(0x000000, 0, 128, 128, "black");
    one(0xffffff, 255, 128, 128, "white");
    one(0xff0000, 76, 85, 255, "red");
    one(0x00ff00, 149, 43, 21, "green");
    one(0x0000ff, 29, 255, 107, "blue");
    one(0x336699, 92, 161, 98, "336699");
    /* a block of black and white: Y per pixel, chroma neutral */
    uint32_t mix[4] = { 0x000000, 0xffffff, 0xffffff, 0x000000 };
    uint8_t d[6];
    xrgb_to_i420(mix, 2, 2, 2, d);
    near("mix Y0", d[0], 0); near("mix Y1", d[1], 255); near("mix U", d[4], 128); near("mix V", d[5], 128);
    /* stride wider than the picture: the extra column is ignored */
    uint32_t wide[6] = { 0xff0000, 0xff0000, 0x00ff00, 0xff0000, 0xff0000, 0x00ff00 };
    xrgb_to_i420(wide, 3, 2, 2, d);
    near("stride Y", d[3], 76); near("stride V", d[5], 255);
    if (fails) return 1;
    printf("rgb_test: ok\n");
    return 0;
}
