// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * wl-sink: a minimal Wayland compositor for one game. Wine's Wayland driver
 * (Proton with PROTON_ENABLE_WAYLAND=1) draws into it, and every picture goes
 * into mgu-render's frame file, as the browser's sink does
 * (knowledge/central-screen.md). It never touches the display: the unit's
 * screen belongs to Winston and the HMI.
 *
 *   wl-sink --socket NAME --frame FILE [--create WxH] [--fps N] [--snap F.ppm]
 *           [--device /dev/dri/renderD128] [--no-drm] [--uid U --gid G]
 *
 * --uid / --gid (the car: started as root): the frame file is mapped first
 * (mgu-render wants it root's), then every group is dropped and the sink
 * runs as U:G (the tool's uid, the render node's group) before it opens its
 * socket or the GPU.
 * --create makes the frame file (3 slots) when it isn't there (the bench;
 * on the car the tool's server makes it, root-owned, as mgu-render wants).
 * --snap rewrites F.ppm with each picture (tests). --fps caps how often a
 * picture is made (default 60).
 *
 * What it offers a client: wl_compositor 4, wl_subcompositor, wl_shm (ARGB /
 * XRGB 8888), xdg_wm_base 2, one wl_output 2 (the frame's size, so a game
 * goes full screen at it), wl_seat 5 (pointer and keyboard, no keymap yet),
 * and wl_drm 2 when the unit's EGL opens a GBM display on the render node.
 * wl_drm is what Mesa 19's own Wayland EGL needs to draw on the GPU: it
 * names the render node and takes each frame as a PRIME (dmabuf) buffer,
 * which is imported here as an EGLImage and read back. Written here rather
 * than through EGL_WL_bind_wayland_display, so it doesn't depend on that
 * Mesa 19 extension. GL clients without it fall back to shared memory
 * (Mesa's swrast).
 *
 * The picture: the newest mapped toplevel with its subsurfaces (Wine puts a
 * GL client area in a subsurface), centred on black, cut off if bigger.
 * Subsurfaces are treated as desynchronised. Surfaces are copied at commit
 * and their buffers released at once, so a client is never held up by us.
 *
 * --winston SOCKET: connected to Winston at start (before the drop; its
 * socket is root:mgu_wayland), and stdin also takes "winston X,Y,W,H" (the
 * pictures straight onto the centre screen through Winston, fitted into
 * that place, full colour: platform native/winston_out) and "hide" (back to
 * the frame file only). Through Winston no I420 is made, and when the
 * picture is one surface shown at its own size (a game's GL / Direct3D client
 * area) whose content is a GPU buffer, that buffer goes to Winston as it is,
 * placed where the composed picture would have it (no read-back, no copy),
 * and back to Wine at Winston's release. Otherwise the picture is composed
 * as ever and handed over in our own buffers.
 *
 * stdout: one JSON event a line: {"ev":"ready","socket":..,"drm":bool,..},
 * {"ev":"toplevel","title":..}, {"ev":"stats","pictures":n,"commits":n,
 * "shm":n,"drm":n,"ms":avg} once a second while anything happens,
 * {"ev":"error",...}.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <grp.h>
#include <wayland-server.h>
#include "frame_out.h"
#include "rgb.h"
#include "winston_out.h"
#include "xdg-shell-server-protocol.h"
#include "wayland-drm-server-protocol.h"
#include "viewporter-server-protocol.h"

#define FOURCC(a, b, c, d) ((uint32_t)(a) | (uint32_t)(b) << 8 | (uint32_t)(c) << 16 | (uint32_t)(d) << 24)
#define FMT_ARGB8888 FOURCC('A', 'R', '2', '4')
#define FMT_XRGB8888 FOURCC('X', 'R', '2', '4')

static struct wl_display *display;
static struct frame_out fo;
static int out_w = 1280, out_h = 720;
static uint32_t *canvas;
/* through Winston (--winston) */
static struct wo *wo;
static struct wl_event_source *wo_source;
static int wshown;
static struct wo_ring *ring;
static unsigned long n_winston, n_fwd;   /* pictures through Winston; of them, GPU buffers passed on as they are */
static const char *snap_path;
static int dirty;
static unsigned long n_pictures, n_commits, n_shm, n_drm, n_ms_total;
static unsigned long stat_pictures;

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}

static void jstr(const char *s) {
    if (!s) { fputs("null", stdout); return; }
    putchar('"');
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') printf("\\%c", c);
        else if (c < 0x20) printf("\\u%04x", c);
        else putchar(c);
    }
    putchar('"');
}

/* ---- GL: the unit's EGL on a GBM display, for wl_drm buffers ---- */

typedef void *EGLDisplay, *EGLContext, *EGLImage;
typedef int EGLint;
typedef unsigned int GLuint, GLenum;
#define EGL_NONE 0x3038
#define EGL_OPENGL_ES_API 0x30A0
#define EGL_CONTEXT_CLIENT_VERSION 0x3098
#define EGL_PLATFORM_GBM_MESA 0x31D7
#define EGL_WIDTH 0x3057
#define EGL_HEIGHT 0x3056
#define EGL_LINUX_DMA_BUF_EXT 0x3270
#define EGL_LINUX_DRM_FOURCC_EXT 0x3271
#define EGL_DMA_BUF_PLANE0_FD_EXT 0x3272
#define EGL_DMA_BUF_PLANE0_OFFSET_EXT 0x3273
#define EGL_DMA_BUF_PLANE0_PITCH_EXT 0x3274
#define GL_TEXTURE_2D 0x0DE1
#define GL_FRAMEBUFFER 0x8D40
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_RGBA 0x1908
#define GL_UNSIGNED_BYTE 0x1401

static struct {
    int ok;
    char device[64];
    EGLDisplay dpy;
    EGLContext ctx;
    void *(*getProcAddress)(const char *);
    EGLImage (*createImage)(EGLDisplay, EGLContext, unsigned, void *, const EGLint *);
    unsigned (*destroyImage)(EGLDisplay, EGLImage);
    void (*imageTargetTexture)(GLenum, void *);
    void (*genTextures)(int, GLuint *);
    void (*deleteTextures)(int, const GLuint *);
    void (*bindTexture)(GLenum, GLuint);
    void (*genFramebuffers)(int, GLuint *);
    void (*deleteFramebuffers)(int, const GLuint *);
    void (*bindFramebuffer)(GLenum, GLuint);
    void (*framebufferTexture2D)(GLenum, GLenum, GLenum, GLuint, int);
    GLenum (*checkFramebufferStatus)(GLenum);
    void (*readPixels)(int, int, int, int, GLenum, GLenum, void *);
    void (*finish)(void);
} gl;

static int gl_init(const char *device) {
    void *egl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_GLOBAL);
    void *gbm = dlopen("libgbm.so.1", RTLD_NOW | RTLD_GLOBAL);
    if (!egl || !gbm) return -1;
    gl.getProcAddress = dlsym(egl, "eglGetProcAddress");
    if (!gl.getProcAddress) return -1;
    EGLDisplay (*getPlatformDisplay)(unsigned, void *, const EGLint *) = gl.getProcAddress("eglGetPlatformDisplayEXT");
    unsigned (*initialize)(EGLDisplay, EGLint *, EGLint *) = gl.getProcAddress("eglInitialize");
    unsigned (*bindAPI)(unsigned) = gl.getProcAddress("eglBindAPI");
    EGLContext (*createContext)(EGLDisplay, void *, EGLContext, const EGLint *) = gl.getProcAddress("eglCreateContext");
    unsigned (*makeCurrent)(EGLDisplay, void *, void *, EGLContext) = gl.getProcAddress("eglMakeCurrent");
    const char *(*queryString)(EGLDisplay, EGLint) = gl.getProcAddress("eglQueryString");
    void *(*gbm_create_device)(int) = dlsym(gbm, "gbm_create_device");
    if (!getPlatformDisplay || !initialize || !bindAPI || !createContext || !makeCurrent || !queryString
        || !gbm_create_device) return -1;
    int fd = open(device, O_RDWR | O_CLOEXEC);
    if (fd < 0) return -1;
    void *gdev = gbm_create_device(fd);
    gl.dpy = gdev ? getPlatformDisplay(EGL_PLATFORM_GBM_MESA, gdev, NULL) : NULL;
    if (!gl.dpy || !initialize(gl.dpy, NULL, NULL)) return -1;
    const char *ext = queryString(gl.dpy, 0x3055 /* EGL_EXTENSIONS */);
    if (!ext || !strstr(ext, "EGL_EXT_image_dma_buf_import") || !strstr(ext, "EGL_KHR_surfaceless_context")) return -1;
    bindAPI(EGL_OPENGL_ES_API);
    const EGLint attr[] = { EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE };
    gl.ctx = createContext(gl.dpy, NULL, NULL, attr);   /* EGL_KHR_no_config_context */
    if (!gl.ctx || !makeCurrent(gl.dpy, NULL, NULL, gl.ctx)) return -1;
