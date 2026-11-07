// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * winston_out: our pictures straight onto the centre screen as a native
 * client of Winston, the head unit's compositor (/run/wayland/wayland-0,
 * knowledge/central-screen.md, "Winston"), instead of mgu-render's I420
 * frame file. One ivi surface on an ivi layer of our own, above the HMI,
 * shows buffers as they are: a client's shared memory (its pool's fd, passed
 * on) or a GPU buffer (a dmabuf, through zwp_linux_dmabuf_v1). Nothing is
 * copied or converted on the way; Winston scales the picture to the place.
 *
 * How the layer is put on the screen follows mgu-render's layer mode
 * (mgu-store native/mgu-render/src/main.c, relist.c, GPL-3.0), seen working
 * on iDrive 7: the surface and layer through ivi_controller; the layer onto
 * the screen's list through a connection made for it (Winston applies a
 * screen's add_layer to the list as that connection last saw it), back on
 * when the HMI takes it off (its scene changes do), at most 5 times in 10 s;
 * no input region, so touch stays with the HMI; hidden while a camera or
 * video surface shows (the reversing camera).
 *
 * Single-threaded: call everything from the thread that runs the loop, and
 * wo_dispatch() when wo_fd() is readable, wo_flush() after a batch of calls.
 */
#ifndef WINSTON_OUT_H
#define WINSTON_OUT_H

#include <stddef.h>
#include <stdint.h>

struct wo;
struct wo_pool;
struct wo_buf;

/* wl_shm's codes for the two shared memory formats every client has */
#define WO_SHM_ARGB8888 0
#define WO_SHM_XRGB8888 1

struct wo_opts {
    const char *socket;        /* a path, or a name in $XDG_RUNTIME_DIR; NULL: /run/wayland/wayland-0 */
    uint32_t surface_id;       /* ivi ids of our own (0: 0x565a0100 / 0x565a0000, "VZ") */
    uint32_t layer_id;
    int x, y, w, h;            /* the place on the centre screen (wo_place changes it) */
    const uint32_t *yield;     /* surfaces that hide us while visible; NULL: the cameras 0x197 0x198 0x19d 0x19f */
    int nyield;
    void *ud;
    void (*log)(void *ud, const char *msg);
    /* Winston has shown the last picture: time for the next (a frame callback) */
    void (*frame)(void *ud);
    /* a yield surface showed (1) or went (0): we are hidden meanwhile */
    void (*yielding)(void *ud, int on);
};

/* Connects; nothing shows yet. NULL with err on failure. */
struct wo *wo_open(const struct wo_opts *o, char *err, size_t n);
void wo_close(struct wo *w);
/* The connection's fd: wo_dispatch() when it is readable. */
int wo_fd(struct wo *w);
/* Reads and handles what Winston said; -1 once the connection is lost. */
int wo_dispatch(struct wo *w);
/* Sends what is queued; -1 once the connection is lost. */
int wo_flush(struct wo *w);
/* What Winston offers: zwp_linux_dmabuf_v1's version (0: none), and whether
 * shm format f (a wl_shm code) and dmabuf format f (a DRM fourcc) are in it. */
int wo_dmabuf_version(struct wo *w);
int wo_has_shm_format(struct wo *w, uint32_t f);
int wo_has_dmabuf_format(struct wo *w, uint32_t f);

/* Shared memory: a pool from a client's fd (dup'ed: the caller keeps its own). */
struct wo_pool *wo_pool_new(struct wo *w, int fd, int32_t size);
void wo_pool_resize(struct wo_pool *p, int32_t size);
/* Buffers made from a pool outlive it. */
void wo_pool_free(struct wo_pool *p);
struct wo_buf *wo_buf_shm(struct wo_pool *p, int32_t offset, int width, int height, int stride, uint32_t shm_format);
/* A GPU buffer: one plane (fd dup'ed), a DRM fourcc and modifier
 * (DRM_FORMAT_MOD_INVALID, ~0, when the client didn't say). NULL when
 * Winston refused it. */
struct wo_buf *wo_buf_dmabuf(struct wo *w, int fd, int width, int height, uint32_t fourcc,
                             uint32_t offset, uint32_t stride, uint64_t modifier);
/* Called once Winston no longer reads the buffer after a present. */
void wo_buf_on_release(struct wo_buf *b, void (*cb)(void *data, struct wo_buf *b), void *data);
int wo_buf_busy(const struct wo_buf *b);
void wo_buf_free(struct wo_buf *b);

/* On (1) or off (0). The surface and its layer are made at the first show
 * and destroyed at wo_hide(); off only hides them. */
int wo_show(struct wo *w, int on);
void wo_hide(struct wo *w);
/* The place on the screen; the picture is fitted into it, aspect kept, centred. */
void wo_place(struct wo *w, int x, int y, int width, int height);
/* Shows the top left src_w x src_h of b (the whole buffer when 0). The
 * buffer is busy until its release. 0, or -1 when not shown. */
int wo_present(struct wo *w, struct wo_buf *b, int src_w, int src_h);
/* A camera or video surface is visible: we are hidden meanwhile. */
int wo_yielding(struct wo *w);

/* Our own shared memory for pictures we make (several surfaces composed, a
 * GPU buffer read back): nbuf buffers of w x h XRGB8888, the next free one
 * each time. NULL when all are busy (Winston still reads them). */
struct wo_ring;
struct wo_ring *wo_ring_new(struct wo *w, int width, int height, int nbuf);
void wo_ring_free(struct wo_ring *r);
/* A free buffer's pixels (stride width * 4), and the buffer to present. */
uint32_t *wo_ring_next(struct wo_ring *r, struct wo_buf **b);

#endif
