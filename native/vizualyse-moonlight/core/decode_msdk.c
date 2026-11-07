// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
// Ported from robertnisipeanu/idrive-apps native/waze-on-cluster/src/decoder_msdk.cpp
// (GPL-3.0-or-later, Copyright (C) 2026 Robert Nisipeanu), commit daaa3f7.
/*
 * H.264 on the GPU through the unit's Intel Media SDK (API 1.24; no
 * dispatcher: libmfxhw64.so exports the API itself) over VA-API on the DRM
 * render node, as upstream's waze-on-cluster does on iDrive 7. Our own
 * CarPlay (Cinemo's libNmeVideoMSDK) decodes the same way on this firmware.
 *
 *  - Each access unit is passed whole (MFX_BITSTREAM_COMPLETE_FRAME), one
 *    frame in flight (AsyncDepth 1), in decoding order (DecodedOrder 1: in
 *    display order MSDK held frames back for an SPS without VUI; Sunshine
 *    sends no B frames).
 *  - The decoder writes NV12 into GPU memory MSDK allocates itself (opaque
 *    surfaces), which VPP reads; VPP scales to the output size into one
 *    system-memory NV12 surface (page-aligned, pitch a multiple of 64, as
 *    MSDK's GPU copy takes it), and the CPU splits its UV plane while
 *    copying into the I420 slot. A frame decoded without a picture skips
 *    VPP and the copy.
 *  - GPU copy (GPUCopy on, MFXInitEx): VPP's output is copied to system
 *    memory by the GPU (MSDK's CM copy; the unit has igfxcmrt64.so). A
 *    session that can't be set up with it is made again without, and a
 *    failed VPP run turns it off for the process (upstream: unverified on
 *    the car whether the CM runtime starts there).
 *  - A new session for every sequence: reinitialising in the same session
 *    made MSDK hand out surfaces from the closed pool (upstream, seen with
 *    the unit's libmfxsw64).
 *  - Nothing decodes before an access unit with an SPS. A sequence that
 *    MSDK can't continue (a new SPS needing more) restarts from that access
 *    unit; a failed one returns -1 and waits for the next SPS (the core
 *    then asks for an IDR frame).
 * Libraries by dlopen: libmfxhw64.so + libva.so.1 + libva-drm.so.1 (msdk),
 * or libmfxsw64.so alone (msdk-sw, no VA). MOONLIGHT_MSDK_DIR: where they
 * are (the tests: the firmware's copies).
 */
#define _GNU_SOURCE
#include "decode.h"

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "mfx/mfxvideo.h"

/* libva (va/va.h, va/va_drm.h); the unit has libva.so.1 1.9900.0 */
typedef void *VADisplay;
typedef int VAStatus;
#define VA_STATUS_SUCCESS 0
typedef VADisplay (*vaGetDisplayDRM_t)(int fd);
typedef VAStatus (*vaInitialize_t)(VADisplay dpy, int *major, int *minor);
typedef VAStatus (*vaTerminate_t)(VADisplay dpy);
typedef const char *(*vaErrorStr_t)(VAStatus s);
typedef const char *(*vaQueryVendorString_t)(VADisplay dpy);

#define RENDER_NODE "/dev/dri/renderD128"
#define SYNC_MS 1000          /* the longest wait for one frame */
#define BUSY_RETRIES 1000     /* MFX_WRN_DEVICE_BUSY, 1 ms apart */
#define STALL_LIMIT 64        /* decode calls in a row with no progress */
#define FAIL_LIMIT 30         /* access units in a row that fail: wait for an SPS */

_Static_assert(sizeof(mfxInitParam) == 80 && offsetof(mfxInitParam, GPUCopy) == 32,
               "mfxInitParam as the unit's MFXInitEx takes it");

