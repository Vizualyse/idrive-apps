// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * chromium-wl: the browser's display. A minimal Wayland compositor that
 * Chromium (--ozone-platform=wayland) draws into; each picture goes straight
 * into mgu-render's frame file as I420 (libyuv's ARGBToJ420: BT.601 full
 * range, as the file says). No JPEG: 0.2.4's screencast encoded every
 * picture in Chromium's browser process and decoded it again in
 * chromium-sink. Derived from vizualyse-steam's wl-sink. It never touches the
 * display: the screen belongs to Winston and the HMI.
 *
 *   chromium-wl --dir DIR --socket NAME --size WxH [--fps N] [--uid U --gid G]
 *               [--drm --device /dev/dri/renderD128 --unit-lib /usr/lib] [--snap F.ppm]
 *
 * It lives as long as Chromium (a Wayland client dies with its compositor),
 * shown or not. Started as root (server.js), it drops to U:G (nobody and
 * Chromium's group) before anything else; the socket DIR/NAME is 0660, so
 * only that group connects. The frame file must be readable and writable by
 * U (server.js makes it nobody's: mgu-render takes the app's uid, root or
 * nobody).
 *
 * stdin, one command a line:
 *   show FILE   pictures into FILE from now on; the output takes its size
 *   winston X,Y,W,H  pictures straight onto the centre screen through Winston
 *               (--winston), fitted into that place; the output keeps its size
 *   hide        neither (pictures are kept at a slow pace for the next show)
 *   fps N       at most N pictures a second while shown (default 30)
 *
 * Through Winston (platform native/winston_out, knowledge/central-screen.md):
 * Chromium's GPU buffers (wl_drm, the GPU mode) go to Winston as they are,
 * as dmabufs, and go back to Chromium when Winston releases them: no
 * read-back, no conversion. Shared memory pictures are copied once into our
 * own buffers (full colour, no I420). --winston SOCKET connects at start,
 * before the drop to U:G (Winston's socket is root:mgu_wayland 0770).
 *
 * Pacing: a commit is converted at once (shared memory is read in place, no
 * copy), and the surface's frame callbacks are answered no sooner than 1/fps
 * after the last ones: Chromium draws its next frame only then, so it never
 * draws more than the screen takes (5 a second while hidden).
 *
 * What a client gets: wl_compositor 4, wl_subcompositor, wl_shm (ARGB / XRGB
 * 8888), xdg_wm_base 5 (one full-screen toplevel at the output's size,
 * popups dismissed), wl_output 4, wl_seat 5 (pointer and keyboard: input
 * goes in over DevTools, but the browser's window gets the keyboard's focus,
 * wl_keyboard.enter, or Chromium refuses a page pointer lock, a game's
 * "WrongDocumentError"). --drm (the GPU mode) adds wl_drm 2: the
 * render node for Chromium's GBM buffers, which come as PRIME (dmabuf)
 * buffers and are read back through the unit's own EGL (Mesa 19, loaded from
 * --unit-lib by path, as the browser's EGL shim does).
 *
 * stdout: one JSON event a line: {"ev":"ready",...}, {"ev":"toplevel",
 * "title":..}, {"ev":"stats","pictures":n,"commits":n,"shm":n,"drm":n,
 * "ms":avg conversion} once a second while pictures come, {"ev":"error",...}.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <grp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <libyuv/convert_from_argb.h>
#include <wayland-server.h>
#include "frame_out.h"
#include "winston_out.h"
#include "xdg-shell-server-protocol.h"
#include "wayland-drm-server-protocol.h"

#define FOURCC(a, b, c, d) ((uint32_t)(a) | (uint32_t)(b) << 8 | (uint32_t)(c) << 16 | (uint32_t)(d) << 24)
#define FMT_ARGB8888 FOURCC('A', 'R', '2', '4')
#define FMT_XRGB8888 FOURCC('X', 'R', '2', '4')
#define HIDDEN_FPS 5
#define SLOT0 64

static struct wl_display *display;
static struct frame_out fo;
static int shown;
static int out_w = 1280, out_h = 720;
static int fps = 30;
static const char *snap_path;
static long snap_at;
static uint8_t *last;                 /* the latest picture while hidden (I420, out_w x out_h) */
static int last_w, last_h, last_ok;
static uint32_t *canvas;              /* the general path: several surfaces */
static int canvas_w, canvas_h;
static unsigned long n_pictures, n_commits, n_shm, n_drm, n_us_total, stat_pictures;
static int src_w, src_h;              /* the last picture's buffer */
static struct wl_list outputs;        /* wl_output resources */
/* through Winston */
static struct wo *wo;                 /* the connection (--winston) */
static struct wl_event_source *wo_source;
static int wmode;                     /* the last show was "winston" */
static int wshown;                    /* shown through Winston now */
static struct wo_ring *ring;          /* our buffers for pictures we make */
static int ring_w, ring_h;
static uint32_t *lastbgra;            /* the latest picture while hidden (winston mode) */
static int lastbgra_w, lastbgra_h, lastbgra_ok;
static unsigned long n_fwd;           /* GPU buffers passed on as they are */
static struct wl_list drm_buffers;    /* every drm_buffer, for the releases at a hide */
static struct drm_buffer *last_drm;   /* the last GPU buffer passed on */

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}
static long now_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000000L + ts.tv_nsec / 1000;
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

static void error_event(const char *msg) {
    printf("{\"ev\":\"error\",\"error\":"); jstr(msg); puts("}");
    fflush(stdout);
}

/* ---- GL: the unit's EGL on a GBM display, for wl_drm buffers (the GPU mode) ---- */

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
} gl;

