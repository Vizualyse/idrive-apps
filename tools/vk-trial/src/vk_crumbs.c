// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// vk_crumbs.so: preloaded into vk-trial's child (on the car and on the
// bench). Two jobs:
//
// - Breadcrumbs: every DRM ioctl is written to fd VK_TRIAL_CRUMB_FD (the
//   gate opens it O_DSYNC in the run's log folder) *before* it enters the
//   kernel, and its return after. The journal is in RAM and a GPU hang
//   restarts the unit, so after a restart the last "> " line without its
//   "< " is the call that never came back. Programs add their own lines
//   with vk_crumb() (looked up with dlsym, optional).
// - A guard: the display node (/dev/dri/card*, Winston's) is refused;
//   only the render node may be opened.
//
// After CRUMB_ALL lines only the calls that can hang are kept (execbuffer,
// waits, contexts, syncobj waits), so a long program stays bearable.
//
// VK_TRIAL_CRUMB_MODE=watch (the Steam tool's games, not the gate's trials:
// the gate takes a growing log as its sign of life): a game makes those
// calls eight and more times a frame, and two O_DSYNC writes around each
// held a game with nothing to draw to 20 frames a second (the bench,
// 2026-11-11). So only a process's first WATCH_SYNC lines are written as
// they happen (the driver starting: where every hang so far was); after
// them the calls are kept in memory, and a thread of ours writes them out,
// with the call itself, when one hasn't come back in WATCH_LATE_MS: a call
// stuck in the kernel holds only its own thread. What that gives up: a
// lockup that stops that thread too leaves the calls after the start
// unwritten.

#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>
#include <libdrm/drm.h>
#include <libdrm/i915_drm.h>

#define CRUMB_ALL 4000
#define WATCH_SYNC 400       /* watch: a process's first lines, written as they happen */
#define WATCH_LATE_MS 1000   /* watch: a call not back after this is written out */
#define WATCH_TICK_MS 250    /* watch: how often the calls under way are looked at */
#define RING 96              /* watch: the last lines kept in memory */
#define LINE 240
#define PEND 64              /* watch: calls under way at once (threads in the driver) */

static int crumb_fd = -2;
static long lines;

static int cfd(void) {
    if (crumb_fd == -2) {
        const char *e = getenv("VK_TRIAL_CRUMB_FD");
        crumb_fd = e ? atoi(e) : -1;
        if (crumb_fd >= 0 && fcntl(crumb_fd, F_GETFD) < 0) crumb_fd = -1;
    }
    return crumb_fd;
}

static long now_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000;
}

/* "seconds.ms [pid] text\n" into b: its length */
static int line_fmt(char *b, size_t cap, const char *fmt, va_list ap) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    /* the pid: the probe and its wl-sink write to the same file */
    int n = snprintf(b, cap, "%ld.%03ld [%d] ", (long)ts.tv_sec, ts.tv_nsec / 1000000, (int)getpid());
    int m = vsnprintf(b + n, cap - n - 1, fmt, ap);
    if (m < 0) return 0;
    n += m;
    if (n > (int)cap - 2) n = cap - 2;
    b[n++] = '\n';
    return n;
}

__attribute__((visibility("default"))) void vk_crumb(const char *fmt, ...) {
    int fd = cfd();
    if (fd < 0) return;
    char b[512];
    va_list ap;
    va_start(ap, fmt);
    int n = line_fmt(b, sizeof b, fmt, ap);
    va_end(ap);
    if (!n) return;
    lines++;
    if (write(fd, b, n) < 0) { /* nothing better to do */ }
}

/* ---- watch mode ---------------------------------------------------------- */

static int watch_mode(void) {
    static int w = -1;
    if (w < 0) { const char *e = getenv("VK_TRIAL_CRUMB_MODE"); w = e && !strcmp(e, "watch"); }
    return w;
}

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static char ring[RING][LINE];
static int ring_len[RING];
static unsigned long ring_n, ring_out;   /* lines put in all; lines written or overwritten */
static struct { long start; int said; int len; char line[LINE]; } pend[PEND];
static int watcher;                      /* our thread runs (this process) */

/* (mu held) one more line kept */
static void ring_put(const char *l, int n) {
    if (n > LINE) n = LINE;
    memcpy(ring[ring_n % RING], l, n);
    ring_len[ring_n % RING] = n;
    ring_n++;
    if (ring_n - ring_out > RING) ring_out = ring_n - RING;
}

static int ring_putf(const char *fmt, ...) {
    char b[LINE];
    va_list ap;
    va_start(ap, fmt);
    int n = line_fmt(b, sizeof b, fmt, ap);
    va_end(ap);
    if (n) ring_put(b, n);
    return n;
}

