// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * winston_out: our pictures on the centre screen through Winston (winston_out.h).
 * The layer handling follows mgu-store's mgu-render (native/mgu-render/src/
 * main.c, relist.c; GPL-3.0-or-later, Copyright its authors), as seen on iDrive 7.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>
#include <wayland-client.h>
#include "winston_out.h"
#include "ivi-application-client-protocol.h"
#include "ivi-controller-client-protocol.h"
#include "linux-dmabuf-unstable-v1-client-protocol.h"

#define DEFAULT_SOCKET "/run/wayland/wayland-0"
#define DEFAULT_SURFACE 0x565a0100u   /* "VZ"; mgu-render uses "MR" 0x4d52...., the community "MG" 0x4d47.... */
#define DEFAULT_LAYER 0x565a0000u
#define MAX_YIELD 8
#define MAX_OUTPUTS 8
#define MAX_FORMATS 64
#define DROP_WINDOW_MS 10000
#define DROP_MAX 5

static const uint32_t default_yield[] = { 0x197, 0x198, 0x19d, 0x19f };

struct wo_buf {
    struct wo *w;
    struct wl_buffer *wb;
    int width, height, busy;
    void (*cb)(void *, struct wo_buf *);
    void *data;
};

struct wo_pool {
    struct wo *w;
    struct wl_shm_pool *p;
};

struct wo {
    struct wo_opts o;
    char socket[108];
    struct wl_display *dpy;
    struct wl_registry *reg;
    struct wl_compositor *comp;
    struct wl_shm *shm;
    struct zwp_linux_dmabuf_v1 *dmabuf;
    int dmabuf_version;
    struct ivi_application *iapp;
    struct ivi_controller *ictl;
    struct wl_output *outputs[MAX_OUTPUTS];
    int noutputs;
    uint32_t shm_formats[MAX_FORMATS], dmabuf_formats[MAX_FORMATS];
    int nshm, ndmabuf;
    struct wl_event_queue *q;          /* dmabuf imports wait on it alone */
    uint32_t yield_ids[MAX_YIELD];
    int nyield;
    struct { struct ivi_controller_surface *s; int visible, gone; } yield[MAX_YIELD];
    int yielding;
    /* the picture */
    struct wl_surface *ws;
    struct ivi_surface *is;
    struct ivi_controller_surface *cs;
    struct ivi_controller_layer *cl;
    struct wl_callback *frame_cb;
    int on, applied_on, listed, has_picture;
    int x, y, pw, ph;                  /* the place */
    int bw, bh;                        /* the shown part of the last buffer */
    int geo_dirty;
    long drop_t;
    int drops;
    int lost;
};

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}

static void say(struct wo *w, const char *fmt, ...) {
    if (!w->o.log) return;
    char m[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(m, sizeof m, fmt, ap);
    va_end(ap);
    w->o.log(w->o.ud, m);
}

/* A path, or a name in $XDG_RUNTIME_DIR. */
static void socket_path(char *out, size_t n, const char *s) {
    if (!s) s = DEFAULT_SOCKET;
    if (s[0] == '/') { snprintf(out, n, "%s", s); return; }
    const char *dir = getenv("XDG_RUNTIME_DIR");
    snprintf(out, n, "%s/%s", dir ? dir : "/run/wayland", s);
}

/* By path: libwayland before 1.15 takes names only. */
static struct wl_display *connect_path(const char *path) {
    int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) return NULL;
    struct sockaddr_un a;
    memset(&a, 0, sizeof a);
    a.sun_family = AF_UNIX;
    snprintf(a.sun_path, sizeof a.sun_path, "%s", path);
    if (connect(fd, (struct sockaddr *)&a, sizeof a) < 0) { int e = errno; close(fd); errno = e; return NULL; }
    struct wl_display *d = wl_display_connect_to_fd(fd);
    if (!d) close(fd);
    return d;
}

/* ---- the layer onto the screen, through a connection made for it (mgu-render's relist.c) ---- */