static struct {
    void *mfx, *va, *vadrm;
    __typeof__(MFXInit) *Init;
    __typeof__(MFXInitEx) *InitEx;
    __typeof__(MFXClose) *Close;
    __typeof__(MFXQueryVersion) *QueryVersion;
    __typeof__(MFXVideoCORE_SetHandle) *SetHandle;
    __typeof__(MFXVideoCORE_SyncOperation) *Sync;
    __typeof__(MFXVideoDECODE_DecodeHeader) *DecodeHeader;
    __typeof__(MFXVideoDECODE_QueryIOSurf) *DecQueryIOSurf;
    __typeof__(MFXVideoDECODE_Init) *DecInit;
    __typeof__(MFXVideoDECODE_Close) *DecClose;
    __typeof__(MFXVideoDECODE_DecodeFrameAsync) *DecodeFrameAsync;
    __typeof__(MFXVideoVPP_QueryIOSurf) *VppQueryIOSurf;
    __typeof__(MFXVideoVPP_Init) *VppInit;
    __typeof__(MFXVideoVPP_Close) *VppClose;
    __typeof__(MFXVideoVPP_RunFrameVPPAsync) *RunVPP;
    vaGetDisplayDRM_t GetDisplayDRM;
    vaInitialize_t vaInit;
    vaTerminate_t vaTerm;
    vaErrorStr_t vaErr;
    vaQueryVendorString_t vaVendor;
} M;

/* GPU copy failed once: no session asks for it again. */
static int no_gpu_copy = 0;

struct msdk {
    struct decoder base;
    int hw, fd;
    VADisplay va;
    mfxSession session;
    int session_gpu_copy;
    int out_w, out_h;
    int running, failed;
    mfxVideoParam dec, vpp;
    mfxExtOpaqueSurfaceAlloc dec_opq, vpp_opq;
    mfxExtBuffer *dec_ext[1], *vpp_ext[1];
    mfxFrameSurface1 *pool, **pool_ptrs;
    int npool;
    mfxFrameSurface1 vout;     /* VPP's output, system memory */
    uint8_t *vout_mem;
    char *err; size_t errn;    /* this call's error, first one wins */
    int has_err;
};

static const char *sts_name(mfxStatus s) {
    switch (s) {
    case MFX_ERR_NONE: return "NONE";
    case MFX_ERR_UNKNOWN: return "ERR_UNKNOWN";
    case MFX_ERR_NULL_PTR: return "ERR_NULL_PTR";
    case MFX_ERR_UNSUPPORTED: return "ERR_UNSUPPORTED";
    case MFX_ERR_MEMORY_ALLOC: return "ERR_MEMORY_ALLOC";
    case MFX_ERR_NOT_ENOUGH_BUFFER: return "ERR_NOT_ENOUGH_BUFFER";
    case MFX_ERR_INVALID_HANDLE: return "ERR_INVALID_HANDLE";
    case MFX_ERR_LOCK_MEMORY: return "ERR_LOCK_MEMORY";
    case MFX_ERR_NOT_INITIALIZED: return "ERR_NOT_INITIALIZED";
    case MFX_ERR_NOT_FOUND: return "ERR_NOT_FOUND";
    case MFX_ERR_MORE_DATA: return "ERR_MORE_DATA";
    case MFX_ERR_MORE_SURFACE: return "ERR_MORE_SURFACE";
    case MFX_ERR_ABORTED: return "ERR_ABORTED";
    case MFX_ERR_DEVICE_LOST: return "ERR_DEVICE_LOST";
    case MFX_ERR_INCOMPATIBLE_VIDEO_PARAM: return "ERR_INCOMPATIBLE_VIDEO_PARAM";
    case MFX_ERR_INVALID_VIDEO_PARAM: return "ERR_INVALID_VIDEO_PARAM";
    case MFX_ERR_UNDEFINED_BEHAVIOR: return "ERR_UNDEFINED_BEHAVIOR";
    case MFX_ERR_DEVICE_FAILED: return "ERR_DEVICE_FAILED";
    case MFX_ERR_GPU_HANG: return "ERR_GPU_HANG";
    case MFX_ERR_REALLOC_SURFACE: return "ERR_REALLOC_SURFACE";
    case MFX_WRN_IN_EXECUTION: return "WRN_IN_EXECUTION";
    case MFX_WRN_DEVICE_BUSY: return "WRN_DEVICE_BUSY";
    case MFX_WRN_VIDEO_PARAM_CHANGED: return "WRN_VIDEO_PARAM_CHANGED";
    case MFX_WRN_PARTIAL_ACCELERATION: return "WRN_PARTIAL_ACCELERATION";
    case MFX_WRN_INCOMPATIBLE_VIDEO_PARAM: return "WRN_INCOMPATIBLE_VIDEO_PARAM";
    case MFX_WRN_VALUE_NOT_CHANGED: return "WRN_VALUE_NOT_CHANGED";
    case MFX_WRN_OUT_OF_RANGE: return "WRN_OUT_OF_RANGE";
    case MFX_WRN_FILTER_SKIPPED: return "WRN_FILTER_SKIPPED";
    default: return "?";
    }
}

