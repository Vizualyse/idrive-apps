// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The shim's display and pbuffer emulation against fake_egl.c (a GBM display
 * whose configs have window surfaces only, as Mesa 19's): run by
 * tools/bundle.sh at every build.
 *
 *   egl_pbuffer_test <shim libEGL.so.1> <fake_egl.so>
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

typedef int32_t EGLint;
typedef void (*egl_fn)(void);

#define EGL_NONE 0x3038
#define EGL_SURFACE_TYPE 0x3033
#define EGL_MAX_PBUFFER_WIDTH 0x302C
#define EGL_WIDTH 0x3057
#define EGL_HEIGHT 0x3056
#define EGL_PBUFFER_BIT 0x0001
#define EGL_WINDOW_BIT 0x0004
#define EGL_PLATFORM_GBM_MESA 0x31D7

struct fake_state {
    unsigned platform;
    void *platform_native;
    EGLint last_choose_surface_type;
    void *last_window;
    int windows, destroyed, swaps;
    unsigned gbm_w, gbm_h, gbm_format, gbm_flags;
    int gbm_created, gbm_destroyed;
};

static int fails;
static void check(int ok, const char *what)
{
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok)
        fails++;
}

int main(int argc, char **argv)
{
    if (argc < 3)
        return 2;
    setenv("CHROMIUM_EGL_REAL", argv[2], 1);
    setenv("CHROMIUM_EGL_NODE", "/dev/null", 1);
    void *shim = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!shim) {
        printf("FAIL %s\n", dlerror());
        return 1;
    }
    egl_fn (*gpa)(const char *) = (egl_fn (*)(const char *))dlsym(shim, "eglGetProcAddress");
    void *(*get_display)(void *) = (void *(*)(void *))gpa("eglGetDisplay");
    void *dpy = get_display(NULL);
    void *fake = dlopen(argv[2], RTLD_NOW | RTLD_NOLOAD);
    struct fake_state *(*state)(void) = fake ? (struct fake_state *(*)(void))dlsym(fake, "fake_state") : NULL;
    if (!state) {
        printf("FAIL the fake is not loaded behind the shim\n");
        return 1;
    }
    struct fake_state *st = state();
    check(dpy == (void *)0xD15 && st->platform == EGL_PLATFORM_GBM_MESA && st->platform_native == (void *)0xDE,
          "the default display is a GBM display on the node");

    unsigned (*choose)(void *, const EGLint *, void **, EGLint, EGLint *) =
        (unsigned (*)(void *, const EGLint *, void **, EGLint, EGLint *))gpa("eglChooseConfig");
    unsigned (*attrib)(void *, void *, EGLint, EGLint *) = (unsigned (*)(void *, void *, EGLint, EGLint *))gpa("eglGetConfigAttrib");
    void *(*pbuffer)(void *, void *, const EGLint *) = (void *(*)(void *, void *, const EGLint *))gpa("eglCreatePbufferSurface");
    void *(*window)(void *, void *, void *, const EGLint *) = (void *(*)(void *, void *, void *, const EGLint *))gpa("eglCreateWindowSurface");
    unsigned (*destroy)(void *, void *) = (unsigned (*)(void *, void *))gpa("eglDestroySurface");
    unsigned (*swap)(void *, void *) = (unsigned (*)(void *, void *))gpa("eglSwapBuffers");
    check(choose && attrib && pbuffer && window && destroy && swap, "the entry points are there");
    if (fails)
        return 1;

    /* Chromium's ChooseConfig for an offscreen surface */
    const EGLint want[] = { EGL_SURFACE_TYPE, EGL_PBUFFER_BIT, EGL_NONE };
    void *config = NULL;
    EGLint n = 0;
    check(choose(dpy, want, &config, 1, &n) && n == 1 && config == (void *)1, "a pbuffer config is found");
    check(st->last_choose_surface_type == EGL_WINDOW_BIT, "by asking Mesa for a window config");
    EGLint type = 0, maxw = 0;
    attrib(dpy, (void *)1, EGL_SURFACE_TYPE, &type);
    check(type == (EGL_WINDOW_BIT | EGL_PBUFFER_BIT), "a window config says pbuffer too");
    attrib(dpy, (void *)2, EGL_SURFACE_TYPE, &type);
    check(type == 0, "a config without windows doesn't");
    attrib(dpy, (void *)1, EGL_MAX_PBUFFER_WIDTH, &maxw);
    check(maxw == 8192, "pbuffer limits are given");

    const EGLint size[] = { EGL_WIDTH, 16, EGL_HEIGHT, 8, EGL_NONE };
    void *pb = pbuffer(dpy, config, size);
    check(pb != NULL && st->gbm_created == 1 && st->gbm_w == 16 && st->gbm_h == 8, "a 16x8 pbuffer is a 16x8 GBM surface");
    check(st->gbm_format == 0x34325258u && st->gbm_flags == (1u << 2), "in the config's format, for rendering");
    check(st->windows == 1 && st->last_window != NULL, "with a window surface on it");
    check(swap(dpy, pb) == 1 && st->swaps == 0, "swapping a pbuffer does nothing");
    void *win = window(dpy, config, (void *)0x77, NULL);
    check(swap(dpy, win) == 1 && st->swaps == 1, "swapping a real window still swaps");
    check(destroy(dpy, pb) == 1 && st->destroyed == 1 && st->gbm_destroyed == 1, "destroying the pbuffer frees its GBM surface");
    check(destroy(dpy, win) == 1 && st->destroyed == 2 && st->gbm_destroyed == 1, "destroying a window leaves GBM alone");
    const EGLint none[] = { EGL_NONE };
    void *pb0 = pbuffer(dpy, config, none);
    check(pb0 != NULL && st->gbm_w == 1 && st->gbm_h == 1, "a pbuffer without a size is 1x1");
    destroy(dpy, pb0);
    for (int i = 0; i < 300; i++) {
        void *p = pbuffer(dpy, config, size);
        if (!p) {
            check(0, "pbuffers are reused after destroy");
            break;
        }
        destroy(dpy, p);
    }
    check(st->gbm_created == st->gbm_destroyed, "no GBM surface left behind");
    puts(fails ? "egl-pbuffer-test: FAILED" : "egl-pbuffer-test: all ok");
    return fails ? 1 : 0;
}