struct rl {
    struct ivi_controller *ctl;
    struct wl_output *outputs[MAX_OUTPUTS];
    int noutputs;
    struct { uint32_t id; struct ivi_controller_screen *s; } screens[MAX_OUTPUTS];
    int nscreens;
    struct wo *w;
};
static void rl_screen(void *d, struct ivi_controller *c, uint32_t id, struct ivi_controller_screen *s) {
    struct rl *r = d;
    (void)c;
    if (r->nscreens < MAX_OUTPUTS) { r->screens[r->nscreens].id = id; r->screens[r->nscreens].s = s; r->nscreens++; }
}
static void rl_id(void *d, struct ivi_controller *c, uint32_t id) { (void)d; (void)c; (void)id; }
static void rl_error(void *d, struct ivi_controller *c, int32_t oid, int32_t ot, int32_t code, const char *t) {
    struct rl *r = d;
    (void)c;
    say(r->w, "relist: ivi error, object %d type %d code %d: %s", oid, ot, code, t ? t : "");
}
static const struct ivi_controller_listener rl_listener = { rl_screen, rl_id, rl_id, rl_error };
static void rl_global(void *d, struct wl_registry *reg, uint32_t name, const char *iface, uint32_t ver) {
    struct rl *r = d;
    (void)ver;
    /* Winston reports a screen to a controller for each output the connection has bound */
    if (!strcmp(iface, "wl_output") && r->noutputs < MAX_OUTPUTS) r->outputs[r->noutputs++] = wl_registry_bind(reg, name, &wl_output_interface, 1);
    else if (!strcmp(iface, "ivi_controller") && !r->ctl) {
        r->ctl = wl_registry_bind(reg, name, &ivi_controller_interface, 1);
        ivi_controller_add_listener(r->ctl, &rl_listener, r);
    }
}
static void rl_global_remove(void *d, struct wl_registry *reg, uint32_t name) { (void)d; (void)reg; (void)name; }
static const struct wl_registry_listener rl_reg_listener = { rl_global, rl_global_remove };

/* Our layer on top of the centre screen's (the lowest screen id) layers. */
static int layer_put(struct wo *w) {
    struct wl_display *dpy = connect_path(w->socket);
    if (!dpy) { say(w, "relist: cannot connect to %s (%s)", w->socket, strerror(errno)); return -1; }
    struct rl r;
    memset(&r, 0, sizeof r);
    r.w = w;
    struct wl_registry *reg = wl_display_get_registry(dpy);
    wl_registry_add_listener(reg, &rl_reg_listener, &r);
    int ok = wl_display_roundtrip(dpy) >= 0 && r.ctl && wl_display_roundtrip(dpy) >= 0;
    struct ivi_controller_screen *scr = NULL;
    uint32_t best = 0xffffffffu;
    for (int i = 0; ok && i < r.nscreens; i++)
        if (r.screens[i].id < best) { best = r.screens[i].id; scr = r.screens[i].s; }
    struct ivi_controller_layer *l = NULL;
    if (scr) {
        l = ivi_controller_layer_create(r.ctl, w->o.layer_id, w->pw, w->ph);   /* the existing layer */
        ivi_controller_screen_add_layer(scr, l);
        ivi_controller_commit_changes(r.ctl);
        ok = wl_display_roundtrip(dpy) >= 0;
    } else {
        say(w, "relist: %s", ok ? "no screen to put the layer on" : "no ivi controller");
        ok = 0;
    }
    /* proxies only (no request): the layer belongs to the scene, not to this connection */
    if (l) wl_proxy_destroy((struct wl_proxy *)l);
    for (int i = 0; i < r.nscreens; i++) wl_proxy_destroy((struct wl_proxy *)r.screens[i].s);
    for (int i = 0; i < r.noutputs; i++) wl_proxy_destroy((struct wl_proxy *)r.outputs[i]);
    if (r.ctl) wl_proxy_destroy((struct wl_proxy *)r.ctl);
    wl_registry_destroy(reg);
    wl_display_disconnect(dpy);
    if (ok) w->listed = 1;
    return ok ? 0 : -1;
}

/* ---- visibility ---- */

