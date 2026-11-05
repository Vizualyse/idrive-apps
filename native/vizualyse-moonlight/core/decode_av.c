// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * Software H.264: FFmpeg 6.1.2's decoder, built into moonlight-core (the
 * build image's static libavcodec / libavutil, H.264 alone, LGPL-2.1+; the
 * unit's own libavcodec.so.57 has AAC decoders only). Slice threads
 * (moonlight-core asks the PC for 4 slices a frame), low delay: one frame
 * in, its picture out.
 */
#define _GNU_SOURCE
#include "decode.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <libavcodec/avcodec.h>
#include <libavutil/frame.h>

#define AV_THREADS 4

struct av_dec {
    struct decoder base;
    AVCodecContext *ctx;
    AVPacket *pkt;
    AVFrame *frame;
    int out_w, out_h;
};

static void av_close(struct decoder *b) {
    struct av_dec *d = (struct av_dec *)b;
    if (d->frame) av_frame_free(&d->frame);
    if (d->pkt) av_packet_free(&d->pkt);
    if (d->ctx) avcodec_free_context(&d->ctx);
    free(d);
}

static int av_decode(struct decoder *b, const uint8_t *au, size_t len, uint8_t *pic, char *err, size_t n) {
    struct av_dec *d = (struct av_dec *)b;
    d->pkt->data = (uint8_t *)au;
    d->pkt->size = (int)len;
    int r = avcodec_send_packet(d->ctx, d->pkt);
    d->pkt->data = NULL; d->pkt->size = 0;
    if (r < 0 && r != AVERROR(EAGAIN)) { snprintf(err, n, "avcodec_send_packet: %d", r); return -1; }
    int got = 0;
    /* low delay: at most one picture per access unit; take whatever is out */
    while (avcodec_receive_frame(d->ctx, d->frame) == 0) {
        AVFrame *f = d->frame;
        if (pic && (f->format == AV_PIX_FMT_YUV420P || f->format == AV_PIX_FMT_YUVJ420P)) {
            const int W = d->out_w, H = d->out_h;
            scale_plane(f->data[0], f->linesize[0], f->width, f->height, pic, W, H);
            scale_plane(f->data[1], f->linesize[1], f->width / 2, f->height / 2, pic + W * H, W / 2, H / 2);
            scale_plane(f->data[2], f->linesize[2], f->width / 2, f->height / 2, pic + W * H + W * H / 4, W / 2, H / 2);
            got = 1;
        } else if (pic && !got) {
            snprintf(err, n, "libavcodec gave pixel format %d, not 4:2:0", f->format);
            av_frame_unref(f);
            return -1;
        }
        av_frame_unref(f);
    }
    return got;
}

struct decoder *av_open(int out_w, int out_h, char *err, size_t n) {
    const AVCodec *codec = avcodec_find_decoder(AV_CODEC_ID_H264);
    if (!codec) { snprintf(err, n, "libavcodec has no H.264 decoder"); return NULL; }
    struct av_dec *d = calloc(1, sizeof(*d));
    if (!d) { snprintf(err, n, "no memory"); return NULL; }
    d->base.decode = av_decode;
    d->base.close = av_close;
    d->out_w = out_w; d->out_h = out_h;
    d->ctx = avcodec_alloc_context3(codec);
    d->pkt = av_packet_alloc();
    d->frame = av_frame_alloc();
    if (!d->ctx || !d->pkt || !d->frame) { snprintf(err, n, "libavcodec: no memory"); av_close(&d->base); return NULL; }
    d->ctx->flags |= AV_CODEC_FLAG_LOW_DELAY;
    d->ctx->thread_type = FF_THREAD_SLICE;
    d->ctx->thread_count = AV_THREADS;
    int r = avcodec_open2(d->ctx, codec, NULL);
    if (r < 0) { snprintf(err, n, "avcodec_open2: %d", r); av_close(&d->base); return NULL; }
    snprintf(d->base.name, sizeof(d->base.name), "av (software, libavcodec %s, %d slice threads)", LIBAVCODEC_IDENT + 4, AV_THREADS);
    return &d->base;
}