static int fail(struct msdk *d, const char *call, mfxStatus s) {
    if (!d->has_err && d->err) {
        if (s) snprintf(d->err, d->errn, "%s: MFX_%s (%d)", call, sts_name(s), (int)s);
        else snprintf(d->err, d->errn, "%s", call);
        d->has_err = 1;
    }
    return -1;
}

static void *lib(const char *name, char *err, size_t n) {
    const char *dir = getenv("MOONLIGHT_MSDK_DIR");
    char p[512];
    snprintf(p, sizeof(p), "%s%s%s", dir ? dir : "", dir ? "/" : "", name);
    void *h = dlopen(p, RTLD_NOW | RTLD_GLOBAL);
    if (!h) snprintf(err, n, "%s", dlerror());
    return h;
}

static int load(int hw, char *err, size_t n) {
    if (M.mfx) return 0;
    if (hw) {
        if (!(M.va = lib("libva.so.1", err, n))) return -1;
        if (!(M.vadrm = lib("libva-drm.so.1", err, n))) return -1;
#define VSYM(h, f, name) if (!(M.f = (__typeof__(M.f))dlsym(M.h, name))) { snprintf(err, n, "no %s", name); return -1; }
        VSYM(vadrm, GetDisplayDRM, "vaGetDisplayDRM");
        VSYM(va, vaInit, "vaInitialize");
        VSYM(va, vaTerm, "vaTerminate");
        VSYM(va, vaErr, "vaErrorStr");
        VSYM(va, vaVendor, "vaQueryVendorString");
#undef VSYM
    }
    void *m = lib(hw ? "libmfxhw64.so" : "libmfxsw64.so", err, n);
    if (!m) return -1;
#define SYM(f, name) if (!(M.f = (__typeof__(M.f))dlsym(m, name))) { snprintf(err, n, "no %s in MSDK", name); dlclose(m); return -1; }
    SYM(Init, "MFXInit");
    SYM(InitEx, "MFXInitEx");
    SYM(Close, "MFXClose");
    SYM(QueryVersion, "MFXQueryVersion");
    SYM(SetHandle, "MFXVideoCORE_SetHandle");
    SYM(Sync, "MFXVideoCORE_SyncOperation");
    SYM(DecodeHeader, "MFXVideoDECODE_DecodeHeader");
    SYM(DecQueryIOSurf, "MFXVideoDECODE_QueryIOSurf");
    SYM(DecInit, "MFXVideoDECODE_Init");
    SYM(DecClose, "MFXVideoDECODE_Close");
    SYM(DecodeFrameAsync, "MFXVideoDECODE_DecodeFrameAsync");
    SYM(VppQueryIOSurf, "MFXVideoVPP_QueryIOSurf");
    SYM(VppInit, "MFXVideoVPP_Init");
    SYM(VppClose, "MFXVideoVPP_Close");
    SYM(RunVPP, "MFXVideoVPP_RunFrameVPPAsync");
#undef SYM
    M.mfx = m;
    return 0;
}

static mfxU16 align16(int v) { return (mfxU16)((v + 15) & ~15); }