static void apply(struct wo *w) {
    if (!w->cl) return;
    int on = w->on && w->has_picture && !w->yielding;
    if (w->geo_dirty && w->bw > 0 && w->bh > 0) {
        /* fitted into the place, aspect kept, centred */
        int dw = w->pw, dh = (int)((long)w->pw * w->bh / w->bw);
        if (dh > w->ph) { dh = w->ph; dw = (int)((long)w->ph * w->bw / w->bh); }
        int dx = (w->pw - dw) / 2, dy = (w->ph - dh) / 2;
        ivi_controller_surface_set_source_rectangle(w->cs, 0, 0, w->bw, w->bh);
        ivi_controller_surface_set_destination_rectangle(w->cs, dx, dy, dw, dh);
        ivi_controller_layer_set_source_rectangle(w->cl, 0, 0, w->pw, w->ph);
        ivi_controller_layer_set_destination_rectangle(w->cl, w->x, w->y, w->pw, w->ph);
        w->geo_dirty = 0;
    }
    if (on && !w->applied_on && !w->listed) layer_put(w);
    ivi_controller_layer_set_visibility(w->cl, on);
    ivi_controller_surface_set_visibility(w->cs, on);
    ivi_controller_commit_changes(w->ictl);
    if (on != w->applied_on) say(w, "%s", on ? "on the screen" : "off the screen");
    w->applied_on = on;
}

/* Winston says which screen the layer is on: none once another program set
 * the screen's layers without it (the HMI does on scene changes). */
static void l_screen(void *d, struct ivi_controller_layer *l, struct wl_output *o) {
    struct wo *w = d;
    (void)l;
    if (!w->cl) return;
    if (o) { w->listed = 1; return; }
    if (!w->listed) return;
    w->listed = 0;
    if (!w->applied_on) { say(w, "layer taken off the screen"); return; }
    long t = now_ms();
    if (t - w->drop_t > DROP_WINDOW_MS) { w->drop_t = t; w->drops = 0; }
    if (++w->drops > DROP_MAX) {
        if (w->drops == DROP_MAX + 1) say(w, "layer taken off the screen more than %d times in %d s; back at the next show", DROP_MAX, DROP_WINDOW_MS / 1000);
        return;
    }
    say(w, "layer taken off the screen, put back");
    layer_put(w);
}
static void l_int(void *d, struct ivi_controller_layer *l, int32_t v) { (void)d; (void)l; (void)v; }
static void l_opacity(void *d, struct ivi_controller_layer *l, wl_fixed_t v) { (void)d; (void)l; (void)v; }
static void l_rect(void *d, struct ivi_controller_layer *l, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)d; (void)l; (void)x; (void)y; (void)w; (void)h;
}
static void l_config(void *d, struct ivi_controller_layer *l, int32_t w, int32_t h) { (void)d; (void)l; (void)w; (void)h; }
static void l_destroyed(void *d, struct ivi_controller_layer *l) { (void)d; (void)l; }
static const struct ivi_controller_layer_listener layer_listener = {
    l_int, l_opacity, l_rect, l_rect, l_config, l_int, l_screen, l_destroyed,
};

/* ---- yield surfaces (the cameras) ---- */

static int yield_index(struct wo *w, struct ivi_controller_surface *s) {
    for (int i = 0; i < w->nyield; i++) if (w->yield[i].s == s) return i;
    return -1;
}
static void yield_update(struct wo *w) {
    int any = 0;
    for (int i = 0; i < w->nyield; i++) any |= w->yield[i].visible && !w->yield[i].gone;
    if (any == w->yielding) return;
    w->yielding = any;
    say(w, any ? "a camera surface shows: hidden" : "no camera surface: may show");
    if (w->o.yielding) w->o.yielding(w->o.ud, any);
    apply(w);
}
static void y_visibility(void *d, struct ivi_controller_surface *s, int32_t v) {
    struct wo *w = d;
    int i = yield_index(w, s);
    if (i < 0) return;
    w->yield[i].visible = v != 0;
    yield_update(w);
}
static void y_opacity(void *d, struct ivi_controller_surface *s, wl_fixed_t o) { (void)d; (void)s; (void)o; }
static void y_rect(void *d, struct ivi_controller_surface *s, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)d; (void)s; (void)x; (void)y; (void)w; (void)h;
}
static void y_config(void *d, struct ivi_controller_surface *s, int32_t w, int32_t h) { (void)d; (void)s; (void)w; (void)h; }
/* 1: the surface has a client's content again; 2: removed (its client went:
 * Winston keeps the surface "visible", without a picture, and says no
 * destroyed). Measured on the bench's Winston. */
