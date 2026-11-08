// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * fsr: FSR 1 (EASU + RCAS) as two GLES 3.0 passes; see fsr.h.
 *
 * The shaders port AMD's ffx_fsr1.h (FidelityFX-FSR, MIT, Copyright (c)
 * 2021 Advanced Micro Devices, Inc.): FsrEasuF, FsrEasuSetF, FsrEasuTapF,
 * FsrRcasF in their 32-bit forms, with ffx_a.h's approximate reciprocals
 * (APrxLoRcpF1, APrxLoRsqF1, APrxMedRcpF1). Taps are texelFetch at whole
 * pixels clamped to the source rectangle, in place of the four gathers.
 * AMD's MIT notice is in THIRD-PARTY.md, shipped with the tool.
 */
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "fsr.h"

typedef unsigned int GLuint, GLenum;
typedef int GLint, GLsizei;
typedef char GLchar;
typedef unsigned long long GLuint64;

#define GL_FRAGMENT_SHADER 0x8B30
#define GL_VERTEX_SHADER 0x8B31
#define GL_COMPILE_STATUS 0x8B81
#define GL_LINK_STATUS 0x8B82
#define GL_TEXTURE_2D 0x0DE1
#define GL_TEXTURE0 0x84C0
#define GL_TEXTURE_MIN_FILTER 0x2801
#define GL_TEXTURE_MAG_FILTER 0x2800
#define GL_NEAREST 0x2600
#define GL_RGBA 0x1908
#define GL_RGBA8 0x8058
#define GL_UNSIGNED_BYTE 0x1401
#define GL_FRAMEBUFFER 0x8D40
#define GL_COLOR_ATTACHMENT0 0x8CE0
#define GL_FRAMEBUFFER_COMPLETE 0x8CD5
#define GL_TRIANGLES 0x0004
#define GL_BLEND 0x0BE2
#define GL_SCISSOR_TEST 0x0C11
#define GL_DEPTH_TEST 0x0B71
#define GL_EXTENSIONS 0x1F03
#define GL_TIME_ELAPSED_EXT 0x88BF
#define GL_QUERY_RESULT 0x8866
#define GL_QUERY_RESULT_AVAILABLE 0x8867
#define GL_GPU_DISJOINT_EXT 0x8FBB

static const char VS[] =
    "#version 300 es\n"
    "void main() {\n"
    "  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));\n"
    "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n"
    "}\n";

/* EASU: FsrEasuF. con0: the output pixel to the input's (scale xy, offset
 * zw, FsrEasuConOffset's con0); rect: the input's pixels, inclusive. */