#define P(f, n) if (!(gl.f = gl.getProcAddress(n))) return -1
    P(createImage, "eglCreateImageKHR"); P(destroyImage, "eglDestroyImageKHR");
    P(imageTargetTexture, "glEGLImageTargetTexture2DOES");
    P(genTextures, "glGenTextures"); P(deleteTextures, "glDeleteTextures"); P(bindTexture, "glBindTexture");
    P(genFramebuffers, "glGenFramebuffers"); P(deleteFramebuffers, "glDeleteFramebuffers");
    P(bindFramebuffer, "glBindFramebuffer"); P(framebufferTexture2D, "glFramebufferTexture2D");
    P(checkFramebufferStatus, "glCheckFramebufferStatus"); P(readPixels, "glReadPixels"); P(finish, "glFinish");
#undef P
    snprintf(gl.device, sizeof gl.device, "%s", device);
    gl.ok = 1;
    return 0;
}

/* ---- buffers: wl_shm's, and ours from wl_drm ---- */

struct drm_buffer {
    struct wl_resource *res;
    int fd, w, h, offset, stride;
    uint32_t format;
    struct wl_list link;          /* drm_buffers */
    struct wo_buf *wb;            /* the same buffer in Winston, once passed on */
    int refused;                  /* Winston refused it: read back instead */
    int held;                     /* Winston has it: the client gets it back at its release */
};

static struct wl_list drm_buffers;
static void drm_buffer_gone(struct drm_buffer *b);   /* surfaces forget it */

static void drm_buffer_destroy_res(struct wl_resource *res) {
    struct drm_buffer *b = wl_resource_get_user_data(res);
    drm_buffer_gone(b);
    if (b->fd >= 0) close(b->fd);
    if (b->wb) wo_buf_free(b->wb);   /* Winston keeps what it shows */
    wl_list_remove(&b->link);
    free(b);
}

/* Winston no longer reads it: back to the client. */
static void drm_buffer_released(void *data, struct wo_buf *wb) {
    struct drm_buffer *b = data;
    (void)wb;
    if (!b->held) return;
    b->held = 0;
    wl_buffer_send_release(b->res);
}

static void buffer_destroy(struct wl_client *c, struct wl_resource *res) { (void)c; wl_resource_destroy(res); }
static const struct wl_buffer_interface drm_buffer_impl = { .destroy = buffer_destroy };

/* Reads a wl_drm buffer into dst (w x h, XRGB) through an EGLImage: 0 or -1. */
static int drm_buffer_read(struct drm_buffer *b, uint32_t *dst) {
    if (!gl.ok) return -1;
    const EGLint attr[] = {
        EGL_WIDTH, b->w, EGL_HEIGHT, b->h, EGL_LINUX_DRM_FOURCC_EXT, (EGLint)b->format,
        EGL_DMA_BUF_PLANE0_FD_EXT, b->fd, EGL_DMA_BUF_PLANE0_OFFSET_EXT, b->offset,
        EGL_DMA_BUF_PLANE0_PITCH_EXT, b->stride, EGL_NONE };
    EGLImage img = gl.createImage(gl.dpy, NULL, EGL_LINUX_DMA_BUF_EXT, NULL, attr);
    if (!img) return -1;
    GLuint tex, fb;
    gl.genTextures(1, &tex);
    gl.bindTexture(GL_TEXTURE_2D, tex);
    gl.imageTargetTexture(GL_TEXTURE_2D, img);
    gl.genFramebuffers(1, &fb);
    gl.bindFramebuffer(GL_FRAMEBUFFER, fb);
    gl.framebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
    int r = -1;
    if (gl.checkFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE) {
        gl.readPixels(0, 0, b->w, b->h, GL_RGBA, GL_UNSIGNED_BYTE, dst);
        /* RGBA bytes -> 0x00RRGGBB; the read is bottom-up only for GL's own
         * framebuffers, a dmabuf's row 0 is its top. */
        for (long i = 0; i < (long)b->w * b->h; i++) {
            uint32_t p = dst[i];
            dst[i] = (p & 0xff) << 16 | (p & 0xff00) | (p >> 16 & 0xff);
        }
        r = 0;
    }
    gl.bindFramebuffer(GL_FRAMEBUFFER, 0);
    gl.deleteFramebuffers(1, &fb);
    gl.deleteTextures(1, &tex);
    gl.destroyImage(gl.dpy, img);
    return r;
}

/* ---- wl_drm ---- */

static void drm_authenticate(struct wl_client *c, struct wl_resource *res, uint32_t id) {
    (void)c; (void)id;
    wl_drm_send_authenticated(res);   /* a render node needs no authentication */
}

static void drm_create_buffer(struct wl_client *c, struct wl_resource *res, uint32_t id, uint32_t name,
                              int32_t w, int32_t h, uint32_t stride, uint32_t format) {
    (void)c; (void)id; (void)name; (void)w; (void)h; (void)stride; (void)format;
    wl_resource_post_error(res, WL_DRM_ERROR_INVALID_NAME, "flink names are not supported; use PRIME");
}

static void drm_create_planar_buffer(struct wl_client *c, struct wl_resource *res, uint32_t id, uint32_t name,
                                     int32_t w, int32_t h, uint32_t format, int32_t o0, int32_t s0,
                                     int32_t o1, int32_t s1, int32_t o2, int32_t s2) {
    (void)c; (void)id; (void)name; (void)w; (void)h; (void)format; (void)o0; (void)s0; (void)o1; (void)s1; (void)o2; (void)s2;
    wl_resource_post_error(res, WL_DRM_ERROR_INVALID_NAME, "flink names are not supported; use PRIME");
}

static void drm_create_prime_buffer(struct wl_client *c, struct wl_resource *res, uint32_t id, int32_t fd,
                                    int32_t w, int32_t h, uint32_t format, int32_t o0, int32_t s0,
                                    int32_t o1, int32_t s1, int32_t o2, int32_t s2) {
    (void)o1; (void)s1; (void)o2; (void)s2;
    if (format != FMT_ARGB8888 && format != FMT_XRGB8888) {
        close(fd);
        wl_resource_post_error(res, WL_DRM_ERROR_INVALID_FORMAT, "format 0x%x", format);
        return;
    }
    struct drm_buffer *b = calloc(1, sizeof *b);
    b->res = wl_resource_create(c, &wl_buffer_interface, 1, id);
    if (!b || !b->res) { close(fd); free(b); wl_client_post_no_memory(c); return; }
    b->fd = fd; b->w = w; b->h = h; b->offset = o0; b->stride = s0; b->format = format;
    wl_list_insert(&drm_buffers, &b->link);
    wl_resource_set_implementation(b->res, &drm_buffer_impl, b, drm_buffer_destroy_res);
}

static const struct wl_drm_interface drm_impl = {
    .authenticate = drm_authenticate,
    .create_buffer = drm_create_buffer,
    .create_planar_buffer = drm_create_planar_buffer,
    .create_prime_buffer = drm_create_prime_buffer,
};