static void y_content(void *d, struct ivi_controller_surface *s, int32_t v) {
    struct wo *w = d;
    int i = yield_index(w, s);
    if (i < 0 || (v != 1 && v != 2)) return;
    w->yield[i].gone = v == 2;
    yield_update(w);
}
static void y_int(void *d, struct ivi_controller_surface *s, int32_t v) { (void)d; (void)s; (void)v; }
static void y_layer(void *d, struct ivi_controller_surface *s, struct ivi_controller_layer *l) { (void)d; (void)s; (void)l; }
static void y_stats(void *d, struct ivi_controller_surface *s, uint32_t a, uint32_t b, uint32_t c, uint32_t p, const char *n) {
    (void)d; (void)s; (void)a; (void)b; (void)c; (void)p; (void)n;
}
static void y_destroyed(void *d, struct ivi_controller_surface *s) {
    struct wo *w = d;
    int i = yield_index(w, s);
    if (i < 0) return;
    ivi_controller_surface_destroy(s, 0);
    w->yield[i].s = NULL;
    w->yield[i].visible = 0;
    yield_update(w);
}
static const struct ivi_controller_surface_listener yield_listener = {
    y_visibility, y_opacity, y_rect, y_rect, y_config, y_int, y_int, y_layer, y_stats, y_destroyed, y_content,
};

/* ---- the controller ---- */

static void c_screen(void *d, struct ivi_controller *c, uint32_t id, struct ivi_controller_screen *s) {
    (void)d; (void)c; (void)id; (void)s;
}
static void c_layer(void *d, struct ivi_controller *c, uint32_t id) { (void)d; (void)c; (void)id; }
static void c_surface(void *d, struct ivi_controller *c, uint32_t id) {
    struct wo *w = d;
    for (int i = 0; i < w->nyield; i++) {
        if (w->yield_ids[i] != id || w->yield[i].s) continue;
        w->yield[i].s = ivi_controller_surface_create(c, id);
        ivi_controller_surface_add_listener(w->yield[i].s, &yield_listener, w);
        say(w, "watching surface %#x", id);
    }
}
static void c_error(void *d, struct ivi_controller *c, int32_t oid, int32_t ot, int32_t code, const char *t) {
    struct wo *w = d;
    (void)c;
    say(w, "ivi error, object %d type %d code %d: %s", oid, ot, code, t ? t : "");
}
static const struct ivi_controller_listener ctl_listener = { c_screen, c_layer, c_surface, c_error };

/* ---- the registry ---- */

