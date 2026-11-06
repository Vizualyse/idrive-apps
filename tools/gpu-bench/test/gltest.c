// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// The GPU bench's smoke test: what a GL client on the head unit does, on the
// unit's own Mesa 19 (libgbm, libEGL, libGLESv2) in its rootfs container.
// GBM device on a DRM fd -> EGL display (EGL_PLATFORM_GBM_MESA, the unit's
// only off-screen platform) -> surfaceless GLES 3 context -> an FBO -> a
// shader that draws a gradient -> glReadPixels.
//
//   gltest [--device PATH] [--pixels] [--desktop-gl]
//
// --device  the DRM node (default /dev/dri/renderD128: the stub shim fakes
//           it; in swrast mode any character device will do, run.sh passes
//           /dev/null).
// --pixels  check what was drawn (swrast mode: llvmpipe really draws; the stub
//           runs nothing, its pixels are zeros).
// --desktop-gl  also try a desktop OpenGL context (eglBindAPI(EGL_OPENGL_API))
//           and print its version; failing it is reported, not an error.
//
// Prints what it found as key: value lines; exit 0 when every step passed.
#define _GNU_SOURCE
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <gbm.h>
#include <fcntl.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define W 64
#define H 64

static int failures;

static void fail(const char *what) {
    fprintf(stderr, "FAIL: %s\n", what);
    failures++;
}

static int gl_ok(const char *what) {
    GLenum e = glGetError();
    if (e != GL_NO_ERROR) {
        fprintf(stderr, "FAIL: %s: GL error 0x%04x\n", what, e);
        failures++;
        return 0;
    }
    return 1;
}

static GLuint compile(GLenum type, const char *src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, NULL);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[2048] = "";
        glGetShaderInfoLog(s, sizeof log, NULL, log);
        fprintf(stderr, "FAIL: compile %s shader: %s\n", type == GL_VERTEX_SHADER ? "vertex" : "fragment", log);
        failures++;
    }
    return s;
}

static const char *VS =
    "#version 300 es\n"
    "in vec2 pos;\n"
    "void main() { gl_Position = vec4(pos, 0.0, 1.0); }\n";
// x and y ramps and a constant blue: every pixel is predictable.
static const char *FS =
    "#version 300 es\n"
    "precision highp float;\n"
    "uniform vec2 size;\n"
    "out vec4 color;\n"
    "void main() { color = vec4(gl_FragCoord.x / size.x, gl_FragCoord.y / size.y, 0.5, 1.0); }\n";

static int near(unsigned got, double want) {
    return fabs((double)got - want * 255.0) <= 2.0;
}

static void desktop_gl(EGLDisplay dpy) {
    if (!eglBindAPI(EGL_OPENGL_API)) {
        printf("desktop_gl: no (eglBindAPI 0x%x)\n", eglGetError());
        return;
    }
    static const EGLint core[] = {
        EGL_CONTEXT_MAJOR_VERSION, 4, EGL_CONTEXT_MINOR_VERSION, 5,
        EGL_CONTEXT_OPENGL_PROFILE_MASK, EGL_CONTEXT_OPENGL_CORE_PROFILE_BIT, EGL_NONE };
    static const EGLint compat[] = { EGL_NONE };
    const EGLint *tries[] = { core, compat };
    const char *names[] = { "core", "compatibility" };
    for (int i = 0; i < 2; i++) {
        EGLContext c = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, tries[i]);
        if (c == EGL_NO_CONTEXT) {
            printf("desktop_gl_%s: no (0x%x)\n", names[i], eglGetError());
            continue;
        }
        if (eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, c)) {
            // glGetString is the same entry for GL and GLES through libglapi.
            printf("desktop_gl_%s: %s\n", names[i], (const char *)glGetString(GL_VERSION));
            if (i == 0) {
                const char *sl = (const char *)glGetString(GL_SHADING_LANGUAGE_VERSION);
                printf("desktop_glsl: %s\n", sl ? sl : "?");
            }
        } else {
            printf("desktop_gl_%s: no current (0x%x)\n", names[i], eglGetError());
        }
        eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        eglDestroyContext(dpy, c);
    }
    eglBindAPI(EGL_OPENGL_ES_API);
}

