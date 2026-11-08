// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * fsr_test: src/fsr.c on the unit's own Mesa 19 (tools/gpu-bench), the way
 * wl-sink uses it: a GBM buffer for the output, exported as a dmabuf and
 * imported again as an EGLImage, rendered into through an FBO; the input a
 * GL texture (wl-sink's is a game's dmabuf, imported the same way).
 *
 *   fsr_test [--pixels] [--out DIR] [--in WxH] [--to WxH]
 *
 * Always (stub: i965's own compiler and limits): the shaders compile and
 * link, the dmabuf round trip works, a run is accepted. --pixels (swrast,
 * real pixels): a flat colour stays flat (RCAS's divisions at black and
 * white), nothing is flipped (a marker in the input's top left lands in the
 * output's top left), and FSR's edges are sharper than bilinear's from the
 * same input. --out DIR: in.ppm, bilinear.ppm, fsr.ppm, easu.ppm to compare.
 * "PASS" or "FAIL: ..." lines; exit 0 when nothing failed.
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <gbm.h>
#include "../src/fsr.h"

static int fails;
static void fail(const char *m) { printf("FAIL: %s\n", m); fails++; }
static void pass(const char *m) { printf("PASS: %s\n", m); }

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

/* RGBA bytes, row 0 the top */
static void write_ppm(const char *dir, const char *name, const unsigned char *rgba, int w, int h) {
    if (!dir) return;
    char p[512];
    snprintf(p, sizeof p, "%s/%s", dir, name);
    FILE *f = fopen(p, "wb");
    if (!f) { fprintf(stderr, "fsr_test: cannot write %s\n", p); return; }
    fprintf(f, "P6\n%d %d\n255\n", w, h);
    for (long i = 0; i < (long)w * h; i++) fwrite(rgba + i * 4, 1, 3, f);
    fclose(f);
}

/* A picture with what upscalers get wrong: thin diagonal lines, a ring, small
 * text-like bars, a soft gradient; a red marker in the top left. */
static unsigned char *pattern(int w, int h) {
    unsigned char *p = malloc((size_t)w * h * 4);
    for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++) {
            unsigned char *q = p + ((long)y * w + x) * 4;
            int v = 40 + 120 * x / w;                                   /* gradient */
            if (((x + y) % 23) == 0 || ((x - y + 1000) % 31) == 0) v = 235;   /* thin diagonals */
            double dx = x - w * 0.7, dy = y - h * 0.5, r = sqrt(dx * dx + dy * dy);
            if (fabs(r - h * 0.3) < 1.0) v = 20;                         /* a ring */
            if (y > h / 8 && y < h / 8 + 6 && x > w / 4 && x < w / 2 && (x / 3) % 2) v = 250;   /* "text" */
            q[0] = q[1] = q[2] = (unsigned char)v; q[3] = 255;
            if (x < 8 && y < 8) { q[0] = 255; q[1] = 0; q[2] = 0; }      /* the marker */
        }
    return p;
}

/* mean absolute horizontal + vertical difference: how sharp edges are */
static double sharpness(const unsigned char *p, int w, int h) {
    double s = 0;
    for (int y = 1; y < h; y++)
        for (int x = 1; x < w; x++) {
            const unsigned char *a = p + ((long)y * w + x) * 4;
            s += abs(a[1] - a[1 - 4]) + abs(a[1] - a[1 - (long)w * 4]);
        }
    return s / ((double)w * h);
}

struct target { struct gbm_bo *bo; int fd; EGLImageKHR img; GLuint tex, fb; };

/* the output as wl-sink makes it: a GBM buffer, its dmabuf back as an EGLImage, an FBO on it */
static int target_new(struct target *t, struct gbm_device *gbm, EGLDisplay dpy, int w, int h) {
    PFNEGLCREATEIMAGEKHRPROC createImage = (PFNEGLCREATEIMAGEKHRPROC)eglGetProcAddress("eglCreateImageKHR");
    PFNGLEGLIMAGETARGETTEXTURE2DOESPROC target2d = (PFNGLEGLIMAGETARGETTEXTURE2DOESPROC)eglGetProcAddress("glEGLImageTargetTexture2DOES");
    t->bo = gbm_bo_create(gbm, w, h, GBM_FORMAT_XRGB8888, GBM_BO_USE_RENDERING);
    if (!t->bo) return -1;
    t->fd = gbm_bo_get_fd(t->bo);   /* for Winston only */
    if (t->fd < 0) return -1;
    /* the GBM buffer itself as the image (EGL_KHR_image_pixmap on GBM): its
     * dmabuf imported back into the same i965 made two buffers of one and
     * freeing them corrupted the heap ("double free", bench 2026-11-08) */
    t->img = createImage(dpy, EGL_NO_CONTEXT, EGL_NATIVE_PIXMAP_KHR, (EGLClientBuffer)t->bo, NULL);
    if (!t->img) return -1;
    glGenTextures(1, &t->tex);
    glBindTexture(GL_TEXTURE_2D, t->tex);
    target2d(GL_TEXTURE_2D, t->img);
    glGenFramebuffers(1, &t->fb);
    glBindFramebuffer(GL_FRAMEBUFFER, t->fb);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t->tex, 0);
    return glCheckFramebufferStatus(GL_FRAMEBUFFER) == GL_FRAMEBUFFER_COMPLETE ? 0 : -1;
}