static void add_format(uint32_t *list, int *n, uint32_t f) {
    for (int i = 0; i < *n; i++) if (list[i] == f) return;
    if (*n < MAX_FORMATS) list[(*n)++] = f;
}
static void shm_format(void *d, struct wl_shm *s, uint32_t f) { struct wo *w = d; (void)s; add_format(w->shm_formats, &w->nshm, f); }
static const struct wl_shm_listener shm_listener = { shm_format };
static void dmabuf_format(void *d, struct zwp_linux_dmabuf_v1 *z, uint32_t f) { struct wo *w = d; (void)z; add_format(w->dmabuf_formats, &w->ndmabuf, f); }
static void dmabuf_modifier(void *d, struct zwp_linux_dmabuf_v1 *z, uint32_t f, uint32_t hi, uint32_t lo) {
    struct wo *w = d;
    (void)z; (void)hi; (void)lo;
    add_format(w->dmabuf_formats, &w->ndmabuf, f);
}
static const struct zwp_linux_dmabuf_v1_listener dmabuf_listener = { dmabuf_format, dmabuf_modifier };

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
    struct wo *w = d;
    if (!strcmp(iface, "wl_compositor") && !w->comp) w->comp = wl_registry_bind(r, name, &wl_compositor_interface, ver < 3 ? ver : 3);
    else if (!strcmp(iface, "wl_shm") && !w->shm) {
        w->shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
        wl_shm_add_listener(w->shm, &shm_listener, w);
    } else if (!strcmp(iface, "zwp_linux_dmabuf_v1") && !w->dmabuf) {
        w->dmabuf_version = ver < 3 ? (int)ver : 3;
        w->dmabuf = wl_registry_bind(r, name, &zwp_linux_dmabuf_v1_interface, (uint32_t)w->dmabuf_version);
        zwp_linux_dmabuf_v1_add_listener(w->dmabuf, &dmabuf_listener, w);
    } else if (!strcmp(iface, "ivi_application") && !w->iapp) w->iapp = wl_registry_bind(r, name, &ivi_application_interface, 1);
    else if (!strcmp(iface, "ivi_controller") && !w->ictl) {
        w->ictl = wl_registry_bind(r, name, &ivi_controller_interface, 1);
        ivi_controller_add_listener(w->ictl, &ctl_listener, w);
    } else if (!strcmp(iface, "wl_output") && w->noutputs < MAX_OUTPUTS) {
        w->outputs[w->noutputs++] = wl_registry_bind(r, name, &wl_output_interface, 1);
    }
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t name) { (void)d; (void)r; (void)name; }
static const struct wl_registry_listener reg_listener = { reg_global, reg_remove };

struct wo *wo_open(const struct wo_opts *o, char *err, size_t n) {
    struct wo *w = calloc(1, sizeof *w);
    if (!w) { snprintf(err, n, "out of memory"); return NULL; }
    w->o = *o;
    if (!w->o.surface_id) w->o.surface_id = DEFAULT_SURFACE;
    if (!w->o.layer_id) w->o.layer_id = DEFAULT_LAYER;
    const uint32_t *y = o->yield ? o->yield : default_yield;
    int ny = o->yield ? o->nyield : (int)(sizeof default_yield / sizeof *default_yield);
    for (int i = 0; i < ny && i < MAX_YIELD; i++) w->yield_ids[w->nyield++] = y[i];
    w->x = o->x; w->y = o->y; w->pw = o->w > 0 ? o->w : 1920; w->ph = o->h > 0 ? o->h : 720;
    socket_path(w->socket, sizeof w->socket, o->socket);
    w->dpy = connect_path(w->socket);
    if (!w->dpy) { snprintf(err, n, "cannot connect to %s: %s", w->socket, strerror(errno)); free(w); return NULL; }
    w->q = wl_display_create_queue(w->dpy);
    w->reg = wl_display_get_registry(w->dpy);
    wl_registry_add_listener(w->reg, &reg_listener, w);
    if (wl_display_roundtrip(w->dpy) < 0 || wl_display_roundtrip(w->dpy) < 0) {
        snprintf(err, n, "%s: the connection failed", w->socket);
        wo_close(w);
        return NULL;
    }
    if (!w->comp || !w->shm || !w->iapp || !w->ictl) {
        snprintf(err, n, "%s lacks%s%s%s%s", w->socket, w->comp ? "" : " wl_compositor", w->shm ? "" : " wl_shm",
                 w->iapp ? "" : " ivi_application", w->ictl ? "" : " ivi_controller");
        wo_close(w);
        return NULL;
    }
    say(w, "connected to %s: dmabuf v%d (%d formats), shm %d formats", w->socket, w->dmabuf_version, w->ndmabuf, w->nshm);
    return w;
}

void wo_close(struct wo *w) {
    if (!w) return;
    if (w->dpy && !w->lost) {
        wo_hide(w);
        for (int i = 0; i < w->nyield; i++) if (w->yield[i].s) ivi_controller_surface_destroy(w->yield[i].s, 0);
        wl_display_flush(w->dpy);
    }
    if (w->dpy) wl_display_disconnect(w->dpy);   /* frees what is left */
    free(w);
}

int wo_fd(struct wo *w) { return wl_display_get_fd(w->dpy); }

long wo_socket_gid(struct wo *w) {
    struct stat st;
    /* never root's group (a process dropping privileges keeps it) */
    return stat(w->socket, &st) == 0 && st.st_gid != 0 ? (long)st.st_gid : -1;
}

