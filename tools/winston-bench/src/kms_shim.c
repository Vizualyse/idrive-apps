// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * kms_shim: a display card for Winston off the car. Preloaded ahead of the
 * GPU bench's DRM shim (tools/gpu-bench), it gives Winston's drm-output
 * plugin the /dev/dri/card0 it looks for, with no connectors, so only its
 * null outputs (offscreen, rendered by its GL renderer) exist:
 *
 *   - libudev: drm-output finds the card with udev_enumerate (subsystem drm,
 *     sysname card[0-9]*). The container has no udev, so these functions are
 *     defined here and list one device, /dev/dri/card0.
 *   - open("/dev/dri/card0") opens the DRM shim's fake render node instead,
 *     so Mesa (GBM, EGL) gets a device it can drive (i965 on the no-op GPU,
 *     or swrast).
 *   - the KMS ioctls on it (master, client caps, resources with no CRTC,
 *     connector or plane, framebuffers) are answered here; everything else
 *     goes on to the DRM shim.
 *
 * KMS_SHIM_DEBUG=1 logs every ioctl it answers or passes on (stderr).
 * Never shipped to the car: the bench only.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <drm.h>
#include <drm_mode.h>

#define CARD "/dev/dri/card0"
#define RENDER "/dev/dri/renderD128"
#define MAXFD 1024

static char card_fd[MAXFD];
static int debug = -1;

