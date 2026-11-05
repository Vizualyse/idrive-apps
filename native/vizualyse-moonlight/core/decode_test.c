// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * decode_test <decoder> <in.h264> <out.yuv> <w> <h> [every]
 *
 * Splits an Annex B stream at its access unit delimiters (NAL 9; encode with
 * x264's aud=1), decodes each access unit as moonlight-core would, and writes
 * every picture to out.yuv as I420 of w x h. every N: a picture for every
 * Nth access unit only, the others decoded without one (as when behind).
 * Prints one JSON line: the decoder, access units, pictures, failures, ms.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "decode.h"

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

/* The offset of the next AUD start code at or after from, or n. */
static size_t next_aud(const unsigned char *p, size_t n, size_t from) {
    for (size_t i = from; i + 4 < n; i++)
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 && (p[i + 3] & 0x1f) == 9) return i > 0 && p[i - 1] == 0 ? i - 1 : i;
    return n;
}

int main(int argc, char **argv) {
    if (argc < 6) { fprintf(stderr, "usage: decode_test <auto|msdk|msdk-sw|av> <in.h264> <out.yuv> <w> <h> [every]\n"); return 2; }
    int w = atoi(argv[4]), h = atoi(argv[5]), every = argc > 6 ? atoi(argv[6]) : 1;
    FILE *f = fopen(argv[2], "rb");
    if (!f) { perror(argv[2]); return 1; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    unsigned char *buf = malloc((size_t)n);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { fprintf(stderr, "read failed\n"); return 1; }
    fclose(f);
    FILE *out = fopen(argv[3], "wb");
    if (!out) { perror(argv[3]); return 1; }

    char err[512];
    struct decoder *d = decoder_open(argv[1], w, h, err, sizeof(err));
    if (!d) { fprintf(stderr, "decoder: %s\n", err); return 1; }
    fprintf(stderr, "decoder: %s\n", decoder_name(d));
    size_t frame = (size_t)w * h * 3 / 2;
    unsigned char *pic = malloc(frame);
    int aus = 0, pics = 0, fails = 0;
    double ms = 0;
    size_t at = next_aud(buf, (size_t)n, 0);
    while (at < (size_t)n) {
        size_t end = next_aud(buf, (size_t)n, at + 4);
        int want = (aus % every) == 0;
        double t0 = now_ms();
        int r = decoder_decode(d, buf + at, end - at, want ? pic : NULL, err, sizeof(err));
        ms += now_ms() - t0;
        aus++;
        if (r < 0) { fails++; fprintf(stderr, "access unit %d: %s\n", aus - 1, err); }
        else if (r > 0) { fwrite(pic, 1, frame, out); pics++; }
        at = end;
    }
    fclose(out);
    printf("{\"decoder\":\"%s\",\"aus\":%d,\"pictures\":%d,\"failed\":%d,\"ms_per_au\":%.2f}\n", decoder_name(d), aus, pics, fails, aus ? ms / aus : 0);
    decoder_close(d);
    return fails ? 1 : 0;
}