/* A session on our VA display, with GPU copy or not. */
static int session_up(struct msdk *d, int gpu) {
    mfxVersion ver;
    ver.Major = MFX_VERSION_MAJOR;
    ver.Minor = MFX_VERSION_MINOR;
    mfxIMPL impl = d->hw ? (MFX_IMPL_HARDWARE | MFX_IMPL_VIA_VAAPI) : MFX_IMPL_SOFTWARE;
    mfxStatus s;
    if (gpu) {
        mfxInitParam p;
        memset(&p, 0, sizeof(p));
        p.Implementation = impl;
        p.Version = ver;
        p.GPUCopy = MFX_GPUCOPY_ON;
        s = M.InitEx(p, &d->session);
    } else {
        s = M.Init(impl, &ver, &d->session);
    }
    if (s < MFX_ERR_NONE) { d->session = NULL; return fail(d, gpu ? "MFXInitEx" : "MFXInit", s); }
    if (d->hw) {
        s = M.SetHandle(d->session, MFX_HANDLE_VA_DISPLAY, d->va);
        if (s < MFX_ERR_NONE) { M.Close(d->session); d->session = NULL; return fail(d, "MFXVideoCORE_SetHandle", s); }
    }
    d->session_gpu_copy = gpu;
    return 0;
}

static int open_session(struct msdk *d) {
    if (d->hw && !no_gpu_copy) {
        int had = d->has_err;
        if (session_up(d, 1) == 0) return 0;
        no_gpu_copy = 1;
        d->has_err = had;   /* not this call's error: it goes on without */
    }
    return session_up(d, 0);
}

static void stop(struct msdk *d) {
    if (d->running) {
        M.DecClose(d->session);
        M.VppClose(d->session);
        d->running = 0;
    }
    if (d->session) { M.Close(d->session); d->session = NULL; }
    free(d->pool); d->pool = NULL;
    free(d->pool_ptrs); d->pool_ptrs = NULL;
    d->npool = 0;
    free(d->vout_mem); d->vout_mem = NULL;
}

static void wrap(mfxBitstream *bs, const uint8_t *au, size_t len) {
    memset(bs, 0, sizeof(*bs));
    bs->Data = (mfxU8 *)au;
    bs->DataLength = bs->MaxLength = (mfxU32)len;
    bs->DataFlag = MFX_BITSTREAM_COMPLETE_FRAME;
}

/* Whether the access unit carries an SPS (NAL type 7). */
static int has_sps(const uint8_t *p, size_t n) {
    for (size_t i = 0; i + 3 < n; i++) {
        if (p[i] == 0 && p[i + 1] == 0 && p[i + 2] == 1 && (p[i + 3] & 0x1f) == 7) return 1;
    }
    return 0;
}

static int start(struct msdk *d, const uint8_t *au, size_t len);

/* After a set-up step failed in a session with GPU copy: again without. */
static int setup_failed(struct msdk *d, const uint8_t *au, size_t len, const char *call, mfxStatus s) {
    if (!d->session_gpu_copy) return fail(d, call, s);
    no_gpu_copy = 1;
    stop(d);
    return start(d, au, len);
}