static int dbg(void) {
    if (debug < 0) { const char *e = getenv("KMS_SHIM_DEBUG"); debug = e && *e == '1'; }
    return debug;
}
static void say(const char *fmt, ...) {
    if (!dbg()) return;
    va_list ap;
    va_start(ap, fmt);
    fputs("kms_shim: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}

/* ---- open ---- */

static int open_card(int flags) {
    int (*real)(const char *, int, ...) = dlsym(RTLD_NEXT, "open");
    int fd = real(RENDER, flags & ~O_CREAT);
    if (fd >= 0 && fd < MAXFD) card_fd[fd] = 1;
    say("open %s -> %d (the DRM shim's %s)", CARD, fd, RENDER);
    return fd;
}

#define OPEN_WRAPPER(name)                                                   \
    int name(const char *path, int flags, ...) {                             \
        mode_t mode = 0;                                                     \
        if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); } \
        if (!strcmp(path, CARD)) return open_card(flags);           \
        int (*real)(const char *, int, ...) = dlsym(RTLD_NEXT, #name);       \
        return real(path, flags, mode);                                      \
    }
OPEN_WRAPPER(open)
OPEN_WRAPPER(open64)

int openat(int dirfd, const char *path, int flags, ...) {
    mode_t mode = 0;
    if (flags & O_CREAT) { va_list ap; va_start(ap, flags); mode = va_arg(ap, mode_t); va_end(ap); }
    if (!strcmp(path, CARD)) return open_card(flags);
    int (*real)(int, const char *, int, ...) = dlsym(RTLD_NEXT, "openat");
    return real(dirfd, path, flags, mode);
}

int close(int fd) {
    if (fd >= 0 && fd < MAXFD) card_fd[fd] = 0;
    int (*real)(int) = dlsym(RTLD_NEXT, "close");
    return real(fd);
}

/* ---- KMS ---- */

static uint32_t next_fb = 100;

static int kms(int fd, unsigned long req, void *arg, int *handled) {
    *handled = 1;
    switch (req) {
    case DRM_IOCTL_SET_MASTER:
    case DRM_IOCTL_DROP_MASTER:
        return 0;
    case DRM_IOCTL_SET_CLIENT_CAP: {
        struct drm_set_client_cap *c = arg;
        say("client cap %llu = %llu", (unsigned long long)c->capability, (unsigned long long)c->value);
        /* universal planes yes; atomic no (legacy modesetting, nothing to set anyway) */
        if (c->capability == DRM_CLIENT_CAP_ATOMIC) { errno = EOPNOTSUPP; return -1; }
        return 0;
    }
    case DRM_IOCTL_MODE_GETRESOURCES: {
        struct drm_mode_card_res *r = arg;
        r->count_fbs = r->count_crtcs = r->count_connectors = r->count_encoders = 0;
        r->min_width = r->min_height = 0;
        r->max_width = r->max_height = 8192;
        return 0;
    }
    case DRM_IOCTL_MODE_GETPLANERESOURCES: {
        struct drm_mode_get_plane_res *p = arg;
        p->count_planes = 0;
        return 0;
    }
    case DRM_IOCTL_MODE_ADDFB:
        ((struct drm_mode_fb_cmd *)arg)->fb_id = next_fb++;
        return 0;
    case DRM_IOCTL_MODE_ADDFB2:
        ((struct drm_mode_fb_cmd2 *)arg)->fb_id = next_fb++;
        return 0;
    case DRM_IOCTL_MODE_RMFB:
        return 0;
    case DRM_IOCTL_GET_MAGIC:
        ((struct drm_auth *)arg)->magic = 0x4b4d53;
        return 0;
    case DRM_IOCTL_AUTH_MAGIC:
        return 0;
    }
    (void)fd;
    *handled = 0;
    return 0;
}

int ioctl(int fd, unsigned long req, ...) {
    va_list ap;
    va_start(ap, req);
    void *arg = va_arg(ap, void *);
    va_end(ap);
    if (fd >= 0 && fd < MAXFD && card_fd[fd]) {
        int handled, r = kms(fd, req, arg, &handled);
        if (handled) { say("ioctl %d 0x%lx: answered (%d)", fd, req, r); return r; }
        say("ioctl %d 0x%lx: to the DRM shim", fd, req);
    }
    int (*real)(int, unsigned long, ...) = dlsym(RTLD_NEXT, "ioctl");
    return real(fd, req, arg);
}

/* ---- EGL configs (swrast only, KMS_SHIM_SWRAST=1) ----
 * Winston's null output makes a GBM surface of XRGB8888 and takes the first
 * config eglChooseConfig gives. On i965 (the car, the stub) that config's
 * native visual is the surface's format; Mesa 19's swrast lists other
 * configs first, so eglCreateWindowSurface fails with EGL_BAD_MATCH. Here
 * the configs whose native visual is the format of the last GBM surface
 * made (or XRGB8888) come first. */

typedef void *EGLDisplay_, *EGLConfig_;

/* drm-output.so (dlopened, local) brings libEGL and libgbm: not in the global
 * scope RTLD_NEXT searches, so through the loaded library itself. */
static void *next_sym(const char *lib, const char *name) {
    void *f = dlsym(RTLD_NEXT, name);
    if (f) return f;
    void *h = dlopen(lib, RTLD_NOW | RTLD_NOLOAD);
    if (!h) h = dlopen(lib, RTLD_NOW);
    return h ? dlsym(h, name) : NULL;
}
#define K_EGL_NATIVE_VISUAL_ID 0x302E
static uint32_t last_gbm_format = 0x34325258; /* XR24 */

void *gbm_surface_create(void *dev, uint32_t w, uint32_t h, uint32_t format, uint32_t flags) {
    void *(*real)(void *, uint32_t, uint32_t, uint32_t, uint32_t) = next_sym("libgbm.so.1", "gbm_surface_create");
    say("gbm_surface_create %ux%u format %.4s flags 0x%x", w, h, (char *)&format, flags);
    last_gbm_format = format;
    return real(dev, w, h, format, flags);
}

unsigned eglChooseConfig(EGLDisplay_ dpy, const int *attr, EGLConfig_ *configs, int size, int *num) {
    unsigned (*real)(EGLDisplay_, const int *, EGLConfig_ *, int, int *) = next_sym("libEGL.so.1", "eglChooseConfig");
    const char *sw = getenv("KMS_SHIM_SWRAST");
    if (!sw || *sw != '1' || !configs || size <= 0) return real(dpy, attr, configs, size, num);
    unsigned (*getattr)(EGLDisplay_, EGLConfig_, int, int *) = next_sym("libEGL.so.1", "eglGetConfigAttrib");
    say("eglChooseConfig size %d getattr %p", size, (void *)getattr);
    if (!getattr) return real(dpy, attr, configs, size, num);
    int n = 0;
    if (!real(dpy, attr, NULL, 0, &n) || n <= 0) return real(dpy, attr, configs, size, num);
    EGLConfig_ *all = calloc((size_t)n, sizeof *all);
    if (!all || !real(dpy, attr, all, n, &n)) { free(all); return real(dpy, attr, configs, size, num); }
    int k = 0;
    for (int pass = 0; pass < 2; pass++)
        for (int i = 0; i < n && k < size; i++) {
            int vid = 0;
            getattr(dpy, all[i], K_EGL_NATIVE_VISUAL_ID, &vid);
            if ((pass == 0) == ((uint32_t)vid == last_gbm_format)) configs[k++] = all[i];
        }
    say("eglChooseConfig: %d configs, those of visual %.4s first", n, (char *)&last_gbm_format);
    free(all);
    if (num) *num = k;
    return 1;
}

/* ---- grabbing what Winston composed (KMS_SHIM_GRAB=/out/grab) ----
 * Winston's null outputs compose nothing until something asks for their
 * picture: a screenshot (ivi_controller_screen.screenshot) makes it render
 * the screen into its GBM surface, swap, and lock the front buffer. While
 * GRAB.req exists, the picture of a 1920x720 surface (the centre display) is
 * read back at that swap and written to GRAB.ppm; then GRAB.req goes.
 * On swrast the GBM surface has no front buffer to lock (Winston then
 * crashed): a stand-in buffer object takes its place (below). */

#define K_EGL_WIDTH 0x3057
#define K_EGL_HEIGHT 0x3056
#define K_GL_RGBA 0x1908
#define K_GL_UNSIGNED_BYTE 0x1401

static void grab(EGLDisplay_ dpy, void *surf) {
    const char *g = getenv("KMS_SHIM_GRAB");
    if (!g) return;
    char req[256], tmp[256], out[256];
    snprintf(req, sizeof req, "%s.req", g);
    struct stat st;
    if (stat(req, &st) != 0) return;
    unsigned (*query)(EGLDisplay_, void *, int, int *) = next_sym("libEGL.so.1", "eglQuerySurface");
    void (*readpix)(int, int, int, int, unsigned, unsigned, void *) = next_sym("libGLESv2.so.2", "glReadPixels");
    int w = 0, h = 0;
    if (!query || !readpix || !query(dpy, surf, K_EGL_WIDTH, &w) || !query(dpy, surf, K_EGL_HEIGHT, &h)) return;
    say("grab: a picture of %dx%d", w, h);
    if (w != 1920 || h != 720) return;
    unsigned char *px = malloc((size_t)w * h * 4);
    if (!px) return;
    readpix(0, 0, w, h, K_GL_RGBA, K_GL_UNSIGNED_BYTE, px);
    snprintf(tmp, sizeof tmp, "%s.tmp", g);
    snprintf(out, sizeof out, "%s.ppm", g);
    FILE *f = fopen(tmp, "wb");
    if (f) {
        fprintf(f, "P6\n%d %d\n255\n", w, h);
        for (int y = h - 1; y >= 0; y--)       /* GL's rows go bottom up */
            for (int x = 0; x < w; x++) fwrite(px + ((size_t)y * w + x) * 4, 1, 3, f);
        fclose(f);
        rename(tmp, out);
        unlink(req);
        say("grabbed %dx%d into %s", w, h, out);
    }
    free(px);
}

unsigned eglSwapBuffers(EGLDisplay_ dpy, void *surf) {
    unsigned (*real)(EGLDisplay_, void *) = next_sym("libEGL.so.1", "eglSwapBuffers");
    grab(dpy, surf);
    return real(dpy, surf);
}

/* ---- a stand-in front buffer (swrast) ---- */

#define MAGIC_BO 0x626f6b6du
struct fake_bo {
    uint32_t magic;
    void *dev;
    uint32_t w, h;
    void *user;
    void (*destroy)(void *bo, void *user);
};
static struct fake_bo fake_front = { MAGIC_BO, NULL, 1920, 720, NULL, NULL };
static int is_fake(void *bo) { return bo && ((struct fake_bo *)bo)->magic == MAGIC_BO; }

void *gbm_surface_lock_front_buffer(void *surf) {
    void *(*real)(void *) = next_sym("libgbm.so.1", "gbm_surface_lock_front_buffer");
    void *bo = real(surf);
    if (bo) return bo;
    const char *sw = getenv("KMS_SHIM_SWRAST");
    if (!sw || *sw != '1') return NULL;
    say("gbm_surface_lock_front_buffer: none (swrast), a stand-in");
    return &fake_front;
}
void gbm_surface_release_buffer(void *surf, void *bo) {
    if (is_fake(bo)) return;
    void (*real)(void *, void *) = next_sym("libgbm.so.1", "gbm_surface_release_buffer");
    real(surf, bo);
}

static uint32_t fake_u32(void *bo, int what) {
    struct fake_bo *b = bo;
    switch (what) {
    case 0: return b->w;
    case 1: return b->h;
    case 2: return b->w * 4;
    case 3: return 0x34325241; /* AR24 */
    default: return 0;
    }
}
#define BO_U32(name, what)                                                       \
    uint32_t name(void *bo) {                                                    \
        if (is_fake(bo)) return fake_u32(bo, what);                              \
        uint32_t (*real)(void *) = next_sym("libgbm.so.1", #name);              \
        return real(bo);                                                         \
    }
BO_U32(gbm_bo_get_width, 0)
BO_U32(gbm_bo_get_height, 1)
BO_U32(gbm_bo_get_stride, 2)
BO_U32(gbm_bo_get_format, 3)
uint32_t gbm_bo_get_stride_for_plane(void *bo, int plane) {
    if (is_fake(bo)) return plane ? 0 : fake_u32(bo, 2);
    uint32_t (*real)(void *, int) = next_sym("libgbm.so.1", "gbm_bo_get_stride_for_plane");
    return real(bo, plane);
}
uint32_t gbm_bo_get_offset(void *bo, int plane) {
    if (is_fake(bo)) return 0;
    uint32_t (*real)(void *, int) = next_sym("libgbm.so.1", "gbm_bo_get_offset");
    return real(bo, plane);
}
uint64_t gbm_bo_get_handle(void *bo) {
    if (is_fake(bo)) return 1;
    uint64_t (*real)(void *) = next_sym("libgbm.so.1", "gbm_bo_get_handle");
    return real(bo);
}
uint64_t gbm_bo_get_handle_for_plane(void *bo, int plane) {
    if (is_fake(bo)) return plane ? 0 : 1;
    uint64_t (*real)(void *, int) = next_sym("libgbm.so.1", "gbm_bo_get_handle_for_plane");
    return real(bo, plane);
}
void *gbm_bo_get_device(void *bo) {
    if (is_fake(bo)) return ((struct fake_bo *)bo)->dev;
    void *(*real)(void *) = next_sym("libgbm.so.1", "gbm_bo_get_device");
    return real(bo);
}
void *gbm_bo_get_user_data(void *bo) {
    if (is_fake(bo)) return ((struct fake_bo *)bo)->user;
    void *(*real)(void *) = next_sym("libgbm.so.1", "gbm_bo_get_user_data");
    return real(bo);
}
void gbm_bo_set_user_data(void *bo, void *data, void (*destroy)(void *, void *)) {
    if (is_fake(bo)) { ((struct fake_bo *)bo)->user = data; ((struct fake_bo *)bo)->destroy = destroy; return; }
    void (*real)(void *, void *, void (*)(void *, void *)) = next_sym("libgbm.so.1", "gbm_bo_set_user_data");
    real(bo, data, destroy);
}

/* ---- libudev: one DRM device, card0 ---- */

#define MAGIC_UDEV 0x75646576u
struct udev { uint32_t magic; };
struct udev_list_entry { const char *name; struct udev_list_entry *next; };
struct udev_enumerate { uint32_t magic; int drm, scanned; struct udev_list_entry entry; };
struct udev_device { uint32_t magic; };

static struct udev the_udev = { MAGIC_UDEV };
static struct udev_device card_dev = { MAGIC_UDEV };
#define SYSPATH "/sys/devices/pci0000:00/0000:00:02.0/drm/card0"

struct udev *udev_new(void) { say("udev_new"); return &the_udev; }
struct udev *udev_ref(struct udev *u) { return u; }
struct udev *udev_unref(struct udev *u) { (void)u; return NULL; }

struct udev_enumerate *udev_enumerate_new(struct udev *u) {
    (void)u;
    struct udev_enumerate *e = calloc(1, sizeof *e);
    if (e) e->magic = MAGIC_UDEV;
    return e;
}
struct udev_enumerate *udev_enumerate_unref(struct udev_enumerate *e) { free(e); return NULL; }
int udev_enumerate_add_match_subsystem(struct udev_enumerate *e, const char *s) {
    say("udev match subsystem %s", s);
    if (e && s && !strcmp(s, "drm")) e->drm = 1;
    return 0;
}
int udev_enumerate_add_match_sysname(struct udev_enumerate *e, const char *s) { (void)e; say("udev match sysname %s", s); return 0; }
int udev_enumerate_add_match_property(struct udev_enumerate *e, const char *p, const char *v) { (void)e; (void)p; (void)v; return 0; }
int udev_enumerate_add_match_tag(struct udev_enumerate *e, const char *t) { (void)e; (void)t; return 0; }
int udev_enumerate_scan_devices(struct udev_enumerate *e) {
    if (!e) return -1;
    e->scanned = 1;
    e->entry.name = SYSPATH;
    e->entry.next = NULL;
    return 0;
}
struct udev_list_entry *udev_enumerate_get_list_entry(struct udev_enumerate *e) {
    return e && e->scanned && e->drm ? &e->entry : NULL;
}
struct udev_list_entry *udev_list_entry_get_next(struct udev_list_entry *l) { return l ? l->next : NULL; }
const char *udev_list_entry_get_name(struct udev_list_entry *l) { return l ? l->name : NULL; }
const char *udev_list_entry_get_value(struct udev_list_entry *l) { (void)l; return NULL; }

struct udev_device *udev_device_new_from_syspath(struct udev *u, const char *p) {
    (void)u;
    say("udev device %s", p);
    return p && !strcmp(p, SYSPATH) ? &card_dev : NULL;
}
struct udev_device *udev_device_ref(struct udev_device *d) { return d; }
struct udev_device *udev_device_unref(struct udev_device *d) { (void)d; return NULL; }
const char *udev_device_get_devnode(struct udev_device *d) { return d == &card_dev ? CARD : NULL; }
const char *udev_device_get_syspath(struct udev_device *d) { return d == &card_dev ? SYSPATH : NULL; }
const char *udev_device_get_sysname(struct udev_device *d) { return d == &card_dev ? "card0" : NULL; }
const char *udev_device_get_subsystem(struct udev_device *d) { return d == &card_dev ? "drm" : NULL; }
const char *udev_device_get_property_value(struct udev_device *d, const char *k) {
    say("udev property %s", k);
    (void)d;
    return NULL;
}

