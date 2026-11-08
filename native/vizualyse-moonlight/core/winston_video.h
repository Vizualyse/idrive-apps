// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The stream's pictures straight onto the centre screen through Winston
 * (platform native/winston_out, knowledge/central-screen.md "Winston
 * directly"), instead of mgu-render's I420 frame file:
 *
 *  - three GPU buffers (GBM on the render node, through the unit's libgbm,
 *    dlopened), linear, each one NV12: w x h of Y, then w x h/2 of U,V
 *    interleaved (an "R8" buffer of h * 3/2 rows);
 *  - the decoder writes a picture straight into a free one (decoder_nv12:
 *    MSDK's NV12 rows as they are, libavcodec's I420 interleaved), mapped
 *    for that picture only (the unmap makes it the GPU's);
 *  - Winston gets each as an NV12 dmabuf (two planes, one buffer) and
 *    converts it on the GPU; fitted into the place, black around it (the
 *    backdrop: the same bars as mgu-render's); a buffer is written again only
 *    once Winston released it;
 *  - the stop hint (MLHI, premultiplied RGBA) as an overlay at the bottom
 *    centre for the first 10 s.
 *
 * All calls from one thread at a time: wv_open on the main thread (while
 * root: Winston's socket, the render node), the per-picture ones on the
 * decoder's, wv_close after it stopped.
 */
#ifndef WINSTON_VIDEO_H
#define WINSTON_VIDEO_H

#include <stddef.h>
#include <stdint.h>
#include "decode.h"

struct wv;

/* w x h: the pictures (even); px..ph: the place on the screen; hint: an MLHI
 * file or NULL. NULL with err when Winston or the buffers aren't there. */
struct wv *wv_open(const char *socket, int w, int h, int px, int py, int pw, int ph,
                   const char *hint, char *err, size_t n);
/* Winston's socket group (keep it after a privilege drop), or -1. */
long wv_socket_gid(struct wv *v);
/* A free buffer's mapping for the next picture, the decoder told its NV12
 * layout; NULL when none is free (Winston still shows them all) or the
 * connection is lost (wv_lost). */
uint8_t *wv_begin(struct wv *v, struct decoder *d);
/* After wv_begin: unmapped; shown when the decoder gave a picture (got 1). */
void wv_end(struct wv *v, int got);
/* The connection to Winston is gone (the caller goes back to the frame file). */
int wv_lost(struct wv *v);
/* "NV12 dmabufs 1280x720, stride 1280" */
const char *wv_name(struct wv *v);
void wv_close(struct wv *v);

#endif