/* (mu held) the lines kept and not yet written, in one write */
static void ring_flush(void) {
    static char out[RING * LINE];
    int n = 0;
    for (; ring_out < ring_n; ring_out++) {
        memcpy(out + n, ring[ring_out % RING], ring_len[ring_out % RING]);
        n += ring_len[ring_out % RING];
    }
    if (n && write(cfd(), out, n) < 0) { /* nothing better to do */ }
}

/* our thread: a call under way for WATCH_LATE_MS is written out, with the
 * lines before it; once a call */
static void *watch_thread(void *arg) {
    (void)arg;
    for (;;) {
        struct timespec ts = { 0, WATCH_TICK_MS * 1000000L };
        nanosleep(&ts, NULL);
        pthread_mutex_lock(&mu);
        long t = now_ms();
        for (int i = 0; i < PEND; i++) {
            if (!pend[i].start || pend[i].said || t - pend[i].start < WATCH_LATE_MS) continue;
            pend[i].said = 1;
            ring_putf("! not back after %ld ms: %.*s", t - pend[i].start, pend[i].len, pend[i].line);
            ring_flush();
        }
        pthread_mutex_unlock(&mu);
    }
    return NULL;
}

/* (mu held) the thread, once a process; every signal blocked in it: Wine's
 * handlers want a Wine thread */
static void watch_start(void) {
    if (watcher) return;
    watcher = 1;
    sigset_t all, old;
    sigfillset(&all);
    pthread_sigmask(SIG_BLOCK, &all, &old);
    pthread_t th;
    pthread_attr_t at;
    pthread_attr_init(&at);
    pthread_attr_setdetachstate(&at, PTHREAD_CREATE_DETACHED);
    if (pthread_create(&th, &at, watch_thread, NULL)) watcher = 0;
    pthread_attr_destroy(&at);
    pthread_sigmask(SIG_SETMASK, &old, NULL);
}

/* a fork (Wine starting a process): the child has only the forking thread */
static void fork_prepare(void) { pthread_mutex_lock(&mu); }
static void fork_parent(void) { pthread_mutex_unlock(&mu); }
static void fork_child(void) {
    watcher = 0;
    memset(pend, 0, sizeof pend);
    pthread_mutex_unlock(&mu);
}

/* i915's ioctl names, from the header (DRM_COMMAND_BASE + nr) */
#define N(x) [DRM_I915_##x] = #x
static const char *I915[0x40] = {
    N(GETPARAM), N(SETPARAM), N(GEM_EXECBUFFER), N(GEM_BUSY), N(GEM_THROTTLE), N(GEM_CREATE),
    N(GEM_PREAD), N(GEM_PWRITE), N(GEM_MMAP), N(GEM_SET_DOMAIN), N(GEM_SW_FINISH), N(GEM_SET_TILING),
    N(GEM_GET_TILING), N(GEM_GET_APERTURE), N(GEM_MMAP_GTT), N(GEM_MADVISE), N(GEM_EXECBUFFER2),
    N(GEM_WAIT), N(GEM_CONTEXT_CREATE), N(GEM_CONTEXT_DESTROY), N(GEM_SET_CACHING), N(GEM_GET_CACHING),
    N(REG_READ), N(GET_RESET_STATS), N(GEM_USERPTR), N(GEM_CONTEXT_GETPARAM), N(GEM_CONTEXT_SETPARAM),
    N(PERF_OPEN), N(PERF_ADD_CONFIG), N(PERF_REMOVE_CONFIG),
    [0x39] = "QUERY(0x39: GEM_GVTBUFFER on the unit's IOTG kernel)",
};
static const char *core(unsigned nr) {
    switch (nr) {
    case 0x00: return "VERSION";
    case 0x01: return "GET_UNIQUE";
    case 0x02: return "GET_MAGIC";
    case 0x0c: return "GET_CAP";
    case 0x0d: return "SET_CLIENT_CAP";
    case 0x09: return "GEM_CLOSE";
    case 0x0a: return "GEM_FLINK";
    case 0x0b: return "GEM_OPEN";
    case 0x2d: return "PRIME_HANDLE_TO_FD";
    case 0x2e: return "PRIME_FD_TO_HANDLE";
    case 0xbf: return "SYNCOBJ_CREATE";
    case 0xc0: return "SYNCOBJ_DESTROY";
    case 0xc1: return "SYNCOBJ_HANDLE_TO_FD";
    case 0xc2: return "SYNCOBJ_FD_TO_HANDLE";
    case 0xc3: return "SYNCOBJ_WAIT";
    case 0xc4: return "SYNCOBJ_RESET";
    case 0xc5: return "SYNCOBJ_SIGNAL";
    default: return NULL;
    }
}

