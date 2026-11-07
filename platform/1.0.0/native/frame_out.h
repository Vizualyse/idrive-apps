// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * mgu-render's frame file, written in place (knowledge/central-screen.md):
 * a 64-byte header of u32 LE words (0 magic "MGVF", 1 version 1, 2-3 w h,
 * 4 seq, 5 slot, 6 nslot, 7 matrix 0 BT.601 / 1 BT.709, 8 range 0 limited /
 * 1 full), then nslot I420 frames of w x h with no padding. server.js
 * creates the file (root-owned, as the renderer wants); the producer
 * (moonlight-core, chromium-wl, wl-sink) maps it and fills slot
 * (slot+1) % nslot, then sets slot, then seq + 1.
 */
#ifndef FRAME_OUT_H
#define FRAME_OUT_H

#include <stddef.h>
#include <stdint.h>

#define FRAME_MAGIC 0x4656474du

struct frame_out {
    uint8_t *map;
    size_t size;
    int w, h, nslot;
    uint32_t seq, slot;
};

/* Maps an existing frame file: 0, or -1 with err. */
int frame_out_open(struct frame_out *f, const char *path, char *err, size_t n);
/* The colour words, as the stream was asked for. */
void frame_out_colour(struct frame_out *f, int bt709, int full_range);
/* The slot to fill next: w*h*3/2 bytes of I420. */
uint8_t *frame_out_next(struct frame_out *f);
/* Shows the slot frame_out_next gave. */
void frame_out_publish(struct frame_out *f);
void frame_out_close(struct frame_out *f);

#endif