static const char EASU[] =
    "#version 300 es\n"
    "precision highp float;\n"
    "precision highp int;\n"
    "uniform highp sampler2D src;\n"
    "uniform vec4 con0;\n"
    "uniform ivec4 rect;\n"
    "out vec4 o;\n"
    "float rcpLo(float a) { return uintBitsToFloat(0x7ef07ebbu - floatBitsToUint(a)); }\n"
    "float rsqLo(float a) { return uintBitsToFloat(0x5f347d74u - (floatBitsToUint(a) >> 1u)); }\n"
    "vec3 tap(ivec2 p) { return texelFetch(src, clamp(p, rect.xy, rect.zw), 0).rgb; }\n"
    "float luma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }\n"
    /* FsrEasuSetF: a above, b c d across, e below */
    "void setF(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {\n"
    "  float lenX = max(abs(lD - lC), abs(lC - lB));\n"
    "  lenX = rcpLo(lenX);\n"
    "  float dirX = lD - lB;\n"
    "  dir.x += dirX * w;\n"
    "  lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);\n"
    "  lenX *= lenX;\n"
    "  len += lenX * w;\n"
    "  float lenY = max(abs(lE - lC), abs(lC - lA));\n"
    "  lenY = rcpLo(lenY);\n"
    "  float dirY = lE - lA;\n"
    "  dir.y += dirY * w;\n"
    "  lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);\n"
    "  lenY *= lenY;\n"
    "  len += lenY * w;\n"
    "}\n"
    /* FsrEasuTapF */
    "void tapF(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {\n"
    "  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * (-dir.y) + off.y * dir.x) * len;\n"
    "  float d2 = min(v.x * v.x + v.y * v.y, clp);\n"
    "  float wB = 0.4 * d2 - 1.0;\n"
    "  float wA = lob * d2 - 1.0;\n"
    "  wB *= wB;\n"
    "  wA *= wA;\n"
    "  wB = 1.5625 * wB - 0.5625;\n"
    "  float w = wB * wA;\n"
    "  aC += c * w;\n"
    "  aW += w;\n"
    "}\n"
    "void main() {\n"
    "  vec2 pp = floor(gl_FragCoord.xy) * con0.xy + con0.zw;\n"
    "  vec2 fp = floor(pp);\n"
    "  pp -= fp;\n"
    "  ivec2 f = ivec2(fp);\n"
    /*    b c
     *  e f g h
     *  i j k l
     *    n o    */
    "  vec3 b = tap(f + ivec2(0, -1)), c = tap(f + ivec2(1, -1));\n"
    "  vec3 e = tap(f + ivec2(-1, 0)), F = tap(f), g = tap(f + ivec2(1, 0)), h = tap(f + ivec2(2, 0));\n"
    "  vec3 i = tap(f + ivec2(-1, 1)), j = tap(f + ivec2(0, 1)), k = tap(f + ivec2(1, 1)), l = tap(f + ivec2(2, 1));\n"
    "  vec3 n = tap(f + ivec2(0, 2)), O = tap(f + ivec2(1, 2));\n"
    "  float bL = luma(b), cL = luma(c), eL = luma(e), fL = luma(F), gL = luma(g), hL = luma(h);\n"
    "  float iL = luma(i), jL = luma(j), kL = luma(k), lL = luma(l), nL = luma(n), oL = luma(O);\n"
    "  vec2 dir = vec2(0.0);\n"
    "  float len = 0.0;\n"
    "  setF(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);\n"
    "  setF(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);\n"
    "  setF(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);\n"
    "  setF(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);\n"
    "  vec2 dir2 = dir * dir;\n"
    "  float dirR = dir2.x + dir2.y;\n"
    "  bool zro = dirR < 1.0 / 32768.0;\n"
    "  dirR = rsqLo(dirR);\n"
    "  dirR = zro ? 1.0 : dirR;\n"
    "  dir.x = zro ? 1.0 : dir.x;\n"
    "  dir *= dirR;\n"
    "  len = len * 0.5;\n"
    "  len *= len;\n"
    "  float stretch = (dir.x * dir.x + dir.y * dir.y) * rcpLo(max(abs(dir.x), abs(dir.y)));\n"
    "  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);\n"
    "  float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;\n"
    "  float clp = rcpLo(lob);\n"
    "  vec3 mn = min(min(F, g), min(j, k));\n"
    "  vec3 mx = max(max(F, g), max(j, k));\n"
    "  vec3 aC = vec3(0.0);\n"
    "  float aW = 0.0;\n"
    "  tapF(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);\n"
    "  tapF(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);\n"
    "  tapF(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);\n"
    "  tapF(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);\n"
    "  tapF(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, F);\n"
    "  tapF(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);\n"
    "  tapF(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);\n"
    "  tapF(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);\n"
    "  tapF(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);\n"
    "  tapF(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);\n"
    "  tapF(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, O);\n"
    "  tapF(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);\n"
    "  o = vec4(min(mx, max(mn, aC / aW)), 1.0);\n"
    "}\n";

/* RCAS: FsrRcasF, without the denoise option. sharp: exp2(-stops). The
 * limiters' divisions are kept off zero (flat black or white): AMD's rcp
 * of 0 is +inf on their targets, GLSL leaves it undefined. */
static const char RCAS[] =
    "#version 300 es\n"
    "precision highp float;\n"
    "precision highp int;\n"
    "uniform highp sampler2D src;\n"
    "uniform ivec2 maxp;\n"
    "uniform float sharp;\n"
    "out vec4 o;\n"
    "float rcpMed(float a) { float b = uintBitsToFloat(0x7ef19fffu - floatBitsToUint(a)); return b * (-b * a + 2.0); }\n"
    "vec3 ld(ivec2 p) { return texelFetch(src, clamp(p, ivec2(0), maxp), 0).rgb; }\n"
    "void main() {\n"
    "  ivec2 sp = ivec2(gl_FragCoord.xy);\n"
    "  vec3 b = ld(sp + ivec2(0, -1)), d = ld(sp + ivec2(-1, 0)), e = ld(sp);\n"
    "  vec3 f = ld(sp + ivec2(1, 0)), h = ld(sp + ivec2(0, 1));\n"
    "  vec3 mn4 = min(min(b, d), min(f, h));\n"
    "  vec3 mx4 = max(max(b, d), max(f, h));\n"
    "  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1.0 / 65536.0));\n"
    "  vec3 hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3(-1.0 / 65536.0));\n"
    "  vec3 lobe3 = max(-hitMin, hitMax);\n"
    "  float lobe = max(-(0.25 - 1.0 / 16.0), min(max(max(lobe3.r, lobe3.g), lobe3.b), 0.0)) * sharp;\n"
    "  float rcpL = rcpMed(4.0 * lobe + 1.0);\n"
    "  o = vec4((lobe * (b + d + h + f) + e) * rcpL, 1.0);\n"
    "}\n";