static void drm_bind(struct wl_client *c, void *data, uint32_t version, uint32_t id) {
    (void)data;
    struct wl_resource *res = wl_resource_create(c, &wl_drm_interface, version, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &drm_impl, NULL, NULL);
    wl_drm_send_device(res, gl.device);
    wl_drm_send_format(res, FMT_ARGB8888);
    wl_drm_send_format(res, FMT_XRGB8888);
    if (version >= 2) wl_drm_send_capabilities(res, WL_DRM_CAPABILITY_PRIME);
}

/* ---- surfaces ---- */

enum role { ROLE_NONE, ROLE_TOPLEVEL, ROLE_SUB };

struct surface {
    struct wl_resource *res;
    struct wl_list link;          /* surfaces */
    enum role role;
    struct surface *parent;       /* ROLE_SUB */
    int sx, sy, pend_sx, pend_sy; /* position in the parent (ROLE_SUB) */
    struct wl_resource *pend_buffer;
    int pend_attached;
    struct wl_list pend_frames, frames;   /* wl_callback resources */
    uint32_t *pix;
    int w, h;
    long order;                   /* the newest toplevel is shown */
    struct wl_resource *xdg_surface, *xdg_toplevel;
    int configured;
    char title[128];
    /* wp_viewport: the size the surface is shown at (0: its buffer's), and
     * the part of the buffer shown (sw 0: all); pending until commit */
    struct wl_resource *viewport, *subsurface;
    int dw, dh, pend_dw, pend_dh;
    double vx, vy, vw, vh, pend_vx, pend_vy, pend_vw, pend_vh;
    /* shown through Winston: its GPU buffer, not read back yet (pix is
     * stale); compose() passes it on as it is, or reads it back */
    struct drm_buffer *drm;
};

static struct wl_list surfaces;
static long next_order;

static void drm_done(struct surface *s);

/* A GPU buffer the client destroyed: no surface shows it any more. */
static void drm_buffer_gone(struct drm_buffer *b) {
    struct surface *s;
    wl_list_for_each(s, &surfaces, link)
        if (s->drm == b) { s->drm = NULL; dirty = 1; }
}

static void remove_cb(struct wl_resource *res) { wl_list_remove(wl_resource_get_link(res)); }

/* input (--input): the surface the pointer and keyboard last entered, and
 * where the shown toplevel's (0,0) is on the canvas (compose) */
static struct surface *entered, *shown_top;
static int org_x, org_y;

static void surface_destroy_res(struct wl_resource *res) {
    struct surface *s = wl_resource_get_user_data(res);
    struct surface *o;
    drm_done(s);
    if (entered == s) entered = NULL;
    if (shown_top == s) shown_top = NULL;
    wl_list_for_each(o, &surfaces, link)
        if (o->parent == s) o->parent = NULL;
    struct wl_resource *cb, *tmp;
    wl_resource_for_each_safe(cb, tmp, &s->pend_frames) wl_resource_destroy(cb);
    wl_resource_for_each_safe(cb, tmp, &s->frames) wl_resource_destroy(cb);
    /* the role objects outlive it only as inert handles */
    struct wl_resource *roles[] = { s->xdg_surface, s->xdg_toplevel, s->viewport, s->subsurface };
    for (size_t i = 0; i < sizeof roles / sizeof *roles; i++)
        if (roles[i]) wl_resource_set_user_data(roles[i], NULL);
    wl_list_remove(&s->link);
    free(s->pix);
    free(s);
    dirty = 1;
}

static void s_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }

static void s_attach(struct wl_client *c, struct wl_resource *r, struct wl_resource *buffer, int32_t x, int32_t y) {
    (void)c; (void)x; (void)y;
    struct surface *s = wl_resource_get_user_data(r);
    s->pend_buffer = buffer;
    s->pend_attached = 1;
}

static void s_damage(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)c; (void)r; (void)x; (void)y; (void)w; (void)h;
}

static void s_frame(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct surface *s = wl_resource_get_user_data(r);
    struct wl_resource *cb = wl_resource_create(c, &wl_callback_interface, 1, id);
    if (!cb) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(cb, NULL, NULL, remove_cb);
    wl_list_insert(s->pend_frames.prev, wl_resource_get_link(cb));
}

static void s_region(struct wl_client *c, struct wl_resource *r, struct wl_resource *region) {
    (void)c; (void)r; (void)region;
}

/* Copies the attached buffer into the surface: shm directly, wl_drm through GL. */
/* A GPU buffer the surface no longer shows: back to the client, unless
 * Winston still has it (then at Winston's release). */
static void drm_done(struct surface *s) {
    struct drm_buffer *b = s->drm;
    s->drm = NULL;
    if (b && !b->held) wl_buffer_send_release(b->res);
}

/* The surface's deferred GPU buffer into its pixels, then done with it. */
static void drm_read_back(struct surface *s) {
    struct drm_buffer *b = s->drm;
    if (!b) return;
    if (!s->pix || s->w != b->w || s->h != b->h) {
        free(s->pix);
        s->pix = calloc((size_t)b->w * b->h, 4);
        s->w = s->pix ? b->w : 0; s->h = s->pix ? b->h : 0;
    }
    if (s->pix && drm_buffer_read(b, s->pix) == 0) n_drm++;
    drm_done(s);
}

/* Copies the attached buffer into the surface: shm directly, wl_drm through
 * GL; while shown through Winston a wl_drm buffer is kept as it is instead
 * (compose: passed on, or read back then). 1: kept, released later. */
static int take_buffer(struct surface *s, struct wl_resource *buffer) {
    struct wl_shm_buffer *shm = wl_shm_buffer_get(buffer);
    struct drm_buffer *drm = NULL;
    int w, h;
    if (shm) {
        w = wl_shm_buffer_get_width(shm); h = wl_shm_buffer_get_height(shm);
    } else if (wl_resource_instance_of(buffer, &wl_buffer_interface, &drm_buffer_impl)) {
        drm = wl_resource_get_user_data(buffer);
        w = drm->w; h = drm->h;
    } else {
        return 0;
    }
    if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return 0;
    if (s->drm && s->drm != drm) drm_done(s);   /* superseded */
    if (drm && wshown && wo && !drm->refused) {
        s->drm = drm;
        s->w = w; s->h = h;   /* the size it is shown at; pix is filled only if it is read back */
        if (s->pix) { free(s->pix); s->pix = NULL; }
        return 1;
    }
    if (drm && s->drm == drm) s->drm = NULL;   /* read back below and released now */
    if (!s->pix || w != s->w || h != s->h) {   /* (no pixels after a buffer passed on) */
        free(s->pix);
        s->pix = calloc((size_t)w * h, 4);
        s->w = s->pix ? w : 0; s->h = s->pix ? h : 0;
        if (!s->pix) return 0;
    }
    if (shm) {
        int stride = wl_shm_buffer_get_stride(shm);
        wl_shm_buffer_begin_access(shm);
        const uint8_t *p = wl_shm_buffer_get_data(shm);
        for (int y = 0; y < h; y++) memcpy(s->pix + (long)y * w, p + (long)y * stride, (size_t)w * 4);
        wl_shm_buffer_end_access(shm);
        n_shm++;
    } else {
        if (drm_buffer_read(drm, s->pix) == 0) n_drm++;
    }
    return 0;
}

static void s_commit(struct wl_client *c, struct wl_resource *r) {
    (void)c;
    struct surface *s = wl_resource_get_user_data(r);
    n_commits++;
    if (s->pend_attached) {
        if (s->pend_buffer) {
            if (!take_buffer(s, s->pend_buffer)) wl_buffer_send_release(s->pend_buffer);
        } else {
            drm_done(s);
            free(s->pix); s->pix = NULL; s->w = s->h = 0;
        }
        s->pend_buffer = NULL;
        s->pend_attached = 0;
    }
    s->sx = s->pend_sx; s->sy = s->pend_sy;
    s->dw = s->pend_dw; s->dh = s->pend_dh;
    s->vx = s->pend_vx; s->vy = s->pend_vy; s->vw = s->pend_vw; s->vh = s->pend_vh;
    wl_list_insert_list(s->frames.prev, &s->pend_frames);
    wl_list_init(&s->pend_frames);
    if (s->role == ROLE_TOPLEVEL && s->xdg_surface && !s->configured) {
        /* The first commit asks for the configure; full screen at the frame's size. */
        struct wl_array states;
        wl_array_init(&states);
        uint32_t *st = wl_array_add(&states, sizeof *st);
        if (st) *st = XDG_TOPLEVEL_STATE_ACTIVATED;
        xdg_toplevel_send_configure(s->xdg_toplevel, 0, 0, &states);
        wl_array_release(&states);
        xdg_surface_send_configure(s->xdg_surface, wl_display_next_serial(display));
        s->configured = 1;
    }
    if (s->role == ROLE_TOPLEVEL && s->pix && !s->order) s->order = ++next_order;
    dirty = 1;
}

