// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * A stand-in for the unit's Mesa 19 libEGL + libgbm, for egl_pbuffer_test.c
 * (tools/bundle.sh runs it at every build): a GBM-platform display whose
 * configs have window surfaces only, as Mesa 19's have, recording what the
 * shim asks of it. Not shipped.
 */
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef int32_t EGLint;
typedef void (*egl_fn)(void);

#define EGL_NONE 0x3038
#define EGL_SURFACE_TYPE 0x3033
#define EGL_NATIVE_VISUAL_ID 0x302E
#define EGL_MAX_PBUFFER_HEIGHT 0x302A
#define EGL_MAX_PBUFFER_PIXELS 0x302B
#define EGL_MAX_PBUFFER_WIDTH 0x302C
#define EGL_WINDOW_BIT 0x0004
#define EGL_DONT_CARE ((EGLint)-1)

struct fake_state {
    unsigned platform;
    void *platform_native;
    EGLint last_choose_surface_type;
    void *last_window;
    int windows, destroyed, swaps;
    unsigned gbm_w, gbm_h, gbm_format, gbm_flags;
    int gbm_created, gbm_destroyed;
};
static struct fake_state st;
struct fake_state *fake_state(void) { return &st; }

/* config 1: window surfaces (as Mesa 19's GBM ones); config 2: none */
#define C1 ((void *)1)
#define C2 ((void *)2)
#define XR24 0x34325258u

static void *get_display(void *d) { (void)d; return (void *)0xD0; }
static void *get_platform_display(unsigned p, void *native, const EGLint *a)
{
    (void)a;
    st.platform = p;
    st.platform_native = native;
    return (void *)0xD15;
}
static unsigned choose_config(void *dpy, const EGLint *a, void **configs, EGLint size, EGLint *num)
{
    (void)dpy;
    EGLint want = EGL_DONT_CARE;
    for (int i = 0; a && a[i] != EGL_NONE; i += 2)
        if (a[i] == EGL_SURFACE_TYPE)
            want = a[i + 1];
    st.last_choose_surface_type = want;
    int n = 0;
    if (want == EGL_DONT_CARE || (want & ~EGL_WINDOW_BIT) == 0) {
        if (configs && size > 0)
            configs[0] = C1;
        n = 1;
    }
    *num = n;
    return 1;
}
static unsigned get_config_attrib(void *dpy, void *c, EGLint attr, EGLint *v)
{
    (void)dpy;
    switch (attr) {
    case EGL_SURFACE_TYPE: *v = c == C1 ? EGL_WINDOW_BIT : 0; return 1;
    case EGL_NATIVE_VISUAL_ID: *v = (EGLint)XR24; return 1;
    case EGL_MAX_PBUFFER_WIDTH: case EGL_MAX_PBUFFER_HEIGHT: case EGL_MAX_PBUFFER_PIXELS: *v = 0; return 1;
    default: *v = 0; return 1;
    }
}
static void *create_window_surface(void *dpy, void *c, void *win, const EGLint *a)
{
    (void)dpy; (void)c; (void)a;
    st.last_window = win;
    st.windows++;
    return (void *)(uintptr_t)(0x5000 + st.windows);
}
static unsigned destroy_surface(void *dpy, void *s) { (void)dpy; (void)s; st.destroyed++; return 1; }
static unsigned swap_buffers(void *dpy, void *s) { (void)dpy; (void)s; st.swaps++; return 1; }
static unsigned initialize(void *dpy, EGLint *ma, EGLint *mi) { (void)dpy; if (ma) *ma = 1; if (mi) *mi = 4; return 1; }

egl_fn eglGetProcAddress(const char *n)
{
    static const struct { const char *n; egl_fn f; } t[] = {
        { "eglGetPlatformDisplayEXT", (egl_fn)get_platform_display },
        { "eglChooseConfig", (egl_fn)choose_config },
        { "eglGetConfigAttrib", (egl_fn)get_config_attrib },
        { "eglCreateWindowSurface", (egl_fn)create_window_surface },
        { "eglDestroySurface", (egl_fn)destroy_surface },
        { "eglSwapBuffers", (egl_fn)swap_buffers },
        { "eglInitialize", (egl_fn)initialize },
    };
    for (unsigned i = 0; i < sizeof t / sizeof t[0]; i++)
        if (strcmp(n, t[i].n) == 0)
            return t[i].f;
    return NULL;
}
void *eglGetDisplay(void *d) { return get_display(d); }

void *gbm_create_device(int fd) { (void)fd; return (void *)0xDE; }
void *gbm_surface_create(void *dev, uint32_t w, uint32_t h, uint32_t format, uint32_t flags)
{
    if (dev != (void *)0xDE)
        return NULL;
    st.gbm_w = w; st.gbm_h = h; st.gbm_format = format; st.gbm_flags = flags;
    st.gbm_created++;
    return malloc(16);
}
void gbm_surface_destroy(void *s) { free(s); st.gbm_destroyed++; }
