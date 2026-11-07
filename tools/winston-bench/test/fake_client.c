// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * fake_client: stands in for Chromium or Wine in front of our compositors
 * (chromium-wl, wl-sink) on the Winston bench: one xdg toplevel that draws
 * wo_bench's test pattern (quadrants red, green, blue, white) at the size it
 * is configured to, a new picture per frame callback, into
 *   shm  shared memory (as Chromium on the CPU), or
 *   drm  GBM buffers on the render node handed over as wl_drm PRIME buffers
 *        (as Mesa's Wayland EGL does for Chromium's GPU mode and Wine's GL).
 * Buffers are reused only once the compositor released them.
 *   fake_client shm|drm|wine SOCKET SECONDS   (wine: drm, as Wine draws: a software
 *        window frame as the toplevel, the GL area a subsurface over it)
 * stdout: {"ev":"done","frames":n,"releases":n,"size":[w,h]}
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "xdg-shell-client-protocol.h"
#include "wayland-drm-client-protocol.h"

#define NBUF 3

static struct wl_compositor *comp;
static struct wl_subcompositor *subcomp;
static struct wl_shm *shm;
static struct xdg_wm_base *wm;
static struct wl_drm *drm;
static int cfg_w, cfg_h, configured, frame_due = 1, frames, releases;

struct buf { struct wl_buffer *wb; uint32_t *pix; void *bo; int busy, w, h, stride; };
static struct buf bufs[NBUF];

static struct {
    void *(*create_device)(int);
    void *(*bo_create)(void *, uint32_t, uint32_t, uint32_t, uint32_t);
    int (*bo_get_fd)(void *);
    uint32_t (*bo_get_stride)(void *);
    void *(*bo_map)(void *, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t *, void **);
    void (*bo_unmap)(void *, void *);
    void *dev;
} g;

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}

static void pattern(uint32_t *p, int stride_px, int w, int h, int n) {
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            uint32_t c = y < h / 2 ? (x < w / 2 ? 0xffff0000u : 0xff00ff00u) : (x < w / 2 ? 0xff0000ffu : 0xffffffffu);
            int mx = w / 2 + (n * 8) % (w / 2 - 8), my = h * 3 / 4;
            if (x >= mx && x < mx + 8 && y >= my && y < my + 8) c = 0xff000000u;
            p[(long)y * stride_px + x] = c;
        }
}

static void released(void *d, struct wl_buffer *wb) { struct buf *b = d; (void)wb; b->busy = 0; releases++; }
static const struct wl_buffer_listener buf_listener = { released };

