// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The compositor's picture (XRGB8888, one u32 per pixel, 0x00RRGGBB) into
 * mgu-render's I420, BT.601 full range (the frame file says so): each 2x2
 * block's chroma is the average of its four pixels. Pure: rgb_test.c.
 */
#pragma once
#include <stdint.h>

/* src: w x h pixels, stride in pixels; dst: w*h*3/2 bytes. w, h even. */
void xrgb_to_i420(const uint32_t *src, int stride, int w, int h, uint8_t *dst);
