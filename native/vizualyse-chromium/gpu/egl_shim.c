// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * libEGL.so.1 for the GPU mode: ANGLE (--use-angle=gles-egl) on the unit's
 * OWN Mesa 19 EGL and i965 driver, the GL stack mgu-render and the HMI use
 * on this kernel. No GPU driver comes with the bundle (0.1.1's own Vulkan
 * driver hung the kernel: knowledge/browser.md).
 *
 * Why a shim: headless Chromium has ANGLE ask for eglGetDisplay(
 * EGL_DEFAULT_DISPLAY), and the unit's Mesa 19 EGL then picks its drm
 * platform, which opens /dev/dri/card0 (the display, Winston's) and has no
 * surfaceless platform. Here the default display becomes a GBM display on
 * the render node (/dev/dri/renderD128, group video), as Mesa's
 * EGL_MESA_platform_gbm offers: no card0, no root, no Wayland. Everything
 * else goes straight to the unit's libEGL (ANGLE loads every entry point
 * through eglGetProcAddress; Mesa 19 hands out core ones too).
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
typedef void *EGLNativeDisplayType;
typedef int32_t EGLint;
typedef unsigned int EGLenum;
typedef void (*egl_fn)(void);

#define EGL_DEFAULT_DISPLAY ((EGLNativeDisplayType)0)
#define EGL_NO_DISPLAY ((EGLDisplay)0)
#define EGL_PLATFORM_GBM_MESA 0x31D7

#define VISIBLE __attribute__((visibility("default")))

static pthread_once_t once = PTHREAD_ONCE_INIT;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static void *real;
static egl_fn (*real_gpa)(const char *);
static EGLDisplay (*real_get_display)(EGLNativeDisplayType);
static EGLDisplay (*real_gpd_ext)(EGLenum, void *, const EGLint *);
static void *gbm_dev;

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
    if (real_gpa)
        real_gpd_ext = (EGLDisplay (*)(EGLenum, void *, const EGLint *))real_gpa("eglGetPlatformDisplayEXT");
    say("%s loaded%s", path, real_gpd_ext ? "" : ", but it has no eglGetPlatformDisplayEXT");
}

/* The GBM device on the render node, made by the gbm the unit's libEGL is
 * linked against (Mesa's EGL reaches into its own gbm's structures). */
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

VISIBLE EGLDisplay eglGetDisplay(EGLNativeDisplayType d)
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

VISIBLE egl_fn eglGetProcAddress(const char *name)
{
    pthread_once(&once, load);
    if (!real_gpa || !name)
        return NULL;
    if (strcmp(name, "eglGetDisplay") == 0)
        return (egl_fn)eglGetDisplay;
    return real_gpa(name);
}
