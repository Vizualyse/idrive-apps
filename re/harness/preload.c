/*
 * libhook111.so: hook111 as an LD_PRELOAD library for carplay 20.40.2.
 *
 * Cinemo loads libNmeCarPlay.so as a plugin with dlopen (libNmeBaseClasses.so,
 * dlopen@GLIBC_2.2.5), not at startup. So the hook installs:
 *  - in our constructor, if it is already loaded;
 *  - otherwise right after the dlopen that loads it: our dlopen comes first in
 *    the lookup scope (LD_PRELOAD), calls the real one, then installs.
 * hook111_install patches nothing unless the build-id and every patched
 * prologue are the expected ones; a refusal leaves carplay stock.
 *
 * Off: HOOK111_OFF=1 in the environment, or the file /run/hook111/off.
 * Config (environment, set by the arm step's env file):
 *   HOOK111_SINK_PORT   127.0.0.1 port of the Annex-B consumer (default 6111)
 *   HOOK111_DATA_PORT   stream 111's listener (default 6031, open in the firewall)
 *   HOOK111_LOG_DIR     the plist log (default /run/hook111/log, used if it exists)
 *   HOOK111_MODE_FILE   off | alt | full, read at every SETUP and /info
 *                       (default /run/hook111/mode; missing: off). The arm step writes it.
 */
#define _GNU_SOURCE
#include "hook111.c"
#include "annexb.c"
#include "sink_annexb.c"
#include <dlfcn.h>

static pthread_mutex_t once = PTHREAD_MUTEX_INITIALIZER;
static int state;   /* 0 not yet, 1 installed, -1 refused or off */
static struct annexb sink_state;

static int env_int(const char *name, int def, int lo, int hi) {
    const char *v = getenv(name);
    if (!v || !*v) return def;
    char *e; long n = strtol(v, &e, 10);
    return *e || n < lo || n > hi ? def : (int)n;
}

static struct hook111_display display = {
    "b7e6c5a0-0000-4000-8000-000000000111", 1088, 480, 200, 88, 30, 2,
    "maps:/car/instrumentcluster",
    { "maps:/car/instrumentcluster", "maps:/car/instrumentcluster/map", "maps:/car/instrumentcluster/instructioncard" },
    6031 };

/* by name, without dlopen (that would re-enter ours) */
static int name_cb(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size;
    if (info->dlpi_name && strstr(info->dlpi_name, "libNmeCarPlay.so")) { *(int *)data = 1; return 1; }
    return 0;
}
static int nme_loaded(void) { int f = 0; dl_iterate_phdr(name_cb, &f); return f; }

static void try_install(const char *why) {
    pthread_mutex_lock(&once);
    if (state == 0) {
        uintptr_t b = hook111_find();
        if (b) {
            display.port = env_int("HOOK111_DATA_PORT", 6031, 1, 65535);
            int port = env_int("HOOK111_SINK_PORT", 6111, 1, 65535);
            const char *ld = getenv("HOOK111_LOG_DIR");
            hook111_log_to(ld ? ld : "/run/hook111/log");   /* only if it exists: the arm step makes it */
            const char *mf = getenv("HOOK111_MODE_FILE");
            hook111_mode_file(mf ? mf : "/run/hook111/mode");   /* read at every SETUP; missing: off */
            int rc = hook111_install(b, sink_annexb(&sink_state, (uint16_t)port), &display);
            state = rc == 0 ? 1 : -1;
            fprintf(stderr, "[hook111] %s: %s (stream 111 on %d, sink 127.0.0.1:%d, mode now %s)\n", why,
                    rc == 0 ? "installed" : "refused: unexpected code, carplay left stock", display.port, port,
                    mode_names[hook111_mode()]);
        } else if (nme_loaded()) {
            /* loaded, but another build: every later check would fail the same way */
            state = -1;
            fprintf(stderr, "[hook111] %s: libNmeCarPlay.so is not build %s: carplay left stock\n", why, BUILD_ID);
        }   /* else not loaded yet: the dlopen that loads it tries again */
    }
    pthread_mutex_unlock(&once);
}

static int off(void) {
    const char *e = getenv("HOOK111_OFF");
    return (e && *e && strcmp(e, "0")) || access("/run/hook111/off", F_OK) == 0;
}

__attribute__((constructor)) static void hook111_preload_init(void) {
    if (off()) { state = -1; fprintf(stderr, "[hook111] off\n"); return; }
    try_install("at start");
}

/* the interposed dlopen */
__attribute__((visibility("default"))) void *dlopen(const char *file, int mode) {
    static void *(*real)(const char *, int);
    if (!real) real = (void *(*)(const char *, int))dlvsym(RTLD_NEXT, "dlopen", "GLIBC_2.2.5");
    if (!real) return NULL;
    void *h = real(file, mode);
    if (h && state == 0 && file && strstr(file, "NmeCarPlay")) try_install("after dlopen");
    return h;
}

/* for tests and diagnostics: 1 installed, -1 refused or off, 0 not yet */
__attribute__((visibility("default"))) int hook111_preload_state(void) { return state; }