struct fsr {
    /* GL */
    GLuint (*createShader)(GLenum);
    void (*shaderSource)(GLuint, GLsizei, const GLchar *const *, const GLint *);
    void (*compileShader)(GLuint);
    void (*getShaderiv)(GLuint, GLenum, GLint *);
    void (*getShaderInfoLog)(GLuint, GLsizei, GLsizei *, GLchar *);
    void (*deleteShader)(GLuint);
    GLuint (*createProgram)(void);
    void (*attachShader)(GLuint, GLuint);
    void (*linkProgram)(GLuint);
    void (*getProgramiv)(GLuint, GLenum, GLint *);
    void (*getProgramInfoLog)(GLuint, GLsizei, GLsizei *, GLchar *);
    void (*deleteProgram)(GLuint);
    void (*useProgram)(GLuint);
    GLint (*getUniformLocation)(GLuint, const GLchar *);
    void (*uniform1i)(GLint, GLint);
    void (*uniform1f)(GLint, float);
    void (*uniform2i)(GLint, GLint, GLint);
    void (*uniform4f)(GLint, float, float, float, float);
    void (*uniform4i)(GLint, GLint, GLint, GLint, GLint);
    void (*genTextures)(GLsizei, GLuint *);
    void (*deleteTextures)(GLsizei, const GLuint *);
    void (*bindTexture)(GLenum, GLuint);
    void (*activeTexture)(GLenum);
    void (*texParameteri)(GLenum, GLenum, GLint);
    void (*texImage2D)(GLenum, GLint, GLint, GLsizei, GLsizei, GLint, GLenum, GLenum, const void *);
    void (*genFramebuffers)(GLsizei, GLuint *);
    void (*deleteFramebuffers)(GLsizei, const GLuint *);
    void (*bindFramebuffer)(GLenum, GLuint);
    void (*framebufferTexture2D)(GLenum, GLenum, GLenum, GLuint, GLint);
    GLenum (*checkFramebufferStatus)(GLenum);
    void (*viewport)(GLint, GLint, GLsizei, GLsizei);
    void (*disable)(GLenum);
    void (*drawArrays)(GLenum, GLint, GLsizei);
    void (*flush)(void);
    const unsigned char *(*getString)(GLenum);
    void (*getIntegerv)(GLenum, GLint *);
    /* GL_EXT_disjoint_timer_query (optional) */
    void (*genQueries)(GLsizei, GLuint *);
    void (*beginQuery)(GLenum, GLuint);
    void (*endQuery)(GLenum);
    void (*getQueryObjectuiv)(GLuint, GLenum, GLuint *);
    void (*getQueryObjectui64v)(GLuint, GLenum, GLuint64 *);

    GLuint easu, rcas;
    GLint easu_src, easu_con0, easu_rect, rcas_src, rcas_maxp, rcas_sharp;
    /* EASU's output when RCAS follows */
    GLuint mid_tex, mid_fb;
    int mid_w, mid_h;
    /* timer queries: a small ring, read when available */
    int timers;
    GLuint q[4];
    int q_used[4], q_next;
    /* measured since the last fsr_gpu_take */
    double sum_ms, max_ms;
    int n_ms;
};

static GLuint compile(struct fsr *f, GLenum type, const char *src, char *err, int n) {
    GLuint s = f->createShader(type);
    f->shaderSource(s, 1, &src, NULL);
    f->compileShader(s);
    GLint ok = 0;
    f->getShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) {
        char log[1024] = "";
        f->getShaderInfoLog(s, sizeof log, NULL, log);
        snprintf(err, (size_t)n, "fsr: %s shader: %s", type == GL_VERTEX_SHADER ? "vertex" : "fragment", log);
        f->deleteShader(s);
        return 0;
    }
    return s;
}