/* The unit's Mesa 19 by path: its libglapi and libgbm first (its EGL reads
 * gbm's internals), so the bundle's newer libgbm never meets it. */
static int gl_init(const char *device, const char *unit_lib) {
    char p[256];
    const char *libs[] = { "libglapi.so.0", "libgbm.so.1", "libEGL.so.1" };
    void *h[3];
    for (int i = 0; i < 3; i++) {
        snprintf(p, sizeof p, "%s/%s", unit_lib, libs[i]);
        if (!(h[i] = dlopen(p, RTLD_NOW | RTLD_GLOBAL))) { fprintf(stderr, "chromium-wl: %s\n", dlerror()); return -1; }
    }
    gl.getProcAddress = dlsym(h[2], "eglGetProcAddress");
    if (!gl.getProcAddress) return -1;
    EGLDisplay (*getPlatformDisplay)(unsigned, void *, const EGLint *) = gl.getProcAddress("eglGetPlatformDisplayEXT");
    unsigned (*initialize)(EGLDisplay, EGLint *, EGLint *) = gl.getProcAddress("eglInitialize");
    unsigned (*bindAPI)(unsigned) = gl.getProcAddress("eglBindAPI");
    EGLContext (*createContext)(EGLDisplay, void *, EGLContext, const EGLint *) = gl.getProcAddress("eglCreateContext");
    unsigned (*makeCurrent)(EGLDisplay, void *, void *, EGLContext) = gl.getProcAddress("eglMakeCurrent");
    const char *(*queryString)(EGLDisplay, EGLint) = gl.getProcAddress("eglQueryString");
    void *(*gbm_create_device)(int) = dlsym(h[1], "gbm_create_device");
    if (!getPlatformDisplay || !initialize || !bindAPI || !createContext || !makeCurrent || !queryString
        || !gbm_create_device) return -1;
    int fd = open(device, O_RDWR | O_CLOEXEC);
    if (fd < 0) { fprintf(stderr, "chromium-wl: %s: %s\n", device, strerror(errno)); return -1; }
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
    P(checkFramebufferStatus, "glCheckFramebufferStatus"); P(readPixels, "glReadPixels");
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
    int wo_refused;               /* Winston refused it: read back instead */
    int held;                     /* Winston has it: Chromium gets it back at its release */
};

static void drm_buffer_destroy_res(struct wl_resource *res) {
    struct drm_buffer *b = wl_resource_get_user_data(res);
    if (b->fd >= 0) close(b->fd);
    if (b->wb) wo_buf_free(b->wb);   /* Winston keeps what it shows */
    if (last_drm == b) last_drm = NULL;
    wl_list_remove(&b->link);
    free(b);
}

/* Winston no longer reads it: back to Chromium. */
static void drm_buffer_released(void *data, struct wo_buf *wb) {
    struct drm_buffer *b = data;
    (void)wb;
    if (!b->held) return;
    b->held = 0;
    wl_buffer_send_release(b->res);
}

/* Every buffer Winston still has goes back to Chromium (our surface went). */
static void drm_buffers_unhold(void) {
    struct drm_buffer *b;
    wl_list_for_each(b, &drm_buffers, link)
        if (b->held) { b->held = 0; wl_buffer_send_release(b->res); }
}

static void buffer_destroy(struct wl_client *c, struct wl_resource *res) { (void)c; wl_resource_destroy(res); }
static const struct wl_buffer_interface drm_buffer_impl = { .destroy = buffer_destroy };

