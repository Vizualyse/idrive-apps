// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * H.264 access units in, I420 pictures of a fixed size out, into memory the
 * caller gives (a slot of mgu-render's frame file).
 *
 *  - msdk: the GPU, through the unit's Intel Media SDK (libmfxhw64.so, API
 *    1.24, VA-API on /dev/dri/renderD128): decode_msdk.c, ported from
 *    upstream's waze-on-cluster decoder_msdk.cpp.
 *  - msdk-sw: the same code on MSDK's software library (libmfxsw64.so), no
 *    VA: the off-car tests' stand-in for the GPU.
 *  - av: software, FFmpeg's H.264 decoder built in (decode_av.c).
 * MSDK and libva are loaded with dlopen: moonlight-core starts on a unit
 * without them, and "auto" falls back from msdk to av.
 *
 * A frame decoded without a picture (pic NULL: we're behind, or the output
 * wants fewer frames) costs the decode only, not the copy out.
 */
#ifndef DECODE_H
#define DECODE_H

#include <stddef.h>
#include <stdint.h>

struct decoder;

/* which: "auto", "msdk", "msdk-sw" or "av". out_w x out_h: the pictures'
 * size, even; the stream is scaled to it. Opens the device and loads the
 * libraries, so call it while still root. NULL with err when none works. */
struct decoder *decoder_open(const char *which, int out_w, int out_h, char *err, size_t n);
/* One whole access unit. pic: out_w*out_h*3/2 bytes of I420 to fill, or
 * NULL. 1: pic filled; 0: no picture (none asked, or none came out yet);
 * -1: the access unit failed, err says why (the next IDR starts over). */
int decoder_decode(struct decoder *d, const uint8_t *au, size_t len, uint8_t *pic, char *err, size_t n);
/* "msdk (GPU, API 1.24, GPU copy, ...)", "av (software, libavcodec 60.31.102, ...)" */
const char *decoder_name(const struct decoder *d);
void decoder_close(struct decoder *d);

/* The backends, for decode.c: each one's state starts with this. */
struct decoder {
    int (*decode)(struct decoder *d, const uint8_t *au, size_t len, uint8_t *pic, char *err, size_t n);
    void (*close)(struct decoder *d);
    char name[128];
};
struct decoder *msdk_open(int hw, int out_w, int out_h, char *err, size_t n);
struct decoder *av_open(int out_w, int out_h, char *err, size_t n);

/* I420 scaling for av's pictures (bilinear; a copy at the same size). */
void scale_plane(const uint8_t *src, int sstride, int sw, int sh, uint8_t *dst, int dw, int dh);

#endif
