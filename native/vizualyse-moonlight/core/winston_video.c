// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The stream's pictures through Winston: winston_video.h. */
#define _GNU_SOURCE
#include "winston_video.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include "winston_out.h"

#define NBUF 3
#define GBM_FORMAT_R8 0x20203852u
#define DRM_FORMAT_NV12 0x3231564eu
#define GBM_BO_USE_RENDERING 4u
#define GBM_BO_USE_LINEAR 16u
#define GBM_BO_TRANSFER_WRITE 2u
#define MOD_NONE 0x00ffffffffffffffull   /* DRM_FORMAT_MOD_INVALID: no modifier said */
#define HINT_SECONDS 10
#define HINT_MARGIN 40

struct wv {
    struct wo *wo;
    void *gbm_lib, *gdev;
    int dfd;
    void *(*create_device)(int);
    void (*device_destroy)(void *);
    void *(*bo_create)(void *, uint32_t, uint32_t, uint32_t, uint32_t);
    void (*bo_destroy)(void *);
    int (*bo_get_fd)(void *);
    uint32_t (*bo_get_stride)(void *);
    void *(*bo_map)(void *, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t *, void **);
    void (*bo_unmap)(void *, void *);
    void *bo[NBUF];
    struct wo_buf *buf[NBUF];
    uint32_t stride;
    int w, h, cur;
    int pw, ph;                 /* the place's size: the hint's position */
    void *map_data;
    uint32_t *hint;
    int hint_w, hint_h, hint_shown, shown;
    long hint_until;
    char name[96];
};

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}

static void wv_log(void *ud, const char *m) { (void)ud; fprintf(stderr, "winston: %s\n", m); }

/* The stop hint: "MLHI", w, h (u32 LE), then premultiplied RGBA; as ARGB words. */
static void load_hint(struct wv *v, const char *path) {
    FILE *f = path ? fopen(path, "rb") : NULL;
    if (!f) return;
    unsigned char hdr[12];
    if (fread(hdr, 1, 12, f) == 12 && !memcmp(hdr, "MLHI", 4)) {
        int w = hdr[4] | hdr[5] << 8 | hdr[6] << 16 | hdr[7] << 24, h = hdr[8] | hdr[9] << 8 | hdr[10] << 16 | hdr[11] << 24;
        unsigned char *rgba = w > 0 && h > 0 && w <= 2048 && h <= 1024 ? malloc((size_t)w * h * 4) : NULL;
        if (rgba && fread(rgba, 4, (size_t)w * h, f) == (size_t)w * h && (v->hint = malloc((size_t)w * h * 4))) {
            for (long i = 0; i < (long)w * h; i++)
                v->hint[i] = (uint32_t)rgba[i * 4 + 3] << 24 | (uint32_t)rgba[i * 4] << 16 | (uint32_t)rgba[i * 4 + 1] << 8 | rgba[i * 4 + 2];
            v->hint_w = w; v->hint_h = h;
        }
        free(rgba);
    }
    fclose(f);
}

