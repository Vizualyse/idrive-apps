// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * fsr: AMD FidelityFX Super Resolution 1 (EASU upscaling, then RCAS
 * sharpening) as two GLES 3.0 passes, for a game drawn smaller than it is
 * shown. The shaders are a port of AMD's ffx_fsr1.h (MIT, THIRD-PARTY.md),
 * 32-bit float, with texelFetch taps instead of textureGather (GLES 3.0 has
 * no gather, and llvmpipe on the bench runs the same code).
 *
 * Needs a current GLES 3 context. Images are in memory order throughout
 * (row 0 is the top of a dmabuf, and the first row an FBO writes), so
 * nothing is flipped.
 */
#ifndef FSR_H
#define FSR_H

#include <stdint.h>

struct fsr;

/* getProcAddress: eglGetProcAddress (Mesa's returns core GL too). NULL with
 * err (a compile log, say) when it can't run here. */
struct fsr *fsr_new(void *(*getProcAddress)(const char *), char *err, int n);
void fsr_free(struct fsr *f);

/* Upscales src_w x src_h at src_x, src_y of texture src (tex_w x tex_h, a
 * GL_TEXTURE_2D; its min filter is set to NEAREST here) into the
 * framebuffer dst_fbo, dst_w x dst_h. sharpness: RCAS's, in stops (0 the
 * sharpest, AMD's default 0.2), < 0 for EASU alone. Submits, doesn't wait.
 * 0, or -1. */
int fsr_run(struct fsr *f, unsigned src, int tex_w, int tex_h, int src_x, int src_y, int src_w, int src_h,
            unsigned dst_fbo, int dst_w, int dst_h, float sharpness);

/* The GPU time of the runs, when the driver has timer queries
 * (GL_EXT_disjoint_timer_query): the runs measured since the last call
 * (their count; 0 when none or no timers), their mean and max in ms. */
int fsr_gpu_take(struct fsr *f, double *mean_ms, double *max_ms);
/* whether timer queries work here */
int fsr_timers(const struct fsr *f);

#endif