int wo_dispatch(struct wo *w) {
    if (w->lost) return -1;
    if (wl_display_dispatch(w->dpy) < 0) {
        w->lost = 1;
        say(w, "the connection to Winston is lost (%s)", strerror(wl_display_get_error(w->dpy)));
        return -1;
    }
    return wo_flush(w);
}

int wo_flush(struct wo *w) {
    if (w->lost) return -1;
    if (wl_display_flush(w->dpy) < 0 && errno != EAGAIN) {
        w->lost = 1;
        say(w, "the connection to Winston is lost (%s)", strerror(errno));
        return -1;
    }
    return 0;
}

int wo_dmabuf_version(struct wo *w) { return w->dmabuf ? w->dmabuf_version : 0; }
int wo_has_shm_format(struct wo *w, uint32_t f) {
    for (int i = 0; i < w->nshm; i++) if (w->shm_formats[i] == f) return 1;
    return 0;
}
int wo_has_dmabuf_format(struct wo *w, uint32_t f) {
    for (int i = 0; i < w->ndmabuf; i++) if (w->dmabuf_formats[i] == f) return 1;
    return 0;
}

/* ---- buffers ---- */

static void buf_release(void *d, struct wl_buffer *wb) {
    struct wo_buf *b = d;
    (void)wb;
    b->busy = 0;
    if (b->cb) b->cb(b->data, b);
}
static const struct wl_buffer_listener buf_listener = { buf_release };

static struct wo_buf *buf_new(struct wo *w, struct wl_buffer *wb, int width, int height) {
    struct wo_buf *b = calloc(1, sizeof *b);
    if (!b) { wl_buffer_destroy(wb); return NULL; }
    b->w = w; b->wb = wb; b->width = width; b->height = height;
    wl_buffer_add_listener(wb, &buf_listener, b);
    return b;
}

struct wo_pool *wo_pool_new(struct wo *w, int fd, int32_t size) {
    struct wo_pool *p = calloc(1, sizeof *p);
    if (!p) return NULL;
    p->w = w;
    p->p = wl_shm_create_pool(w->shm, fd, size);   /* libwayland sends a dup of fd */
    return p;
}
void wo_pool_resize(struct wo_pool *p, int32_t size) { wl_shm_pool_resize(p->p, size); }
void wo_pool_free(struct wo_pool *p) {
    if (!p) return;
    wl_shm_pool_destroy(p->p);
    free(p);
}
struct wo_buf *wo_buf_shm(struct wo_pool *p, int32_t offset, int width, int height, int stride, uint32_t shm_format) {
    struct wl_buffer *wb = wl_shm_pool_create_buffer(p->p, offset, width, height, stride, shm_format);
    return wb ? buf_new(p->w, wb, width, height) : NULL;
}

struct dmabuf_wait { struct wl_buffer *wb; int done; };
static void params_created(void *d, struct zwp_linux_buffer_params_v1 *p, struct wl_buffer *wb) {
    struct dmabuf_wait *x = d;
    (void)p;
    x->wb = wb; x->done = 1;
}
static void params_failed(void *d, struct zwp_linux_buffer_params_v1 *p) {
    struct dmabuf_wait *x = d;
    (void)p;
    x->done = 1;
}
static const struct zwp_linux_buffer_params_v1_listener params_listener = { params_created, params_failed };

struct wo_buf *wo_buf_dmabuf(struct wo *w, int fd, int width, int height, uint32_t fourcc,
                             uint32_t offset, uint32_t stride, uint64_t modifier) {
    return wo_buf_dmabuf_planes(w, 1, &fd, &offset, &stride, width, height, fourcc, modifier);
}