/* the calls worth keeping after CRUMB_ALL lines: the ones a GPU hang holds */
static int may_hang(unsigned nr) {
    return nr == DRM_COMMAND_BASE + DRM_I915_GEM_EXECBUFFER2 || nr == DRM_COMMAND_BASE + DRM_I915_GEM_WAIT ||
           nr == DRM_COMMAND_BASE + DRM_I915_GEM_CONTEXT_CREATE || nr == DRM_COMMAND_BASE + DRM_I915_GEM_CONTEXT_DESTROY ||
           nr == DRM_COMMAND_BASE + DRM_I915_GEM_SET_DOMAIN || nr == DRM_COMMAND_BASE + DRM_I915_GEM_BUSY || nr == 0xc3;
}

static void detail(unsigned nr, void *arg, int after, char *out, size_t cap) {
    out[0] = 0;
    if (!arg) return;
    switch (nr - DRM_COMMAND_BASE) {
    case DRM_I915_GETPARAM: {
        drm_i915_getparam_t *g = arg;
        if (after && g->value) snprintf(out, cap, " param %d -> %d", g->param, *g->value);
        else snprintf(out, cap, " param %d", g->param);
        break;
    }
    case DRM_I915_GEM_CONTEXT_GETPARAM:
    case DRM_I915_GEM_CONTEXT_SETPARAM: {
        struct drm_i915_gem_context_param *p = arg;
        snprintf(out, cap, " ctx %u param %#llx value %#llx", p->ctx_id, (unsigned long long)p->param, (unsigned long long)p->value);
        break;
    }
    case DRM_I915_GEM_EXECBUFFER2: {
        /* and the buffers: how many softpinned (EXEC_OBJECT_PINNED) and
         * 48-bit, the highest address, relocations */
        struct drm_i915_gem_execbuffer2 *e = arg;
        struct drm_i915_gem_exec_object2 *o = (void *)(uintptr_t)e->buffers_ptr;
        unsigned pinned = 0, b48 = 0, relocs = 0;
        unsigned long long top = 0;
        for (unsigned i = 0; o && i < e->buffer_count; i++) {
            pinned += !!(o[i].flags & EXEC_OBJECT_PINNED);
            b48 += !!(o[i].flags & EXEC_OBJECT_SUPPORTS_48B_ADDRESS);
            relocs += o[i].relocation_count;
            if (o[i].offset > top) top = o[i].offset;
        }
        snprintf(out, cap, " ctx %llu buffers %u batch_len %u flags %#llx pinned %u 48b %u relocs %u top %#llx",
                 (unsigned long long)(e->rsvd1 & 0xffffffff), e->buffer_count, e->batch_len, (unsigned long long)e->flags,
                 pinned, b48, relocs, top);
        break;
    }
    case DRM_I915_GEM_CREATE: {
        struct drm_i915_gem_create *c = arg;
        snprintf(out, cap, " size %llu handle %u", (unsigned long long)c->size, c->handle);
        break;
    }
    case DRM_I915_GEM_WAIT: {
        struct drm_i915_gem_wait *w = arg;
        snprintf(out, cap, " handle %u timeout %lld", w->bo_handle, (long long)w->timeout_ns);
        break;
    }
    case DRM_I915_GEM_CONTEXT_CREATE: {
        struct drm_i915_gem_context_create *c = arg;
        if (after) snprintf(out, cap, " ctx %u", c->ctx_id);
        break;
    }
    }
    if (nr == 0x0c) {   /* GET_CAP */
        struct drm_get_cap *c = arg;
        snprintf(out, cap, " cap %llu%s%llu", (unsigned long long)c->capability, after ? " -> " : "", after ? (unsigned long long)c->value : 0ULL);
        if (!after) out[strlen(out) - 1] = 0;
    }
}

typedef int (*ioctl_fn)(int, unsigned long, ...);

