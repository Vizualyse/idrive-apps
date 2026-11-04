/*
 * hook111: add the CarPlay alternate screen (stream 111) to libNmeCarPlay.so
 * of carplay 20.40.2, by driving the library's own Apple AirPlay receiver code
 * for a second screen (re/findings-20.40.2.md).
 *
 *  SETUP   AirPlayReceiverSessionSetup (0x180670) is wrapped: the stock code
 *          runs first (it logs and skips a type-111 stream); then each 111
 *          stream gets a second screen object, its key (same helpers as 110),
 *          a listener, and a {type:111, dataPort} entry in the response. A
 *          request offering "altScreen"/"viewAreas" gets them back in
 *          "enabledFeatures".
 *  /info   AirPlayServerCopyProperty (0x10d270) is wrapped: "displays" gets a
 *          second record (struct hook111_display). With a safe area
 *          (hook111_safearea_file) it also gets viewAreas, and SETUP
 *          answers viewAreas.
 *  TEARDOWN AirPlayReceiverSessionTearDown (0x17e840) is wrapped: a 111
 *          stream, or the whole session, takes screen B down first.
 *  idle    _ControlIdleStateTransition (0x17c0e0) is wrapped: while screen B
 *          is up the session counts as having a screen, so it stays active
 *          (timing running, no keep-alive timeout) without a stream 110.
 *  commands AirPlayReceiverSessionControl (0x183bf0) is wrapped: the phone's
 *          suggestUI is logged, not answered. hook111_send_command sends any
 *          command the library's own way; while screen B streams, the
 *          consumer's scene URL goes as showUI, its view area as
 *          updateViewArea and its zoom requests as changeMapZoomLevel.
 *  frames  The four ScreenStream functions are replaced by equivalents: calls
 *          for screen B's context go to the sink; all others do what the stock
 *          code does.
 *
 * Addresses are Ghidra's (image base 0x100000) and valid only for the build-id
 * below; hook111_install checks it and every patched prologue before writing.
 */
#define _GNU_SOURCE
#include "hook111.h"
#include "annexb.h"   /* annexb_avcc_size: the size the phone really sends */
#include <elf.h>
#include <errno.h>
#include <time.h>
#include <link.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/syscall.h>
static long gettid_(void) { return syscall(SYS_gettid); }

static const char BUILD_ID[] = "8e502fa40b7fbfb79c36acdd9905da6a1d000254";
static uintptr_t base;
#define AT(a) ((void *)(base + (uintptr_t)(a) - 0x100000))
#define FN(type, a) ((type)AT(a))
volatile struct hook111_stats hook111_stats;
static const struct hook111_sink *sink;
static struct hook111_display disp;

/* ---- the library's CoreFoundation-like API ---- */
typedef void *CF;
#define CFDictCreate()        FN(CF (*)(void *, long, void *, void *), 0x134280)(NULL, 0, AT(0x3dbb60), AT(0x3dbb20))
#define CFDictSet(d, k, v)    FN(void (*)(CF, CF, CF), 0x136a90)(d, k, v)
#define CFDictSetI64(d, k, v) FN(int (*)(CF, CF, int64_t), 0x141050)(d, k, v)
#define CFDictGetI64(d, k, e) FN(int64_t (*)(CF, CF, int *), 0x13f7d0)(d, k, e)
#define CFDictGetTyped(d, k, t, e) FN(CF (*)(CF, CF, unsigned, int *), 0x13f970)(d, k, t, e)
#define CFArrayTypeID()       FN(unsigned (*)(void), 0x135940)()
#define CFDictTypeID()        FN(unsigned (*)(void), 0x136710)()
#define CFStrTypeID()         FN(unsigned (*)(void), 0x137b60)()
#define CFTypeOf(o)           FN(unsigned (*)(CF), 0x133670)(o)
#define CFArrayCreate()       FN(CF (*)(void *, long, void *), 0x1338b0)(NULL, 0, AT(0x3dbba0))
#define CFArrayAppend(a, v)   FN(void (*)(CF, CF), 0x135dc0)(a, v)
#define CFArrayCount(a)       FN(int (*)(CF), 0x133950)(a)
#define CFArrayAt(a, i)       FN(CF (*)(CF, long), 0x133a80)(a, i)
#define CFArrayIndexOf(a, v)  FN(int (*)(CF, uint64_t, CF), 0x1339a0)(a, (uint64_t)(uint32_t)CFArrayCount(a) << 32, v)
#define CFNumI64(v)           FN(CF (*)(int64_t), 0x13fab0)(v)
#define CFRelease(o)          FN(void (*)(CF), 0x1356d0)(o)
#define CFEqual(a, b)         FN(char (*)(CF, CF), 0x1357c0)(a, b)
static CF CFStr(const char *s) {
    return FN(CF (*)(void *, const char *, long, unsigned, int), 0x1345f0)(NULL, s, (long)strlen(s), 0x8000100, 0);
}
/* constant keys in the library (Cinemo constant strings: 8-byte header + text) */
#define K_STREAMS  AT(0x1b80d6)
#define K_TYPE     AT(0x1b812b)
#define K_DATAPORT AT(0x1b8252)
#define K_CONNID   AT(0x1b8190)
#define K_FEATURES AT(0x1a0aa8)  /* "features" */
#define K_PARAMS   AT(0x1b65e8)  /* "params" (a /command body) */
#define K_URL      AT(0x1b835c)  /* "url" (requestUI's) */
#define K_DISPLAYS AT(0x1a0b89)  /* the /info property name CopyProperty compares */
#define K_UUID     AT(0x1a0a20)
#define K_MAXFPS   AT(0x1a0ab9)
#define K_HPX      AT(0x1a0ac8)
#define K_HMM      AT(0x1a0add)
#define K_WPX      AT(0x1a0af4)
#define K_WMM      AT(0x1a0b08)