static int start(struct msdk *d, const uint8_t *au, size_t len) {
    if (!d->session && open_session(d) < 0) return -1;
    mfxBitstream bs;
    wrap(&bs, au, len);
    memset(&d->dec, 0, sizeof(d->dec));
    d->dec.mfx.CodecId = MFX_CODEC_AVC;
    mfxStatus s = M.DecodeHeader(d->session, &bs, &d->dec);
    if (s == MFX_ERR_MORE_DATA) return 0;   /* an SPS without its PPS: wait for the next */
    if (s < MFX_ERR_NONE) return fail(d, "MFXVideoDECODE_DecodeHeader", s);
    d->dec.AsyncDepth = 1;
    d->dec.IOPattern = MFX_IOPATTERN_OUT_OPAQUE_MEMORY;
    d->dec.mfx.DecodedOrder = 1;

    const mfxFrameInfo in = d->dec.mfx.FrameInfo;
    memset(&d->vpp, 0, sizeof(d->vpp));
    d->vpp.AsyncDepth = 1;
    d->vpp.IOPattern = MFX_IOPATTERN_IN_OPAQUE_MEMORY | MFX_IOPATTERN_OUT_SYSTEM_MEMORY;
    d->vpp.vpp.In = in;
    mfxFrameInfo *out = &d->vpp.vpp.Out;
    *out = in;
    out->FourCC = MFX_FOURCC_NV12;
    out->ChromaFormat = MFX_CHROMAFORMAT_YUV420;
    out->PicStruct = MFX_PICSTRUCT_PROGRESSIVE;
    out->Width = align16(d->out_w);
    out->Height = align16(d->out_h);
    out->CropX = out->CropY = 0;
    out->CropW = (mfxU16)d->out_w;
    out->CropH = (mfxU16)d->out_h;
    /* the same rate in and out: no frame rate conversion */
    if (!in.FrameRateExtN || !in.FrameRateExtD) {
        d->vpp.vpp.In.FrameRateExtN = out->FrameRateExtN = 60;
        d->vpp.vpp.In.FrameRateExtD = out->FrameRateExtD = 1;
    }

    /* decoder output = VPP input: one pool covers both */
    mfxFrameAllocRequest dr, vr[2];
    memset(&dr, 0, sizeof(dr));
    memset(vr, 0, sizeof(vr));
    s = M.DecQueryIOSurf(d->session, &d->dec, &dr);
    if (s < MFX_ERR_NONE) return setup_failed(d, au, len, "MFXVideoDECODE_QueryIOSurf", s);
    s = M.VppQueryIOSurf(d->session, &d->vpp, vr);
    if (s < MFX_ERR_NONE) return setup_failed(d, au, len, "MFXVideoVPP_QueryIOSurf", s);
    int n = dr.NumFrameSuggested + vr[0].NumFrameSuggested;
    d->pool = calloc((size_t)n, sizeof(*d->pool));
    d->pool_ptrs = calloc((size_t)n, sizeof(*d->pool_ptrs));
    if (!d->pool || !d->pool_ptrs) return fail(d, "no memory for the surface pool", 0);
    d->npool = n;
    for (int i = 0; i < n; i++) { d->pool[i].Info = in; d->pool_ptrs[i] = &d->pool[i]; }
    memset(&d->dec_opq, 0, sizeof(d->dec_opq));
    d->dec_opq.Header.BufferId = MFX_EXTBUFF_OPAQUE_SURFACE_ALLOCATION;
    d->dec_opq.Header.BufferSz = sizeof(d->dec_opq);
    d->dec_opq.Out.Surfaces = d->pool_ptrs;
    d->dec_opq.Out.NumSurface = (mfxU16)n;
    d->dec_opq.Out.Type = dr.Type;
    memset(&d->vpp_opq, 0, sizeof(d->vpp_opq));
    d->vpp_opq.Header = d->dec_opq.Header;
    d->vpp_opq.In = d->dec_opq.Out;
    d->dec_ext[0] = &d->dec_opq.Header;
    d->vpp_ext[0] = &d->vpp_opq.Header;
    d->dec.ExtParam = d->dec_ext; d->dec.NumExtParam = 1;
    d->vpp.ExtParam = d->vpp_ext; d->vpp.NumExtParam = 1;

    const char *call = "MFXVideoDECODE_Init";
    s = M.DecInit(d->session, &d->dec);
    if (s >= MFX_ERR_NONE) {
        call = "MFXVideoVPP_Init";
        s = M.VppInit(d->session, &d->vpp);
        if (s < MFX_ERR_NONE) M.DecClose(d->session);
    }
    if (s < MFX_ERR_NONE) return setup_failed(d, au, len, call, s);

    /* NV12: Y, then U,V interleaved at half size */
    const mfxU32 pitch = (out->Width + 63u) & ~63u;
    void *mem = NULL;
    if (posix_memalign(&mem, 4096, (size_t)pitch * out->Height * 3 / 2) != 0) {
        M.VppClose(d->session); M.DecClose(d->session);
        return fail(d, "no memory for VPP's output", 0);
    }
    d->vout_mem = mem;
    memset(&d->vout, 0, sizeof(d->vout));
    d->vout.Info = *out;
    d->vout.Data.Pitch = (mfxU16)pitch;
    d->vout.Data.Y = d->vout_mem;
    d->vout.Data.UV = d->vout_mem + (size_t)pitch * out->Height;
    d->running = 1;
    return 0;
}

