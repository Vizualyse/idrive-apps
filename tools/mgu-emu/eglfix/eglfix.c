/*
 * eglfix: Winston on llvmpipe (mgu-emu only).
 *
 * Winston takes the first config eglChooseConfig returns and creates its GBM
 * surface in its own format. On the unit's i965 those agree; on Mesa's
 * kms_swrast the first config's visual is another format, and
 * eglCreateWindowSurface fails with EGL_BAD_MATCH ("No output was setup").
 * Preloaded into Winston, this puts the configs whose EGL_NATIVE_VISUAL_ID is
 * the wanted GBM format first (EGLFIX_FORMAT, a fourcc, default XR24: the
 * only format of virtio-gpu's primary plane), and logs what it saw.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static FILE *logf_(void)
{
    static FILE *f;
    if (!f) { const char *p = getenv("EGLFIX_LOG"); f = fopen(p ? p : "/run/eglfix.log", "a"); if (f) setvbuf(f, NULL, _IOLBF, 0); else f = stderr; }
    return f;
}

/* Winston dlopens drm-output.so (and through it libEGL / libgbm) with local
 * scope: RTLD_NEXT from a preload cannot see them. Open them by name. */
static void *real_sym(const char *lib, const char *name)
{
    void *h = dlopen(lib, RTLD_LAZY | RTLD_NOLOAD);
    if (!h) h = dlopen(lib, RTLD_LAZY);
    void *p = h ? dlsym(h, name) : NULL;
    if (!p) fprintf(logf_(), "eglfix: %s not found in %s\n", name, lib);
    return p;
}

typedef void *EGLDisplay, *EGLConfig, *EGLSurface;
typedef int32_t EGLint;
typedef unsigned int EGLBoolean;
#define EGL_NATIVE_VISUAL_ID 0x302E
#define EGL_ALPHA_SIZE 0x3021

static uint32_t fourcc(const char *s)
{
    return (uint32_t)s[0] | (uint32_t)s[1] << 8 | (uint32_t)s[2] << 16 | (uint32_t)s[3] << 24;
}

static uint32_t wanted(void)
{
    const char *f = getenv("EGLFIX_FORMAT");
    return fourcc(f && strlen(f) == 4 ? f : "XR24");
}

static void fmt(uint32_t v, char out[5])
{
    for (int i = 0; i < 4; i++) { char c = (char)(v >> (8 * i)); out[i] = (c >= 32 && c < 127) ? c : '?'; }
    out[4] = 0;
}

EGLBoolean eglChooseConfig(EGLDisplay dpy, const EGLint *attrs, EGLConfig *configs, EGLint size, EGLint *num)
{
    static EGLBoolean (*real)(EGLDisplay, const EGLint *, EGLConfig *, EGLint, EGLint *);
    static EGLBoolean (*getattr)(EGLDisplay, EGLConfig, EGLint, EGLint *);
    if (!real) real = real_sym("libEGL.so.1", "eglChooseConfig");
    if (!getattr) getattr = real_sym("libEGL.so.1", "eglGetConfigAttrib");
    if (!configs || size <= 0) return real(dpy, attrs, configs, size, num);

    /* ask for all of them, then hand back the matching ones first */
    EGLint total = 0;
    if (!real(dpy, attrs, NULL, 0, &total) || total <= 0) return real(dpy, attrs, configs, size, num);
    EGLConfig *all = calloc((size_t)total, sizeof *all);
    if (!all || !real(dpy, attrs, all, total, &total)) { free(all); return real(dpy, attrs, configs, size, num); }

    uint32_t want = wanted();
    EGLint n = 0;
    for (int pass = 0; pass < 2; pass++)
        for (EGLint i = 0; i < total && n < size; i++) {
            EGLint vid = 0;
            getattr(dpy, all[i], EGL_NATIVE_VISUAL_ID, &vid);
            if (((uint32_t)vid == want) == (pass == 0)) configs[n++] = all[i];
        }
    if (num) *num = n;

    char w[5], f[5];
    EGLint vid = 0;
    getattr(dpy, configs[0], EGL_NATIVE_VISUAL_ID, &vid);
    fmt(want, w); fmt((uint32_t)vid, f);
    fprintf(logf_(), "eglfix: eglChooseConfig: %d configs, first now %s (wanted %s)\n", total, f, w);
    free(all);
    return 1;
}

void *gbm_surface_create(void *dev, uint32_t w, uint32_t h, uint32_t format, uint32_t flags)
{
    static void *(*real)(void *, uint32_t, uint32_t, uint32_t, uint32_t);
    if (!real) real = real_sym("libgbm.so.1", "gbm_surface_create");
    /* Winston asks for AR24; virtio-gpu's primary plane scans out XR24 only
     * (atomic commit: EINVAL). Same layout, alpha ignored: give it the
     * wanted format, which the first EGL config now matches too. */
    uint32_t want = wanted();
    char f[5], t[5];
    fmt(format, f);
    if (format == fourcc("AR24") && want == fourcc("XR24")) format = want;
    fmt(format, t);
    fprintf(logf_(), "eglfix: gbm_surface_create %ux%u %s -> %s flags 0x%x\n", w, h, f, t, flags);
    return real(dev, w, h, format, flags);
}

/*
 * kms_swrast has no EGL_WL_bind_wayland_display: Winston still calls through
 * the pointers it got for it (NULL: a segfault at the first client buffer).
 * Stubs that say "not an EGL buffer" make it take the client's wl_shm
 * buffers, which is what Mesa's swrast Wayland clients send.
 */
static EGLBoolean stub_bind(EGLDisplay d, void *w) { (void)d; (void)w; return 0; }
static EGLBoolean stub_query(EGLDisplay d, void *r, EGLint a, EGLint *v) { (void)d; (void)r; (void)a; (void)v; return 0; }

typedef void (*proc)(void);
proc eglGetProcAddress(const char *name)
{
    static proc (*real)(const char *);
    if (!real) real = (proc (*)(const char *))real_sym("libEGL.so.1", "eglGetProcAddress");
    proc p = real(name);
    if (!p) {
        if (!strcmp(name, "eglBindWaylandDisplayWL") || !strcmp(name, "eglUnbindWaylandDisplayWL"))
            p = (proc)stub_bind;
        else if (!strcmp(name, "eglQueryWaylandBufferWL"))
            p = (proc)stub_query;
        fprintf(logf_(), "eglfix: eglGetProcAddress(%s): none%s\n", name, p ? ", stubbed" : "");
    }
    return p;
}