static void readback(GLuint fb, int w, int h, unsigned char *dst) {
    glBindFramebuffer(GL_FRAMEBUFFER, fb);
    glReadPixels(0, 0, w, h, GL_RGBA, GL_UNSIGNED_BYTE, dst);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

/* bilinear (what Winston does with a smaller picture), into fb */
static void bilinear(GLuint src_fb, int sw, int sh, GLuint dst_fb, int dw, int dh) {
    glBindFramebuffer(GL_READ_FRAMEBUFFER, src_fb);
    glBindFramebuffer(GL_DRAW_FRAMEBUFFER, dst_fb);
    glBlitFramebuffer(0, 0, sw, sh, 0, 0, dw, dh, GL_COLOR_BUFFER_BIT, GL_LINEAR);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

static GLuint texture(int w, int h, const unsigned char *rgba, GLuint *fb) {
    GLuint t;
    glGenTextures(1, &t);
    glBindTexture(GL_TEXTURE_2D, t);
    glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, rgba);
    glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    if (fb) {
        glGenFramebuffers(1, fb);
        glBindFramebuffer(GL_FRAMEBUFFER, *fb);
        glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, t, 0);
        glBindFramebuffer(GL_FRAMEBUFFER, 0);
    }
    return t;
}

int main(int argc, char **argv) {
    int pixels = 0, iw = 896, ih = 320, ow = 1792, oh = 640;
    const char *out = NULL;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--pixels")) pixels = 1;
        else if (!strcmp(argv[i], "--out") && i + 1 < argc) out = argv[++i];
        else if (!strcmp(argv[i], "--in") && i + 1 < argc) sscanf(argv[++i], "%dx%d", &iw, &ih);
        else if (!strcmp(argv[i], "--to") && i + 1 < argc) sscanf(argv[++i], "%dx%d", &ow, &oh);
        else { fprintf(stderr, "usage: fsr_test [--pixels] [--out DIR] [--in WxH] [--to WxH]\n"); return 2; }
    }
    int fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (fd < 0) { fail("open /dev/dri/renderD128"); return 1; }
    struct gbm_device *gbm = gbm_create_device(fd);
    PFNEGLGETPLATFORMDISPLAYEXTPROC gpd = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    EGLDisplay dpy = gbm && gpd ? gpd(EGL_PLATFORM_GBM_MESA, gbm, NULL) : EGL_NO_DISPLAY;
    if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, NULL, NULL)) { fail("EGL on GBM"); return 1; }
    eglBindAPI(EGL_OPENGL_ES_API);
    const EGLint ca[] = { EGL_CONTEXT_CLIENT_VERSION, 3, EGL_NONE };   /* as wl-sink asks */
    EGLContext ctx = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, ca);
    if (!ctx || !eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) { fail("a GLES 3 context"); return 1; }
    printf("renderer: %s, %s\n", glGetString(GL_RENDERER), glGetString(GL_VERSION));

    char err[1200];
    struct fsr *f = fsr_new((void *(*)(const char *))eglGetProcAddress, err, sizeof err);
    if (!f) { fail(err); return 1; }
    pass("the FSR shaders compile and link");

    struct target t;
    memset(&t, 0, sizeof t);
    if (target_new(&t, gbm, dpy, ow, oh) == 0) {
        pass("the output: a GBM buffer as an EGLImage (its dmabuf for Winston), an FBO");
    } else if (pixels) {
        /* llvmpipe imports no dmabufs (shared memory only): the pixels into a texture */
        printf("note: no dmabuf output here (llvmpipe): pixels checked in a texture\n");
        while (glGetError() != GL_NO_ERROR) {}
        t.tex = texture(ow, oh, NULL, &t.fb);
    } else {
        fail("the output as a GBM buffer through a dmabuf, an FBO on it");
        return 1;
    }

    unsigned char *in = pattern(iw, ih);
    GLuint in_fb, in_tex = texture(iw, ih, in, &in_fb);
    double t0 = now_ms();
    if (fsr_run(f, in_tex, iw, ih, 0, 0, iw, ih, t.fb, ow, oh, 0.2f) < 0) { fail("fsr_run"); return 1; }
    glFinish();
    printf("fsr: %dx%d -> %dx%d, %.1f ms on this stand-in (not the car's GPU)\n", iw, ih, ow, oh, now_ms() - t0);
    if (glGetError() != GL_NO_ERROR) fail("a GL error after the passes");
    else pass("EASU + RCAS ran into the dmabuf");
    /* wl-sink's pool: three outputs drawn in turn, then freed as pool_free
     * does (FBO, texture, EGLImage, fd, GBM buffer); a hang here hung wl-sink
     * at a hide (bench 2026-11-08) */
    if (!pixels) {
        struct target pool[3];
        int made = 1;
        for (int i = 0; i < 3 && made; i++) made = target_new(&pool[i], gbm, dpy, ow, oh) == 0;
        if (!made) fail("three outputs");
        else {
            for (int n = 0; n < 12; n++) fsr_run(f, in_tex, iw, ih, 0, 0, iw, ih, pool[n % 3].fb, ow, oh, 0.2f);
            PFNEGLDESTROYIMAGEKHRPROC destroyImage = (PFNEGLDESTROYIMAGEKHRPROC)eglGetProcAddress("eglDestroyImageKHR");
            for (int i = 0; i < 3; i++) {
                fprintf(stderr, "pool %d: fb\n", i); glDeleteFramebuffers(1, &pool[i].fb);
                fprintf(stderr, "pool %d: tex\n", i); glDeleteTextures(1, &pool[i].tex);
                fprintf(stderr, "pool %d: image\n", i); destroyImage(dpy, pool[i].img);
                fprintf(stderr, "pool %d: bo\n", i); close(pool[i].fd); gbm_bo_destroy(pool[i].bo);
            }
            pass("three outputs drawn in turn and freed");
        }
    }
    /* a source rectangle (a viewport's): the middle of the input */
    if (fsr_run(f, in_tex, iw, ih, iw / 4, ih / 4, iw / 2, ih / 2, t.fb, ow, oh, -1) < 0 || glGetError() != GL_NO_ERROR)
        fail("EASU alone from a source rectangle");
    else pass("EASU alone from a source rectangle");

    if (pixels) {
        size_t on = (size_t)ow * oh * 4;
        unsigned char *a = malloc(on), *b = malloc(on), *e = malloc(on);
        fsr_run(f, in_tex, iw, ih, 0, 0, iw, ih, t.fb, ow, oh, 0.2f);
        readback(t.fb, ow, oh, a);
        fsr_run(f, in_tex, iw, ih, 0, 0, iw, ih, t.fb, ow, oh, -1);
        readback(t.fb, ow, oh, e);
        GLuint bl_fb, bl_tex = texture(ow, oh, NULL, &bl_fb);
        bilinear(in_fb, iw, ih, bl_fb, ow, oh);
        readback(bl_fb, ow, oh, b);
        write_ppm(out, "in.ppm", in, iw, ih);
        write_ppm(out, "fsr.ppm", a, ow, oh);
        write_ppm(out, "easu.ppm", e, ow, oh);
        write_ppm(out, "bilinear.ppm", b, ow, oh);
        /* orientation: the marker's corner */
        const unsigned char *m = a + ((long)2 * ow + 2) * 4;
        if (m[0] > 200 && m[1] < 60 && m[2] < 60) pass("not flipped: the marker in the top left");
        else { char s[96]; snprintf(s, sizeof s, "the top left is %d,%d,%d, not the red marker", m[0], m[1], m[2]); fail(s); }
        double sf = sharpness(a, ow, oh), sb = sharpness(b, ow, oh), se = sharpness(e, ow, oh);
        printf("edges (mean |difference|): bilinear %.2f, EASU %.2f, EASU + RCAS %.2f\n", sb, se, sf);
        if (sf > sb * 1.05 && se > sb) pass("sharper than bilinear");
        else fail("not sharper than bilinear");
        /* flat black, grey, white stay so (RCAS's limiters at 0 and 1) */
        static const unsigned char levels[] = { 0, 128, 255 };
        for (int li = 0; li < 3; li++) {
            unsigned char *flat = malloc((size_t)32 * 32 * 4);
            for (int i = 0; i < 32 * 32; i++) { flat[i * 4] = flat[i * 4 + 1] = flat[i * 4 + 2] = levels[li]; flat[i * 4 + 3] = 255; }
            GLuint ft = texture(32, 32, flat, NULL);
            fsr_run(f, ft, 32, 32, 0, 0, 32, 32, t.fb, 77, 61, 0.0f);   /* odd sizes, the sharpest */
            unsigned char px[4];
            int bad = 0;
            for (int y = 0; y < 61 && !bad; y += 5)
                for (int x = 0; x < 77; x += 7) {
                    glBindFramebuffer(GL_FRAMEBUFFER, t.fb);
                    glReadPixels(x, y, 1, 1, GL_RGBA, GL_UNSIGNED_BYTE, px);
                    if (abs(px[0] - levels[li]) > 1 || abs(px[1] - levels[li]) > 1) { bad = 1; break; }
                }
            glBindFramebuffer(GL_FRAMEBUFFER, 0);
            char s[64];
            snprintf(s, sizeof s, "flat %d stays %d", levels[li], levels[li]);
            if (bad) fail(s); else pass(s);
            glDeleteTextures(1, &ft);
            free(flat);
        }
        glDeleteTextures(1, &bl_tex);
        free(a); free(b); free(e);
    }
    double mean, max;
    int nt = fsr_gpu_take(f, &mean, &max);
    printf("gpu timer: %s (%d runs measured, mean %.2f ms, max %.2f ms on this stand-in)\n",
           fsr_timers(f) ? "yes" : "none here", nt, mean, max);
    fsr_free(f);
    free(in);
    (void)in_tex;
    printf(fails ? "fsr_test: %d failed\n" : "fsr_test: all passed\n", fails);
    return fails ? 1 : 0;
}