/* VPP on a decoded surface, then the NV12 into pic as I420. */
static int picture(struct msdk *d, mfxFrameSurface1 *in, uint8_t *pic) {
    mfxSyncPoint sync = NULL;
    mfxStatus s;
    int busy = 0;
    while ((s = M.RunVPP(d->session, in, &d->vout, NULL, &sync)) == MFX_WRN_DEVICE_BUSY) {
        if (++busy > BUSY_RETRIES) return fail(d, "MFXVideoVPP_RunFrameVPPAsync", s);
        usleep(1000);
    }
    if (s == MFX_ERR_MORE_DATA || (s >= MFX_ERR_NONE && !sync)) return 0;
    if (s >= MFX_ERR_NONE) s = M.Sync(d->session, sync, SYNC_MS);
    if (s != MFX_ERR_NONE) {
        if (d->session_gpu_copy) {
            /* the next sequence starts without GPU copy */
            no_gpu_copy = 1;
            fail(d, "VPP with GPU copy", s);
            stop(d);
            return -1;
        }
        return fail(d, "MFXVideoVPP_RunFrameVPPAsync", s);
    }
    const int W = d->out_w, H = d->out_h, P = d->vout.Data.Pitch;
    if (d->base.nv12_stride) {
        /* NV12 wanted (a GPU buffer for Winston): VPP's rows as they are */
        const int S = d->base.nv12_stride;
        for (int y = 0; y < H; y++) memcpy(pic + (size_t)y * S, d->vout.Data.Y + (size_t)y * P, (size_t)W);
        uint8_t *uvo = pic + d->base.nv12_uv;
        for (int y = 0; y < H / 2; y++) memcpy(uvo + (size_t)y * S, d->vout.Data.UV + (size_t)y * P, (size_t)W);
        return 1;
    }
    for (int y = 0; y < H; y++) memcpy(pic + (size_t)y * W, d->vout.Data.Y + (size_t)y * P, (size_t)W);
    uint8_t *u = pic + (size_t)W * H, *v = u + (size_t)W * H / 4;
    for (int y = 0; y < H / 2; y++) {
        const uint8_t *uv = d->vout.Data.UV + (size_t)y * P;
        uint8_t *ur = u + (size_t)y * (W / 2), *vr = v + (size_t)y * (W / 2);
        for (int x = 0; x < W / 2; x++) { ur[x] = uv[2 * x]; vr[x] = uv[2 * x + 1]; }
    }
    return 1;
}

enum { DEC_OK, DEC_FAILED, DEC_RESTART };

/* Decodes all of bs (or drains with bs NULL) until MSDK wants more data. */
static int decode(struct msdk *d, mfxBitstream *bs, uint8_t *pic, int *got) {
    int busy = 0, stalls = 0;
    for (;;) {
        mfxFrameSurface1 *work = NULL;
        for (int i = 0; i < d->npool; i++) if (!d->pool[i].Data.Locked) { work = &d->pool[i]; break; }
        if (!work) { fail(d, "no free decode surface", 0); return DEC_FAILED; }
        mfxFrameSurface1 *out = NULL;
        mfxSyncPoint sync = NULL;
        mfxStatus s = M.DecodeFrameAsync(d->session, bs, work, &out, &sync);
        if (s == MFX_WRN_DEVICE_BUSY) {
            if (++busy > BUSY_RETRIES) { fail(d, "MFXVideoDECODE_DecodeFrameAsync", s); return DEC_FAILED; }
            usleep(1000);
            continue;
        }
        busy = 0;
        if (s == MFX_ERR_MORE_DATA) return DEC_OK;
        if (s == MFX_ERR_INCOMPATIBLE_VIDEO_PARAM && bs) return DEC_RESTART;
        if (s < MFX_ERR_NONE && s != MFX_ERR_MORE_SURFACE) { fail(d, "MFXVideoDECODE_DecodeFrameAsync", s); return DEC_FAILED; }
        if (sync) {
            stalls = 0;
            if (pic) {
                /* VPP's task waits for the decode's */
                int r = picture(d, out, pic);
                if (r < 0) return DEC_FAILED;
                if (r > 0) *got = 1;
            } else {
                /* no picture: wait for the decode alone (the next frame would) */
                s = M.Sync(d->session, sync, SYNC_MS);
                if (s != MFX_ERR_NONE) { fail(d, "MFXVideoCORE_SyncOperation", s); return DEC_FAILED; }
            }
        } else if (++stalls > STALL_LIMIT) {
            fail(d, "MFXVideoDECODE_DecodeFrameAsync makes no progress", s);
            return DEC_FAILED;
        }
    }
}