static GLuint program(struct fsr *f, const char *fs, char *err, int n) {
    GLuint v = compile(f, GL_VERTEX_SHADER, VS, err, n);
    if (!v) return 0;
    GLuint s = compile(f, GL_FRAGMENT_SHADER, fs, err, n);
    if (!s) { f->deleteShader(v); return 0; }
    GLuint p = f->createProgram();
    f->attachShader(p, v);
    f->attachShader(p, s);
    f->linkProgram(p);
    f->deleteShader(v);
    f->deleteShader(s);
    GLint ok = 0;
    f->getProgramiv(p, GL_LINK_STATUS, &ok);
    if (!ok) {
        char log[1024] = "";
        f->getProgramInfoLog(p, sizeof log, NULL, log);
        snprintf(err, (size_t)n, "fsr: link: %s", log);
        f->deleteProgram(p);
        return 0;
    }
    return p;
}

struct fsr *fsr_new(void *(*gpa)(const char *), char *err, int n) {
    struct fsr *f = calloc(1, sizeof *f);
    if (!f) { snprintf(err, (size_t)n, "fsr: no memory"); return NULL; }
#define P(m, name) if (!(*(void **)&f->m = gpa(name))) { snprintf(err, (size_t)n, "fsr: no %s", name); free(f); return NULL; }
    P(createShader, "glCreateShader"); P(shaderSource, "glShaderSource"); P(compileShader, "glCompileShader");
    P(getShaderiv, "glGetShaderiv"); P(getShaderInfoLog, "glGetShaderInfoLog"); P(deleteShader, "glDeleteShader");
    P(createProgram, "glCreateProgram"); P(attachShader, "glAttachShader"); P(linkProgram, "glLinkProgram");
    P(getProgramiv, "glGetProgramiv"); P(getProgramInfoLog, "glGetProgramInfoLog"); P(deleteProgram, "glDeleteProgram");
    P(useProgram, "glUseProgram"); P(getUniformLocation, "glGetUniformLocation");
    P(uniform1i, "glUniform1i"); P(uniform1f, "glUniform1f"); P(uniform2i, "glUniform2i");
    P(uniform4f, "glUniform4f"); P(uniform4i, "glUniform4i");
    P(genTextures, "glGenTextures"); P(deleteTextures, "glDeleteTextures"); P(bindTexture, "glBindTexture");
    P(activeTexture, "glActiveTexture"); P(texParameteri, "glTexParameteri"); P(texImage2D, "glTexImage2D");
    P(genFramebuffers, "glGenFramebuffers"); P(deleteFramebuffers, "glDeleteFramebuffers");
    P(bindFramebuffer, "glBindFramebuffer"); P(framebufferTexture2D, "glFramebufferTexture2D");
    P(checkFramebufferStatus, "glCheckFramebufferStatus"); P(viewport, "glViewport"); P(disable, "glDisable");
    P(drawArrays, "glDrawArrays"); P(flush, "glFlush"); P(getString, "glGetString"); P(getIntegerv, "glGetIntegerv");
#undef P
    const char *ext = (const char *)f->getString(GL_EXTENSIONS);
    if (ext && strstr(ext, "GL_EXT_disjoint_timer_query")) {
        *(void **)&f->genQueries = gpa("glGenQueriesEXT");
        *(void **)&f->beginQuery = gpa("glBeginQueryEXT");
        *(void **)&f->endQuery = gpa("glEndQueryEXT");
        *(void **)&f->getQueryObjectuiv = gpa("glGetQueryObjectuivEXT");
        *(void **)&f->getQueryObjectui64v = gpa("glGetQueryObjectui64vEXT");
        f->timers = f->genQueries && f->beginQuery && f->endQuery && f->getQueryObjectuiv && f->getQueryObjectui64v;
        if (f->timers) f->genQueries(4, f->q);
    }
    if (!(f->easu = program(f, EASU, err, n)) || !(f->rcas = program(f, RCAS, err, n))) {
        if (f->easu) f->deleteProgram(f->easu);
        free(f);
        return NULL;
    }
    f->easu_src = f->getUniformLocation(f->easu, "src");
    f->easu_con0 = f->getUniformLocation(f->easu, "con0");
    f->easu_rect = f->getUniformLocation(f->easu, "rect");
    f->rcas_src = f->getUniformLocation(f->rcas, "src");
    f->rcas_maxp = f->getUniformLocation(f->rcas, "maxp");
    f->rcas_sharp = f->getUniformLocation(f->rcas, "sharp");
    return f;
}

void fsr_free(struct fsr *f) {
    if (!f) return;
    if (f->mid_fb) f->deleteFramebuffers(1, &f->mid_fb);
    if (f->mid_tex) f->deleteTextures(1, &f->mid_tex);
    f->deleteProgram(f->easu);
    f->deleteProgram(f->rcas);
    free(f);
}