static void s_set_transform(struct wl_client *c, struct wl_resource *r, int32_t t) { (void)c; (void)r; (void)t; }
static void s_set_scale(struct wl_client *c, struct wl_resource *r, int32_t sc) { (void)c; (void)r; (void)sc; }
static void s_offset(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y) { (void)c; (void)r; (void)x; (void)y; }

static const struct wl_surface_interface surface_impl = {
    .destroy = s_destroy, .attach = s_attach, .damage = s_damage, .frame = s_frame,
    .set_opaque_region = s_region, .set_input_region = s_region, .commit = s_commit,
    .set_buffer_transform = s_set_transform, .set_buffer_scale = s_set_scale,
    .damage_buffer = s_damage, .offset = s_offset,
};

static void region_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void region_box(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)c; (void)r; (void)x; (void)y; (void)w; (void)h;
}
static const struct wl_region_interface region_impl = { .destroy = region_destroy, .add = region_box, .subtract = region_box };

static void comp_create_surface(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct surface *s = calloc(1, sizeof *s);
    if (!s) { wl_client_post_no_memory(c); return; }
    s->res = wl_resource_create(c, &wl_surface_interface, wl_resource_get_version(r), id);
    if (!s->res) { free(s); wl_client_post_no_memory(c); return; }
    wl_list_init(&s->pend_frames);
    wl_list_init(&s->frames);
    wl_list_insert(&surfaces, &s->link);
    wl_resource_set_implementation(s->res, &surface_impl, s, surface_destroy_res);
}

static void comp_create_region(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct wl_resource *res = wl_resource_create(c, &wl_region_interface, 1, id);
    (void)r;
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &region_impl, NULL, NULL);
}

static const struct wl_compositor_interface compositor_impl = {
    .create_surface = comp_create_surface, .create_region = comp_create_region,
};

static void compositor_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &wl_compositor_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &compositor_impl, NULL, NULL);
}

/* ---- subsurfaces ---- */

static void sub_destroy_res(struct wl_resource *res) {
    struct surface *s = wl_resource_get_user_data(res);
    if (s) { s->role = ROLE_NONE; s->parent = NULL; s->subsurface = NULL; dirty = 1; }
}
static void sub_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void sub_set_position(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y) {
    (void)c;
    struct surface *s = wl_resource_get_user_data(r);
    if (s) { s->pend_sx = x; s->pend_sy = y; }
}
static void sub_place(struct wl_client *c, struct wl_resource *r, struct wl_resource *sibling) { (void)c; (void)r; (void)sibling; }
static void sub_sync(struct wl_client *c, struct wl_resource *r) { (void)c; (void)r; }

static const struct wl_subsurface_interface subsurface_impl = {
    .destroy = sub_destroy, .set_position = sub_set_position, .place_above = sub_place,
    .place_below = sub_place, .set_sync = sub_sync, .set_desync = sub_sync,
};

static void subcomp_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void subcomp_get(struct wl_client *c, struct wl_resource *r, uint32_t id,
                        struct wl_resource *surface, struct wl_resource *parent) {
    (void)r;
    struct surface *s = wl_resource_get_user_data(surface);
    struct wl_resource *res = wl_resource_create(c, &wl_subsurface_interface, 1, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    s->role = ROLE_SUB;
    s->parent = wl_resource_get_user_data(parent);
    s->subsurface = res;
    wl_resource_set_implementation(res, &subsurface_impl, s, sub_destroy_res);
}
static const struct wl_subcompositor_interface subcompositor_impl = {
    .destroy = subcomp_destroy, .get_subsurface = subcomp_get,
};
static void subcompositor_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &wl_subcompositor_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &subcompositor_impl, NULL, NULL);
}

/* ---- xdg-shell ---- */

static void top_destroy_res(struct wl_resource *res) {
    struct surface *s = wl_resource_get_user_data(res);
    if (s) { s->xdg_toplevel = NULL; s->role = ROLE_NONE; s->order = 0; dirty = 1; }
}
static void top_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void top_set_parent(struct wl_client *c, struct wl_resource *r, struct wl_resource *p) { (void)c; (void)r; (void)p; }
static void top_set_title(struct wl_client *c, struct wl_resource *r, const char *title) {
    (void)c;
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    snprintf(s->title, sizeof s->title, "%s", title);
    printf("{\"ev\":\"toplevel\",\"title\":"); jstr(title); puts("}");
    fflush(stdout);
}
static void top_set_app_id(struct wl_client *c, struct wl_resource *r, const char *id) { (void)c; (void)r; (void)id; }
static void top_menu(struct wl_client *c, struct wl_resource *r, struct wl_resource *seat, uint32_t serial, int32_t x, int32_t y) {
    (void)c; (void)r; (void)seat; (void)serial; (void)x; (void)y;
}
static void top_move(struct wl_client *c, struct wl_resource *r, struct wl_resource *seat, uint32_t serial) {
    (void)c; (void)r; (void)seat; (void)serial;
}
static void top_resize(struct wl_client *c, struct wl_resource *r, struct wl_resource *seat, uint32_t serial, uint32_t edges) {
    (void)c; (void)r; (void)seat; (void)serial; (void)edges;
}
static void top_size(struct wl_client *c, struct wl_resource *r, int32_t w, int32_t h) { (void)c; (void)r; (void)w; (void)h; }
static void top_noarg(struct wl_client *c, struct wl_resource *r) { (void)c; (void)r; }

/* Full screen: the frame's size, so the game draws at it. */
static void top_set_fullscreen(struct wl_client *c, struct wl_resource *r, struct wl_resource *output) {
    (void)c; (void)output;
    struct surface *s = wl_resource_get_user_data(r);
    if (!s || !s->xdg_surface) return;
    struct wl_array states;
    wl_array_init(&states);
    uint32_t *st = wl_array_add(&states, 2 * sizeof *st);
    if (st) { st[0] = XDG_TOPLEVEL_STATE_FULLSCREEN; st[1] = XDG_TOPLEVEL_STATE_ACTIVATED; }
    xdg_toplevel_send_configure(r, out_w, out_h, &states);
    wl_array_release(&states);
    xdg_surface_send_configure(s->xdg_surface, wl_display_next_serial(display));
}

static const struct xdg_toplevel_interface toplevel_impl = {
    .destroy = top_destroy, .set_parent = top_set_parent, .set_title = top_set_title,
    .set_app_id = top_set_app_id, .show_window_menu = top_menu, .move = top_move, .resize = top_resize,
    .set_max_size = top_size, .set_min_size = top_size, .set_maximized = top_noarg,
    .unset_maximized = top_noarg, .set_fullscreen = top_set_fullscreen, .unset_fullscreen = top_noarg,
    .set_minimized = top_noarg,
};