int main(int argc, char **argv) {
    const char *device = "/dev/dri/renderD128";
    int check_pixels = 0, try_desktop = 0;
    for (int i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "--device") && i + 1 < argc) device = argv[++i];
        else if (!strcmp(argv[i], "--pixels")) check_pixels = 1;
        else if (!strcmp(argv[i], "--desktop-gl")) try_desktop = 1;
        else { fprintf(stderr, "usage: gltest [--device PATH] [--pixels] [--desktop-gl]\n"); return 2; }
    }
    setvbuf(stdout, NULL, _IOLBF, 0);

    int fd = open(device, O_RDWR | O_CLOEXEC);
    if (fd < 0) { perror(device); return 1; }
    struct gbm_device *gbm = gbm_create_device(fd);
    if (!gbm) { fail("gbm_create_device"); return 1; }
    printf("gbm_backend: %s\n", gbm_device_get_backend_name(gbm));

    PFNEGLGETPLATFORMDISPLAYEXTPROC get_platform_display =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    if (!get_platform_display) { fail("eglGetPlatformDisplayEXT"); return 1; }
    EGLDisplay dpy = get_platform_display(EGL_PLATFORM_GBM_MESA, gbm, NULL);
    EGLint major = 0, minor = 0;
    if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, &major, &minor)) {
        fprintf(stderr, "FAIL: eglInitialize: 0x%x\n", eglGetError());
        return 1;
    }
    printf("egl: %d.%d\n", major, minor);
    printf("egl_vendor: %s\n", eglQueryString(dpy, EGL_VENDOR));
    printf("egl_version: %s\n", eglQueryString(dpy, EGL_VERSION));
    printf("egl_client_apis: %s\n", eglQueryString(dpy, EGL_CLIENT_APIS));
    printf("egl_extensions: %s\n", eglQueryString(dpy, EGL_EXTENSIONS));
    EGLint nconfigs = 0;
    eglGetConfigs(dpy, NULL, 0, &nconfigs);
    printf("egl_configs: %d\n", nconfigs);

    if (!eglBindAPI(EGL_OPENGL_ES_API)) { fail("eglBindAPI(GLES)"); return 1; }
    static const EGLint es3[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 2, EGL_NONE };
    static const EGLint es30[] = { EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE };
    EGLContext ctx = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, es3);
    if (ctx == EGL_NO_CONTEXT) ctx = eglCreateContext(dpy, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, es30);
    if (ctx == EGL_NO_CONTEXT) { fprintf(stderr, "FAIL: eglCreateContext(GLES 3): 0x%x\n", eglGetError()); return 1; }
    if (!eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx)) {
        fprintf(stderr, "FAIL: eglMakeCurrent (surfaceless): 0x%x\n", eglGetError());
        return 1;
    }
    printf("gl_vendor: %s\n", (const char *)glGetString(GL_VENDOR));
    printf("gl_renderer: %s\n", (const char *)glGetString(GL_RENDERER));
    printf("gl_version: %s\n", (const char *)glGetString(GL_VERSION));
    printf("glsl_version: %s\n", (const char *)glGetString(GL_SHADING_LANGUAGE_VERSION));
    GLint next = 0, max_tex = 0, max_samples = 0;
    glGetIntegerv(GL_NUM_EXTENSIONS, &next);
    glGetIntegerv(GL_MAX_TEXTURE_SIZE, &max_tex);
    glGetIntegerv(GL_MAX_SAMPLES, &max_samples);
    printf("gl_extensions: %d\n", next);
    printf("gl_max_texture_size: %d\n", max_tex);
    printf("gl_max_samples: %d\n", max_samples);
    gl_ok("queries");

    GLuint tex, fbo;
    glGenTextures(1, &tex);
    glBindTexture(GL_TEXTURE_2D, tex);
    glTexStorage2D(GL_TEXTURE_2D, 1, GL_RGBA8, W, H);
    glGenFramebuffers(1, &fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, tex, 0);
    if (glCheckFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) fail("framebuffer incomplete");
    gl_ok("framebuffer");

    GLuint prog = glCreateProgram();
    glAttachShader(prog, compile(GL_VERTEX_SHADER, VS));
    glAttachShader(prog, compile(GL_FRAGMENT_SHADER, FS));
    glBindAttribLocation(prog, 0, "pos");
    glLinkProgram(prog);
    GLint linked = 0;
    glGetProgramiv(prog, GL_LINK_STATUS, &linked);
    if (!linked) {
        char log[2048] = "";
        glGetProgramInfoLog(prog, sizeof log, NULL, log);
        fprintf(stderr, "FAIL: link: %s\n", log);
        failures++;
    }
    glUseProgram(prog);
    glUniform2f(glGetUniformLocation(prog, "size"), W, H);
    gl_ok("program");

    static const GLfloat quad[] = { -1, -1, 1, -1, -1, 1, 1, 1 };
    GLuint vbo, vao;
    glGenVertexArrays(1, &vao);
    glBindVertexArray(vao);
    glGenBuffers(1, &vbo);
    glBindBuffer(GL_ARRAY_BUFFER, vbo);
    glBufferData(GL_ARRAY_BUFFER, sizeof quad, quad, GL_STATIC_DRAW);
    glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, 0);
    glEnableVertexAttribArray(0);
    glViewport(0, 0, W, H);
    glClearColor(1, 0, 1, 1);
    glClear(GL_COLOR_BUFFER_BIT);
    glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
    glFinish();
    gl_ok("draw");

    static unsigned char px[W * H * 4];
    glReadPixels(0, 0, W, H, GL_RGBA, GL_UNSIGNED_BYTE, px);
    gl_ok("glReadPixels");
    static const int probes[][2] = { { 0, 0 }, { W - 1, 0 }, { 0, H - 1 }, { W / 2, H / 2 }, { W - 1, H - 1 } };
    int bad = 0;
    for (unsigned i = 0; i < sizeof probes / sizeof probes[0]; i++) {
        int x = probes[i][0], y = probes[i][1];
        const unsigned char *p = px + (y * W + x) * 4;
        double wr = (x + 0.5) / W, wg = (y + 0.5) / H;
        int ok = near(p[0], wr) && near(p[1], wg) && near(p[2], 0.5) && p[3] == 255;
        printf("pixel %d,%d: %u %u %u %u%s\n", x, y, p[0], p[1], p[2], p[3],
               check_pixels ? (ok ? "" : " (wrong)") : "");
        bad += !ok;
    }
    if (check_pixels && bad) fail("pixels");

    if (try_desktop) desktop_gl(dpy);

    eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    eglDestroyContext(dpy, ctx);
    eglTerminate(dpy);
    gbm_device_destroy(gbm);
    close(fd);
    printf("result: %s\n", failures ? "FAIL" : "ok");
    return failures ? 1 : 0;
}