static void make_buffers(int use_drm, int w, int h) {
    for (int i = 0; i < NBUF; i++) {
        struct buf *b = &bufs[i];
        if (b->wb) wl_buffer_destroy(b->wb);
        memset(b, 0, sizeof *b);
        b->w = w; b->h = h;
        if (!use_drm) {
            int fd = (int)syscall(SYS_memfd_create, "fake", 1u);
            if (fd < 0 || ftruncate(fd, (off_t)w * h * 4) < 0) exit(1);
            b->pix = mmap(NULL, (size_t)w * h * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
            struct wl_shm_pool *p = wl_shm_create_pool(shm, fd, w * h * 4);
            b->wb = wl_shm_pool_create_buffer(p, 0, w, h, w * 4, WL_SHM_FORMAT_XRGB8888);
            b->stride = w * 4;
            wl_shm_pool_destroy(p);
            close(fd);
        } else {
            b->bo = g.bo_create(g.dev, (uint32_t)w, (uint32_t)h, 0x34325258u /* XR24 */, 4 | 16);
            if (!b->bo) { fprintf(stderr, "gbm_bo_create failed\n"); exit(1); }
            int fd = g.bo_get_fd(b->bo);
            b->stride = (int)g.bo_get_stride(b->bo);
            b->wb = wl_drm_create_prime_buffer(drm, fd, w, h, WL_DRM_FORMAT_XRGB8888, 0, b->stride, 0, 0, 0, 0);
            close(fd);
        }
        wl_buffer_add_listener(b->wb, &buf_listener, b);
    }
}

static void frame_done(void *d, struct wl_callback *cb, uint32_t t) { (void)d; (void)t; wl_callback_destroy(cb); frame_due = 1; frames++; }
static const struct wl_callback_listener frame_listener = { frame_done };

static void wm_ping(void *d, struct xdg_wm_base *w, uint32_t s) { (void)d; xdg_wm_base_pong(w, s); }
static const struct xdg_wm_base_listener wm_listener = { wm_ping };
static void xs_configure(void *d, struct xdg_surface *s, uint32_t serial) { (void)d; xdg_surface_ack_configure(s, serial); configured = 1; }
static const struct xdg_surface_listener xs_listener = { xs_configure };
static void top_configure(void *d, struct xdg_toplevel *t, int32_t w, int32_t h, struct wl_array *st) {
    (void)d; (void)t; (void)st;
    if (w > 0 && h > 0) { cfg_w = w; cfg_h = h; }
}
static void top_close(void *d, struct xdg_toplevel *t) { (void)d; (void)t; }
static const struct xdg_toplevel_listener top_listener = { top_configure, top_close };

static void drm_device(void *d, struct wl_drm *w, const char *name) { (void)d; (void)w; fprintf(stderr, "wl_drm device %s\n", name); }
static void drm_format(void *d, struct wl_drm *w, uint32_t f) { (void)d; (void)w; (void)f; }
static void drm_authenticated(void *d, struct wl_drm *w) { (void)d; (void)w; }
static void drm_caps(void *d, struct wl_drm *w, uint32_t c) { (void)d; (void)w; (void)c; }
static const struct wl_drm_listener drm_listener = { drm_device, drm_format, drm_authenticated, drm_caps };

static void global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    (void)d;
    if (!strcmp(iface, "wl_compositor")) comp = wl_registry_bind(r, name, &wl_compositor_interface, 4);
    else if (!strcmp(iface, "wl_subcompositor")) subcomp = wl_registry_bind(r, name, &wl_subcompositor_interface, 1);
    else if (!strcmp(iface, "wl_shm")) shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
    else if (!strcmp(iface, "xdg_wm_base")) { wm = wl_registry_bind(r, name, &xdg_wm_base_interface, 1); xdg_wm_base_add_listener(wm, &wm_listener, NULL); }
    else if (!strcmp(iface, "wl_drm")) { drm = wl_registry_bind(r, name, &wl_drm_interface, ver < 2 ? ver : 2); wl_drm_add_listener(drm, &drm_listener, NULL); }
}
static void global_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d; (void)r; (void)n; }
static const struct wl_registry_listener reg_listener = { global, global_remove };