static void xs_destroy_res(struct wl_resource *res) {
    struct surface *s = wl_resource_get_user_data(res);
    if (s) s->xdg_surface = NULL;
}
static void xs_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void xs_get_toplevel(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct surface *s = wl_resource_get_user_data(r);
    struct wl_resource *res = wl_resource_create(c, &xdg_toplevel_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(c); return; }
    if (s) { s->role = ROLE_TOPLEVEL; s->xdg_toplevel = res; }
    wl_resource_set_implementation(res, &toplevel_impl, s, top_destroy_res);
}
static void popup_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void popup_grab(struct wl_client *c, struct wl_resource *r, struct wl_resource *seat, uint32_t serial) {
    (void)c; (void)r; (void)seat; (void)serial;
}
static void popup_reposition(struct wl_client *c, struct wl_resource *r, struct wl_resource *pos, uint32_t token) {
    (void)c; (void)r; (void)pos; (void)token;
}
static const struct xdg_popup_interface popup_impl = {
    .destroy = popup_destroy, .grab = popup_grab, .reposition = popup_reposition,
};

static void xs_get_popup(struct wl_client *c, struct wl_resource *r, uint32_t id, struct wl_resource *parent,
                         struct wl_resource *positioner) {
    (void)parent; (void)positioner;
    /* Not shown; created so the client carries on (popup_done tells it it's gone). */
    struct wl_resource *res = wl_resource_create(c, &xdg_popup_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &popup_impl, NULL, NULL);
    xdg_popup_send_popup_done(res);
}
static void xs_set_geometry(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)c; (void)r; (void)x; (void)y; (void)w; (void)h;
}
static void xs_ack(struct wl_client *c, struct wl_resource *r, uint32_t serial) { (void)c; (void)r; (void)serial; }

static const struct xdg_surface_interface xdg_surface_impl = {
    .destroy = xs_destroy, .get_toplevel = xs_get_toplevel, .get_popup = xs_get_popup,
    .set_window_geometry = xs_set_geometry, .ack_configure = xs_ack,
};

static void pos_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void pos_ii(struct wl_client *c, struct wl_resource *r, int32_t a, int32_t b) { (void)c; (void)r; (void)a; (void)b; }
static void pos_u(struct wl_client *c, struct wl_resource *r, uint32_t a) { (void)c; (void)r; (void)a; }
static void pos_rect(struct wl_client *c, struct wl_resource *r, int32_t x, int32_t y, int32_t w, int32_t h) {
    (void)c; (void)r; (void)x; (void)y; (void)w; (void)h;
}
static void pos_none(struct wl_client *c, struct wl_resource *r) { (void)c; (void)r; }
static void pos_parent_configure(struct wl_client *c, struct wl_resource *r, uint32_t s) { (void)c; (void)r; (void)s; }
static const struct xdg_positioner_interface positioner_impl = {
    .destroy = pos_destroy, .set_size = pos_ii, .set_anchor_rect = pos_rect, .set_anchor = pos_u,
    .set_gravity = pos_u, .set_constraint_adjustment = pos_u, .set_offset = pos_ii,
    .set_reactive = pos_none, .set_parent_size = pos_ii, .set_parent_configure = pos_parent_configure,
};

static void wm_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void wm_create_positioner(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct wl_resource *res = wl_resource_create(c, &xdg_positioner_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &positioner_impl, NULL, NULL);
}
static void wm_get_xdg_surface(struct wl_client *c, struct wl_resource *r, uint32_t id, struct wl_resource *surface) {
    struct surface *s = wl_resource_get_user_data(surface);
    struct wl_resource *res = wl_resource_create(c, &xdg_surface_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(c); return; }
    s->xdg_surface = res;
    s->configured = 0;
    wl_resource_set_implementation(res, &xdg_surface_impl, s, xs_destroy_res);
}
static void wm_pong(struct wl_client *c, struct wl_resource *r, uint32_t serial) { (void)c; (void)r; (void)serial; }
static const struct xdg_wm_base_interface wm_base_impl = {
    .destroy = wm_destroy, .create_positioner = wm_create_positioner,
    .get_xdg_surface = wm_get_xdg_surface, .pong = wm_pong,
};
static void wm_base_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &xdg_wm_base_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &wm_base_impl, NULL, NULL);
}

/* ---- wp_viewporter: Wine shows its window and GL surfaces at sizes it picks ---- */

static void vp_destroy_res(struct wl_resource *res) {
    struct surface *s = wl_resource_get_user_data(res);
    if (s) { s->viewport = NULL; s->pend_dw = s->pend_dh = 0; s->pend_vw = s->pend_vh = 0; }
}
static void vp_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void vp_set_source(struct wl_client *c, struct wl_resource *r, wl_fixed_t x, wl_fixed_t y, wl_fixed_t w, wl_fixed_t h) {
    (void)c;
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    /* -1 everywhere unsets it */
    if (w == wl_fixed_from_int(-1)) { s->pend_vw = s->pend_vh = 0; return; }
    s->pend_vx = wl_fixed_to_double(x); s->pend_vy = wl_fixed_to_double(y);
    s->pend_vw = wl_fixed_to_double(w); s->pend_vh = wl_fixed_to_double(h);
}
static void vp_set_destination(struct wl_client *c, struct wl_resource *r, int32_t w, int32_t h) {
    (void)c;
    struct surface *s = wl_resource_get_user_data(r);
    if (!s) return;
    s->pend_dw = w > 0 ? w : 0; s->pend_dh = h > 0 ? h : 0;
}
static const struct wp_viewport_interface viewport_impl = {
    .destroy = vp_destroy, .set_source = vp_set_source, .set_destination = vp_set_destination,
};
static void vpr_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void vpr_get_viewport(struct wl_client *c, struct wl_resource *r, uint32_t id, struct wl_resource *surface) {
    (void)r;
    struct surface *s = wl_resource_get_user_data(surface);
    struct wl_resource *res = wl_resource_create(c, &wp_viewport_interface, 1, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    s->viewport = res;
    wl_resource_set_implementation(res, &viewport_impl, s, vp_destroy_res);
}
static const struct wp_viewporter_interface viewporter_impl = {
    .destroy = vpr_destroy, .get_viewport = vpr_get_viewport,
};
static void viewporter_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &wp_viewporter_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &viewporter_impl, NULL, NULL);
}

/* ---- output and seat ---- */

static void output_release(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static const struct wl_output_interface output_impl = { .release = output_release };
static void output_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &wl_output_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &output_impl, NULL, NULL);
    /* 1920x720 at ~ 290 x 110 mm: the iDrive 7 centre display's shape */
    wl_output_send_geometry(res, 0, 0, 290, 110, WL_OUTPUT_SUBPIXEL_UNKNOWN, "BMW", "iDrive centre display",
                            WL_OUTPUT_TRANSFORM_NORMAL);
    wl_output_send_mode(res, WL_OUTPUT_MODE_CURRENT | WL_OUTPUT_MODE_PREFERRED, out_w, out_h, 60000);
    if (v >= 2) wl_output_send_scale(res, 1);
    if (v >= 4) { wl_output_send_name(res, "CENTRE-1"); wl_output_send_description(res, "iDrive centre display"); }
    if (v >= 2) wl_output_send_done(res);
}

static void pointer_set_cursor(struct wl_client *c, struct wl_resource *r, uint32_t serial, struct wl_resource *s,
                               int32_t x, int32_t y) { (void)c; (void)r; (void)serial; (void)s; (void)x; (void)y; }
static void res_release(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static const struct wl_pointer_interface pointer_impl = { .set_cursor = pointer_set_cursor, .release = res_release };
static const struct wl_keyboard_interface keyboard_impl = { .release = res_release };

/* every client's wl_pointer and wl_keyboard (--input sends to them) */
static struct wl_list pointers, keyboards;

static void seat_get_pointer(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct wl_resource *res = wl_resource_create(c, &wl_pointer_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &pointer_impl, NULL, remove_cb);
    wl_list_insert(&pointers, wl_resource_get_link(res));
    entered = NULL;   /* a new pointer gets its enter with the next touch */
}
static void seat_get_keyboard(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct wl_resource *res = wl_resource_create(c, &wl_keyboard_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &keyboard_impl, NULL, remove_cb);
    wl_list_insert(&keyboards, wl_resource_get_link(res));
    entered = NULL;
    int fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (fd >= 0) { wl_keyboard_send_keymap(res, WL_KEYBOARD_KEYMAP_FORMAT_NO_KEYMAP, fd, 0); close(fd); }
    if (wl_resource_get_version(r) >= 4) wl_keyboard_send_repeat_info(res, 0, 0);
}
static void seat_get_touch(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    (void)id;
    wl_resource_post_error(r, WL_SEAT_ERROR_MISSING_CAPABILITY, "no touch");
    (void)c;
}
static const struct wl_seat_interface seat_impl = {
    .get_pointer = seat_get_pointer, .get_keyboard = seat_get_keyboard, .get_touch = seat_get_touch,
    .release = res_release,
};
static void seat_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &wl_seat_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &seat_impl, NULL, NULL);
    wl_seat_send_capabilities(res, WL_SEAT_CAPABILITY_POINTER | WL_SEAT_CAPABILITY_KEYBOARD);
    if (v >= 2) wl_seat_send_name(res, "seat0");
}

