// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * libEGL.so.1 for the GPU mode: ANGLE (--use-angle=gles-egl) on the unit's
 * OWN Mesa 19 EGL and i965 driver, the GL stack mgu-render and the HMI use
 * on this kernel. No GPU driver comes with the bundle (0.1.1's own Vulkan
 * driver hung the kernel: knowledge/browser.md).
 *
 * 1. The display. Headless Chromium has ANGLE ask for eglGetDisplay(
 *    EGL_DEFAULT_DISPLAY), and the unit's Mesa 19 EGL then picks its drm
 *    platform, which opens /dev/dri/card0 (the display, Winston's) and has no
 *    surfaceless platform. Here the default display becomes a GBM display on
 *    the render node (/dev/dri/renderD128, group video), as Mesa's
 *    EGL_MESA_platform_gbm offers: no card0, no root, no Wayland.
 *
 * 2. Pbuffers. Chromium wants an EGL config with EGL_PBUFFER_BIT for its
 *    offscreen surfaces (ui/gl/gl_surface_egl.cc ChooseConfig), and ANGLE
 *    offers only what the native configs have; Mesa 19's GBM platform has
 *    window surfaces only, so on the car (0.2.0, 2026-11-06) the GPU process
 *    stopped at "No suitable EGL configs found". So configs that have
 *    EGL_WINDOW_BIT also say EGL_PBUFFER_BIT (eglGetConfigAttrib,
 *    eglChooseConfig), and eglCreatePbufferSurface makes a GBM surface of the
 *    size asked for on the same device and a window surface on it: real
 *    Mesa buffers, never shown. eglSwapBuffers on one does nothing (as on a
 *    pbuffer; it would also lock GBM buffers nobody releases), and
 *    eglDestroySurface frees the GBM surface too.
 *
 * Everything else goes straight to the unit's libEGL: ANGLE loads every entry
 * point through eglGetProcAddress (Mesa 19 hands out core ones too), so the
 * shim exports only eglGetDisplay and eglGetProcAddress and hands its own
 * versions of the others out through it.
 *
 * Loaded only in the GPU process, only in GPU mode (LD_LIBRARY_PATH puts
 * /var/opt/vizualyse-chromium/gpu-libs first: env.js). Its lines go to
 * stderr as "egl-shim: ...", into the tool's journal.
 *
 *   CHROMIUM_EGL_REAL  the unit's libEGL (/usr/lib/libEGL.so.1)
 *   CHROMIUM_EGL_NODE  the render node (/dev/dri/renderD128)
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef void *EGLDisplay;
typedef void *EGLConfig;
typedef void *EGLSurface;
typedef void *EGLNativeDisplayType;
typedef void *EGLNativeWindowType;
typedef int32_t EGLint;
typedef unsigned int EGLenum;
typedef unsigned int EGLBoolean;
typedef void (*egl_fn)(void);

#define EGL_DEFAULT_DISPLAY ((EGLNativeDisplayType)0)
#define EGL_NO_DISPLAY ((EGLDisplay)0)
#define EGL_NO_SURFACE ((EGLSurface)0)
#define EGL_FALSE 0
#define EGL_TRUE 1
#define EGL_DONT_CARE ((EGLint)-1)
#define EGL_NONE 0x3038
#define EGL_SURFACE_TYPE 0x3033
#define EGL_MAX_PBUFFER_HEIGHT 0x302A
#define EGL_MAX_PBUFFER_PIXELS 0x302B
#define EGL_MAX_PBUFFER_WIDTH 0x302C
#define EGL_NATIVE_VISUAL_ID 0x302E
#define EGL_WIDTH 0x3057
#define EGL_HEIGHT 0x3056
#define EGL_PBUFFER_BIT 0x0001
#define EGL_WINDOW_BIT 0x0004
#define EGL_PLATFORM_GBM_MESA 0x31D7

#define GBM_FORMAT_ARGB8888 0x34325241u /* 'AR24' */
#define GBM_BO_USE_RENDERING (1u << 2)

#define PBUFFER_MAX 8192
#define MAX_PBUFFERS 256

#define VISIBLE __attribute__((visibility("default")))

static pthread_once_t once = PTHREAD_ONCE_INIT;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static void *real;
static egl_fn (*real_gpa)(const char *);
static EGLDisplay (*real_get_display)(EGLNativeDisplayType);
static EGLDisplay (*real_gpd_ext)(EGLenum, void *, const EGLint *);
static EGLBoolean (*real_choose_config)(EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *);
static EGLBoolean (*real_get_config_attrib)(EGLDisplay, EGLConfig, EGLint, EGLint *);
static EGLSurface (*real_create_window_surface)(EGLDisplay, EGLConfig, EGLNativeWindowType, const EGLint *);
static EGLBoolean (*real_destroy_surface)(EGLDisplay, EGLSurface);
static EGLBoolean (*real_swap_buffers)(EGLDisplay, EGLSurface);
static void *(*gbm_surface_create_fn)(void *, uint32_t, uint32_t, uint32_t, uint32_t);
static void (*gbm_surface_destroy_fn)(void *);
static void *gbm_dev;
static int pbuffers_said;

/* the emulated pbuffers: the EGL surface and its GBM surface */
static struct { EGLSurface egl; void *gbm; } pbuf[MAX_PBUFFERS];

static void say(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fputs("egl-shim: ", stderr);
    vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    va_end(ap);
}

static const char *env_or(const char *name, const char *dflt)
{
    const char *v = getenv(name);
    return v && *v ? v : dflt;
}

#define REAL(var, name) var = (__typeof__(var))real_gpa(name)

static void load(void)
{
    const char *path = env_or("CHROMIUM_EGL_REAL", "/usr/lib/libEGL.so.1");
    real = dlopen(path, RTLD_NOW | RTLD_LOCAL);
    if (!real) {
        say("%s", dlerror());
        return;
    }
    real_gpa = (egl_fn (*)(const char *))dlsym(real, "eglGetProcAddress");
    real_get_display = (EGLDisplay (*)(EGLNativeDisplayType))dlsym(real, "eglGetDisplay");
    if (!real_gpa) {
        say("%s has no eglGetProcAddress", path);
        return;
    }
    REAL(real_gpd_ext, "eglGetPlatformDisplayEXT");
    REAL(real_choose_config, "eglChooseConfig");
    REAL(real_get_config_attrib, "eglGetConfigAttrib");
    REAL(real_create_window_surface, "eglCreateWindowSurface");
    REAL(real_destroy_surface, "eglDestroySurface");
    REAL(real_swap_buffers, "eglSwapBuffers");
    /* the gbm the unit's libEGL is linked against (Mesa's EGL reaches into
     * its own gbm's structures) */
    gbm_surface_create_fn = (void *(*)(void *, uint32_t, uint32_t, uint32_t, uint32_t))dlsym(real, "gbm_surface_create");
    gbm_surface_destroy_fn = (void (*)(void *))dlsym(real, "gbm_surface_destroy");
    say("%s loaded%s", path, real_gpd_ext ? "" : ", but it has no eglGetPlatformDisplayEXT");
}

/* The GBM device on the render node. Called with the lock held. */
static void *gbm_device(void)
{
    if (gbm_dev)
        return gbm_dev;
    const char *node = env_or("CHROMIUM_EGL_NODE", "/dev/dri/renderD128");
    int fd = open(node, O_RDWR | O_CLOEXEC);
    if (fd < 0) {
        say("%s: %s", node, strerror(errno));
        return NULL;
    }
    void *(*create)(int) = (void *(*)(int))dlsym(real, "gbm_create_device");
    if (!create) {
        say("no gbm_create_device next to the unit's libEGL");
        close(fd);
        return NULL;
    }
    gbm_dev = create(fd);
    if (!gbm_dev) {
        say("gbm_create_device(%s) failed", node);
        close(fd);
        return NULL;
    }
    say("display: GBM on %s", node);
    return gbm_dev;
}

static EGLDisplay shim_get_display(EGLNativeDisplayType d)
{
    pthread_once(&once, load);
    if (!real || !real_get_display)
        return EGL_NO_DISPLAY;
    if (d != EGL_DEFAULT_DISPLAY)
        return real_get_display(d);
    if (!real_gpd_ext)
        return EGL_NO_DISPLAY;
    pthread_mutex_lock(&lock);
    void *g = gbm_device();
    pthread_mutex_unlock(&lock);
    return g ? real_gpd_ext(EGL_PLATFORM_GBM_MESA, g, NULL) : EGL_NO_DISPLAY;
}

/* Configs with window surfaces count as pbuffer-capable too (the pbuffers
 * are GBM window surfaces); their pbuffer limits are ours. */
static EGLBoolean shim_get_config_attrib(EGLDisplay dpy, EGLConfig config, EGLint attr, EGLint *value)
{
    EGLBoolean ok = real_get_config_attrib(dpy, config, attr, value);
    if (!ok || !value)
        return ok;
    if (attr == EGL_SURFACE_TYPE && (*value & EGL_WINDOW_BIT))
        *value |= EGL_PBUFFER_BIT;
    else if ((attr == EGL_MAX_PBUFFER_WIDTH || attr == EGL_MAX_PBUFFER_HEIGHT) && *value == 0)
        *value = PBUFFER_MAX;
    else if (attr == EGL_MAX_PBUFFER_PIXELS && *value == 0)
        *value = PBUFFER_MAX * PBUFFER_MAX;
    return ok;
}

/* A request for pbuffer configs asks for window ones instead. */
static EGLBoolean shim_choose_config(EGLDisplay dpy, const EGLint *attribs, EGLConfig *configs,
                                     EGLint size, EGLint *num)
{
    EGLint fixed[128];
    int n = 0, changed = 0;
    if (attribs) {
        while (n + 1 < (int)(sizeof fixed / sizeof fixed[0]) && attribs[n] != EGL_NONE) {
            fixed[n] = attribs[n];
            fixed[n + 1] = attribs[n + 1];
            if (attribs[n] == EGL_SURFACE_TYPE && attribs[n + 1] != EGL_DONT_CARE &&
                (attribs[n + 1] & EGL_PBUFFER_BIT)) {
                fixed[n + 1] = (attribs[n + 1] & ~EGL_PBUFFER_BIT) | EGL_WINDOW_BIT;
                changed = 1;
            }
            n += 2;
        }
        if (attribs[n] != EGL_NONE)
            return real_choose_config(dpy, attribs, configs, size, num); /* too long: as it is */
        fixed[n] = EGL_NONE;
    }
    if (changed && !pbuffers_said) {
        pbuffers_said = 1;
        say("pbuffer configs asked for: window configs given (pbuffers are GBM surfaces)");
    }
    return real_choose_config(dpy, changed ? fixed : attribs, configs, size, num);
}

static EGLSurface shim_create_pbuffer_surface(EGLDisplay dpy, EGLConfig config, const EGLint *attribs)
{
    EGLint w = 0, h = 0, format = 0;
    for (int i = 0; attribs && attribs[i] != EGL_NONE && i < 64; i += 2) {
        if (attribs[i] == EGL_WIDTH)
            w = attribs[i + 1];
        else if (attribs[i] == EGL_HEIGHT)
            h = attribs[i + 1];
    }
    if (w < 1)
        w = 1;
    if (h < 1)
        h = 1;
    if (!real_get_config_attrib(dpy, config, EGL_NATIVE_VISUAL_ID, &format) || format == 0)
        format = (EGLint)GBM_FORMAT_ARGB8888;
    pthread_mutex_lock(&lock);
    int slot = -1;
    for (int i = 0; i < MAX_PBUFFERS; i++)
        if (!pbuf[i].egl && !pbuf[i].gbm) {
            slot = i;
            pbuf[i].gbm = (void *)1; /* taken */
            break;
        }
    void *dev = gbm_dev;
    pthread_mutex_unlock(&lock);
    if (slot < 0 || !dev || !gbm_surface_create_fn || !gbm_surface_destroy_fn) {
        say("pbuffer %dx%d: %s", w, h, slot < 0 ? "too many" : "no GBM device or gbm_surface_create");
        if (slot >= 0) {
            pthread_mutex_lock(&lock);
            pbuf[slot].gbm = NULL;
            pthread_mutex_unlock(&lock);
        }
        return EGL_NO_SURFACE;
    }
    void *gs = gbm_surface_create_fn(dev, (uint32_t)w, (uint32_t)h, (uint32_t)format, GBM_BO_USE_RENDERING);
    EGLSurface s = gs ? real_create_window_surface(dpy, config, (EGLNativeWindowType)gs, NULL) : EGL_NO_SURFACE;
    if (s == EGL_NO_SURFACE) {
        say("pbuffer %dx%d (format 0x%x): %s", w, h, (unsigned)format, gs ? "eglCreateWindowSurface failed" : "gbm_surface_create failed");
        if (gs)
            gbm_surface_destroy_fn(gs);
        pthread_mutex_lock(&lock);
        pbuf[slot].gbm = NULL;
        pthread_mutex_unlock(&lock);
        return EGL_NO_SURFACE;
    }
    pthread_mutex_lock(&lock);
    pbuf[slot].egl = s;
    pbuf[slot].gbm = gs;
    pthread_mutex_unlock(&lock);
    return s;
}

/* the GBM surface behind an emulated pbuffer, or NULL; take: forget it */
static void *pbuffer_gbm(EGLSurface s, int take)
{
    void *gs = NULL;
    if (s == EGL_NO_SURFACE)
        return NULL;
    pthread_mutex_lock(&lock);
    for (int i = 0; i < MAX_PBUFFERS; i++)
        if (pbuf[i].egl == s) {
            gs = pbuf[i].gbm;
            if (take)
                pbuf[i].egl = pbuf[i].gbm = NULL;
            break;
        }
    pthread_mutex_unlock(&lock);
    return gs;
}

static EGLBoolean shim_destroy_surface(EGLDisplay dpy, EGLSurface s)
{
    void *gs = pbuffer_gbm(s, 1);
    EGLBoolean ok = real_destroy_surface(dpy, s);
    if (gs)
        gbm_surface_destroy_fn(gs);
    return ok;
}

static EGLBoolean shim_swap_buffers(EGLDisplay dpy, EGLSurface s)
{
    if (pbuffer_gbm(s, 0))
        return EGL_TRUE; /* a pbuffer: nothing to swap */
    return real_swap_buffers(dpy, s);
}

VISIBLE EGLDisplay eglGetDisplay(EGLNativeDisplayType d)
{
    return shim_get_display(d);
}

VISIBLE egl_fn eglGetProcAddress(const char *name)
{
    pthread_once(&once, load);
    if (!real_gpa || !name)
        return NULL;
    if (strcmp(name, "eglGetDisplay") == 0)
        return (egl_fn)eglGetDisplay;
    if (strcmp(name, "eglGetConfigAttrib") == 0 && real_get_config_attrib)
        return (egl_fn)shim_get_config_attrib;
    if (strcmp(name, "eglChooseConfig") == 0 && real_choose_config)
        return (egl_fn)shim_choose_config;
    if (strcmp(name, "eglCreatePbufferSurface") == 0 && real_create_window_surface && real_get_config_attrib)
        return (egl_fn)shim_create_pbuffer_surface;
    if (strcmp(name, "eglDestroySurface") == 0 && real_destroy_surface)
        return (egl_fn)shim_destroy_surface;
    if (strcmp(name, "eglSwapBuffers") == 0 && real_swap_buffers)
        return (egl_fn)shim_swap_buffers;
    return real_gpa(name);
}