struct wv *wv_open(const char *socket, int w, int h, int px, int py, int pw, int ph,
                   const char *hint, char *err, size_t n) {
    struct wv *v = calloc(1, sizeof *v);
    if (!v) { snprintf(err, n, "no memory"); return NULL; }
    v->dfd = -1;
    v->w = w; v->h = h; v->cur = -1;
    v->pw = pw; v->ph = ph;
    char e[256];
    struct wo_opts o = { .socket = socket, .x = px, .y = py, .w = pw, .h = ph, .log = wv_log, .backdrop = 2 };
    if (!(v->wo = wo_open(&o, e, sizeof e))) { snprintf(err, n, "%s", e); wv_close(v); return NULL; }
    if (!wo_has_dmabuf_format(v->wo, DRM_FORMAT_NV12)) { snprintf(err, n, "Winston takes no NV12 dmabufs"); wv_close(v); return NULL; }
    /* the unit's libgbm (Mesa 19, i965) on the render node */
    if (!(v->gbm_lib = dlopen("libgbm.so.1", RTLD_NOW | RTLD_GLOBAL))) { snprintf(err, n, "libgbm: %s", dlerror()); wv_close(v); return NULL; }
#define S(f, s) if (!(v->f = dlsym(v->gbm_lib, s))) { snprintf(err, n, "libgbm lacks %s", s); wv_close(v); return NULL; }
    S(create_device, "gbm_create_device"); S(device_destroy, "gbm_device_destroy");
    S(bo_create, "gbm_bo_create"); S(bo_destroy, "gbm_bo_destroy"); S(bo_get_fd, "gbm_bo_get_fd");
    S(bo_get_stride, "gbm_bo_get_stride"); S(bo_map, "gbm_bo_map"); S(bo_unmap, "gbm_bo_unmap");
#undef S
    if ((v->dfd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC)) < 0 || !(v->gdev = v->create_device(v->dfd))) {
        snprintf(err, n, "no GBM device on /dev/dri/renderD128: %s", strerror(errno));
        wv_close(v);
        return NULL;
    }
    for (int i = 0; i < NBUF; i++) {
        v->bo[i] = v->bo_create(v->gdev, (uint32_t)w, (uint32_t)(h * 3 / 2), GBM_FORMAT_R8, GBM_BO_USE_RENDERING | GBM_BO_USE_LINEAR);
        if (!v->bo[i]) { snprintf(err, n, "gbm_bo_create %dx%d R8 failed", w, h * 3 / 2); wv_close(v); return NULL; }
        uint32_t stride = v->bo_get_stride(v->bo[i]);
        if (i && stride != v->stride) { snprintf(err, n, "GBM strides differ"); wv_close(v); return NULL; }
        v->stride = stride;
        int fd = v->bo_get_fd(v->bo[i]);
        int fds[2] = { fd, fd };
        uint32_t offs[2] = { 0, stride * (uint32_t)h }, strides[2] = { stride, stride };
        v->buf[i] = fd >= 0 ? wo_buf_dmabuf_planes(v->wo, 2, fds, offs, strides, w, h, DRM_FORMAT_NV12, MOD_NONE) : NULL;
        if (fd >= 0) close(fd);
        if (!v->buf[i]) { snprintf(err, n, "Winston refused an NV12 dmabuf %dx%d stride %u", w, h, stride); wv_close(v); return NULL; }
    }
    load_hint(v, hint);
    snprintf(v->name, sizeof v->name, "NV12 dmabufs %dx%d, stride %u, place %dx%d+%d+%d", w, h, v->stride, pw, ph, px, py);
    return v;
}

long wv_socket_gid(struct wv *v) { return wo_socket_gid(v->wo); }
int wv_lost(struct wv *v) { return wo_poll(v->wo) < 0; }
const char *wv_name(struct wv *v) { return v->name; }

uint8_t *wv_begin(struct wv *v, struct decoder *d) {
    if (wo_poll(v->wo) < 0) return NULL;   /* Winston's releases first */
    if (!v->shown) {
        if (wo_show(v->wo, 1) < 0) return NULL;
        v->shown = 1;
    }
    for (int k = 1; k <= NBUF; k++) {
        int i = (v->cur + k) % NBUF;
        if (wo_buf_busy(v->buf[i])) continue;
        uint32_t st = 0;
        void *p = v->bo_map(v->bo[i], 0, 0, (uint32_t)v->w, (uint32_t)(v->h * 3 / 2), GBM_BO_TRANSFER_WRITE, &st, &v->map_data);
        if (!p) return NULL;
        if (st != v->stride) {   /* a linear buffer maps in place: never seen otherwise */
            v->bo_unmap(v->bo[i], v->map_data);
            return NULL;
        }
        v->cur = i;
        decoder_nv12(d, (int)st, (size_t)st * (size_t)v->h);
        return p;
    }
    return NULL;
}

void wv_end(struct wv *v, int got) {
    if (v->cur < 0 || !v->map_data) return;
    v->bo_unmap(v->bo[v->cur], v->map_data);
    v->map_data = NULL;
    if (!got) return;
    if (wo_present(v->wo, v->buf[v->cur], v->w, v->h) < 0) return;
    if (v->hint && !v->hint_shown) {
        /* the stop hint over the picture, at the bottom centre, for its time */
        v->hint_shown = 1;
        v->hint_until = now_ms() + HINT_SECONDS * 1000L;
        int x = (v->pw - v->hint_w) / 2, y = v->ph - v->hint_h - HINT_MARGIN;
        wo_overlay(v->wo, v->hint, v->hint_w, v->hint_h, x < 0 ? 0 : x, y < 0 ? 0 : y);
    }
    if (v->hint_shown == 1 && now_ms() > v->hint_until) { wo_overlay_hide(v->wo); v->hint_shown = 2; }
}

void wv_close(struct wv *v) {
    if (!v) return;
    for (int i = 0; i < NBUF; i++) {
        if (v->buf[i]) wo_buf_free(v->buf[i]);
        if (v->bo[i]) v->bo_destroy(v->bo[i]);
    }
    if (v->wo) wo_close(v->wo);
    if (v->gdev) v->device_destroy(v->gdev);
    if (v->dfd >= 0) close(v->dfd);
    free(v->hint);
    free(v);
}