/* ---- input (--input): stdin lines "d|m|u X Y" ---- */

/* A touch on the picture (canvas pixels): the shown toplevel gets the pointer
 * there (and the keyboard's focus, which Wine takes for its foreground
 * window), and the left button down (d) or up (u). Coordinates go through
 * org_x / org_y, so they stay right when only the client area is shown. */
static void touch_input(char kind, int X, int Y) {
    struct surface *top = shown_top;
    if (!top || !top->res) return;
    struct wl_client *cl = wl_resource_get_client(top->res);
    wl_fixed_t fx = wl_fixed_from_int(X - org_x), fy = wl_fixed_from_int(Y - org_y);
    uint32_t t = (uint32_t)now_ms();
    struct wl_resource *p;
    if (entered != top) {
        struct wl_array keys;
        wl_array_init(&keys);
        wl_resource_for_each(p, &keyboards)
            if (wl_resource_get_client(p) == cl) wl_keyboard_send_enter(p, wl_display_next_serial(display), top->res, &keys);
        wl_array_release(&keys);
        wl_resource_for_each(p, &pointers)
            if (wl_resource_get_client(p) == cl) wl_pointer_send_enter(p, wl_display_next_serial(display), top->res, fx, fy);
        entered = top;
    }
    wl_resource_for_each(p, &pointers) {
        if (wl_resource_get_client(p) != cl) continue;
        wl_pointer_send_motion(p, t, fx, fy);
        if (kind == 'd' || kind == 'u')
            wl_pointer_send_button(p, wl_display_next_serial(display), t, 0x110 /* BTN_LEFT */,
                                   kind == 'd' ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
        if (wl_resource_get_version(p) >= 5) wl_pointer_send_frame(p);
    }
    wl_display_flush_clients(display);
}

/* ---- through Winston (--winston) ---- */

/* Every GPU buffer Winston still has goes back to the client (our surface
 * went), each exactly once: the ones surfaces show are read back first (a
 * second release of a buffer the client has taken again made Mesa's Wayland
 * EGL drop it and Wine stall for good: real Wine on the bench, 2026-11-07). */
static void drm_buffers_unhold(void) {
    struct surface *s;
    wl_list_for_each(s, &surfaces, link)
        if (s->drm) drm_read_back(s);   /* releases it unless Winston has it */
    struct drm_buffer *b;
    wl_list_for_each(b, &drm_buffers, link)
        if (b->held) { b->held = 0; wl_buffer_send_release(b->res); }
    dirty = 1;
}

static void wo_lost(void) {
    if (!wo) return;
    if (wo_source) { wl_event_source_remove(wo_source); wo_source = NULL; }
    drm_buffers_unhold();
    struct drm_buffer *b;
    wl_list_for_each(b, &drm_buffers, link)
        if (b->wb) { wo_buf_free(b->wb); b->wb = NULL; }
    wo_ring_free(ring); ring = NULL;
    wo_close(wo); wo = NULL;
    wshown = 0;
    puts("{\"ev\":\"winston-lost\"}");   /* the frame file goes on */
    fflush(stdout);
}

static int on_wo(int fd, uint32_t mask, void *data) {
    (void)fd; (void)data;
    if ((mask & (WL_EVENT_HANGUP | WL_EVENT_ERROR)) || wo_dispatch(wo) < 0) wo_lost();
    return 0;
}

static void wo_say(void *ud, const char *m) {
    (void)ud;
    printf("{\"ev\":\"winston\",\"msg\":"); jstr(m); puts("}");
    fflush(stdout);
}

/* "winston X,Y,W,H": shown through Winston there; "hide": not. */
static void winston_cmd(const char *line) {
    int x, y, w, h;
    if (!strcmp(line, "hide")) {
        if (wshown && wo) wo_hide(wo);
        wshown = 0;
        drm_buffers_unhold();
        wo_ring_free(ring); ring = NULL;
        return;
    }
    if (sscanf(line, "winston %d,%d,%d,%d", &x, &y, &w, &h) != 4 || w < 16 || h < 16 || w > 4096 || h > 4096) return;
    if (!wo) { puts("{\"ev\":\"error\",\"error\":\"not connected to Winston\"}"); fflush(stdout); return; }
    wo_place(wo, x, y, w, h);
    if (wo_show(wo, 1) < 0) { wo_lost(); return; }
    wshown = 1;
    dirty = 1;   /* the current picture at the next tick */
}

static char in_buf[512];
static size_t in_len;

static int on_stdin(int fd, uint32_t mask, void *data) {
    struct wl_event_source **src = data;
    ssize_t r = (mask & WL_EVENT_READABLE) ? read(fd, in_buf + in_len, sizeof in_buf - 1 - in_len) : 0;
    if (r <= 0) {   /* the tool closed it: no more input, the game goes on */
        if (r < 0 && errno == EINTR) return 0;
        wl_event_source_remove(*src);
        *src = NULL;
        return 0;
    }
    in_len += (size_t)r;
    in_buf[in_len] = 0;
    char *line = in_buf, *nl;
    while ((nl = strchr(line, '\n'))) {
        *nl = 0;
        char kind;
        int x, y;
        if (!strncmp(line, "winston ", 8) || !strcmp(line, "hide"))
            winston_cmd(line);
        else if (sscanf(line, " %c %d %d", &kind, &x, &y) == 3 && (kind == 'd' || kind == 'm' || kind == 'u'))
            touch_input(kind, x, y);
        line = nl + 1;
    }
    in_len = strlen(line);
    memmove(in_buf, line, in_len);
    if (in_len >= sizeof in_buf - 1) in_len = 0;   /* a line too long: dropped */
    return 0;
}

/* ---- the picture ---- */

/* The size a surface is shown at: its viewport's, else its buffer's. */
static void shown_size(const struct surface *s, int *w, int *h) {
    *w = s->dw ? s->dw : (s->vw > 0 ? (int)s->vw : s->w);
    *h = s->dh ? s->dh : (s->vh > 0 ? (int)s->vh : s->h);
}

/* Draws s at x, y in its shown size (nearest-neighbour from its source
 * rectangle), clipped to the canvas. A 1x1 destination is how Wine hides one. */
static void blit(const struct surface *s, int x, int y) {
    int w, h;
    shown_size(s, &w, &h);
    if (w <= 1 && h <= 1) return;
    double sx0 = s->vw > 0 ? s->vx : 0, sy0 = s->vw > 0 ? s->vy : 0;
    double sw = s->vw > 0 ? s->vw : s->w, sh = s->vh > 0 ? s->vh : s->h;
    int scaled = w != s->w || h != s->h || sx0 != 0 || sy0 != 0;
    for (int r = 0; r < h; r++) {
        int oy = y + r;
        if (oy < 0 || oy >= out_h) continue;
        int x0 = x < 0 ? -x : 0, x1 = w;
        if (x + x1 > out_w) x1 = out_w - x;
        if (x1 <= x0) continue;
        uint32_t *dst = canvas + (long)oy * out_w + x;
        int syi = scaled ? (int)(sy0 + (r + 0.5) * sh / h) : r;
        if (syi < 0 || syi >= s->h) continue;
        const uint32_t *row = s->pix + (long)syi * s->w;
        if (!scaled) {
            for (int i = x0; i < x1; i++) dst[i] = row[i] & 0xffffff;
            continue;
        }
        for (int i = x0; i < x1; i++) {
            int sxi = (int)(sx0 + (i + 0.5) * sw / w);
            dst[i] = sxi >= 0 && sxi < s->w ? row[sxi] & 0xffffff : 0;
        }
    }
}

static void write_snap(void) {
    if (!snap_path) return;
    char tmp[512];
    snprintf(tmp, sizeof tmp, "%s.tmp", snap_path);
    static unsigned char *rgb;
    long n = (long)out_w * out_h;
    if (!rgb && !(rgb = malloc((size_t)n * 3))) return;
    for (long i = 0; i < n; i++) {
        uint32_t p = canvas[i];
        rgb[i * 3] = (unsigned char)(p >> 16); rgb[i * 3 + 1] = (unsigned char)(p >> 8); rgb[i * 3 + 2] = (unsigned char)p;
    }
    FILE *f = fopen(tmp, "wb");
    if (!f) return;
    fprintf(f, "P6\n%d %d\n255\n", out_w, out_h);
    fwrite(rgb, 3, (size_t)n, f);
    fclose(f);
    rename(tmp, snap_path);
}

static int whole_window;   /* --whole-window: the frame and title bar too */

/* It has a picture: its pixels, or (through Winston) a GPU buffer not read back. */
static int has(const struct surface *s) { return s->pix || s->drm; }

/* Through Winston, when the picture is one surface shown at its own size
 * whose content is a GPU buffer: that buffer straight to Winston, where the
 * composed picture would have it (wo_present_at: the same place, the same
 * touch mapping), no read-back, no copy. 1 when it went. */
static int forward(struct surface *x, int px, int py) {
    struct drm_buffer *d = x->drm;
    int w, h;
    shown_size(x, &w, &h);
    if (!d || w != d->w || h != d->h || x->vw > 0 || d->refused || px < 0 || py < 0 || px + w > out_w || py + h > out_h) return 0;
    if (!d->wb) {
        /* no modifier said (wl_drm): the driver takes the buffer's tiling from the kernel */
        d->wb = wo_buf_dmabuf(wo, d->fd, d->w, d->h, d->format, (uint32_t)d->offset, (uint32_t)d->stride, 0x00ffffffffffffffull);
        if (!d->wb) {
            d->refused = 1;
            puts("{\"ev\":\"error\",\"error\":\"Winston refused a GPU buffer: read back instead\"}");
            fflush(stdout);
            return 0;
        }
        wo_buf_on_release(d->wb, drm_buffer_released, d);
    }
    if (wo_present_at(wo, d->wb, w, h, out_w, out_h, px, py) < 0) return 0;
    d->held = 1;
    n_fwd++;
    n_winston++;
    return 1;
}

static void compose(void) {
    long t0 = now_ms();
    struct surface *top = NULL, *s;
    wl_list_for_each(s, &surfaces, link)
        if (s->role == ROLE_TOPLEVEL && s->xdg_toplevel && has(s) && (!top || s->order > top->order)) top = s;
    /* Wine puts a GL / Direct3D game's client area in a subsurface; the
     * toplevel under it is the window's frame, title bar included, drawn in
     * software. With one, only the largest such subsurface is shown, centred
     * (no title bar); else (a plain window) the toplevel with everything. */
    struct surface *client = NULL;
    int subs = 0;
    if (top) {
        long best = 0;
        wl_list_for_each(s, &surfaces, link) {
            if (s->role != ROLE_SUB || s->parent != top || !has(s)) continue;
            subs++;
            if (whole_window) continue;
            int w, h;
            shown_size(s, &w, &h);
            if (w > 1 && h > 1 && (long)w * h > best) { best = (long)w * h; client = s; }
        }
    }
    shown_top = top;
    /* the one surface shown alone, at its place in the picture */
    struct surface *alone = client ? client : (top && !subs ? top : NULL);
    if (alone && wshown && wo && alone->drm) {
        int w, h;
        shown_size(alone, &w, &h);
        int x = (out_w - w) / 2, y = (out_h - h) / 2;
        if (forward(alone, x, y)) {
            org_x = x - (client ? client->sx : 0); org_y = y - (client ? client->sy : 0);
            n_pictures++;
            n_ms_total += (unsigned long)(now_ms() - t0);
            return;
        }
    }
    /* composed: every GPU buffer kept as it is read back now */
    wl_list_for_each(s, &surfaces, link)
        if (s->drm) drm_read_back(s);
    memset(canvas, 0, (size_t)out_w * out_h * 4);
    if (client) {
        int cw, ch;
        shown_size(client, &cw, &ch);
        int x = (out_w - cw) / 2, y = (out_h - ch) / 2;
        blit(client, x, y);
        org_x = x - client->sx; org_y = y - client->sy;
    } else if (top) {
        int tw, th;
        shown_size(top, &tw, &th);
        int x = (out_w - tw) / 2, y = (out_h - th) / 2;
        blit(top, x, y);
        /* its subsurfaces, oldest first (the list is newest first) */
        wl_list_for_each_reverse(s, &surfaces, link)
            if (s->role == ROLE_SUB && s->parent == top && s->pix) blit(s, x + s->sx, y + s->sy);
        org_x = x; org_y = y;
    }
    if (wshown && wo) {
        /* full colour, straight to Winston: our next free buffer */
        if (!ring) ring = wo_ring_new(wo, out_w, out_h, 3);
        struct wo_buf *b = NULL;
        uint32_t *dst = ring ? wo_ring_next(ring, &b) : NULL;
        if (dst) {
            /* XRGB8888: Winston ignores the canvas's 0 alpha byte (bench) */
            memcpy(dst, canvas, (size_t)out_w * out_h * 4);
            if (wo_present(wo, b, out_w, out_h) == 0) n_winston++;
        }
    } else if (fo.map) {
        xrgb_to_i420(canvas, out_w, out_w, out_h, frame_out_next(&fo));
        frame_out_publish(&fo);
    }
    if (top) write_snap();   /* the last picture with a window in it */
    n_pictures++;
    n_ms_total += (unsigned long)(now_ms() - t0);
}

static int fps = 60;
static long last_stats;
static struct wl_event_source *tick_timer;

static int tick(void *data) {
    (void)data;
    if (dirty) { compose(); dirty = 0; }
    /* every waiting frame callback is answered at the picture's pace */
    uint32_t t = (uint32_t)now_ms();
    struct surface *s;
    wl_list_for_each(s, &surfaces, link) {
        struct wl_resource *cb, *tmp;
        wl_resource_for_each_safe(cb, tmp, &s->frames) {
            wl_callback_send_done(cb, t);
            wl_resource_destroy(cb);
        }
    }
    wl_display_flush_clients(display);
    long now = now_ms();
    /* WL_SINK_DEBUG=1 (the tool's STEAM_SINK_DEBUG): the buffers' and
     * surfaces' state each second on stderr (how Wine's stall at a hide was found) */
    if (now - last_stats >= 1000 && getenv("WL_SINK_DEBUG")) {
        int held = 0, nb = 0, sd = 0, ns = 0, fr = 0, pf = 0;
        struct drm_buffer *db;
        wl_list_for_each(db, &drm_buffers, link) { nb++; held += db->held; }
        struct surface *ss;
        wl_list_for_each(ss, &surfaces, link) {
            ns++; sd += ss->drm != NULL;
            struct wl_resource *cb;
            wl_resource_for_each(cb, &ss->frames) fr++;
            wl_resource_for_each(cb, &ss->pend_frames) pf++;
        }
        fprintf(stderr, "DBG commits %lu pics %lu bufs %d held %d surfaces %d with-drm %d frames %d pending-frames %d wshown %d\n",
                n_commits, n_pictures, nb, held, ns, sd, fr, pf, wshown);
    }
    if (now - last_stats >= 1000) {
        unsigned long pics = n_pictures - stat_pictures;
        if (pics) {
            printf("{\"ev\":\"stats\",\"pictures\":%lu,\"commits\":%lu,\"shm\":%lu,\"drm\":%lu,\"winston\":%lu,\"fwd\":%lu,\"ms\":%.1f}\n",
                   pics, n_commits, n_shm, n_drm, n_winston, n_fwd, (double)n_ms_total / (double)pics);
            fflush(stdout);
        }
        stat_pictures = n_pictures; n_ms_total = 0; last_stats = now;
    }
    wl_event_source_timer_update(tick_timer, 1000 / fps);
    return 0;
}

static int on_signal(int sig, void *data) {
    (void)sig; (void)data;
    wl_display_terminate(display);
    return 0;
}

/* The bench makes the frame file; on the car the tool's server does. */
static int create_frame(const char *path, int w, int h) {
    int fd = open(path, O_RDWR | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (fd < 0) return errno == EEXIST ? 0 : -1;
    size_t size = 64 + 3 * (size_t)w * h * 3 / 2;
    uint32_t hdr[16] = { FRAME_MAGIC, 1, (uint32_t)w, (uint32_t)h, 0, 0, 3, 0, 1 };
    int ok = ftruncate(fd, (off_t)size) == 0 && pwrite(fd, hdr, sizeof hdr, 0) == (ssize_t)sizeof hdr;
    close(fd);
    return ok ? 0 : -1;
}

int main(int argc, char **argv) {
    const char *sock = "wayland-1", *frame = NULL, *device = "/dev/dri/renderD128", *winston = NULL;
    int create_w = 0, create_h = 0, no_drm = 0, input = 0;
    long drop_uid = -1, drop_gid = -1;
    static const struct option opts[] = {
        { "socket", 1, 0, 's' }, { "frame", 1, 0, 'f' }, { "create", 1, 0, 'c' }, { "fps", 1, 0, 'r' },
        { "snap", 1, 0, 'p' }, { "device", 1, 0, 'd' }, { "no-drm", 0, 0, 'n' },
        { "uid", 1, 0, 'u' }, { "gid", 1, 0, 'g' }, { "input", 0, 0, 'i' }, { "whole-window", 0, 0, 'w' },
        { "winston", 1, 0, 'W' }, { 0, 0, 0, 0 } };
    for (int o; (o = getopt_long(argc, argv, "", opts, NULL)) != -1;) {
        switch (o) {
        case 's': sock = optarg; break;
        case 'f': frame = optarg; break;
        case 'c': if (sscanf(optarg, "%dx%d", &create_w, &create_h) != 2) create_w = 0; break;
        case 'r': fps = atoi(optarg); if (fps < 1 || fps > 240) fps = 60; break;
        case 'p': snap_path = optarg; break;
        case 'd': device = optarg; break;
        case 'n': no_drm = 1; break;
        case 'u': drop_uid = strtol(optarg, NULL, 10); break;
        case 'g': drop_gid = strtol(optarg, NULL, 10); break;
        case 'i': input = 1; break;
        case 'w': whole_window = 1; break;
        case 'W': winston = optarg; break;
        default:
            fprintf(stderr, "usage: wl-sink --socket NAME --frame FILE [--create WxH] [--fps N] [--snap F.ppm] [--device D] [--no-drm] [--uid U --gid G] [--input] [--whole-window] [--winston SOCKET]\n");
            return 2;
        }
    }
    if (!strcmp(device, "/dev/dri/card0")) { fprintf(stderr, "wl-sink: not card0 (Winston's)\n"); return 2; }
    if (frame) {
        char err[256];
        if (create_w && (create_w & 1 || create_h & 1 || create_frame(frame, create_w, create_h) < 0)) {
            printf("{\"ev\":\"error\",\"error\":\"cannot create the frame file\"}\n");
            return 1;
        }
        if (frame_out_open(&fo, frame, err, sizeof err) < 0) {
            printf("{\"ev\":\"error\",\"error\":"); jstr(err); puts("}");
            return 1;
        }
        frame_out_colour(&fo, 0, 1);
        out_w = fo.w; out_h = fo.h;
    } else if (create_w > 0 && create_h > 0) {
        out_w = create_w; out_h = create_h;
    }
    /* Winston's socket wants root or mgu_wayland: connected before the drop */
    if (winston) {
        char err[256];
        /* the backdrop: a game's client area passed on as it is sits in black, as in the composed picture */
        struct wo_opts wopts = { .socket = winston, .x = 108, .y = 82, .w = 1790, .h = 638, .log = wo_say, .backdrop = 1 };
        wo = wo_open(&wopts, err, sizeof err);
        if (!wo) { printf("{\"ev\":\"error\",\"error\":"); jstr(err); puts("}"); fflush(stdout); }
    }
    /* the frame file is mapped: from here on the tool's uid, the GPU's group
     * (and Winston's socket group: each show of our layer connects again) */
    if ((drop_uid >= 0) != (drop_gid >= 0)) { fprintf(stderr, "wl-sink: --uid and --gid go together\n"); return 2; }
    gid_t keep = wo ? (gid_t)wo_socket_gid(wo) : (gid_t)-1;
    if (drop_gid >= 0 && (setgroups(keep != (gid_t)-1 ? 1 : 0, &keep) < 0 || setgid((gid_t)drop_gid) < 0 || setuid((uid_t)drop_uid) < 0
                          || getuid() != (uid_t)drop_uid || geteuid() != (uid_t)drop_uid)) {
        printf("{\"ev\":\"error\",\"error\":\"cannot drop to uid %ld gid %ld\"}\n", drop_uid, drop_gid);
        return 1;
    }
    canvas = calloc((size_t)out_w * out_h, 4);
    if (!canvas) return 1;
    wl_list_init(&surfaces);
    wl_list_init(&drm_buffers);
    wl_list_init(&pointers);
    wl_list_init(&keyboards);

    display = wl_display_create();
    if (!display || wl_display_add_socket(display, sock) < 0) {
        printf("{\"ev\":\"error\",\"error\":\"cannot open the socket\"}\n");
        return 1;
    }
    wl_display_init_shm(display);   /* ARGB8888 and XRGB8888 */
    wl_global_create(display, &wl_compositor_interface, 4, NULL, compositor_bind);
    wl_global_create(display, &wl_subcompositor_interface, 1, NULL, subcompositor_bind);
    wl_global_create(display, &xdg_wm_base_interface, 5, NULL, wm_base_bind);
    wl_global_create(display, &wl_output_interface, 4, NULL, output_bind);
    wl_global_create(display, &wl_seat_interface, 5, NULL, seat_bind);
    wl_global_create(display, &wp_viewporter_interface, 1, NULL, viewporter_bind);
    if (!no_drm && gl_init(device) == 0)
        wl_global_create(display, &wl_drm_interface, 2, NULL, drm_bind);

    struct wl_event_loop *loop = wl_display_get_event_loop(display);
    tick_timer = wl_event_loop_add_timer(loop, tick, NULL);
    wl_event_loop_add_signal(loop, SIGTERM, on_signal, NULL);
    wl_event_loop_add_signal(loop, SIGINT, on_signal, NULL);
    signal(SIGPIPE, SIG_IGN);
    static struct wl_event_source *in_src;
    if (input || wo) in_src = wl_event_loop_add_fd(loop, 0, WL_EVENT_READABLE, on_stdin, &in_src);
    if (wo) wo_source = wl_event_loop_add_fd(loop, wo_fd(wo), WL_EVENT_READABLE, on_wo, NULL);

    printf("{\"ev\":\"ready\",\"socket\":"); jstr(sock);
    printf(",\"size\":[%d,%d],\"drm\":%s,\"device\":", out_w, out_h, gl.ok ? "true" : "false");
    jstr(gl.ok ? gl.device : NULL);
    printf(",\"winston\":%s}\n", wo ? "true" : "false");
    fflush(stdout);
    last_stats = now_ms();
    wl_event_source_timer_update(tick_timer, 1000 / fps);
    wl_display_run(display);
    wl_display_destroy_clients(display);
    wl_display_destroy(display);
    if (wo) { wo_ring_free(ring); wo_close(wo); }
    frame_out_close(&fo);
    return 0;
}