static int msdk_decode(struct decoder *b, const uint8_t *au, size_t len, uint8_t *pic, char *err, size_t n) {
    struct msdk *d = (struct msdk *)b;
    d->err = err; d->errn = n; d->has_err = 0;
    int got = 0;
    for (int attempt = 0; attempt < 2; attempt++) {
        if (!d->running) {
            if (!has_sps(au, len)) return 0;   /* nothing decodes before a sequence header */
            if (start(d, au, len) < 0) { stop(d); return -1; }
            if (!d->running) return 0;
        }
        mfxBitstream bs;
        wrap(&bs, au, len);
        int r = decode(d, &bs, pic, &got);
        if (r == DEC_OK) { d->failed = 0; return got; }
        if (r == DEC_FAILED) {
            if (d->running && ++d->failed >= FAIL_LIMIT) { d->failed = 0; stop(d); }
            return -1;
        }
        /* a sequence that needs more: drain the old one, start again here */
        decode(d, NULL, NULL, &got);
        stop(d);
    }
    fail(d, "the decoder refused the new sequence after starting again", 0);
    return -1;
}

static void msdk_close(struct decoder *b) {
    struct msdk *d = (struct msdk *)b;
    stop(d);
    if (d->va) M.vaTerm(d->va);
    if (d->fd >= 0) close(d->fd);
    free(d);
}

struct decoder *msdk_open(int hw, int out_w, int out_h, char *err, size_t n) {
    if (load(hw, err, n) < 0) return NULL;
    struct msdk *d = calloc(1, sizeof(*d));
    if (!d) { snprintf(err, n, "no memory"); return NULL; }
    d->base.decode = msdk_decode;
    d->base.close = msdk_close;
    d->hw = hw; d->fd = -1;
    d->out_w = out_w; d->out_h = out_h;
    d->err = err; d->errn = n;
    const char *vendor = "";
    if (hw) {
        const char *node = getenv("MOONLIGHT_RENDER_NODE");
        if (!node) node = RENDER_NODE;
        d->fd = open(node, O_RDWR | O_CLOEXEC);
        if (d->fd < 0) { snprintf(err, n, "%s: %s", node, strerror(errno)); msdk_close(&d->base); return NULL; }
        d->va = M.GetDisplayDRM(d->fd);
        if (!d->va) { snprintf(err, n, "vaGetDisplayDRM failed"); msdk_close(&d->base); return NULL; }
        int ma = 0, mi = 0;
        VAStatus vs = M.vaInit(d->va, &ma, &mi);
        if (vs != VA_STATUS_SUCCESS) { snprintf(err, n, "vaInitialize: %s", M.vaErr(vs)); M.vaTerm(d->va); d->va = NULL; msdk_close(&d->base); return NULL; }
        vendor = M.vaVendor(d->va);
    }
    /* a session now, as root: an MSDK that refuses shows up here, and the
     * first sequence uses it */
    if (open_session(d) < 0) { msdk_close(&d->base); return NULL; }
    mfxVersion v = { { 0, 0 } };
    M.QueryVersion(d->session, &v);
    snprintf(d->base.name, sizeof(d->base.name), "msdk (%s, API %u.%u%s%s%.60s)", hw ? "GPU" : "software", v.Major, v.Minor,
             d->session_gpu_copy ? ", GPU copy" : ", CPU copy", vendor && *vendor ? ", " : "", vendor ? vendor : "");
    return &d->base;
}