/* EASU's output texture (and its framebuffer) at w x h */
static int mid(struct fsr *f, int w, int h) {
    if (f->mid_tex && f->mid_w == w && f->mid_h == h) return 0;
    if (!f->mid_tex) { f->genTextures(1, &f->mid_tex); f->genFramebuffers(1, &f->mid_fb); }
    f->bindTexture(GL_TEXTURE_2D, f->mid_tex);
    f->texImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
    f->texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);
    f->texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    f->bindFramebuffer(GL_FRAMEBUFFER, f->mid_fb);
    f->framebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, f->mid_tex, 0);
    if (f->checkFramebufferStatus(GL_FRAMEBUFFER) != GL_FRAMEBUFFER_COMPLETE) return -1;
    f->mid_w = w; f->mid_h = h;
    return 0;
}

static void timer_poll(struct fsr *f) {
    for (int i = 0; i < 4; i++) {
        if (!f->q_used[i]) continue;
        GLuint avail = 0;
        f->getQueryObjectuiv(f->q[i], GL_QUERY_RESULT_AVAILABLE, &avail);
        if (!avail) continue;
        GLuint64 ns = 0;
        f->getQueryObjectui64v(f->q[i], GL_QUERY_RESULT, &ns);
        GLint disjoint = 0;
        f->getIntegerv(GL_GPU_DISJOINT_EXT, &disjoint);
        if (!disjoint) {
            double ms = (double)ns / 1e6;
            f->sum_ms += ms;
            if (ms > f->max_ms) f->max_ms = ms;
            f->n_ms++;
        }
        f->q_used[i] = 0;
    }
}

int fsr_run(struct fsr *f, unsigned src, int tex_w, int tex_h, int sx, int sy, int sw, int sh,
            unsigned dst_fbo, int dw, int dh, float sharpness) {
    if (sw < 1 || sh < 1 || dw < 1 || dh < 1 || sx < 0 || sy < 0 || sx + sw > tex_w || sy + sh > tex_h) return -1;
    int rcas = sharpness >= 0;
    if (rcas && mid(f, dw, dh) < 0) return -1;
    GLuint q = 0;
    int qi = -1;
    if (f->timers) {
        timer_poll(f);
        if (!f->q_used[f->q_next]) { qi = f->q_next; q = f->q[qi]; f->beginQuery(GL_TIME_ELAPSED_EXT, q); }
    }
    f->disable(GL_BLEND); f->disable(GL_SCISSOR_TEST); f->disable(GL_DEPTH_TEST);
    f->activeTexture(GL_TEXTURE0);
    f->bindTexture(GL_TEXTURE_2D, src);
    f->texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST);   /* complete without mipmaps */
    f->texParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST);
    /* EASU */
    f->bindFramebuffer(GL_FRAMEBUFFER, rcas ? f->mid_fb : dst_fbo);
    f->viewport(0, 0, dw, dh);
    f->useProgram(f->easu);
    f->uniform1i(f->easu_src, 0);
    float scx = (float)sw / (float)dw, scy = (float)sh / (float)dh;
    f->uniform4f(f->easu_con0, scx, scy, 0.5f * scx - 0.5f + (float)sx, 0.5f * scy - 0.5f + (float)sy);
    f->uniform4i(f->easu_rect, sx, sy, sx + sw - 1, sy + sh - 1);
    f->drawArrays(GL_TRIANGLES, 0, 3);
    /* RCAS */
    if (rcas) {
        f->bindFramebuffer(GL_FRAMEBUFFER, dst_fbo);
        f->bindTexture(GL_TEXTURE_2D, f->mid_tex);
        f->useProgram(f->rcas);
        f->uniform1i(f->rcas_src, 0);
        f->uniform2i(f->rcas_maxp, dw - 1, dh - 1);
        f->uniform1f(f->rcas_sharp, exp2f(-sharpness));   /* FsrRcasCon: stops to linear */
        f->drawArrays(GL_TRIANGLES, 0, 3);
    }
    if (qi >= 0) { f->endQuery(GL_TIME_ELAPSED_EXT); f->q_used[qi] = 1; f->q_next = (qi + 1) & 3; }
    f->useProgram(0);
    f->bindFramebuffer(GL_FRAMEBUFFER, 0);
    f->flush();
    return 0;
}

int fsr_gpu_take(struct fsr *f, double *mean_ms, double *max_ms) {
    if (f->timers) timer_poll(f);
    int n = f->n_ms;
    *mean_ms = n ? f->sum_ms / n : 0;
    *max_ms = f->max_ms;
    f->sum_ms = f->max_ms = 0;
    f->n_ms = 0;
    return n;
}

int fsr_timers(const struct fsr *f) { return f->timers; }
