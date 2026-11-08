// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * winston_video_test <decoder> <in.h264> <w> <h> <winston socket> <hint|-> [seconds]
 *
 * moonlight-core's way to the screen through Winston (winston_video.h), off
 * the car against the unit's own Winston (tools/winston-bench): the stream
 * (Annex B, access unit delimiters) decoded again and again at 60 a second
 * for that long, each picture written into a free NV12 GPU buffer and shown,
 * as dr_submit does. Prints one JSON line: whether Winston took it
 * ("via"), access units, pictures shown, frames without a free buffer, and
 * whether the connection was lost.
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "decode.h"
#include "winston_video.h"

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

static size_t next_aud(const unsigned char *p, size_t n, size_t from) {
    for (size_t i = from; i + 4 < n; i++)
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 && (p[i + 3] & 0x1f) == 9) return i > 0 && p[i - 1] == 0 ? i - 1 : i;
    return n;
}

int main(int argc, char **argv) {
    if (argc < 7) { fprintf(stderr, "usage: winston_video_test <decoder> <in.h264> <w> <h> <socket> <hint|-> [seconds]\n"); return 2; }
    int w = atoi(argv[3]), h = atoi(argv[4]);
    double seconds = argc > 7 ? atof(argv[7]) : 5;
    FILE *f = fopen(argv[2], "rb");
    if (!f) { perror(argv[2]); return 1; }
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    unsigned char *buf = malloc((size_t)n);
    if (!buf || fread(buf, 1, (size_t)n, f) != (size_t)n) { fprintf(stderr, "read failed\n"); return 1; }
    fclose(f);
    char err[512];
    struct decoder *d = decoder_open(argv[1], w, h, err, sizeof(err));
    if (!d) { fprintf(stderr, "decoder: %s\n", err); return 1; }
    struct wv *v = wv_open(argv[5], w, h, 0, 0, 1920, 720, strcmp(argv[6], "-") ? argv[6] : NULL, err, sizeof(err));
    if (!v) {
        printf("{\"via\":\"frame-file\",\"why\":\"%s\"}\n", err);
        decoder_close(d);
        return 0;
    }
    fprintf(stderr, "decoder: %s; %s\n", decoder_name(d), wv_name(v));
    int aus = 0, shown = 0, nobuf = 0, fails = 0, lost = 0;
    double start = now_ms(), next = start;
    size_t at = next_aud(buf, (size_t)n, 0);
    while (now_ms() - start < seconds * 1000) {
        if (at >= (size_t)n) at = next_aud(buf, (size_t)n, 0);   /* again from the start (an IDR) */
        size_t end = next_aud(buf, (size_t)n, at + 4);
        if (wv_lost(v)) { lost = 1; break; }
        uint8_t *pic = wv_begin(v, d);
        if (!pic) nobuf++;
        int r = decoder_decode(d, buf + at, end - at, pic, err, sizeof(err));
        if (pic) wv_end(v, r > 0);
        if (r < 0) fails++;
        else if (r > 0) shown++;
        aus++;
        at = end;
        next += 1000.0 / 60;
        double wait = next - now_ms();
        if (wait > 0) { struct timespec ts = { 0, (long)(wait * 1e6) }; nanosleep(&ts, NULL); }
    }
    printf("{\"via\":\"winston\",\"what\":\"%s\",\"aus\":%d,\"shown\":%d,\"noBuffer\":%d,\"failed\":%d,\"lost\":%d}\n",
           wv_name(v), aus, shown, nobuf, fails, lost);
    wv_close(v);
    decoder_close(d);
    return fails || lost ? 1 : 0;
}
