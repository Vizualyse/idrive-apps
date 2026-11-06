// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The GPU mode's libraries off the car (test/unit_test.js runs this in the
 * unit's root filesystem, on the bundle's loader, with LD_LIBRARY_PATH as
 * Chromium gets it in GPU mode): the shim is the libEGL.so.1 found, the
 * unit's Mesa 19 libEGL loads and binds behind it (libgbm, libglapi,
 * Wayland, libdrm), eglGetDisplay is the shim's, a default display goes to
 * the render node (absent here: no GPU in a container), and the unit's
 * i965_dri.so binds in our process. Nothing can render here.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>

typedef void (*egl_fn)(void);

static int fails;
static void check(int ok, const char *what)
{
    printf("%s %s\n", ok ? "ok  " : "FAIL", what);
    if (!ok)
        fails++;
}

int main(void)
{
    void *egl = dlopen("libEGL.so.1", RTLD_NOW | RTLD_LOCAL);
    check(egl != NULL, "libEGL.so.1 loads");
    if (!egl) {
        printf("     %s\n", dlerror());
        return 1;
    }
    egl_fn (*gpa)(const char *) = (egl_fn (*)(const char *))dlsym(egl, "eglGetProcAddress");
    void *(*get_display)(void *) = (void *(*)(void *))dlsym(egl, "eglGetDisplay");
    check(gpa && get_display, "it is the shim (eglGetProcAddress, eglGetDisplay)");
    if (!gpa || !get_display)
        return 1;
    check(dlsym(egl, "eglInitialize") == NULL, "it exports nothing else (the shim, not Mesa)");
    check(gpa("eglInitialize") != NULL, "the unit's Mesa 19 libEGL is behind it (eglInitialize)");
    check(gpa("eglGetPlatformDisplayEXT") != NULL, "it has eglGetPlatformDisplayEXT (GBM displays)");
    check(gpa("eglCreateContext") != NULL && gpa("eglMakeCurrent") != NULL, "core entry points through eglGetProcAddress");
    check((void *)gpa("eglGetDisplay") == (void *)get_display, "eglGetDisplay through eglGetProcAddress is the shim's");
    check(gpa("glGetString") != NULL, "GLES entry points (libglapi)");
    check(get_display(NULL) == NULL, "no render node here: no display (and no other device tried)");
    void *dri = dlopen("/usr/lib/dri/i965_dri.so", RTLD_NOW | RTLD_LOCAL);
    if (!dri)
        printf("     %s\n", dlerror());
    check(dri != NULL, "the unit's i965_dri.so binds in our process");
    puts(fails ? "egl-shim-test: FAILED" : "egl-shim-test: all ok");
    return fails ? 1 : 0;
}