struct wo_buf *wo_buf_dmabuf_planes(struct wo *w, int n, const int *fds, const uint32_t *offsets,
                                    const uint32_t *strides, int width, int height, uint32_t fourcc,
                                    uint64_t modifier) {
    if (!w->dmabuf || w->lost || n < 1 || n > 4) return NULL;
    uint32_t stride = strides[0];
    struct zwp_linux_buffer_params_v1 *p = zwp_linux_dmabuf_v1_create_params(w->dmabuf);
    if (!p) return NULL;
    struct dmabuf_wait x = { NULL, 0 };
    /* on our own queue: a refusal is an event (never a protocol error), and
     * nothing else is dispatched while we wait */
    wl_proxy_set_queue((struct wl_proxy *)p, w->q);
    zwp_linux_buffer_params_v1_add_listener(p, &params_listener, &x);
    for (int i = 0; i < n; i++)
        zwp_linux_buffer_params_v1_add(p, fds[i], (uint32_t)i, offsets[i], strides[i], (uint32_t)(modifier >> 32), (uint32_t)modifier);
    zwp_linux_buffer_params_v1_create(p, width, height, fourcc, 0);
    while (!x.done)
        if (wl_display_roundtrip_queue(w->dpy, w->q) < 0) { w->lost = 1; break; }
    zwp_linux_buffer_params_v1_destroy(p);
    if (!x.wb) {
        say(w, "Winston refused a dmabuf %dx%d %.4s stride %u modifier %#llx", width, height, (char *)&fourcc, stride,
            (unsigned long long)modifier);
        return NULL;
    }
    wl_proxy_set_queue((struct wl_proxy *)x.wb, NULL);
    return buf_new(w, x.wb, width, height);
}

void wo_buf_on_release(struct wo_buf *b, void (*cb)(void *, struct wo_buf *), void *data) { b->cb = cb; b->data = data; }
int wo_buf_busy(const struct wo_buf *b) { return b->busy; }
void wo_buf_free(struct wo_buf *b) {
    if (!b) return;
    if (!b->w->lost) wl_buffer_destroy(b->wb); else wl_proxy_destroy((struct wl_proxy *)b->wb);
    free(b);
}

/* ---- the surface ---- */

static int make_surface(struct wo *w) {
    w->ws = wl_compositor_create_surface(w->comp);
    struct wl_region *empty = wl_compositor_create_region(w->comp);
    wl_surface_set_input_region(w->ws, empty);           /* touch stays with the HMI underneath */
    wl_region_destroy(empty);
    w->is = ivi_application_surface_create(w->iapp, w->o.surface_id, w->ws);
    w->cs = ivi_controller_surface_create(w->ictl, w->o.surface_id);
    ivi_controller_surface_set_visibility(w->cs, 0);
    w->cl = ivi_controller_layer_create(w->ictl, w->o.layer_id, w->pw, w->ph);
    ivi_controller_layer_set_source_rectangle(w->cl, 0, 0, w->pw, w->ph);
    ivi_controller_layer_set_destination_rectangle(w->cl, w->x, w->y, w->pw, w->ph);
    ivi_controller_layer_set_opacity(w->cl, wl_fixed_from_int(1));
    ivi_controller_layer_add_surface(w->cl, w->cs);
    ivi_controller_layer_set_visibility(w->cl, 0);
    ivi_controller_layer_add_listener(w->cl, &layer_listener, w);
    ivi_controller_commit_changes(w->ictl);
    if (wl_display_roundtrip(w->dpy) < 0) { w->lost = 1; return -1; }   /* the layer exists for the connection that lists it */
    w->listed = 0;
    w->applied_on = 0;
    w->geo_dirty = 1;
    w->has_picture = 0;
    say(w, "surface %#x on layer %#x at %d,%d %dx%d", w->o.surface_id, w->o.layer_id, w->x, w->y, w->pw, w->ph);
    return 0;
}

int wo_show(struct wo *w, int on) {
    if (w->lost) return -1;
    if (on && !w->ws && make_surface(w) < 0) return -1;
    w->on = on;
    apply(w);
    return wo_flush(w);
}

void wo_hide(struct wo *w) {
    if (w->lost) return;
    w->on = 0;
    if (w->frame_cb) { wl_callback_destroy(w->frame_cb); w->frame_cb = NULL; }
    if (w->cl) { ivi_controller_layer_destroy(w->cl, 1); w->cl = NULL; }
    if (w->cs) { ivi_controller_surface_destroy(w->cs, 1); w->cs = NULL; }
    if (w->is) { ivi_surface_destroy(w->is); w->is = NULL; }
    if (w->ws) { wl_surface_destroy(w->ws); w->ws = NULL; }
    ivi_controller_commit_changes(w->ictl);
    w->applied_on = w->listed = w->has_picture = 0;
    wo_flush(w);
}