/* Reads a wl_drm buffer into dst (w x h, BGRA bytes: libyuv's "ARGB") through an EGLImage. */
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
        /* RGBA bytes; a dmabuf's row 0 is its top */
        gl.readPixels(0, 0, b->w, b->h, GL_RGBA, GL_UNSIGNED_BYTE, dst);
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
    if (!b) { close(fd); wl_client_post_no_memory(c); return; }
    b->res = wl_resource_create(c, &wl_buffer_interface, 1, id);
    if (!b->res) { close(fd); free(b); wl_client_post_no_memory(c); return; }
    b->fd = fd; b->w = w; b->h = h; b->offset = o0; b->stride = s0; b->format = format;
    wl_list_insert(&drm_buffers, &b->link);
    wl_resource_set_implementation(b->res, &drm_buffer_impl, b, drm_buffer_destroy_res);
}
static const struct wl_drm_interface drm_impl = {
    .authenticate = drm_authenticate, .create_buffer = drm_create_buffer,
    .create_planar_buffer = drm_create_planar_buffer, .create_prime_buffer = drm_create_prime_buffer,
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

/* ---- the picture ---- */

/* Where the next picture goes: the frame file's next slot while shown, else `last`. */
static uint8_t *target(void) {
    if (shown) return frame_out_next(&fo);
    size_t n = (size_t)out_w * out_h * 3 / 2;
    if (!last || last_w != out_w || last_h != out_h) {
        free(last);
        last = malloc(n);
        last_w = out_w; last_h = out_h; last_ok = 0;
    }
    return last;
}

static void write_snap(const uint8_t *src, int stride, int w, int h) {
    long now = now_ms();
    if (!snap_path || now - snap_at < 1000) return;
    snap_at = now;
    char tmp[512];
    snprintf(tmp, sizeof tmp, "%s.tmp", snap_path);
    FILE *f = fopen(tmp, "wb");
    if (!f) return;
    fprintf(f, "P6\n%d %d\n255\n", w, h);
    unsigned char *row = malloc((size_t)w * 3);
    for (int y = 0; row && y < h; y++) {
        const uint8_t *p = src + (long)y * stride;
        for (int x = 0; x < w; x++) { row[x * 3] = p[x * 4 + 2]; row[x * 3 + 1] = p[x * 4 + 1]; row[x * 3 + 2] = p[x * 4]; }
        fwrite(row, 3, (size_t)w, f);
    }
    free(row);
    fclose(f);
    rename(tmp, snap_path);
}

/* w x h BGRA at the top left of an out_w x out_h picture: cut off where
 * bigger, black where smaller. */
static void copy_out(uint32_t *dst, const uint8_t *src, int stride, int w, int h) {
    int cw = w < out_w ? w : out_w, ch = h < out_h ? h : out_h;
    for (int y = 0; y < out_h; y++) {
        uint32_t *d = dst + (long)y * out_w;
        if (y < ch) {
            memcpy(d, src + (long)y * stride, (size_t)cw * 4);
            if (cw < out_w) memset(d + cw, 0, (size_t)(out_w - cw) * 4);
        } else {
            memset(d, 0, (size_t)out_w * 4);
        }
    }
}

static void wo_lost(void);

/* Through Winston: into our next free buffer, shown at once; hidden, kept
 * for the next show. */
static void picture_winston(const uint8_t *src, int stride, int w, int h) {
    long t0 = now_us();
    if (wshown && wo) {
        if (!ring || ring_w != out_w || ring_h != out_h) {
            wo_ring_free(ring);
            ring = wo_ring_new(wo, out_w, out_h, 3);
            ring_w = out_w; ring_h = out_h;
            if (!ring) { error_event("no buffers for Winston"); return; }
        }
        struct wo_buf *b;
        uint32_t *dst = wo_ring_next(ring, &b);
        if (!dst) return;   /* all three still on the screen: this one is dropped */
        copy_out(dst, src, stride, w, h);
        if (wo_present(wo, b, out_w, out_h) < 0) { wo_lost(); return; }
        last_drm = NULL;
    } else {
        if (!lastbgra || lastbgra_w != out_w || lastbgra_h != out_h) {
            free(lastbgra);
            lastbgra = malloc((size_t)out_w * out_h * 4);
            lastbgra_w = out_w; lastbgra_h = out_h; lastbgra_ok = 0;
            if (!lastbgra) return;
        }
        copy_out(lastbgra, src, stride, w, h);
        lastbgra_ok = 1;
    }
    write_snap(src, stride, w < out_w ? w : out_w, h < out_h ? h : out_h);
    n_pictures++;
    src_w = w; src_h = h;
    n_us_total += (unsigned long)(now_us() - t0);
}

/* A GPU buffer straight to Winston (shown, alone): 1 when it went, and
 * Chromium gets it back at Winston's release. */
static int forward_drm(struct drm_buffer *d) {
    if (!wshown || !wo || d->wo_refused || d->w < out_w || d->h < out_h) return 0;
    if (!d->wb) {
        /* no modifier said (wl_drm): the driver takes the buffer's tiling from the kernel */
        d->wb = wo_buf_dmabuf(wo, d->fd, d->w, d->h, d->format, (uint32_t)d->offset, (uint32_t)d->stride,
                              0x00ffffffffffffffull);
        if (!d->wb) { d->wo_refused = 1; error_event("Winston refused a GPU buffer: read back instead"); return 0; }
        wo_buf_on_release(d->wb, drm_buffer_released, d);
    }
    long t0 = now_us();
    if (wo_present(wo, d->wb, out_w, out_h) < 0) { wo_lost(); return 0; }
    d->held = 1;
    last_drm = d;
    n_fwd++; n_pictures++;
    src_w = d->w; src_h = d->h;
    n_us_total += (unsigned long)(now_us() - t0);
    return 1;
}

/* One picture from w x h pixels (BGRA bytes, stride bytes) at the top left:
 * cut off where bigger than the output, black where smaller. */
static void picture(const uint8_t *src, int stride, int w, int h) {
    if (wmode) { picture_winston(src, stride, w, h); return; }
    long t0 = now_us();
    uint8_t *dst = target();
    if (!dst) return;
    int ow = out_w, oh = out_h;
    uint8_t *Y = dst, *U = dst + (long)ow * oh, *V = U + (long)(ow / 2) * (oh / 2);
    int cw = (w < ow ? w : ow) & ~1, ch = (h < oh ? h : oh) & ~1;
    if (cw < ow || ch < oh) {
        memset(Y, 0, (size_t)ow * oh);
        memset(U, 128, (size_t)(ow / 2) * (oh / 2) * 2);
    }
    if (cw > 0 && ch > 0) ARGBToJ420(src, stride, Y, ow, U, ow / 2, V, ow / 2, cw, ch);
    if (shown) frame_out_publish(&fo); else last_ok = 1;
    write_snap(src, stride, w < ow ? w : ow, h < oh ? h : oh);
    n_pictures++;
    src_w = w; src_h = h;
    n_us_total += (unsigned long)(now_us() - t0);
}

/* ---- surfaces ---- */

enum role { ROLE_NONE, ROLE_TOPLEVEL, ROLE_SUB };

struct surface {
    struct wl_resource *res;
    struct wl_list link;          /* surfaces, newest first */
    enum role role;
    struct surface *parent;       /* ROLE_SUB */
    int sx, sy, pend_sx, pend_sy; /* position in the parent (ROLE_SUB) */
    struct wl_resource *pend_buffer;
    int pend_attached;
    struct wl_list pend_frames, frames;   /* wl_callback resources */
    int has;                      /* it shows a buffer */
    uint32_t *pix;                /* its pixels, kept only on the general path */
    int w, h;
    long order;                   /* the newest toplevel is shown */
    struct wl_resource *xdg_surface, *xdg_toplevel, *subsurface;
    int configured;
    int child;                    /* a toplevel with a parent: a dialog */
};

static struct wl_list surfaces;
static struct wl_list keyboards;       /* wl_keyboard resources */
static struct surface *focus;          /* the one the keyboards entered */
static long next_order;
static int dirty;
static struct wl_event_source *frame_timer;
static long last_done;

/* The browser's window: the first toplevel to show a buffer, of those without
 * a parent (a dialog of Chromium's own is a toplevel with one, never shown). */
static struct surface *top_surface(void) {
    struct surface *top = NULL, *s;
    wl_list_for_each(s, &surfaces, link)
        if (s->role == ROLE_TOPLEVEL && s->xdg_toplevel && s->has && !s->child && (!top || s->order < top->order)) top = s;
    return top;
}

/* The shown tree is one surface with a buffer (Chromium on shared memory
 * draws everything into its toplevel): then a commit goes straight to a
 * picture, no copy. Otherwise every surface keeps its pixels and they are
 * composed. */
static int alone(const struct surface *s) {
    struct surface *o;
    if (s->role != ROLE_TOPLEVEL || top_surface() != s) return 0;
    wl_list_for_each(o, &surfaces, link)
        if (o != s && o->has && o->role == ROLE_SUB && o->parent == s) return 0;
    return 1;
}

static void compose(void) {
    struct surface *top = top_surface(), *s;
    if (!top) return;
    if (canvas_w != out_w || canvas_h != out_h) {
        free(canvas);
        canvas = calloc((size_t)out_w * out_h, 4);
        canvas_w = canvas ? out_w : 0; canvas_h = canvas ? out_h : 0;
        if (!canvas) return;
    } else {
        memset(canvas, 0, (size_t)out_w * out_h * 4);
    }
    /* the toplevel, then its subsurfaces oldest first (the list is newest first) */
    struct surface *order[64];
    int n = 0;
    order[n++] = top;
    wl_list_for_each_reverse(s, &surfaces, link)
        if (n < 64 && s->role == ROLE_SUB && s->parent == top && s->pix) order[n++] = s;
    for (int i = 0; i < n; i++) {
        s = order[i];
        if (!s->pix) continue;
        int x = i ? s->sx : 0, y = i ? s->sy : 0;
        for (int r = 0; r < s->h; r++) {
            int oy = y + r;
            if (oy < 0 || oy >= out_h) continue;
            int x0 = x < 0 ? -x : 0, x1 = s->w;
            if (x + x1 > out_w) x1 = out_w - x;
            if (x1 > x0) memcpy(canvas + (long)oy * out_w + x + x0, s->pix + (long)r * s->w + x0, (size_t)(x1 - x0) * 4);
        }
    }
    picture((const uint8_t *)canvas, out_w * 4, out_w, out_h);
}

/* Frame callbacks are answered no sooner than 1/fps after the last ones. */
static void arm_frames(void) {
    long period = 1000 / (shown || wshown ? fps : HIDDEN_FPS);
    long wait = last_done + period - now_ms();
    wl_event_source_timer_update(frame_timer, wait < 1 ? 1 : (int)wait);
}

static int frame_tick(void *data) {
    (void)data;
    if (dirty) { compose(); dirty = 0; }
    uint32_t t = (uint32_t)now_ms();
    struct surface *s;
    int any = 0;
    wl_list_for_each(s, &surfaces, link) {
        struct wl_resource *cb, *tmp;
        wl_resource_for_each_safe(cb, tmp, &s->frames) {
            wl_callback_send_done(cb, t);
            wl_resource_destroy(cb);
            any = 1;
        }
    }
    if (any) last_done = now_ms();
    wl_display_flush_clients(display);
    return 0;
}

static void remove_cb(struct wl_resource *res) { wl_list_remove(wl_resource_get_link(res)); }

static void surface_destroy_res(struct wl_resource *res) {
    struct surface *s = wl_resource_get_user_data(res);
    struct surface *o;
    if (focus == s) focus = NULL;
    wl_list_for_each(o, &surfaces, link)
        if (o->parent == s) o->parent = NULL;
    struct wl_resource *cb, *tmp;
    wl_resource_for_each_safe(cb, tmp, &s->pend_frames) wl_resource_destroy(cb);
    wl_resource_for_each_safe(cb, tmp, &s->frames) wl_resource_destroy(cb);
    struct wl_resource *roles[] = { s->xdg_surface, s->xdg_toplevel, s->subsurface };
    for (size_t i = 0; i < sizeof roles / sizeof *roles; i++)
        if (roles[i]) wl_resource_set_user_data(roles[i], NULL);
    wl_list_remove(&s->link);
    free(s->pix);
    free(s);
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
static void s_region(struct wl_client *c, struct wl_resource *r, struct wl_resource *region) { (void)c; (void)r; (void)region; }

static int ensure_pix(struct surface *s, int w, int h) {
    if (s->pix && s->w == w && s->h == h) return 0;
    free(s->pix);
    s->pix = malloc((size_t)w * h * 4);
    return s->pix ? 0 : -1;
}

/* The attached buffer: a picture at once when the surface is shown alone,
 * else its pixels kept for compose(). 1 when Winston took the buffer
 * itself (it is released to the client later). */
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
    s->has = 1;
    if (s->role == ROLE_TOPLEVEL && !s->order) s->order = ++next_order;
    int direct = s->role == ROLE_TOPLEVEL && alone(s);
    if (drm && direct && forward_drm(drm)) {
        free(s->pix); s->pix = NULL;
        s->w = w; s->h = h;
        return 1;
    }
    if (shm) {
        n_shm++;
        int stride = wl_shm_buffer_get_stride(shm);
        wl_shm_buffer_begin_access(shm);
        const uint8_t *p = wl_shm_buffer_get_data(shm);
        if (direct) {
            free(s->pix); s->pix = NULL;
            s->w = w; s->h = h;
            picture(p, stride, w, h);
        } else if (ensure_pix(s, w, h) == 0) {
            s->w = w; s->h = h;
            for (int y = 0; y < h; y++) memcpy(s->pix + (long)y * w, p + (long)y * stride, (size_t)w * 4);
            dirty = 1;
        }
        wl_shm_buffer_end_access(shm);
    } else if (ensure_pix(s, w, h) == 0) {
        s->w = w; s->h = h;
        if (drm_buffer_read(drm, s->pix) == 0) {
            n_drm++;
            if (direct) picture((const uint8_t *)s->pix, w * 4, w, h); else dirty = 1;
        }
    }
    return 0;
}

/* Keyboard focus on the browser's window (top_surface), for kb, or every
 * keyboard of its client when the window changed. */
static void enter(struct wl_resource *kb, struct surface *s) {
    if (wl_resource_get_client(kb) != wl_resource_get_client(s->res)) return;
    struct wl_array keys;
    wl_array_init(&keys);
    wl_keyboard_send_enter(kb, wl_display_next_serial(display), s->res, &keys);
    wl_array_release(&keys);
}
static void refocus(void) {
    struct surface *t = top_surface();
    if (!t || t == focus) return;
    struct wl_resource *kb;
    if (focus)
        wl_resource_for_each(kb, &keyboards)
            if (wl_resource_get_client(kb) == wl_resource_get_client(focus->res))
                wl_keyboard_send_leave(kb, wl_display_next_serial(display), focus->res);
    focus = t;
    wl_resource_for_each(kb, &keyboards) enter(kb, t);
}

static void send_configure(struct surface *s) {
    if (!s->xdg_toplevel || !s->xdg_surface) return;
    struct wl_array states;
    wl_array_init(&states);
    uint32_t *st = wl_array_add(&states, 2 * sizeof *st);
    if (st) { st[0] = XDG_TOPLEVEL_STATE_FULLSCREEN; st[1] = XDG_TOPLEVEL_STATE_ACTIVATED; }
    xdg_toplevel_send_configure(s->xdg_toplevel, out_w, out_h, &states);
    wl_array_release(&states);
    xdg_surface_send_configure(s->xdg_surface, wl_display_next_serial(display));
    s->configured = 1;
}

static void s_commit(struct wl_client *c, struct wl_resource *r) {
    (void)c;
    struct surface *s = wl_resource_get_user_data(r);
    n_commits++;
    s->sx = s->pend_sx; s->sy = s->pend_sy;
    if (s->pend_attached) {
        if (s->pend_buffer) {
            if (!take_buffer(s, s->pend_buffer)) wl_buffer_send_release(s->pend_buffer);
        } else {
            free(s->pix); s->pix = NULL; s->w = s->h = 0; s->has = 0;
            dirty = 1;
        }
        s->pend_buffer = NULL;
        s->pend_attached = 0;
    } else if (s->role == ROLE_SUB) {
        dirty = 1;   /* moved */
    }
    wl_list_insert_list(s->frames.prev, &s->pend_frames);
    wl_list_init(&s->pend_frames);
    /* the first commit asks for the configure: full screen at the output's size */
    if (s->role == ROLE_TOPLEVEL && !s->configured) send_configure(s);
    if (s->role == ROLE_TOPLEVEL) refocus();
    arm_frames();
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
    (void)r;
    struct wl_resource *res = wl_resource_create(c, &wl_region_interface, 1, id);
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
static const struct wl_subcompositor_interface subcompositor_impl = { .destroy = subcomp_destroy, .get_subsurface = subcomp_get };
static void subcompositor_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &wl_subcompositor_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &subcompositor_impl, NULL, NULL);
}

