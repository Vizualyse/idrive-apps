// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * wo_bench: clients of the real Winston for tools/winston-bench/test/run_test.sh.
 *
 *   wo_bench app shm|dmabuf|ring WxH X,Y,W,H [SECONDS]
 *       the platform's winston_out as our tools use it: a test pattern
 *       (four quadrants red, green, blue, white) of WxH shown at the place,
 *       a new picture each frame callback; events as JSON lines on stdout.
 *       shm: our shared memory pool (as a client's, passed on); dmabuf: a GBM
 *       buffer on the render node (the unit's libgbm, dlopened); ring:
 *       winston_out's own buffers.
 *   wo_bench grab                     the centre screen as Winston composed it, into
 *                                     $KMS_SHIM_GRAB.ppm (kms_shim reads back its next picture)
 *   wo_bench order                    the centre screen's layers, bottom first
 *   wo_bench reset                    the centre screen's layers set again without ours
 *                                     (what the HMI does on a scene change)
 *   wo_bench camera on|off SECONDS    an ivi surface 0x197 (the reversing camera's), visible or not
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "winston_out.h"
#include "ivi-application-client-protocol.h"
#include "ivi-controller-client-protocol.h"

#define OUR_LAYER 0x565a0000u

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}

static void pattern(uint32_t *p, int stride_px, int w, int h, int frame) {
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            uint32_t c = y < h / 2 ? (x < w / 2 ? 0xffff0000u : 0xff00ff00u) : (x < w / 2 ? 0xff0000ffu : 0xffffffffu);
            /* a marker that moves: one 8x8 black square per frame, in the white quadrant */
            int mx = w / 2 + (frame * 8) % (w / 2 - 8), my = h * 3 / 4;
            if (x >= mx && x < mx + 8 && y >= my && y < my + 8) c = 0xff000000u;
            p[(long)y * stride_px + x] = c;
        }
}

/* ---- app ---- */

static int frames, releases, yields;
static void lg(void *ud, const char *m) { (void)ud; printf("{\"ev\":\"log\",\"msg\":\"%s\"}\n", m); fflush(stdout); }
static int want_frame = 1;
static void on_frame(void *ud) { (void)ud; frames++; want_frame = 1; }
static void on_yield(void *ud, int on) { (void)ud; yields++; printf("{\"ev\":\"yield\",\"on\":%d}\n", on); fflush(stdout); }
static void on_release(void *data, struct wo_buf *b) { (void)data; (void)b; releases++; }

struct gbm {
    void *(*create_device)(int);
    void *(*bo_create)(void *, uint32_t, uint32_t, uint32_t, uint32_t);
    int (*bo_get_fd)(void *);
    uint32_t (*bo_get_stride)(void *);
    void *(*bo_map)(void *, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t *, void **);
    void (*bo_unmap)(void *, void *);
};

static int app(int argc, char **argv) {
    if (argc < 4) return 2;
    const char *kind = argv[1];
    int bw, bh, x, y, w, h;
    if (sscanf(argv[2], "%dx%d", &bw, &bh) != 2 || sscanf(argv[3], "%d,%d,%d,%d", &x, &y, &w, &h) != 4) return 2;
    int seconds = argc > 4 ? atoi(argv[4]) : 5;
    char err[256];
    struct wo_opts o = { .x = x, .y = y, .w = w, .h = h, .log = lg, .frame = on_frame, .yielding = on_yield };
    struct wo *wo = wo_open(&o, err, sizeof err);
    if (!wo) { printf("{\"ev\":\"error\",\"error\":\"%s\"}\n", err); return 1; }
    printf("{\"ev\":\"open\",\"dmabuf\":%d,\"xrgb_dmabuf\":%d,\"argb_shm\":%d}\n", wo_dmabuf_version(wo),
           wo_has_dmabuf_format(wo, 0x34325258u), wo_has_shm_format(wo, WO_SHM_ARGB8888));
    fflush(stdout);

    struct wo_buf *bufs[2] = { 0 };
    uint32_t *pix[2] = { 0 };
    struct wo_ring *ring = NULL;
    void *gbm_bo[2] = { 0 };
    struct gbm g;
    memset(&g, 0, sizeof g);
    void *gdev = NULL;
    if (!strcmp(kind, "shm")) {
        size_t one = (size_t)bw * bh * 4;
        int fd = (int)syscall(SYS_memfd_create, "client-pool", 1u);
        if (fd < 0 || ftruncate(fd, (off_t)(one * 2)) < 0) return 1;
        uint8_t *map = mmap(NULL, one * 2, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        struct wo_pool *p = wo_pool_new(wo, fd, (int32_t)(one * 2));
        for (int i = 0; i < 2; i++) {
            pix[i] = (uint32_t *)(map + one * (size_t)i);
            bufs[i] = wo_buf_shm(p, (int32_t)(one * (size_t)i), bw, bh, bw * 4, WO_SHM_XRGB8888);
            wo_buf_on_release(bufs[i], on_release, NULL);
        }
        wo_pool_free(p);
        close(fd);
    } else if (!strcmp(kind, "dmabuf")) {
        void *lib = dlopen("libgbm.so.1", RTLD_NOW | RTLD_GLOBAL);
        if (!lib) { printf("{\"ev\":\"error\",\"error\":\"no libgbm\"}\n"); return 1; }
        g.create_device = dlsym(lib, "gbm_create_device"); g.bo_create = dlsym(lib, "gbm_bo_create");
        g.bo_get_fd = dlsym(lib, "gbm_bo_get_fd"); g.bo_get_stride = dlsym(lib, "gbm_bo_get_stride");
        g.bo_map = dlsym(lib, "gbm_bo_map"); g.bo_unmap = dlsym(lib, "gbm_bo_unmap");
        int dfd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
        gdev = dfd >= 0 ? g.create_device(dfd) : NULL;
        if (!gdev) { printf("{\"ev\":\"error\",\"error\":\"no GBM device\"}\n"); return 1; }
        for (int i = 0; i < 2; i++) {
            /* GBM_FORMAT_XRGB8888, GBM_BO_USE_RENDERING (4) | GBM_BO_USE_LINEAR (16): as a client's frame */
            gbm_bo[i] = g.bo_create(gdev, (uint32_t)bw, (uint32_t)bh, 0x34325258u, 4 | 16);
            if (!gbm_bo[i]) { printf("{\"ev\":\"error\",\"error\":\"gbm_bo_create failed\"}\n"); return 1; }
            int fd = g.bo_get_fd(gbm_bo[i]);
            uint32_t stride = g.bo_get_stride(gbm_bo[i]);
            /* DRM_FORMAT_MOD_INVALID: what a wl_drm client's buffer carries (no modifier said) */
            bufs[i] = wo_buf_dmabuf(wo, fd, bw, bh, 0x34325258u, 0, stride, 0x00ffffffffffffffull);
            close(fd);
            if (!bufs[i]) { printf("{\"ev\":\"error\",\"error\":\"dmabuf refused\"}\n"); fflush(stdout); return 1; }
            wo_buf_on_release(bufs[i], on_release, NULL);
        }
    } else if (!strcmp(kind, "ring")) {
        ring = wo_ring_new(wo, bw, bh, 2);
        if (!ring) { printf("{\"ev\":\"error\",\"error\":\"no ring\"}\n"); return 1; }
    } else {
        return 2;
    }

    if (wo_show(wo, 1) < 0) { printf("{\"ev\":\"error\",\"error\":\"show failed\"}\n"); return 1; }
    long end = now_ms() + seconds * 1000L;
    int n = 0, presents = 0, skipped = 0;
    signal(SIGPIPE, SIG_IGN);
    while (now_ms() < end) {
        if (want_frame) {
            struct wo_buf *b = NULL;
            uint32_t *p = NULL;
            int stride_px = bw;
            if (ring) p = wo_ring_next(ring, &b);
            else {
                int i = n & 1;
                if (!wo_buf_busy(bufs[i])) { b = bufs[i]; p = pix[i]; }
                else if (!wo_buf_busy(bufs[i ^ 1])) { b = bufs[i ^ 1]; p = pix[i ^ 1]; }
            }
            if (b) {
                if (gbm_bo[0]) {
                    void *bo = b == bufs[0] ? gbm_bo[0] : gbm_bo[1], *mapd = NULL;
                    uint32_t st = 0;
                    p = g.bo_map(bo, 0, 0, (uint32_t)bw, (uint32_t)bh, 2 /* WRITE */, &st, &mapd);
                    if (p) { pattern(p, (int)st / 4, bw, bh, n); g.bo_unmap(bo, mapd); }
                } else if (p) {
                    pattern(p, stride_px, bw, bh, n);
                }
                if (wo_present(wo, b, 0, 0) < 0) { printf("{\"ev\":\"error\",\"error\":\"present failed\"}\n"); return 1; }
                presents++; n++;
                want_frame = 0;
            } else {
                skipped++;
            }
        }
        struct pollfd pf = { wo_fd(wo), POLLIN, 0 };
        if (poll(&pf, 1, 50) > 0 && wo_dispatch(wo) < 0) { printf("{\"ev\":\"error\",\"error\":\"lost\"}\n"); return 1; }
        static long last;
        if (now_ms() - last >= 1000) {
            last = now_ms();
            printf("{\"ev\":\"stats\",\"presents\":%d,\"frames\":%d,\"releases\":%d,\"skipped\":%d,\"yielding\":%d}\n",
                   presents, frames, releases, skipped, wo_yielding(wo));
            fflush(stdout);
        }
    }
    printf("{\"ev\":\"done\",\"presents\":%d,\"frames\":%d,\"releases\":%d}\n", presents, frames, releases);
    fflush(stdout);
    if (ring) wo_ring_free(ring);
    wo_close(wo);
    return 0;
}

/* ---- controller-side probes ---- */

struct ctl {
    struct wl_display *dpy;
    struct ivi_controller *ctl;
    struct ivi_application *iapp;
    struct wl_compositor *comp;
    struct wl_shm *shm;
    struct { uint32_t id; struct ivi_controller_screen *s; } screens[8];
    int nscreens;
};
static void c_screen(void *d, struct ivi_controller *c, uint32_t id, struct ivi_controller_screen *s) {
    struct ctl *k = d;
    (void)c;
    if (k->nscreens < 8) { k->screens[k->nscreens].id = id; k->screens[k->nscreens].s = s; k->nscreens++; }
}
static void c_id(void *d, struct ivi_controller *c, uint32_t id) { (void)d; (void)c; (void)id; }
static void c_error(void *d, struct ivi_controller *c, int32_t oid, int32_t ot, int32_t code, const char *t) {
    (void)d; (void)c;
    fprintf(stderr, "ivi error: object %d type %d code %d: %s\n", oid, ot, code, t ? t : "");
}
static const struct ivi_controller_listener c_listener = { c_screen, c_id, c_id, c_error };
static void g_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    struct ctl *k = d;
    (void)ver;
    if (!strcmp(iface, "wl_output")) wl_registry_bind(r, name, &wl_output_interface, 1);
    else if (!strcmp(iface, "ivi_controller")) { k->ctl = wl_registry_bind(r, name, &ivi_controller_interface, 1); ivi_controller_add_listener(k->ctl, &c_listener, k); }
    else if (!strcmp(iface, "ivi_application")) k->iapp = wl_registry_bind(r, name, &ivi_application_interface, 1);
    else if (!strcmp(iface, "wl_compositor")) k->comp = wl_registry_bind(r, name, &wl_compositor_interface, 1);
    else if (!strcmp(iface, "wl_shm")) k->shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
}
static void g_remove(void *d, struct wl_registry *r, uint32_t n) { (void)d; (void)r; (void)n; }
static const struct wl_registry_listener g_listener = { g_global, g_remove };

static int ctl_open(struct ctl *k) {
    memset(k, 0, sizeof *k);
    k->dpy = wl_display_connect(NULL);
    if (!k->dpy) { fprintf(stderr, "cannot connect\n"); return -1; }
    struct wl_registry *r = wl_display_get_registry(k->dpy);
    wl_registry_add_listener(r, &g_listener, k);
    wl_display_roundtrip(k->dpy);
    wl_display_roundtrip(k->dpy);
    return k->ctl && k->nscreens ? 0 : -1;
}
static struct ivi_controller_screen *centre(struct ctl *k) {
    struct ivi_controller_screen *s = NULL;
    uint32_t best = 0xffffffffu;
    for (int i = 0; i < k->nscreens; i++) if (k->screens[i].id < best) { best = k->screens[i].id; s = k->screens[i].s; }
    return s;
}

/* the layer list of the centre screen: each layer's "screen" event says where it is */
struct lq { uint32_t id; int on; };
static void q_int(void *d, struct ivi_controller_layer *l, int32_t v) { (void)d; (void)l; (void)v; }
static void q_op(void *d, struct ivi_controller_layer *l, wl_fixed_t v) { (void)d; (void)l; (void)v; }
static void q_rect(void *d, struct ivi_controller_layer *l, int32_t a, int32_t b, int32_t c, int32_t e) { (void)d; (void)l; (void)a; (void)b; (void)c; (void)e; }
static void q_cfg(void *d, struct ivi_controller_layer *l, int32_t a, int32_t b) { (void)d; (void)l; (void)a; (void)b; }
static void q_screen(void *d, struct ivi_controller_layer *l, struct wl_output *o) { struct lq *q = d; (void)l; q->on = o != NULL; }
static void q_destroyed(void *d, struct ivi_controller_layer *l) { (void)d; (void)l; }
static const struct ivi_controller_layer_listener q_listener = { q_int, q_op, q_rect, q_rect, q_cfg, q_int, q_screen, q_destroyed };

/* The scene provider's layers (the HMI's, from the Winston log) and ours. */
static const uint32_t known[] = { 0x0, 0x1, 0x64, 0xc8, 0xc9, 0xca, 0x190, 0x191, 0x192, 0x193, 0x194, 0x195, 0x196, 0x197,
                                  0x198, 0x199, 0x19b, 0x19c, 0x19d, 0x19e, 0x19f, 0x300012c, 0x300012d, 0x400012d,
                                  0x500012d, 0x600012d, OUR_LAYER };
#define NKNOWN (int)(sizeof known / sizeof *known)

static int order(void) {
    struct ctl k;
    if (ctl_open(&k) < 0) return 1;
    struct lq q[NKNOWN];
    for (int i = 0; i < NKNOWN; i++) {
        q[i].id = known[i]; q[i].on = 0;
        struct ivi_controller_layer *l = ivi_controller_layer_create(k.ctl, known[i], 1, 1);
        ivi_controller_layer_add_listener(l, &q_listener, &q[i]);
    }
    wl_display_roundtrip(k.dpy);
    wl_display_roundtrip(k.dpy);
    printf("on screen:");
    for (int i = 0; i < NKNOWN; i++) if (q[i].on) printf(" %#x", q[i].id);
    printf("\n");
    return 0;
}

/* kms_shim writes the next picture of the centre output while GRAB.req exists.
 * Winston draws only when something changed: a layer's visibility set again
 * (the HMI's 0x1, as it is) asks for one. */
static int grab(void) {
    const char *g = getenv("KMS_SHIM_GRAB");
    if (!g) { fprintf(stderr, "KMS_SHIM_GRAB unset\n"); return 1; }
    char req[256], out[256];
    snprintf(req, sizeof req, "%s.req", g);
    snprintf(out, sizeof out, "%s.ppm", g);
    unlink(out);
    FILE *f = fopen(req, "w");
    if (!f) return 1;
    fclose(f);
    struct ctl k;
    if (ctl_open(&k) < 0) return 1;
    /* a screenshot makes Winston compose the screen (its null outputs don't otherwise) */
    char png[300];
    snprintf(png, sizeof png, "%s.png", g);
    ivi_controller_screen_screenshot(centre(&k), png);
    wl_display_roundtrip(k.dpy);
    for (int i = 0; i < 60 && access(out, F_OK) != 0; i++) { usleep(50000); wl_display_roundtrip(k.dpy); }
    return access(out, F_OK) == 0 ? 0 : 1;
}

/* The HMI's way: the screen's layers set anew, without ours. */
static int reset(void) {
    struct ctl k;
    if (ctl_open(&k) < 0) return 1;
    struct ivi_controller_screen *s = centre(&k);
    struct wl_array a;
    wl_array_init(&a);
    for (int i = 0; i < NKNOWN; i++) {
        if (known[i] == OUR_LAYER) continue;
        uint32_t *p = wl_array_add(&a, sizeof *p);
        *p = known[i];
    }
    ivi_controller_screen_set_render_order(s, &a);
    ivi_controller_commit_changes(k.ctl);
    wl_display_roundtrip(k.dpy);
    wl_array_release(&a);
    return 0;
}

/* The reversing camera: surface 0x197 with a picture, made visible by the controller (the HMI's job). */
static int camera(int on, int seconds) {
    struct ctl k;
    if (ctl_open(&k) < 0 || !k.iapp || !k.comp || !k.shm) return 1;
    struct wl_surface *ws = wl_compositor_create_surface(k.comp);
    ivi_application_surface_create(k.iapp, 0x197, ws);
    int w = 64, h = 64;
    int fd = (int)syscall(SYS_memfd_create, "cam", 1u);
    if (fd < 0 || ftruncate(fd, w * h * 4) < 0) return 1;
    struct wl_shm_pool *p = wl_shm_create_pool(k.shm, fd, w * h * 4);
    struct wl_buffer *b = wl_shm_pool_create_buffer(p, 0, w, h, w * 4, WL_SHM_FORMAT_XRGB8888);
    wl_surface_attach(ws, b, 0, 0);
    wl_surface_damage(ws, 0, 0, w, h);
    wl_surface_commit(ws);
    wl_display_roundtrip(k.dpy);
    struct ivi_controller_surface *cs = ivi_controller_surface_create(k.ctl, 0x197);
    ivi_controller_surface_set_visibility(cs, (uint32_t)on);
    ivi_controller_commit_changes(k.ctl);
    wl_display_roundtrip(k.dpy);
    printf("camera %s\n", on ? "visible" : "hidden");
    fflush(stdout);
    long end = now_ms() + seconds * 1000L;
    while (now_ms() < end) { wl_display_roundtrip(k.dpy); usleep(100000); }
    return 0;
}

int main(int argc, char **argv) {
    setvbuf(stdout, NULL, _IOLBF, 0);
    if (argc >= 2 && !strcmp(argv[1], "app")) return app(argc - 1, argv + 1);
    if (argc >= 2 && !strcmp(argv[1], "grab")) return grab();
    if (argc >= 2 && !strcmp(argv[1], "order")) return order();
    if (argc >= 2 && !strcmp(argv[1], "reset")) return reset();
    if (argc >= 4 && !strcmp(argv[1], "camera")) return camera(!strcmp(argv[2], "on"), atoi(argv[3]));
    fprintf(stderr, "usage: see wo_bench.c\n");
    return 2;
}