int main(int argc, char **argv) {
    if (argc < 4) { fprintf(stderr, "usage: fake_client shm|drm|wine SOCKET SECONDS\n"); return 2; }
    int wine = !strcmp(argv[1], "wine");
    int use_drm = wine || !strcmp(argv[1], "drm");
    int seconds = atoi(argv[3]);
    struct wl_display *dpy = NULL;
    for (int i = 0; i < 50 && !(dpy = wl_display_connect(argv[2])); i++) usleep(100000);
    if (!dpy) { fprintf(stderr, "cannot connect to %s\n", argv[2]); return 1; }
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &reg_listener, NULL);
    wl_display_roundtrip(dpy);
    wl_display_roundtrip(dpy);
    if (!comp || !shm || !wm || (use_drm && !drm)) { fprintf(stderr, "missing globals (wl_drm: %p)\n", (void *)drm); return 1; }
    if (use_drm) {
        void *lib = dlopen("libgbm.so.1", RTLD_NOW | RTLD_GLOBAL);
        if (!lib) { fprintf(stderr, "no libgbm\n"); return 1; }
        g.create_device = dlsym(lib, "gbm_create_device"); g.bo_create = dlsym(lib, "gbm_bo_create");
        g.bo_get_fd = dlsym(lib, "gbm_bo_get_fd"); g.bo_get_stride = dlsym(lib, "gbm_bo_get_stride");
        g.bo_map = dlsym(lib, "gbm_bo_map"); g.bo_unmap = dlsym(lib, "gbm_bo_unmap");
        int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
        g.dev = fd >= 0 ? g.create_device(fd) : NULL;
        if (!g.dev) { fprintf(stderr, "no GBM device\n"); return 1; }
    }
    struct wl_surface *s = wl_compositor_create_surface(comp), *frame_s = NULL;
    if (wine) {
        /* Wine's way: the window (its frame, drawn in software) is the
         * toplevel; the GL / Direct3D client area a subsurface over it */
        frame_s = s;
        s = wl_compositor_create_surface(comp);
    }
    struct xdg_surface *xs = xdg_wm_base_get_xdg_surface(wm, wine ? frame_s : s);
    xdg_surface_add_listener(xs, &xs_listener, NULL);
    struct xdg_toplevel *top = xdg_surface_get_toplevel(xs);
    xdg_toplevel_add_listener(top, &top_listener, NULL);
    xdg_toplevel_set_title(top, "fake client");
    wl_surface_commit(wine ? frame_s : s);
    while (!configured && wl_display_dispatch(dpy) >= 0) {}
    int w = cfg_w > 0 ? cfg_w : 640, h = cfg_h > 0 ? cfg_h : 360;
    if (wine) {
        /* the frame: a grey shm buffer 20 px wider, 40 taller (title bar), drawn once */
        int fw = w + 20, fh = h + 40;
        int fd = (int)syscall(SYS_memfd_create, "frame", 1u);
        if (fd < 0 || ftruncate(fd, (off_t)fw * fh * 4) < 0) return 1;
        uint32_t *fp = mmap(NULL, (size_t)fw * fh * 4, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        for (long i = 0; i < (long)fw * fh; i++) fp[i] = 0xff808080u;
        struct wl_shm_pool *p = wl_shm_create_pool(shm, fd, fw * fh * 4);
        struct wl_buffer *fb = wl_shm_pool_create_buffer(p, 0, fw, fh, fw * 4, WL_SHM_FORMAT_XRGB8888);
        wl_shm_pool_destroy(p);
        close(fd);
        struct wl_subsurface *sub = wl_subcompositor_get_subsurface(subcomp, s, frame_s);
        wl_subsurface_set_position(sub, 10, 30);
        wl_subsurface_set_desync(sub);
        wl_surface_attach(frame_s, fb, 0, 0);
        wl_surface_damage(frame_s, 0, 0, fw, fh);
        wl_surface_commit(frame_s);
    }
    make_buffers(use_drm, w, h);
    long end = now_ms() + seconds * 1000L;
    int n = 0, stalls = 0;
    while (now_ms() < end) {
        if (cfg_w > 0 && (cfg_w != w || cfg_h != h)) { w = cfg_w; h = cfg_h; make_buffers(use_drm, w, h); }
        if (frame_due) {
            struct buf *b = NULL;
            for (int i = 0; i < NBUF && !b; i++) if (!bufs[(n + i) % NBUF].busy) b = &bufs[(n + i) % NBUF];
            if (b) {
                if (use_drm) {
                    void *md = NULL; uint32_t st = 0;
                    uint32_t *p = g.bo_map(b->bo, 0, 0, (uint32_t)w, (uint32_t)h, 2, &st, &md);
                    if (p) { pattern(p, (int)st / 4, w, h, n); g.bo_unmap(b->bo, md); }
                } else {
                    pattern(b->pix, w, w, h, n);
                }
                wl_surface_attach(s, b->wb, 0, 0);
                wl_surface_damage(s, 0, 0, w, h);
                struct wl_callback *cb = wl_surface_frame(s);
                wl_callback_add_listener(cb, &frame_listener, NULL);
                wl_surface_commit(s);
                b->busy = 1;
                frame_due = 0;
                n++;
            } else {
                stalls++;
            }
        }
        wl_display_flush(dpy);
        struct pollfd pf = { wl_display_get_fd(dpy), POLLIN, 0 };
        if (poll(&pf, 1, 20) > 0 && wl_display_dispatch(dpy) < 0) { fprintf(stderr, "connection lost\n"); return 1; }
        wl_display_dispatch_pending(dpy);
    }
    printf("{\"ev\":\"done\",\"frames\":%d,\"releases\":%d,\"stalls\":%d,\"size\":[%d,%d]}\n", frames, releases, stalls, w, h);
    return 0;
}