int ioctl(int fd, unsigned long req, ...) {
    static ioctl_fn real;
    if (!real) real = (ioctl_fn)dlsym(RTLD_NEXT, "ioctl");
    va_list ap;
    va_start(ap, req);
    void *arg = va_arg(ap, void *);
    va_end(ap);
    if (_IOC_TYPE(req) != DRM_IOCTL_BASE || cfd() < 0) return real(fd, req, arg);
    unsigned nr = _IOC_NR(req);
    const char *name = nr >= DRM_COMMAND_BASE && nr < DRM_COMMAND_BASE + 0x40 ? I915[nr - DRM_COMMAND_BASE] : core(nr);
    char nm[32], d[300];
    if (!name) { snprintf(nm, sizeof nm, "nr %#x", nr); name = nm; }
    /* watch mode, past the process's first lines: kept in memory, written by
     * our thread only if the call doesn't come back */
    if (watch_mode() && lines >= WATCH_SYNC) {
        static int said;
        if (!said) { said = 1; vk_crumb("crumbs: from here a call is written only when it is not back in %d ms", WATCH_LATE_MS); }
        if (!may_hang(nr)) return real(fd, req, arg);
        detail(nr, arg, 0, d, sizeof d);
        int slot = -1;
        long t0 = now_ms();
        pthread_mutex_lock(&mu);
        int n = ring_putf("> %s fd %d%s", name, fd, d);
        for (int i = 0; i < PEND && slot < 0; i++) if (!pend[i].start) slot = i;
        if (slot >= 0 && n) {
            /* the line as kept, without its own time and pid: the report has them */
            const char *l = ring[(ring_n - 1) % RING], *p = memchr(l, '>', n);
            pend[slot].len = p ? (int)(n - (p - l) - 1) : 0;   /* less the newline */
            if (p) memcpy(pend[slot].line, p, pend[slot].len);
            pend[slot].said = 0;
            pend[slot].start = t0;
        }
        watch_start();
        pthread_mutex_unlock(&mu);
        int r = real(fd, req, arg);
        int e = errno;
        detail(nr, arg, r >= 0, d, sizeof d);
        pthread_mutex_lock(&mu);
        int late = slot >= 0 && pend[slot].said;
        if (slot >= 0) pend[slot].start = 0;
        if (r < 0) ring_putf("< %s = -1 %s%s%s", name, strerror(e), d, late ? ", back" : "");
        else ring_putf("< %s = %d%s%s", name, r, d, late ? ", back" : "");
        if (late) { ring_putf("! back after %ld ms: %s", now_ms() - t0, name); ring_flush(); }
        pthread_mutex_unlock(&mu);
        errno = e;
        return r;
    }
    int keep = lines < CRUMB_ALL || may_hang(nr);
    if (keep) { detail(nr, arg, 0, d, sizeof d); vk_crumb("> %s fd %d%s", name, fd, d); }
    int r = real(fd, req, arg);
    int e = errno;
    if (keep) {
        detail(nr, arg, r >= 0, d, sizeof d);   /* a failed call wrote no answer */
        if (r < 0) vk_crumb("< %s = -1 %s%s", name, strerror(e), d);
        else vk_crumb("< %s = %d%s", name, r, d);
    }
    errno = e;
    return r;
}

/* ---- the display node guard ---------------------------------------------- */

static int refused(const char *path) {
    if (!path || strncmp(path, "/dev/dri/card", 13)) return 0;
    vk_crumb("! refused open %s (the display node: Winston's)", path);
    errno = EACCES;
    return 1;
}

#define OPENER(fn)                                                             \
    int fn(const char *path, int flags, ...) {                                 \
        static int (*real)(const char *, int, ...);                            \
        if (!real) real = (int (*)(const char *, int, ...))dlsym(RTLD_NEXT, #fn); \
        mode_t mode = 0;                                                       \
        if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap); } \
        if (refused(path)) return -1;                                          \
        int r = real(path, flags, mode);                                       \
        if (!strncmp(path, "/dev/dri/", 9)) vk_crumb("open %s = %d", path, r); \
        return r;                                                              \
    }
OPENER(open)
OPENER(open64)

/* what _FORTIFY_SOURCE builds call for open() without O_CREAT */
int __open_2(const char *path, int flags) {
    static int (*real)(const char *, int);
    if (!real) real = (int (*)(const char *, int))dlsym(RTLD_NEXT, "__open_2");
    if (refused(path)) return -1;
    int r = real(path, flags);
    if (!strncmp(path, "/dev/dri/", 9)) vk_crumb("open %s = %d", path, r);
    return r;
}

#define OPENAT(fn)                                                             \
    int fn(int dfd, const char *path, int flags, ...) {                        \
        static int (*real)(int, const char *, int, ...);                       \
        if (!real) real = (int (*)(int, const char *, int, ...))dlsym(RTLD_NEXT, #fn); \
        mode_t mode = 0;                                                       \
        if (flags & (O_CREAT | O_TMPFILE)) { va_list ap; va_start(ap, flags); mode = va_arg(ap, int); va_end(ap); } \
        if (refused(path)) return -1;                                          \
        int r = real(dfd, path, flags, mode);                                  \
        if (!strncmp(path, "/dev/dri/", 9)) vk_crumb("open %s = %d", path, r); \
        return r;                                                              \
    }
OPENAT(openat)
OPENAT(openat64)

__attribute__((constructor)) static void hello(void) {
    if (cfd() < 0) return;
    vk_crumb("crumbs: pid %d%s", (int)getpid(), watch_mode() ? " (watch)" : "");
    if (watch_mode()) pthread_atfork(fork_prepare, fork_parent, fork_child);
}