void wo_place(struct wo *w, int x, int y, int width, int height) {
    if (x == w->x && y == w->y && width == w->pw && height == w->ph) return;
    w->x = x; w->y = y; w->pw = width; w->ph = height;
    w->geo_dirty = 1;
    if (w->cl) { apply(w); wo_flush(w); }
}

static void frame_done(void *d, struct wl_callback *cb, uint32_t t) {
    struct wo *w = d;
    (void)t;
    wl_callback_destroy(cb);
    if (w->frame_cb == cb) w->frame_cb = NULL;
    if (w->o.frame) w->o.frame(w->o.ud);
}
static const struct wl_callback_listener frame_listener = { frame_done };

int wo_present(struct wo *w, struct wo_buf *b, int src_w, int src_h) {
    if (w->lost || !w->ws) return -1;
    if (src_w <= 0 || src_w > b->width) src_w = b->width;
    if (src_h <= 0 || src_h > b->height) src_h = b->height;
    if (src_w != w->bw || src_h != w->bh) { w->bw = src_w; w->bh = src_h; w->geo_dirty = 1; }
    wl_surface_attach(w->ws, b->wb, 0, 0);
    wl_surface_damage(w->ws, 0, 0, b->width, b->height);
    if (!w->frame_cb) {
        w->frame_cb = wl_surface_frame(w->ws);
        wl_callback_add_listener(w->frame_cb, &frame_listener, w);
    }
    wl_surface_commit(w->ws);
    b->busy = 1;
    int first = !w->has_picture;
    w->has_picture = 1;
    if (first || w->geo_dirty) apply(w);
    return wo_flush(w);
}

int wo_yielding(struct wo *w) { return w->yielding; }

/* ---- our own shared memory ---- */

struct wo_ring {
    struct wo *w;
    int width, height, nbuf;
    uint8_t *map;
    size_t size;
    struct wo_buf *b[4];
};

struct wo_ring *wo_ring_new(struct wo *w, int width, int height, int nbuf) {
    if (nbuf < 1) nbuf = 1;
    if (nbuf > 4) nbuf = 4;
    struct wo_ring *r = calloc(1, sizeof *r);
    if (!r) return NULL;
    r->w = w; r->width = width; r->height = height; r->nbuf = nbuf;
    size_t one = (size_t)width * height * 4;
    r->size = one * (size_t)nbuf;
    int fd = (int)syscall(SYS_memfd_create, "winston-out", 1u /* MFD_CLOEXEC */);
    if (fd < 0 || ftruncate(fd, (off_t)r->size) < 0) { if (fd >= 0) close(fd); free(r); return NULL; }
    r->map = mmap(NULL, r->size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (r->map == MAP_FAILED) { close(fd); free(r); return NULL; }
    struct wo_pool *p = wo_pool_new(w, fd, (int32_t)r->size);
    close(fd);
    for (int i = 0; p && i < nbuf; i++) r->b[i] = wo_buf_shm(p, (int32_t)(one * (size_t)i), width, height, width * 4, WO_SHM_XRGB8888);
    wo_pool_free(p);
    for (int i = 0; i < nbuf; i++) if (!r->b[i]) { wo_ring_free(r); return NULL; }
    return r;
}

void wo_ring_free(struct wo_ring *r) {
    if (!r) return;
    for (int i = 0; i < r->nbuf; i++) wo_buf_free(r->b[i]);
    if (r->map) munmap(r->map, r->size);
    free(r);
}

uint32_t *wo_ring_next(struct wo_ring *r, struct wo_buf **b) {
    for (int i = 0; i < r->nbuf; i++)
        if (!r->b[i]->busy) {
            *b = r->b[i];
            return (uint32_t *)(r->map + (size_t)r->width * r->height * 4 * (size_t)i);
        }
    *b = NULL;
    return NULL;
}