/* ---- xdg-shell ---- */

static void top_destroy_res(struct wl_resource *res) {
    struct surface *s = wl_resource_get_user_data(res);
    if (s) { s->xdg_toplevel = NULL; s->role = ROLE_NONE; s->order = 0; }
}
static void top_destroy(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static void top_set_parent(struct wl_client *c, struct wl_resource *r, struct wl_resource *p) {
    (void)c;
    struct surface *s = wl_resource_get_user_data(r);
    if (s) s->child = p != NULL;
}
static void top_set_title(struct wl_client *c, struct wl_resource *r, const char *title) {
    (void)c; (void)r;
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
/* Whatever it asks (full screen, maximized, back), it stays full screen at the output's size. */
static void top_state(struct wl_client *c, struct wl_resource *r) {
    (void)c;
    struct surface *s = wl_resource_get_user_data(r);
    if (s) send_configure(s);
}
static void top_set_fullscreen(struct wl_client *c, struct wl_resource *r, struct wl_resource *output) { (void)output; top_state(c, r); }
static void top_noarg(struct wl_client *c, struct wl_resource *r) { (void)c; (void)r; }
static const struct xdg_toplevel_interface toplevel_impl = {
    .destroy = top_destroy, .set_parent = top_set_parent, .set_title = top_set_title,
    .set_app_id = top_set_app_id, .show_window_menu = top_menu, .move = top_move, .resize = top_resize,
    .set_max_size = top_size, .set_min_size = top_size, .set_maximized = top_state,
    .unset_maximized = top_state, .set_fullscreen = top_set_fullscreen, .unset_fullscreen = top_state,
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
static const struct xdg_popup_interface popup_impl = { .destroy = popup_destroy, .grab = popup_grab, .reposition = popup_reposition };
static void xs_get_popup(struct wl_client *c, struct wl_resource *r, uint32_t id, struct wl_resource *parent,
                         struct wl_resource *positioner) {
    (void)parent; (void)positioner;
    /* not shown (a menu, a select's list): dismissed at once */
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

/* ---- output and seat ---- */

static void output_send(struct wl_resource *res) {
    int v = wl_resource_get_version(res);
    /* the app area of the iDrive 7 centre display (1920x720 at ~ 290 x 110 mm) */
    wl_output_send_geometry(res, 0, 0, 290 * out_w / 1920, 110 * out_h / 720, WL_OUTPUT_SUBPIXEL_UNKNOWN, "BMW",
                            "iDrive centre display", WL_OUTPUT_TRANSFORM_NORMAL);
    wl_output_send_mode(res, WL_OUTPUT_MODE_CURRENT | WL_OUTPUT_MODE_PREFERRED, out_w, out_h, 60000);
    if (v >= 2) wl_output_send_scale(res, 1);
    if (v >= 2) wl_output_send_done(res);
}
static void output_release(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static const struct wl_output_interface output_impl = { .release = output_release };
static void output_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &wl_output_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &output_impl, NULL, remove_cb);
    wl_list_insert(&outputs, wl_resource_get_link(res));
    if (v >= 4) { wl_output_send_name(res, "CENTRE-1"); wl_output_send_description(res, "iDrive centre display"); }
    output_send(res);
}

static void pointer_set_cursor(struct wl_client *c, struct wl_resource *r, uint32_t serial, struct wl_resource *s,
                               int32_t x, int32_t y) { (void)c; (void)r; (void)serial; (void)s; (void)x; (void)y; }
static void res_release(struct wl_client *c, struct wl_resource *r) { (void)c; wl_resource_destroy(r); }
static const struct wl_pointer_interface pointer_impl = { .set_cursor = pointer_set_cursor, .release = res_release };
static const struct wl_keyboard_interface keyboard_impl = { .release = res_release };
static void seat_get_pointer(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct wl_resource *res = wl_resource_create(c, &wl_pointer_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &pointer_impl, NULL, NULL);
}
static void seat_get_keyboard(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    struct wl_resource *res = wl_resource_create(c, &wl_keyboard_interface, wl_resource_get_version(r), id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &keyboard_impl, NULL, remove_cb);
    wl_list_insert(&keyboards, wl_resource_get_link(res));
    int fd = open("/dev/null", O_RDONLY | O_CLOEXEC);
    if (fd >= 0) { wl_keyboard_send_keymap(res, WL_KEYBOARD_KEYMAP_FORMAT_NO_KEYMAP, fd, 0); close(fd); }
    if (wl_resource_get_version(r) >= 4) wl_keyboard_send_repeat_info(res, 0, 0);
    if (focus) enter(res, focus);
}
static void seat_get_touch(struct wl_client *c, struct wl_resource *r, uint32_t id) {
    (void)c; (void)id;
    wl_resource_post_error(r, WL_SEAT_ERROR_MISSING_CAPABILITY, "no touch");
}
static const struct wl_seat_interface seat_impl = {
    .get_pointer = seat_get_pointer, .get_keyboard = seat_get_keyboard, .get_touch = seat_get_touch, .release = res_release,
};
static void seat_bind(struct wl_client *c, void *d, uint32_t v, uint32_t id) {
    (void)d;
    struct wl_resource *res = wl_resource_create(c, &wl_seat_interface, v, id);
    if (!res) { wl_client_post_no_memory(c); return; }
    wl_resource_set_implementation(res, &seat_impl, NULL, NULL);
    wl_seat_send_capabilities(res, WL_SEAT_CAPABILITY_POINTER | WL_SEAT_CAPABILITY_KEYBOARD);
    if (v >= 2) wl_seat_send_name(res, "seat0");
}

/* ---- commands on stdin ---- */

/* A new output size: the outputs and every toplevel hear it. */
static void resize(int w, int h) {
    if (w == out_w && h == out_h) return;
    out_w = w; out_h = h;
    struct wl_resource *o;
    wl_resource_for_each(o, &outputs) output_send(o);
    struct surface *s;
    wl_list_for_each(s, &surfaces, link)
        if (s->role == ROLE_TOPLEVEL && s->configured) send_configure(s);
}

/* ---- through Winston ---- */

/* The last GPU buffer passed on, read back into lastbgra. */
static int ensure_last_from_drm(void) {
    struct drm_buffer *d = last_drm;
    if (!d || !gl.ok) return 0;
    uint32_t *pix = malloc((size_t)d->w * d->h * 4);
    if (!pix) return 0;
    int ok = drm_buffer_read(d, pix) == 0;
    if (ok) {
        if (!lastbgra || lastbgra_w != out_w || lastbgra_h != out_h) {
            free(lastbgra);
            lastbgra = malloc((size_t)out_w * out_h * 4);
            lastbgra_w = out_w; lastbgra_h = out_h;
        }
        if (lastbgra) copy_out(lastbgra, (const uint8_t *)pix, d->w * 4, d->w, d->h); else ok = 0;
    }
    free(pix);
    return ok;
}

static void winston_hide(void) {
    if (!wshown) return;
    /* the picture on the screen now, for the next show (shown, ours are read
     * in place; a GPU buffer of Chromium's is read back once) */
    if (last_drm && ensure_last_from_drm()) lastbgra_ok = 1;
    if (wo) wo_hide(wo);
    drm_buffers_unhold();
    wo_ring_free(ring); ring = NULL;
    last_drm = NULL;
    wshown = 0;
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
    puts("{\"ev\":\"winston-lost\"}");
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

static void cmd_winston(const char *arg) {
    int x, y, w, h;
    if (sscanf(arg, "%d,%d,%d,%d", &x, &y, &w, &h) != 4 || w < 16 || h < 16 || w > 4096 || h > 4096) {
        error_event("winston X,Y,W,H");
        return;
    }
    if (!wo) { error_event("not connected to Winston"); return; }
    if (shown) { frame_out_close(&fo); shown = 0; }
    wmode = 1;
    wo_place(wo, x, y, w, h);
    if (wo_show(wo, 1) < 0) { wo_lost(); return; }
    wshown = 1;
    /* what Chromium drew while hidden, at once (a still page draws nothing new) */
    if (lastbgra && lastbgra_ok && lastbgra_w == out_w && lastbgra_h == out_h)
        picture_winston((const uint8_t *)lastbgra, out_w * 4, out_w, out_h);
    arm_frames();
}

static void cmd_show(const char *file) {
    char err[256];
    winston_hide();
    wmode = 0;
    if (shown) { frame_out_close(&fo); shown = 0; }
    if (frame_out_open(&fo, file, err, sizeof err) < 0) { error_event(err); return; }
    frame_out_colour(&fo, 0, 1);   /* ARGBToJ420: BT.601, full range */
    shown = 1;
    resize(fo.w, fo.h);
    /* what Chromium drew while hidden, at once (a still page draws nothing new) */
    if (last && last_ok && last_w == fo.w && last_h == fo.h) {
        memcpy(frame_out_next(&fo), last, (size_t)fo.w * fo.h * 3 / 2);
        frame_out_publish(&fo);
    }
    arm_frames();
}

static void cmd_hide(void) {
    if (wshown) winston_hide();
    if (!shown) return;
    /* the picture on the screen now, for the next show */
    size_t n = (size_t)fo.w * fo.h * 3 / 2;
    if (!last || last_w != fo.w || last_h != fo.h) { free(last); last = malloc(n); last_w = fo.w; last_h = fo.h; }
    if (last) { memcpy(last, fo.map + SLOT0 + (size_t)fo.slot * n, n); last_ok = fo.seq > 0; }
    frame_out_close(&fo);
    shown = 0;
}

/* While hidden: the window's next size (shown, the frame file's size rules). */
static void cmd_size(const char *arg) {
    int w, h;
    if (sscanf(arg, "%dx%d", &w, &h) != 2 || w < 16 || h < 16 || w > 4096 || h > 4096 || (w | h) & 1) {
        error_event("size WxH: even, 16 to 4096");
        return;
    }
    if (!shown) resize(w, h);
}

static char inbuf[4096];
static size_t inlen;

static int on_stdin(int fd, uint32_t mask, void *data) {
    (void)data;
    ssize_t r = mask & WL_EVENT_READABLE ? read(fd, inbuf + inlen, sizeof inbuf - 1 - inlen) : 0;
    if (r <= 0) { wl_display_terminate(display); return 0; }   /* the server went away */
    inlen += (size_t)r;
    inbuf[inlen] = 0;
    char *line = inbuf, *nl;
    while ((nl = strchr(line, '\n'))) {
        *nl = 0;
        if (!strncmp(line, "show ", 5)) cmd_show(line + 5);
        else if (!strncmp(line, "winston ", 8)) cmd_winston(line + 8);
        else if (!strcmp(line, "hide")) cmd_hide();
        else if (!strncmp(line, "fps ", 4)) { int f = atoi(line + 4); if (f >= 1 && f <= 120) fps = f; }
        else if (!strncmp(line, "size ", 5)) cmd_size(line + 5);
        else if (*line) error_event("unknown command");
        line = nl + 1;
    }
    inlen -= (size_t)(line - inbuf);
    memmove(inbuf, line, inlen);
    if (inlen >= sizeof inbuf - 1) inlen = 0;
    return 0;
}

static struct wl_event_source *stats_timer;

static int stats_tick(void *data) {
    (void)data;
    unsigned long pics = n_pictures - stat_pictures;
    if (pics) {
        printf("{\"ev\":\"stats\",\"pictures\":%lu,\"commits\":%lu,\"shm\":%lu,\"drm\":%lu,\"fwd\":%lu,\"ms\":%.2f,\"src\":[%d,%d],\"out\":[%d,%d],\"shown\":%s,\"via\":\"%s\"}\n",
               pics, n_commits, n_shm, n_drm, n_fwd, (double)n_us_total / 1000.0 / (double)pics, src_w, src_h, out_w, out_h,
               shown || wshown ? "true" : "false", wmode ? "winston" : "mgu-render");
        fflush(stdout);
    }
    stat_pictures = n_pictures; n_us_total = 0;
    wl_event_source_timer_update(stats_timer, 1000);
    return 0;
}

static int on_signal(int sig, void *data) {
    (void)sig; (void)data;
    wl_display_terminate(display);
    return 0;
}

int main(int argc, char **argv) {
    const char *dir = NULL, *sock = "wayland-0", *device = "/dev/dri/renderD128", *unit_lib = "/usr/lib";
    const char *winston = NULL;
    int use_drm = 0;
    long drop_uid = -1, drop_gid = -1;
    static const struct option opts[] = {
        { "dir", 1, 0, 'D' }, { "socket", 1, 0, 's' }, { "size", 1, 0, 'S' }, { "fps", 1, 0, 'r' },
        { "snap", 1, 0, 'p' }, { "drm", 0, 0, 'm' }, { "device", 1, 0, 'd' }, { "unit-lib", 1, 0, 'L' },
        { "uid", 1, 0, 'u' }, { "gid", 1, 0, 'g' }, { "winston", 1, 0, 'w' }, { 0, 0, 0, 0 } };
    for (int o; (o = getopt_long(argc, argv, "", opts, NULL)) != -1;) {
        switch (o) {
        case 'D': dir = optarg; break;
        case 's': sock = optarg; break;
        case 'S': if (sscanf(optarg, "%dx%d", &out_w, &out_h) != 2 || out_w < 16 || out_h < 16 || (out_w | out_h) & 1) {
                      fprintf(stderr, "chromium-wl: --size WxH, even, at least 16\n"); return 2;
                  } break;
        case 'r': fps = atoi(optarg); if (fps < 1 || fps > 120) fps = 30; break;
        case 'p': snap_path = optarg; break;
        case 'm': use_drm = 1; break;
        case 'd': device = optarg; break;
        case 'L': unit_lib = optarg; break;
        case 'u': drop_uid = strtol(optarg, NULL, 10); break;
        case 'g': drop_gid = strtol(optarg, NULL, 10); break;
        case 'w': winston = optarg; break;
        default:
            fprintf(stderr, "usage: chromium-wl --dir DIR --socket NAME --size WxH [--fps N] [--uid U --gid G] "
                            "[--drm --device D --unit-lib DIR] [--winston SOCKET] [--snap F.ppm]\n");
            return 2;
        }
    }
    if (!dir) { fprintf(stderr, "chromium-wl: --dir\n"); return 2; }
    if (!strcmp(device, "/dev/dri/card0")) { fprintf(stderr, "chromium-wl: not card0 (Winston's)\n"); return 2; }
    if ((drop_uid >= 0) != (drop_gid >= 0)) { fprintf(stderr, "chromium-wl: --uid and --gid go together\n"); return 2; }
    wl_list_init(&drm_buffers);
    /* Winston's socket wants root or mgu_wayland: connected before the drop */
    if (winston) {
        char err[256];
        struct wo_opts wopts = { .socket = winston, .x = 108, .y = 82, .w = 1790, .h = 638, .log = wo_say };
        wo = wo_open(&wopts, err, sizeof err);
        if (!wo) error_event(err);
    }
    /* before anything else: the frame files are opened as U, the socket made as U:G */
    if (drop_gid >= 0 && (setgroups(0, NULL) < 0 || setgid((gid_t)drop_gid) < 0 || setuid((uid_t)drop_uid) < 0
                          || getuid() != (uid_t)drop_uid || geteuid() != (uid_t)drop_uid)) {
        char m[96];
        snprintf(m, sizeof m, "cannot drop to uid %ld gid %ld", drop_uid, drop_gid);
        error_event(m);
        return 1;
    }
    wl_list_init(&surfaces);
    wl_list_init(&outputs);
    wl_list_init(&keyboards);
    setenv("XDG_RUNTIME_DIR", dir, 1);
    umask(0117);   /* the socket: 0660, Chromium's group */
    display = wl_display_create();
    if (!display || wl_display_add_socket(display, sock) < 0) {
        error_event("cannot open the socket");
        return 1;
    }
    wl_display_init_shm(display);   /* ARGB8888 and XRGB8888 */
    wl_global_create(display, &wl_compositor_interface, 4, NULL, compositor_bind);
    wl_global_create(display, &wl_subcompositor_interface, 1, NULL, subcompositor_bind);
    wl_global_create(display, &xdg_wm_base_interface, 5, NULL, wm_base_bind);
    wl_global_create(display, &wl_output_interface, 4, NULL, output_bind);
    wl_global_create(display, &wl_seat_interface, 5, NULL, seat_bind);
    if (use_drm) {
        if (gl_init(device, unit_lib) == 0) wl_global_create(display, &wl_drm_interface, 2, NULL, drm_bind);
        else error_event("no GPU read-back (the unit's EGL on the render node): shared memory only");
    }
    struct wl_event_loop *loop = wl_display_get_event_loop(display);
    frame_timer = wl_event_loop_add_timer(loop, frame_tick, NULL);
    stats_timer = wl_event_loop_add_timer(loop, stats_tick, NULL);
    wl_event_source_timer_update(stats_timer, 1000);
    wl_event_loop_add_fd(loop, 0, WL_EVENT_READABLE, on_stdin, NULL);
    if (wo) wo_source = wl_event_loop_add_fd(loop, wo_fd(wo), WL_EVENT_READABLE, on_wo, NULL);
    wl_event_loop_add_signal(loop, SIGTERM, on_signal, NULL);
    wl_event_loop_add_signal(loop, SIGINT, on_signal, NULL);
    signal(SIGPIPE, SIG_IGN);

    printf("{\"ev\":\"ready\",\"socket\":"); jstr(sock);
    printf(",\"size\":[%d,%d],\"drm\":%s,\"device\":", out_w, out_h, gl.ok ? "true" : "false");
    jstr(gl.ok ? gl.device : NULL);
    printf(",\"winston\":%s,\"dmabuf\":%d", wo ? "true" : "false", wo ? wo_dmabuf_version(wo) : 0);
    printf(",\"uid\":%d}\n", (int)getuid());
    fflush(stdout);
    wl_display_run(display);
    wl_display_destroy_clients(display);
    wl_display_destroy(display);
    if (shown) frame_out_close(&fo);
    if (wo) { winston_hide(); wo_close(wo); }
    return 0;
}