/* ---- patching ---- */
static int write_code(void *at, const void *bytes, size_t n) {
    uintptr_t page = (uintptr_t)at & ~(uintptr_t)0xfff;
    size_t len = ((uintptr_t)at + n - page + 0xfff) & ~(size_t)0xfff;
    if (mprotect((void *)page, len, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) return -1;
    memcpy(at, bytes, n);
    __builtin___clear_cache((char *)at, (char *)at + n);
    return mprotect((void *)page, len, PROT_READ | PROT_EXEC);
}
static void jmp_abs(unsigned char out[14], void *to) {  /* jmp [rip+0]; dq to (no register used) */
    out[0] = 0xff; out[1] = 0x25; memset(out + 2, 0, 4); memcpy(out + 6, &to, 8);
}
static int patch_entry(uintptr_t ghidra, const unsigned char *expect, size_t nexpect, void *to) {
    unsigned char *at = AT(ghidra), j[14];
    if (memcmp(at, expect, nexpect) != 0) return -1;
    jmp_abs(j, to);
    return write_code(at, j, 14);
}
/* a trampoline: the relocated prologue, then a jump back after it */
static void *make_tramp(const unsigned char *code, size_t n, uintptr_t resume_ghidra) {
    unsigned char *t = mmap(NULL, 4096, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (t == MAP_FAILED) return NULL;
    memcpy(t, code, n);
    jmp_abs(t + n, AT(resume_ghidra));
    mprotect(t, 4096, PROT_READ | PROT_EXEC);
    return t;
}

static void status_now(int force);   /* the status file, below */
static void ui_reset(void);           /* the scene and view area, sent again for a new stream (below) */
static char offered_display[32];     /* WxH@fps of the last /info record, for the status */

/* ---- screen B: the second screen object and its thread ----
 * One at a time. Its life follows the stock screen's (_ScreenStart 0x17a480,
 * _ScreenThread 0x17a530, _ScreenTearDown 0x179c40):
 *  - created by a SETUP with a type-111 stream (a repeat SETUP replaces it);
 *  - torn down by TEARDOWN {streams:[{type:111}]} or by a full TEARDOWN (no
 *    streams: also what the connection's close 0x174680 and a failed SETUP
 *    do), always before the stock code frees the session clock (+0x1b18) that
 *    the delegate callbacks read;
 *  - its object is finalized before current_b is cleared: finalize stops the
 *    ScreenStream, and that call must still reach our sink, never Cinemo's. */
struct screen_b {
    void *session, *obj, *ns;
    int lfd, wake[2];       /* wake: teardown -> a pending accept */
    pthread_t thread;
    int have_thread;
    pthread_mutex_t lock;   /* quit / started / ns, between the thread and teardown */
    int quit, started;
};
static struct screen_b *volatile current_b;  /* its address is also its ScreenStream context */
static pthread_mutex_t b_life = PTHREAD_MUTEX_INITIALIZER;  /* SETUP / TEARDOWN */

static int is_b_ctx(void *ctx) { return ctx && ctx == (void *)current_b; }

/* The stock accept helper (0x156a80) can't be woken: after shutdown() its
 * select reports the listener readable, accept fails, and it retries,
 * spinning at timeout 0 once under a second is left. So screen B selects on
 * the listener and a wake pipe, then sets up the socket as the helper does
 * (non-blocking 0x1568e0, TCP_NODELAY). */
static int accept_b(struct screen_b *b, int seconds, int *out) {
    struct timespec end; clock_gettime(CLOCK_MONOTONIC, &end); end.tv_sec += seconds;
    for (;;) {
        struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
        long ms = (end.tv_sec - now.tv_sec) * 1000 + (end.tv_nsec - now.tv_nsec) / 1000000;
        if (ms <= 0) return -6722;                                   /* kTimeoutErr, as the helper */
        fd_set r; FD_ZERO(&r); FD_SET(b->lfd, &r); FD_SET(b->wake[0], &r);
        struct timeval tv = { ms / 1000, (ms % 1000) * 1000 };
        int n = select((b->lfd > b->wake[0] ? b->lfd : b->wake[0]) + 1, &r, NULL, NULL, &tv);
        if (n < 0 && errno == EINTR) continue;
        if (n < 0) return errno ? errno : -6700;
        if (FD_ISSET(b->wake[0], &r)) return -6723;                  /* kCanceledErr */
        if (n == 0 || !FD_ISSET(b->lfd, &r)) continue;
        int fd = accept(b->lfd, NULL, NULL);
        if (fd < 0) { if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR || errno == ECONNABORTED) continue; return errno; }
        FN(void (*)(int, int), 0x1568e0)(fd, 1);
        int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
        *out = fd;
        return 0;
    }
}

static void *screen_b_thread(void *arg) {
    struct screen_b *b = arg;
    int fd = -1, rc;
    rc = accept_b(b, 10, &fd);
    if (rc != 0) goto done;
    pthread_mutex_lock(&b->lock);
    if (b->quit) { pthread_mutex_unlock(&b->lock); close(fd); rc = -6723; goto done; }
    hook111_stats.accepted++;
    status_now(1);
    FN(int (*)(void **, int), 0x156a20)(&b->ns, fd);
    pthread_mutex_unlock(&b->lock);
    FN(void (*)(int, int), 0x157350)(FN(int (*)(void *), 0x155aa0)(b->ns), 0xc);
    /* stock delegate: the session and its clock callbacks (both read only
     * session+0x1b18); the stream context is ours */
    void *delegate[3] = { b->session, AT(0x17a7a0), AT(0x17a790) };
    FN(void (*)(void *, void **), 0x185490)(b->obj, delegate);
    pthread_mutex_lock(&b->lock);
    rc = b->quit ? -6723 : FN(int (*)(void *, void *), 0x185ef0)(b->obj, b);
    if (rc == 0) b->started = 1;            /* from here 'q' on the command socket reaches the pump */
    pthread_mutex_unlock(&b->lock);
    if (rc == 0) {
        int timeout = *(int *)(*(char **)((char *)b->session + 0x10) + 0xac);
        rc = FN(int (*)(void *, void *, int), 0x1855d0)(b->obj, b->ns, timeout);
    }
    FN(void (*)(void *), 0x185360)(b->obj);   /* as the stock thread: the stream ended, stop it (idempotent) */
done:
    hook111_stats.pump_rc = rc;
    hook111_stats.pump_done = 1;
    status_now(1);
    return NULL;
}

/* with b_life held */
static void teardown_b(struct screen_b *b) {
    pthread_mutex_lock(&b->lock);
    b->quit = 1;
    if (b->started) FN(int (*)(void *, int, void *, long), 0x185f90)(b->obj, 'q', NULL, 0);
    if (b->ns) FN(int (*)(void *), 0x155ac0)(b->ns);   /* cancels reads in the pump */
    pthread_mutex_unlock(&b->lock);
    if (write(b->wake[1], "q", 1) != 1) { /* the pipe is ours and empty: cannot fail */ }
    if (b->have_thread) pthread_join(b->thread, NULL);
    FN(void (*)(void *), 0x185360)(b->obj);             /* stops the ScreenStream: sink stop */
    current_b = NULL;
    FN(void (*)(void *), 0x1853f0)(b->obj);
    if (b->ns) FN(int (*)(void *), 0x1559e0)(b->ns);
    if (b->lfd >= 0) close(b->lfd);
    close(b->wake[0]); close(b->wake[1]);
    pthread_mutex_destroy(&b->lock);
    free(b);
    hook111_stats.teardowns++;
    status_now(1);
}

/* the type-111 branch: the stock 110 branch's steps for a second screen; with b_life held */
static int setup_111(void *session, CF stream, CF resp) {
    if (current_b) teardown_b(current_b);   /* a repeat SETUP: the old stream is gone */
    struct screen_b *b = calloc(1, sizeof *b);
    if (!b) return -6728;
    b->session = session; b->lfd = -1;
    if (pipe(b->wake) != 0) { free(b); return -6700; }
    FN(void (*)(int, int), 0x1568e0)(b->wake[0], 1);
    pthread_mutex_init(&b->lock, NULL);
    int rc = FN(int (*)(void **), 0x185440)(&b->obj);
    if (rc) { b->obj = NULL; goto fail; }
    FN(int (*)(void *, CF), 0x185570)(b->obj, stream);
    int err = 0;
    uint64_t cid = (uint64_t)CFDictGetI64(stream, K_CONNID, &err);
    if (err) { rc = err; goto fail; }
    if (*(void **)((char *)session + 0x498)) {   /* pair-verify: HKDF, ChaCha20-Poly1305 */
        unsigned char key[32];
        rc = FN(int (*)(void *, uint64_t, void *, long, void *), 0x17df90)((char *)session + 0x498, cid, NULL, 0, key);
        if (!rc) rc = FN(int (*)(void *, void *, long), 0x1854c0)(b->obj, key, 32);
        memset(key, 0, sizeof key);
    } else {                                     /* AirPlayStreamKey/IV, AES-CTR */
        unsigned char key[16], iv[16];
        FN(void (*)(void *, long, uint64_t, void *, void *), 0x187690)((char *)session + 0x288, 0x10, cid, key, iv);
        FN(void (*)(void *, void *, void *), 0x185510)(b->obj, key, iv);
        memset(key, 0, sizeof key); memset(iv, 0, sizeof iv);
        rc = 0;
    }
    if (rc) goto fail;
    int port = 0;
    rc = FN(int (*)(int, int, int, int, int *, int, int *), 0x1579c0)(
        *(uint16_t *)((char *)session + 0x100), 1, 6, -disp.port, &port, (int)0xfff73334, &b->lfd);
    if (rc) goto fail;
    CF entry = CFDictCreate();
    CFDictSetI64(entry, K_TYPE, 111);
    CFDictSetI64(entry, K_DATAPORT, port);
    rc = FN(int (*)(CF, CF), 0x17cb00)(resp, entry);
    CFRelease(entry);
    if (rc) goto fail;
    hook111_stats.pump_done = 0;
    current_b = b;
    ui_reset();
    if (pthread_create(&b->thread, NULL, screen_b_thread, b) != 0) { current_b = NULL; rc = -6700; goto fail; }
    b->have_thread = 1;
    hook111_stats.setups_111++;
    status_now(1);
    return 0;
fail:
    if (b->obj) FN(void (*)(void *), 0x1853f0)(b->obj);
    if (b->lfd >= 0) close(b->lfd);
    close(b->wake[0]); close(b->wake[1]);
    pthread_mutex_destroy(&b->lock);
    free(b);
    return rc;
}

/* ---- the session's idle state: screen B counts as a screen ----
 * _ControlIdleStateTransition (0x17c0e0) takes the session as idle when it has
 * no main audio (+0x4a8), no alt audio (+0xdc0) and no screen (+0x1cc8, set
 * only by the stock 110 SETUP). Idle, it stops timing and starts the
 * keep-alive receiver (0x17a7b0), which ends the session after 30 s without a
 * beacon on the keepAlivePort. The phone sends beacons only when it is idle
 * itself, and streaming 111 it isn't: on the unit (2026-11-04) every session
 * with 111 as its only stream ended ~40 s after the last stock stream.
 * So while screen B is up the transition runs with +0x1cc8 set, for the call
 * only: the flag also makes a 110 SETUP fail (-6719), and the stock screen
 * teardown clears it. The stock callers are the ends of SETUP and TEARDOWN;
 * the hook adds one after a 111 SETUP. A TEARDOWN {111} takes screen B down
 * before the stock code runs, so its transition goes idle again.
 * On the control thread, never called with b_life held. */
static int (*orig_idle)(void *session, CF resp);
static int my_idle(void *session, CF resp) {
    pthread_mutex_lock(&b_life);
    struct screen_b *b = current_b;
    char *screen = (char *)session + 0x1cc8;
    int held = b && b->session == session && !*screen;
    if (held) *screen = 1;
    int rc = orig_idle(session, resp);
    if (held) {
        *screen = 0;
        hook111_stats.idle_held++;
        hook111_stats.idle_rc = rc;
    }
    pthread_mutex_unlock(&b_life);
    return rc;
}

/* ---- the plist log, for the first car runs ----
 * Each plist as it is (the library's own binary-plist writer, 0x139750: a
 * malloc'd buffer), one file each: <dir>/<nnn>-<what>.bplist, at most
 * LOG_MAX. Off unless hook111_log_to names a writable directory. */
#define LOG_MAX 500
static char log_dir[256];
static volatile int log_n;
void hook111_log_to(const char *dir) {
    log_dir[0] = 0;
    if (dir && *dir && strlen(dir) < sizeof log_dir - 40 && access(dir, W_OK) == 0) strcpy(log_dir, dir);
}
static void log_plist(const char *what, CF obj) {
    if (!log_dir[0] || !obj) return;
    int n = __sync_fetch_and_add(&log_n, 1);
    if (n >= LOG_MAX) return;
    size_t len = 0;
    void *b = FN(void *(*)(CF, size_t *, int *), 0x139750)(obj, &len, NULL);
    if (!b) return;
    char p[sizeof log_dir + 48];
    snprintf(p, sizeof p, "%s/%03d-%s.bplist", log_dir, n, what);
    int fd = open(p, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0644);
    if (fd >= 0) {
        const char *c = b; size_t left = len;
        while (left) { ssize_t k = write(fd, c, left); if (k <= 0) break; c += k; left -= (size_t)k; }
        close(fd);
        hook111_stats.logged++;
    }
    free(b);
}
/* a command with its name: {type, params}. The phone sends iAPSendMessage
 * and updateFeedback every second or so (212 in a few minutes on the unit):
 * only the first NOISY_MAX of each go in, so they don't use up the log. */
#define NOISY_MAX 3
static void log_command(const char *what, CF cmd, CF params) {
    if (!log_dir[0]) return;
    static CF noisy[2]; static int noisy_n[2];
    if (!noisy[0]) { noisy[0] = CFStr("iAPSendMessage"); noisy[1] = CFStr("updateFeedback"); }
    for (int k = 0; k < 2; k++)
        if (cmd && CFEqual(cmd, noisy[k]) && __sync_fetch_and_add(&noisy_n[k], 1) >= NOISY_MAX) return;
    CF d = CFDictCreate();
    if (cmd) CFDictSet(d, K_TYPE, cmd);
    if (params) CFDictSet(d, K_PARAMS, params);
    log_plist(what, d);
    CFRelease(d);
}

/* ---- the mode, and falling back when the phone refuses ----
 * off  pass-through: the stock answers, no stream 111
 * alt  enabledFeatures [altScreen], the second /info display, stream 111
 * full enabledFeatures [altScreen, viewAreas], the same
 * Read from hook111_mode_file at every SETUP and /info, so it can change
 * between the phone's attempts. With no file configured (the harness) it is
 * full; with one configured but missing, off.
 *
 * A session that got our features and then ends in a full TEARDOWN with no
 * stream SETUP is a refusal: on the unit (2026-11-04) the phone did exactly
 * that, every 10 s, with "connection failed" on the screen. After FALLBACK_AFTER
 * refusals in a row the hook is off for the rest of this carplay run, and
 * says so in <log dir>/fallback. A session with a stream SETUP resets it. */
enum { MODE_OFF, MODE_ALT, MODE_FULL };
static const char *mode_names[] __attribute__((unused)) = { "off", "alt", "full" };   /* the preload prints it */
#define FALLBACK_AFTER 3
static char mode_path[256];
static volatile int fallback;
static int refusals;
static void *adv_session;   /* the session our features went to, until its TEARDOWN */
static int adv_streams;     /* it had a stream SETUP */
static pthread_mutex_t mode_lock = PTHREAD_MUTEX_INITIALIZER;

void hook111_mode_file(const char *path) {
    mode_path[0] = 0;
    if (path && strlen(path) < sizeof mode_path) strcpy(mode_path, path);
}
static int read_mode(void) {
    if (fallback) return MODE_OFF;
    if (!mode_path[0]) return MODE_FULL;
    char b[16] = ""; int fd = open(mode_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return MODE_OFF;
    ssize_t n = read(fd, b, sizeof b - 1); close(fd);
    if (n <= 0) return MODE_OFF;
    b[n] = 0;
    if (!strncmp(b, "full", 4)) return MODE_FULL;
    if (!strncmp(b, "alt", 3)) return MODE_ALT;
    return MODE_OFF;
}
int hook111_mode(void) { return read_mode(); }

/* ---- the second display's size, per target ----
 * The phone draws the second screen at the size /info advertises, and reads
 * /info at each connection. A consumer (vizualyse-cast) writes the size its
 * target wants to hook111_display_file as "WxH@fps" (1088x480@30 for the
 * cluster map, 1056x384@30 for the HUD); every /info takes it, if valid:
 * 320-1920 wide in steps of 8, 160-1080 high and even, 1-60 fps. The physical
 * size scales with it at the configured pixel density. Otherwise, or with no
 * file, the configured display. */
static char display_path[256];
void hook111_display_file(const char *path) {
    display_path[0] = 0;
    if (path && strlen(path) < sizeof display_path) strcpy(display_path, path);
}
static void display_now(int *w, int *h, int *fps) {
    *w = disp.width_px; *h = disp.height_px; *fps = disp.max_fps;
    if (!display_path[0]) return;
    char b[40] = ""; int fd = open(display_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return;
    ssize_t n = read(fd, b, sizeof b - 1); close(fd);
    if (n <= 0) return;
    b[n] = 0;
    int W, H, F; char end = 0;
    if (sscanf(b, "%dx%d@%d%c", &W, &H, &F, &end) < 3 || (end && end != '\n')) return;
    if (W < 320 || W > 1920 || W % 8 || H < 160 || H > 1080 || H % 2 || F < 1 || F > 60) return;
    *w = W; *h = H; *fps = F;
}
/* ---- trial files: <trial dir>/features, info-a.plist, info-b.plist, unfallback ----
 * For finding the view-area records on the car without a rebuild, read at
 * every SETUP and /info (the phone reads /info when it connects):
 *  features      names (space or newline separated) answered in
 *                enabledFeatures when the phone offers them; replaces the
 *                mode's list (alt: altScreen; full: altScreen viewAreas)
 *  info-b.plist  a plist array [key, value, key, value, ...] merged into the
 *                second display's /info record (viewAreas, initialViewArea...)
 *  info-a.plist  the same, into the main display's record
 *  unfallback    removed when seen: clears a fallback to off (refused
 *                sessions), so a bad trial doesn't end the run
 * The record format the phone accepts, from the Audi MU0678 work
 * (joeyQuery/MHI2-altScreen): viewAreas [{widthPixels, heightPixels,
 * originXPixels, originYPixels, drawUIOutsideSafeArea, viewAreaTransitionControl,
 * safeArea {widthPixels, heightPixels, originXPixels, originYPixels}}],
 * initialViewArea 0, with viewAreas in enabledFeatures. */
static char trial_dir[200];
void hook111_trial_dir(const char *dir) {
    trial_dir[0] = 0;
    if (dir && strlen(dir) < sizeof trial_dir) strcpy(trial_dir, dir);
}
static int trial_path(char *p, size_t n, const char *name) {
    if (!trial_dir[0]) return 0;
    snprintf(p, n, "%s/%s", trial_dir, name);
    return 1;
}
static CF trial_plist(const char *name) {
    char p[sizeof trial_dir + 32];
    if (!trial_path(p, sizeof p, name)) return NULL;
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return NULL;
    static unsigned char buf[1 << 16];
    ssize_t n = read(fd, buf, sizeof buf); close(fd);
    if (n <= 0 || n == (ssize_t)sizeof buf) return NULL;
    int err = 0;
    CF o = FN(CF (*)(const void *, size_t, int *), 0x13a550)(buf, (size_t)n, &err);
    if (o && (err || CFTypeOf(o) != CFArrayTypeID())) { CFRelease(o); return NULL; }
    return o;
}
/* [key, value, ...] into dict: the number of keys set */
static int merge_pairs(CF dict, CF arr) {
    if (!dict || !arr) return 0;
    int n = CFArrayCount(arr), set = 0;
    for (int i = 0; i + 1 < n; i += 2) {
        CF k = CFArrayAt(arr, i);
        if (k && CFTypeOf(k) == CFStrTypeID()) { CFDictSet(dict, k, CFArrayAt(arr, i + 1)); set++; }
    }
    return set;
}
static char trial_features_text[160];
/* the trial feature list, or NULL without the file */
static const char *trial_features(void) {
    char p[sizeof trial_dir + 32];
    if (!trial_path(p, sizeof p, "features")) return NULL;
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return NULL;
    ssize_t n = read(fd, trial_features_text, sizeof trial_features_text - 1); close(fd);
    trial_features_text[n > 0 ? n : 0] = 0;
    return trial_features_text;
}
static char answered_features[96];   /* for the status */

/* ---- the second display's view (its style) ----
 * Which of the phone's cluster views /info names as initialURL: "cluster"
 * (maps:/car/instrumentcluster, the map with the turn card in a corner),
 * "map" (.../map, the map alone) or "card" (.../instructioncard, the turn card
 * alone), from hook111_view_file, read at every /info like the size. Missing
 * or anything else: the configured initialURL. Whether the phone follows
 * initialURL is untested on the car (the main screen's showUI, the other way
 * to ask, cost the main screen). */
static const struct { const char *name, *url; } views[] = {
    { "cluster", "maps:/car/instrumentcluster" },
    { "map", "maps:/car/instrumentcluster/map" },
    { "card", "maps:/car/instrumentcluster/instructioncard" } };
static char view_path[256];
static char offered_view[16];        /* the view of the last /info record, for the status */
void hook111_view_file(const char *path) {
    view_path[0] = 0;
    if (path && strlen(path) < sizeof view_path) strcpy(view_path, path);
}
static const char *view_now(const char **name) {
    *name = "";
    if (!view_path[0]) return disp.initial_url;
    char b[16] = ""; int fd = open(view_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return disp.initial_url;
    ssize_t n = read(fd, b, sizeof b - 1); close(fd);
    if (n <= 0) return disp.initial_url;
    b[n] = 0;
    if (n > 0 && b[n - 1] == '\n') b[n - 1] = 0;
    for (unsigned i = 0; i < sizeof views / sizeof *views; i++)
        if (!strcmp(b, views[i].name)) { *name = views[i].name; return views[i].url; }
    return disp.initial_url;
}

/* ---- the second display's safe area: where the phone centres its view ----
 * hook111_safearea_file holds "x,y,w,h" in the pixels of the size /info
 * offers. With a valid one (inside that size, at least 64x64), /info's
 * second record gets one view area, the whole display, with that safe area,
 * and SETUP answers viewAreas besides altScreen (mode alt). Without one,
 * neither: as before. The phone needs both together; viewAreas without the
 * records made it refuse every session (2026-11-04, mode full).
 * On the car (2026-11-04, iOS 26.7.1, Google Maps, 936x480): safe area
 * 340x330 at 298,80 put the car and, above it, the directions card at the
 * centre; 600x400 at 168,40 moved the card into the area but left the car a
 * quarter of the way across it (Maps' route view). The record format is the
 * Audi MU0678 work's (joeyQuery/MHI2-altScreen). */
static char safearea_path[256];
static char offered_safearea[48];    /* x,y,w,h of the last /info record, for the status */
void hook111_safearea_file(const char *path) {
    safearea_path[0] = 0;
    if (path && strlen(path) < sizeof safearea_path) strcpy(safearea_path, path);
}
/* the safe area for a display of W x H: 1 and *x..*h, or 0 */
static int safearea_now(int W, int H, int *x, int *y, int *w, int *h) {
    if (!safearea_path[0]) return 0;
    char b[48] = ""; int fd = open(safearea_path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    ssize_t n = read(fd, b, sizeof b - 1); close(fd);
    if (n <= 0) return 0;
    b[n] = 0;
    char end = 0;
    if (sscanf(b, "%d,%d,%d,%d%c", x, y, w, h, &end) < 4 || (end && end != '\n')) return 0;
    return *x >= 0 && *y >= 0 && *w >= 64 && *h >= 64 && *x + *w <= W && *y + *h <= H;
}
/* CF false: the library's own, from parsing a binary plist [false] once */
static CF cf_false(void) {
    static CF arr;
    static const unsigned char BP[] = { 0x62,0x70,0x6c,0x69,0x73,0x74,0x30,0x30,0xa1,0x01,0x08,0x08,0x0a,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x02,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x0b };
    if (!arr) {
        int err = 0;
        CF a = FN(CF (*)(const void *, size_t, int *), 0x13a550)(BP, sizeof BP, &err);
        if (!a || err || CFTypeOf(a) != CFArrayTypeID() || CFArrayCount(a) != 1) { if (a) CFRelease(a); return NULL; }
        arr = a;   /* kept: its element is the constant */
    }
    return CFArrayAt(arr, 0);
}
static void set_rect(CF d, int x, int y, int w, int h) {
    CF n, k;
    k = CFStr("widthPixels");   n = CFNumI64(w); CFDictSet(d, k, n); CFRelease(n); CFRelease(k);
    k = CFStr("heightPixels");  n = CFNumI64(h); CFDictSet(d, k, n); CFRelease(n); CFRelease(k);
    k = CFStr("originXPixels"); n = CFNumI64(x); CFDictSet(d, k, n); CFRelease(n); CFRelease(k);
    k = CFStr("originYPixels"); n = CFNumI64(y); CFDictSet(d, k, n); CFRelease(n); CFRelease(k);
}
/* viewAreas [{the whole W x H, safeArea}] and initialViewArea 0 into rec: 1 if added */
/* a small text file into b (NUL-terminated, a trailing newline dropped): its length, or -1 */
static int read_small(const char *path, char *b, size_t n) {
    if (!path || !path[0]) return -1;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t r = read(fd, b, n - 1); close(fd);
    if (r < 0) return -1;
    b[r] = 0;
    while (r > 0 && (b[r - 1] == '\n' || b[r - 1] == '\r')) b[--r] = 0;
    return (int)r;
}

/* ---- the view area in use: 0 the safe area (centred), 1 Maps' own layout ----
 * hook111_viewarea_file holds "0" or "1" (missing or anything else: 0). It
 * picks initialViewArea at /info and, while screen B streams, a change is
 * sent as updateViewArea, which the phone applies at once (on the car,
 * 2026-11-04: the two layouts switched both ways with no reconnect). */
static char viewarea_path[256];
static int offered_viewareas;        /* this /info offered both view areas */
static int offered_va;               /* initialViewArea of the last /info */
static char ui_url_sent[512];        /* the scene URL the phone last took, this stream */
static volatile int ui_need = 1;     /* a new stream: send the URL again */
static int ui_va_sent;               /* the view area the phone is in */
void hook111_viewarea_file(const char *path) {
    viewarea_path[0] = 0;
    if (path && strlen(path) < sizeof viewarea_path) strcpy(viewarea_path, path);
}
static int viewarea_now(void) {
    char b[8];
    return read_small(viewarea_path, b, sizeof b) > 0 && !strcmp(b, "1") ? 1 : 0;
}
static CF view_area(int W, int H, int x, int y, int w, int h, CF no) {
    CF view = CFDictCreate(), safe = CFDictCreate(), k;
    set_rect(view, 0, 0, W, H);
    set_rect(safe, x, y, w, h);
    k = CFStr("drawUIOutsideSafeArea"); CFDictSet(view, k, no); CFRelease(k);
    k = CFStr("viewAreaTransitionControl"); CFDictSet(view, k, no); CFRelease(k);
    k = CFStr("safeArea"); CFDictSet(view, k, safe); CFRelease(k);
    CFRelease(safe);
    return view;
}
/* the view areas with the current safe area: [0] it, [1] the whole display
 * (Maps' own layout); initialViewArea from the view area file, and
 * adjacentViewAreas as the RGI project's MHI3 reference sends it ([] at 0,
 * [0] at 1). 1 if added. */
static int add_viewareas(CF rec, int W, int H) {
    int x, y, w, h;
    CF no = cf_false();
    offered_viewareas = 0;
    if (!safearea_now(W, H, &x, &y, &w, &h) || !no) { offered_safearea[0] = 0; return 0; }
    int initial = viewarea_now();
    offered_va = initial;
    CF areas = CFArrayCreate(), a0 = view_area(W, H, x, y, w, h, no), a1 = view_area(W, H, 0, 0, W, H, no), adj = CFArrayCreate(), k, n;
    CFArrayAppend(areas, a0); CFArrayAppend(areas, a1);
    CFRelease(a0); CFRelease(a1);
    k = CFStr("viewAreas"); CFDictSet(rec, k, areas); CFRelease(k);
    k = CFStr("initialViewArea"); n = CFNumI64(initial); CFDictSet(rec, k, n); CFRelease(n); CFRelease(k);
    if (initial) { n = CFNumI64(0); CFArrayAppend(adj, n); CFRelease(n); }
    k = CFStr("adjacentViewAreas"); CFDictSet(rec, k, adj); CFRelease(k);
    CFRelease(adj); CFRelease(areas);
    snprintf(offered_safearea, sizeof offered_safearea, "%d,%d,%d,%d", x, y, w, h);
    offered_viewareas = 1;
    return 1;
}

static int mode_now(void) { return read_mode(); }
int hook111_fell_back(void) { return fallback; }

/* ---- the status file: <log dir>/status, text, rewritten whole ----
 * On each event (SETUP of 111, accept, the stream's start and end,
 * TEARDOWN, a fallback, a command sent) and otherwise at most once a second
 * (from the frame pump and the phone's commands). A sink can add lines. */
void (*hook111_status_extra)(FILE *f);
static int mode_now(void);
static void status_now(int force) {
    if (!log_dir[0]) return;
    static volatile long long last;
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    long long now = (long long)t.tv_sec * 1000000000LL + t.tv_nsec;
    if (!force && now - last < 1000000000LL) return;
    last = now;
    char p[sizeof log_dir + 24], q[sizeof log_dir + 32];
    snprintf(p, sizeof p, "%s/status", log_dir);
    snprintf(q, sizeof q, "%s/status.%d", log_dir, (int)gettid_());
    FILE *f = fopen(q, "w");
    if (!f) return;
    volatile struct hook111_stats *x = &hook111_stats;
    if (offered_display[0]) fprintf(f, "display=%s\n", offered_display);
    if (offered_view[0]) fprintf(f, "view=%s\n", offered_view);
    fprintf(f, "safearea=%s\n", offered_safearea[0] ? offered_safearea : "none");
    if (x->b_width) fprintf(f, "b_size=%dx%d\n", x->b_width, x->b_height);   /* from the stream's SPS */
    fprintf(f, "time_s=%lld\nmode=%s\nfell_back=%d\nrefusals=%d\n", now / 1000000000LL, mode_now() == 2 ? "full" : mode_now() == 1 ? "alt" : "off", hook111_fell_back(), x->refusals);
    fprintf(f, "setups_111=%d\naccepted=%d\npump_done=%d\npump_rc=%d\nscreen_b=%s\n", x->setups_111, x->accepted, x->pump_done, x->pump_rc, current_b ? "up" : "none");
    fprintf(f, "b_avcc=%d\nb_avcc_bytes=%d\nb_starts=%d\nb_stops=%d\nb_frames=%d\nb_frame_bytes=%lld\n", x->b_avcc, x->b_avcc_bytes, x->b_starts, x->b_stops, x->b_frames, (long long)x->b_frame_bytes);
    fprintf(f, "enabled_features=%d\ninfo_records=%d\nsuggest_ui=%d\ncommands_sent=%d\nkeyframe_requests=%d\nsent_files=%d\nlast_send_rc=%d\nteardowns=%d\nlogged=%d\n",
            x->enabled_features, x->info_records, x->suggest_ui, x->commands_sent, x->keyframe_requests, x->sent_files, x->last_send_rc, x->teardowns, x->logged);
    fprintf(f, "idle_held=%d\nidle_rc=%d\n", x->idle_held, x->idle_rc);
    fprintf(f, "features=%s\ninfo_extra_a=%d\ninfo_extra_b=%d\n", answered_features, x->info_extra_a, x->info_extra_b);
    fprintf(f, "ui_url=%s\nui_sent=%d\nui_rc=%d\nviewarea=%d\nva_sent=%d\nzoom_sent=%d\n",
            ui_url_sent[0] ? ui_url_sent : "none", x->ui_sent, x->ui_rc, ui_va_sent, x->va_sent, x->zoom_sent);
    if (hook111_status_extra) hook111_status_extra(f);
    fclose(f);
    rename(q, p);
}

/* ---- commands from the bench: <log dir>/send.plist ----
 * A binary or XML plist {type, params}, put there by root. The hook sends it
 * as it is, the library's own way, on the phone's next command (about a
 * second), then renames it send.<n>.done; the result is in the status
 * (last_send_rc). For trying showUI / requestUI variants without a rebuild. */
static int send_dict(void *session, CF cmd);
static void bench_send(void *session) {
    if (!log_dir[0]) return;
    char p[sizeof log_dir + 16];
    snprintf(p, sizeof p, "%s/send.plist", log_dir);
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return;
    static unsigned char buf[1 << 16];
    ssize_t n = read(fd, buf, sizeof buf); close(fd);
    int seq = __sync_add_and_fetch(&hook111_stats.sent_files, 1);
    char d[sizeof log_dir + 32];
    snprintf(d, sizeof d, "%s/send.%d.done", log_dir, seq);
    rename(p, d);   /* first, so a bad file is tried once */
    int err = 0, rc = -6705;   /* kFormatErr */
    CF cmd = n > 0 ? FN(CF (*)(const void *, size_t, int *), 0x13a550)(buf, (size_t)n, &err) : NULL;
    if (cmd && !err && CFTypeOf(cmd) == CFDictTypeID() && CFDictGetTyped(cmd, K_TYPE, CFStrTypeID(), &err)) rc = send_dict(session, cmd);
    if (cmd) CFRelease(cmd);
    hook111_stats.last_send_rc = rc;
    fprintf(stderr, "[hook111] bench command %d sent: %d\n", seq, rc);
    status_now(1);
}

static int (*orig_setup)(void *session, CF req, CF *resp);
static int my_setup(void *session, CF req, CF *resp) {
    log_plist("setup-request", req);
    char up[sizeof trial_dir + 32];
    if (trial_path(up, sizeof up, "unfallback") && unlink(up) == 0) {   /* the bench: clear a fallback */
        pthread_mutex_lock(&mode_lock);
        fallback = 0; refusals = 0; hook111_stats.refusals = 0;
        pthread_mutex_unlock(&mode_lock);
        if (log_dir[0]) { char fb[sizeof log_dir + 16]; snprintf(fb, sizeof fb, "%s/fallback", log_dir); unlink(fb); }
        fprintf(stderr, "[hook111] fallback cleared from the bench\n");
    }
    int m = read_mode();
    int err = 0;
    CF streams = CFDictGetTyped(req, K_STREAMS, CFArrayTypeID(), &err);
    int n = streams ? CFArrayCount(streams) : 0;
    pthread_mutex_lock(&mode_lock);
    if (n == 0) { adv_session = m != MODE_OFF ? session : NULL; adv_streams = 0; }   /* a session's first SETUP */
    else if (session == adv_session) { adv_streams = 1; refusals = 0; }
    pthread_mutex_unlock(&mode_lock);
    int rc = orig_setup(session, req, resp);
    if (rc != 0 || !resp || !*resp) return rc;
    if (m == MODE_OFF) { log_plist("setup-response", *resp); return 0; }
    int b_up = 0;
    pthread_mutex_lock(&b_life);
    for (int i = 0; i < n; i++) {
        CF s = CFArrayAt(streams, i);
        if (!s || CFTypeOf(s) != CFDictTypeID()) continue;
        if (CFDictGetI64(s, K_TYPE, &err) == 111) {
            int r = setup_111(session, s, *resp);
            if (r) fprintf(stderr, "[hook111] stream 111 setup failed: %d\n", r);
            else b_up = 1;
        }
    }
    pthread_mutex_unlock(&b_life);
    /* the stock SETUP ran its idle transition before screen B existed: again,
     * with screen B counted (an error goes in the status; the stream goes on) */
    if (b_up) {
        int r = my_idle(session, *resp);
        if (r) fprintf(stderr, "[hook111] idle state with screen B: %d\n", r);
        status_now(1);
    }
    /* feature negotiation: answer the ones offered that this mode implements */
    CF offered = CFDictGetTyped(req, K_FEATURES, CFArrayTypeID(), &err);
    if (offered) {
        static const char *ours[] = { "altScreen", "viewAreas" };
        const char *names[8]; char tbuf[sizeof trial_features_text];
        unsigned nours = 0;
        const char *tf = trial_features();
        if (tf) {   /* the trial list */
            snprintf(tbuf, sizeof tbuf, "%s", tf);
            for (char *save = NULL, *t = strtok_r(tbuf, " \t\r\n", &save); t && nours < 8; t = strtok_r(NULL, " \t\r\n", &save)) names[nours++] = t;
        } else {
            /* viewAreas: in mode full, or with a safe area (the records go into /info with it) */
            int dw, dh, dfps, sx, sy, sw, sh;
            display_now(&dw, &dh, &dfps);
            nours = m == MODE_FULL || safearea_now(dw, dh, &sx, &sy, &sw, &sh) ? 2 : 1;
            for (unsigned k = 0; k < nours; k++) names[k] = ours[k];
        }
        CF enabled = CFArrayCreate();
        answered_features[0] = 0;
        for (unsigned k = 0; k < nours; k++) {
            CF f = CFStr(names[k]);
            if (CFArrayIndexOf(offered, f) >= 0) {
                CFArrayAppend(enabled, f);
                size_t l = strlen(answered_features);
                snprintf(answered_features + l, sizeof answered_features - l, "%s%s", l ? "," : "", names[k]);
            }
            CFRelease(f);
        }
        if (CFArrayCount(enabled) > 0) {
            CF key = CFStr("enabledFeatures");
            CFDictSet(*resp, key, enabled);
            CFRelease(key);
            hook111_stats.enabled_features = CFArrayCount(enabled);
        }
        CFRelease(enabled);
    }
    log_plist("setup-response", *resp);
    return 0;
}

static void note_fallback(void) {
    fprintf(stderr, "[hook111] the phone refused %d sessions in a row: off for this carplay run\n", FALLBACK_AFTER);
    if (!log_dir[0]) return;
    char p[sizeof log_dir + 16];
    snprintf(p, sizeof p, "%s/fallback", log_dir);
    int fd = open(p, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd >= 0) { if (write(fd, "off\n", 4) != 4) { /* best effort */ } close(fd); }
}

/* AirPlayReceiverSessionTearDown(session, request or NULL, reason, &done) */
static void (*orig_teardown)(void *session, CF req, int reason, void *done);
static void my_teardown(void *session, CF req, int reason, void *done) {
    log_plist("teardown", req);
    int err = 0, n = 0, ours = 0;
    CF streams = req ? CFDictGetTyped(req, K_STREAMS, CFArrayTypeID(), &err) : NULL;
    if (streams) n = CFArrayCount(streams);
    for (int i = 0; i < n; i++) {
        CF s = CFArrayAt(streams, i);
        if (s && CFTypeOf(s) == CFDictTypeID() && CFDictGetI64(s, K_TYPE, &err) == 111) ours = 1;
    }
    if (n == 0) {   /* the whole session goes: was it a refusal of what we advertised? */
        int now_off = 0;
        pthread_mutex_lock(&mode_lock);
        if (session == adv_session) {
            if (adv_streams) refusals = 0;
            else if (++refusals >= FALLBACK_AFTER && !fallback) { fallback = 1; now_off = 1; }
            adv_session = NULL;
        }
        hook111_stats.refusals = refusals;
        pthread_mutex_unlock(&mode_lock);
        if (now_off) note_fallback();
        status_now(1);
    }
    pthread_mutex_lock(&b_life);
    struct screen_b *b = current_b;
    if (b && b->session == session && (n == 0 || ours)) teardown_b(b);
    pthread_mutex_unlock(&b_life);
    orig_teardown(session, req, reason, done);
}

/* ---- session commands, accessory -> phone ----
 * The library's own path, as AirPlayReceiverSessionRequestUI (0x184590) uses
 * it: {type, params} goes to 0x17a0c0 on the session's event queue (+0x468),
 * which POSTs it as a binary plist to /command on the events connection
 * (+0x470, up once +0x466 is set by _ControlStart). */
static int send_dict(void *session, CF cmd) {
    if (!session || !*((char *)session + 0x466) || !*(void **)((char *)session + 0x468)) return -6709;  /* not started */
    log_plist("sent", cmd);
    struct { void *session; CF cmd; void *completion, *ctx; int rc; } c = { session, cmd, NULL, NULL, -6700 };
    FN(void (*)(void *, void *, void *), 0x1460e0)(*(void **)((char *)session + 0x468), &c, AT(0x17a0c0));
    if (c.rc == 0) hook111_stats.commands_sent++;
    return c.rc;
}
int hook111_send_command(void *session, const char *type, void *params) {
    CF cmd = CFDictCreate(), t = CFStr(type);
    CFDictSet(cmd, K_TYPE, t); CFRelease(t);
    if (params) CFDictSet(cmd, K_PARAMS, params);
    int rc = send_dict(session, cmd);
    CFRelease(cmd);
    return rc;
}

/* forceKeyFrame for screen B: {type: forceKeyFrame, params: {uuid: <its
 * display's uuid>}}. On the unit (2026-11-04, iOS 26.7.1) the stock form
 * with no params (0x1843a0) never brought an IDR on stream 111 (167
 * requests); with the uuid the IDR came within 0.5 s. At most once a second;
 * called from the pump thread, whose screen B teardown waits for. */
int hook111_request_keyframe(void) {
    static long long last;
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    long long now = (long long)t.tv_sec * 1000000000LL + t.tv_nsec;
    struct screen_b *b = current_b;
    if (!b || (last && now - last < 1000000000LL)) return -6721;   /* busy */
    last = now;
    CF p = CFDictCreate(), u = CFStr(disp.uuid);
    CFDictSet(p, K_UUID, u); CFRelease(u);
    int rc = hook111_send_command(b->session, "forceKeyFrame", p);
    CFRelease(p);
    if (rc == 0) hook111_stats.keyframe_requests++;
    return rc;
}

/* ---- the cluster scene, the view area and zoom, from the consumer ----
 * Files the consumer (vizualyse-cast) writes; checked from screen B's frame
 * pump, so only while its stream is decodable, at most every 500 ms:
 *  url       the scene: sent as showUI {uuid, url} once per stream and again
 *            when it changes. Its query sets the cards: showETA=yes|no,
 *            maneuverLayout=..., showSpeedLimit=... (DashBoard's
 *            applySettingsForClusterURL, per luka-dev/mib2q-carplay-rgi). On the
 *            car (2026-11-04) these applied at once from showUI and not from
 *            /info's initialURL; showUI did not cost the main screen.
 *  viewarea  "0" / "1": sent as updateViewArea when it differs from what the
 *            phone was last given (needs both view areas offered at /info).
 *  zoom      "in" / "out": taken (renamed, read, removed) and sent as
 *            changeMapZoomLevel {uuid, zoomDirection 0 in / 1 out}. */
static char url_path[256], zoom_path[256];
void hook111_url_file(const char *path) { url_path[0] = 0; if (path && strlen(path) < sizeof url_path) strcpy(url_path, path); }
void hook111_zoom_file(const char *path) { zoom_path[0] = 0; if (path && strlen(path) < sizeof zoom_path) strcpy(zoom_path, path); }
static void ui_reset(void) { ui_need = 1; ui_url_sent[0] = 0; ui_va_sent = offered_va; }

static int send_with_uuid(void *session, const char *type, CF params) {
    CF u = CFStr(disp.uuid);
    CFDictSet(params, K_UUID, u); CFRelease(u);
    int rc = hook111_send_command(session, type, params);
    CFRelease(params);
    return rc;
}
static void ui_poll(struct screen_b *b, int force) {
    static long long last;
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    long long now = (long long)t.tv_sec * 1000000000LL + t.tv_nsec;
    if (!b || !b->started || (!force && last && now - last < 500000000LL)) return;
    last = now;
    char url[512];
    if (read_small(url_path, url, sizeof url) > 0 && (ui_need || strcmp(url, ui_url_sent))) {
        CF p = CFDictCreate(), s = CFStr(url);
        CFDictSet(p, K_URL, s); CFRelease(s);
        int rc = send_with_uuid(b->session, "showUI", p);
        hook111_stats.ui_rc = rc;
        if (rc == 0) { snprintf(ui_url_sent, sizeof ui_url_sent, "%s", url); ui_need = 0; hook111_stats.ui_sent++; }
        status_now(1);
    }
    int va = viewarea_now();
    if (offered_viewareas && va != ui_va_sent) {
        CF p = CFDictCreate(), adj = CFArrayCreate(), n, k;
        n = CFNumI64(va); k = CFStr("viewAreaIndex"); CFDictSet(p, k, n); CFRelease(k); CFRelease(n);
        if (va) { n = CFNumI64(0); CFArrayAppend(adj, n); CFRelease(n); }
        k = CFStr("adjacentViewAreas"); CFDictSet(p, k, adj); CFRelease(k); CFRelease(adj);
        n = CFNumI64(300); k = CFStr("animationDurationMillis"); CFDictSet(p, k, n); CFRelease(k); CFRelease(n);
        int rc = send_with_uuid(b->session, "updateViewArea", p);
        if (rc == 0) { ui_va_sent = va; hook111_stats.va_sent++; }
        status_now(1);
    }
    if (zoom_path[0]) {
        char taken[sizeof zoom_path + 8], z[16];
        snprintf(taken, sizeof taken, "%s.taken", zoom_path);
        if (rename(zoom_path, taken) == 0) {
            int dir = read_small(taken, z, sizeof z) > 0 ? (!strcmp(z, "in") ? 0 : !strcmp(z, "out") ? 1 : -1) : -1;
            unlink(taken);
            if (dir >= 0) {
                CF p = CFDictCreate(), n = CFNumI64(dir), k = CFStr("zoomDirection");
                CFDictSet(p, k, n); CFRelease(k); CFRelease(n);
                if (send_with_uuid(b->session, "changeMapZoomLevel", p) == 0) hook111_stats.zoom_sent++;
                status_now(1);
            }
        }
    }
}

/* suggestUI is accepted and logged, and NOT answered. On the unit
 * (2026-11-04, iOS 26.7.1) the phone sent suggestUI {urls: []}; the hook's
 * guessed answer, showUI {url: maps:/car/instrumentcluster, uuid: <screen B>},
 * made it hand the main screen back to the car within 4 s (modesChanged
 * screen -> entity 2, TEARDOWN 110) and let the session die after about 39 s,
 * session after session. Stream 111 runs without either. A showUI can still
 * be tried from the bench (send.plist). */

/* AirPlayReceiverSessionControl(session, flags, command, qualifier, params, &response):
 * /command from the phone lands here (_requestProcessCommand 0x1775a0); what the
 * stock code doesn't know goes to Cinemo, which has no suggestUI. */
static int (*orig_control)(void *, int, CF, CF, CF, CF *);
static int my_control(void *session, int flags, CF cmd, CF qual, CF params, CF *resp) {
    log_command("command", cmd, params);
    bench_send(session);
    status_now(0);
    CF su = CFStr("suggestUI");
    int ours = cmd && CFEqual(cmd, su);
    CFRelease(su);
    if (!ours || read_mode() == MODE_OFF) return orig_control(session, flags, cmd, qual, params, resp);
    hook111_stats.suggest_ui++;
    return 0;   /* a suggestion: accepted, nothing sent (see above) */
}

static CF (*orig_copyprop)(void *, CF, void *, int *, void *);
static CF my_copyprop(void *a1, CF prop, void *a3, int *err, void *cfg) {
    CF v = orig_copyprop(a1, prop, a3, err, cfg);
    if (!v || !CFEqual(prop, K_DISPLAYS) || CFTypeOf(v) != CFArrayTypeID()) return v;
    if (read_mode() == MODE_OFF) { log_plist("info-displays", v); return v; }
    int w, h, fps;
    display_now(&w, &h, &fps);
    snprintf(offered_display, sizeof offered_display, "%dx%d@%d", w, h, fps);
    CF d = CFDictCreate(), s, k;
    s = CFStr(disp.uuid); CFDictSet(d, K_UUID, s); CFRelease(s);
    CF n;
    n = CFNumI64(w);  CFDictSet(d, K_WPX, n); CFRelease(n);
    n = CFNumI64(h); CFDictSet(d, K_HPX, n); CFRelease(n);
    n = CFNumI64((int64_t)disp.width_mm * w / disp.width_px);  CFDictSet(d, K_WMM, n); CFRelease(n);    /* same density */
    n = CFNumI64((int64_t)disp.height_mm * h / disp.height_px); CFDictSet(d, K_HMM, n); CFRelease(n);
    n = CFNumI64(fps);   CFDictSet(d, K_MAXFPS, n); CFRelease(n);
    n = CFNumI64(disp.features);  CFDictSet(d, K_FEATURES, n); CFRelease(n);
    const char *vname, *vurl = view_now(&vname);
    snprintf(offered_view, sizeof offered_view, "%s", vname[0] ? vname : "default");
    k = CFStr("initialURL"); s = CFStr(vurl); CFDictSet(d, k, s); CFRelease(s); CFRelease(k);
    CF urls = CFArrayCreate();
    for (int i = 0; i < 3 && disp.suggest_urls[i]; i++) { s = CFStr(disp.suggest_urls[i]); CFArrayAppend(urls, s); CFRelease(s); }
    k = CFStr("altScreenSuggestUIURLs"); CFDictSet(d, k, urls); CFRelease(k); CFRelease(urls);
    add_viewareas(d, w, h);   /* the safe area, when the consumer asked for one */
    CF xb = trial_plist("info-b.plist"), xa = trial_plist("info-a.plist");   /* the bench's extra keys (they win) */
    hook111_stats.info_extra_b = merge_pairs(d, xb);
    CF a0 = CFArrayCount(v) > 0 ? CFArrayAt(v, 0) : NULL;
    hook111_stats.info_extra_a = a0 && CFTypeOf(a0) == CFDictTypeID() ? merge_pairs(a0, xa) : 0;
    if (xb) CFRelease(xb);
    if (xa) CFRelease(xa);
    CFArrayAppend(v, d);
    CFRelease(d);
    hook111_stats.info_records = CFArrayCount(v);
    log_plist("info-displays", v);
    return v;
}

/* ---- ScreenStream: the stock behaviour, except for screen B's context ---- */
static void *ss_ctx(void *ss) { return *(void **)((char *)ss + 8); }

static int my_ss_set_avcc(void *ss, const void *p, size_t n) {
    if (is_b_ctx(ss_ctx(ss))) {
        hook111_stats.b_avcc++; hook111_stats.b_avcc_bytes = (int)n;
        int w = 0, h = 0;   /* what the phone really draws (its SPS), not what /info offered */
        if (annexb_avcc_size(p, n, &w, &h) == 0) { hook111_stats.b_width = w; hook111_stats.b_height = h; }
        if (sink && sink->avcc) sink->avcc(p, n);
        status_now(1);
        return 0;
    }
    void **saved = (void **)((char *)ss + 0x10);
    size_t *saved_n = (size_t *)((char *)ss + 0x18);
    if (*saved && *saved_n == n && memcmp(*saved, p, n) == 0) return 0;
    free(*saved); *saved = NULL;
    void *c = malloc(n);
    if (!c) return -6728;
    memcpy(c, p, n); *saved = c; *saved_n = n;
    FN(void (*)(void *, unsigned, void *), 0x19b8b0)(c, (unsigned)n, ss_ctx(ss));
    return 0;
}
static int my_ss_start(void *ss) {
    if (is_b_ctx(ss_ctx(ss))) { hook111_stats.b_starts++; if (sink && sink->start) sink->start(); status_now(1); return 0; }
    FN(void (*)(void *), 0x19b870)(ss_ctx(ss));
    return 0;
}
static void my_ss_stop(void *ss) {
    if (is_b_ctx(ss_ctx(ss))) { hook111_stats.b_stops++; if (sink && sink->stop) sink->stop(); status_now(1); }
    else FN(void (*)(void *), 0x19b890)(ss_ctx(ss));
    void **saved = (void **)((char *)ss + 0x10);
    free(*saved); *saved = NULL;
}
static int my_ss_frame(void *ss, const void *p, size_t n, uint64_t ts, void *x, void (*cb)(void *), void *arg) {
    (void)x;
    if (is_b_ctx(ss_ctx(ss))) { hook111_stats.b_frames++; hook111_stats.b_frame_bytes += (long long)n; if (sink && sink->frame) sink->frame(p, n, ts); status_now(hook111_stats.b_frames == 1); ui_poll(current_b, 0); }
    else FN(void (*)(const void *, size_t, uint64_t, void *), 0x19b8e0)(p, n, (ts * 0x434a900ull) / 1000000000ull, ss_ctx(ss));
    if (cb) cb(arg);
    return 0;
}

/* ---- install ---- */
static int build_id_ok;
static int find_cb(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size; (void)data;
    if (!strstr(info->dlpi_name, "libNmeCarPlay.so")) return 0;
    for (int i = 0; i < info->dlpi_phnum; i++) {
        const ElfW(Phdr) *ph = &info->dlpi_phdr[i];
        if (ph->p_type != PT_NOTE) continue;
        const unsigned char *p = (const unsigned char *)(info->dlpi_addr + ph->p_vaddr), *end = p + ph->p_memsz;
        while (p + 12 <= end) {
            const ElfW(Nhdr) *nh = (const ElfW(Nhdr) *)p;
            const unsigned char *desc = p + 12 + ((nh->n_namesz + 3) & ~3u);
            if (nh->n_type == NT_GNU_BUILD_ID) {
                char hex[129] = "";
                for (unsigned k = 0; k < nh->n_descsz && k < 64; k++) sprintf(hex + 2 * k, "%02x", desc[k]);
                if (strcmp(hex, BUILD_ID) == 0) { build_id_ok = 1; *(uintptr_t *)data = info->dlpi_addr; }
            }
            p = desc + ((nh->n_descsz + 3) & ~3u);
        }
    }
    return 1;
}
uintptr_t hook111_find(void) {
    uintptr_t b = 0;
    build_id_ok = 0;
    dl_iterate_phdr(find_cb, &b);
    return build_id_ok ? b : 0;
}

int hook111_install(uintptr_t b, const struct hook111_sink *s, const struct hook111_display *d) {
    if (!b) return -1;
    base = b; sink = s; disp = *d;
    /* SETUP 0x180670: push r15; push r14; mov r15,rdi; push r13; push r12; push rbp; push rbx; sub rsp,0x1f8 */
    static const unsigned char setup_pro[20] = { 0x41,0x57, 0x41,0x56, 0x49,0x89,0xff, 0x41,0x55, 0x41,0x54, 0x55, 0x53, 0x48,0x81,0xec,0xf8,0x01,0x00,0x00 };
    /* CopyProperty 0x10d270: push r15; push r14; lea rdi,[rip+0x2d3fe5]; push r13; push r12; mov r12,r8; push rbp; push rbx; mov rbp,rcx */
    static const unsigned char copy_pro[23] = { 0x41,0x57, 0x41,0x56, 0x48,0x8d,0x3d,0xe5,0x3f,0x2d,0x00, 0x41,0x55, 0x41,0x54, 0x4d,0x89,0xc4, 0x55, 0x53, 0x48,0x89,0xcd };
    /* TearDown 0x17e840: push r15; push r14; push r13; push r12; mov r13,rsi; push rbp; push rbx; mov rbp,rdi; mov ebx,edx */
    static const unsigned char tear_pro[18] = { 0x41,0x57, 0x41,0x56, 0x41,0x55, 0x41,0x54, 0x49,0x89,0xf5, 0x55, 0x53, 0x48,0x89,0xfd, 0x89,0xd3 };
    /* SessionControl 0x183bf0: push r15; push r14; mov r15,rdi; push r13; push r12; mov r14d,esi; push rbp; push rbx */
    static const unsigned char ctl_pro[16] = { 0x41,0x57, 0x41,0x56, 0x49,0x89,0xff, 0x41,0x55, 0x41,0x54, 0x41,0x89,0xf6, 0x55, 0x53 };
    /* IdleStateTransition 0x17c0e0: push r15; push r14; push r13; push r12; mov r13,rdi; push rbp; push rbx; mov r12,rsi */
    static const unsigned char idle_pro[16] = { 0x41,0x57, 0x41,0x56, 0x41,0x55, 0x41,0x54, 0x49,0x89,0xfd, 0x55, 0x53, 0x49,0x89,0xf4 };
    if (memcmp(AT(0x180670), setup_pro, sizeof setup_pro) || memcmp(AT(0x10d270), copy_pro, sizeof copy_pro)
        || memcmp(AT(0x17e840), tear_pro, sizeof tear_pro) || memcmp(AT(0x183bf0), ctl_pro, sizeof ctl_pro)
        || memcmp(AT(0x17c0e0), idle_pro, sizeof idle_pro)) return -1;
    /* the CopyProperty trampoline: the rip-relative lea becomes movabs rdi, <0x3e1260> */
    unsigned char ct[29];
    void *lea_target = AT(0x3e1260);
    memcpy(ct, copy_pro, 4);
    ct[4] = 0x48; ct[5] = 0xbf; memcpy(ct + 6, &lea_target, 8);
    memcpy(ct + 14, copy_pro + 11, 12);
    orig_setup = make_tramp(setup_pro, sizeof setup_pro, 0x180670 + sizeof setup_pro);
    orig_copyprop = make_tramp(ct, 26, 0x10d270 + sizeof copy_pro);
    orig_teardown = make_tramp(tear_pro, sizeof tear_pro, 0x17e840 + sizeof tear_pro);
    orig_control = make_tramp(ctl_pro, sizeof ctl_pro, 0x183bf0 + sizeof ctl_pro);
    orig_idle = make_tramp(idle_pro, sizeof idle_pro, 0x17c0e0 + sizeof idle_pro);
    if (!orig_setup || !orig_copyprop || !orig_teardown || !orig_control || !orig_idle) return -1;
    /* the ScreenStream functions: stock prologues checked, then replaced */
    /* sizes 226, 92, 108, 69 bytes: room for the 14-byte jump */
    static const struct { uintptr_t at; unsigned char b[4]; } ss[] = {
        { 0x172960, {0x41,0x55,0x41,0x54} },   /* push r13; push r12 */
        { 0x172a50, {0x48,0x83,0xec,0x08} },   /* sub rsp,8 */
        { 0x172ab0, {0x53,0x48,0x89,0xfb} },   /* push rbx; mov rbx,rdi */
        { 0x172b20, {0x49,0x89,0xf0,0x48} } }; /* mov r8,rsi; mov ... */
    void *to[4] = { (void *)my_ss_set_avcc, (void *)my_ss_start, (void *)my_ss_stop, (void *)my_ss_frame };
    for (int i = 0; i < 4; i++)
        if (memcmp(AT(ss[i].at), ss[i].b, 4) != 0) { fprintf(stderr, "[hook111] ScreenStream %#lx: unexpected prologue\n", (unsigned long)ss[i].at); return -1; }
    for (int i = 0; i < 4; i++) {
        unsigned char j[14]; jmp_abs(j, to[i]);
        if (write_code(AT(ss[i].at), j, 14)) return -1;
    }
    if (patch_entry(0x180670, setup_pro, sizeof setup_pro, (void *)my_setup)) return -1;
    if (patch_entry(0x10d270, copy_pro, sizeof copy_pro, (void *)my_copyprop)) return -1;
    if (patch_entry(0x17e840, tear_pro, sizeof tear_pro, (void *)my_teardown)) return -1;
    if (patch_entry(0x183bf0, ctl_pro, sizeof ctl_pro, (void *)my_control)) return -1;
    if (patch_entry(0x17c0e0, idle_pro, sizeof idle_pro, (void *)my_idle)) return -1;
    return 0;
}
