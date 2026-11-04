/*
 * setup_b: hook111 driven through the unit's real libNmeCarPlay.so, off the car
 * (re/run.sh harness-setup). Two tests:
 *
 *  SETUP  A SETUP request {streams:[{type:111, streamConnectionID}], features:[...]}
 *         goes in through the library's own AirPlayReceiverSessionSetup entry
 *         (patched to hook111). The response must carry {type:111, dataPort}
 *         and enabledFeatures [altScreen, viewAreas]. A "phone" then connects
 *         to that dataPort, derives the stream key itself (AirPlayStreamKey/IV:
 *         SHA-512 of the label + connection ID + the session key), and sends
 *         an AVCC config and AES-CTR frames: the sink must get them intact.
 *  /info  The library's own AirPlayServerCopyProperty("displays"), fed one
 *         display by a fake Cinemo configuration, must return the stock record
 *         plus hook111's second one.
 *
 * The session object holds only what the 110 path reads (+0x10 server with
 * its timeout at +0xac, +0x100 address family, +0x288 session key); no
 * pairing session, so the AES-CTR key path is the one exercised.
 */
#include "hook111.c"
#include "annexb.c"
#include "sink_annexb.c"   /* built here so it stays in step with hook111.h */
#include <arpa/inet.h>
#include <dlfcn.h>
#include <netinet/in.h>
#include <openssl/evp.h>
#include <openssl/kdf.h>
#include <openssl/sha.h>
#include <sys/socket.h>
#include <time.h>
#include <dirent.h>
#include <strings.h>
#include <sys/stat.h>

#include <signal.h>
#include <ucontext.h>

static int fail;

/* On a crash: the faulting address, RIP, and every stack word that points into
 * the library's text, all as Ghidra addresses (a poor man's backtrace). */
static void on_segv(int sig, siginfo_t *si, void *uc_) {
    ucontext_t *uc = uc_;
    uintptr_t rip = (uintptr_t)uc->uc_mcontext.gregs[REG_RIP], rsp = (uintptr_t)uc->uc_mcontext.gregs[REG_RSP];
    uintptr_t lo = base, hi = base + 0x2a0000;
    #define G(x) ((x) >= lo && (x) < hi ? (unsigned long)((x) - base + 0x100000) : 0ul)
    fprintf(stderr, "*** signal %d at %p, rip %#lx (ghidra %#lx)\n", sig, si->si_addr, (unsigned long)rip, G(rip));
    for (int i = 0; i < 160; i++) {   /* the top frames only: past the stack top faults */
        uintptr_t w = ((uintptr_t *)rsp)[i];
        if (G(w)) fprintf(stderr, "    [rsp+%#x] %#lx\n", i * 8, G(w));
    }
    _exit(139);
}
#define CHECK(name, cond) do { int _c = (cond); printf("%s %s\n", _c ? "ok  " : "FAIL", name); if (!_c) fail = 1; } while (0)

/* ---- test sink ---- */
static const unsigned char AVCC[] = { 0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x02, 0x68, 0xeb };
static unsigned char got_avcc[64]; static size_t got_avcc_n;
static int got_start, got_stop, got_frames, bad_frames;
static unsigned char *want[16]; static size_t want_n[16];
static void s_avcc(const uint8_t *p, size_t n) { if (n <= sizeof got_avcc) { memcpy(got_avcc, p, n); got_avcc_n = n; } }
static void s_start(void) { got_start++; }
static void s_stop(void) { got_stop++; }
static void s_frame(const uint8_t *p, size_t n, uint64_t ts) {
    (void)ts;
    int i = got_frames++;
    if (i >= 16 || n != want_n[i] || memcmp(p, want[i], n)) bad_frames++;
}
static const struct hook111_sink test_sink = { s_avcc, s_start, s_stop, s_frame };
static const struct hook111_display test_disp = {
    "b7e6c5a0-0000-4000-8000-000000000111", 1088, 480, 200, 88, 30, 2,
    "maps:/car/instrumentcluster",
    { "maps:/car/instrumentcluster", "maps:/car/instrumentcluster/map", "maps:/car/instrumentcluster/instructioncard" },
    6031 };

/* ---- the phone ---- */
static void derive(const char *label, uint64_t cid, const unsigned char sk[16], unsigned char out[16]) {
    char s[64]; unsigned char h[64];
    int n = snprintf(s, sizeof s, "%s%llu", label, (unsigned long long)cid);
    SHA512_CTX c; SHA512_Init(&c); SHA512_Update(&c, s, (size_t)n); SHA512_Update(&c, sk, 16); SHA512_Final(h, &c);
    memcpy(out, h, 16);
}
static void hdr(unsigned char h[128], uint32_t size, uint8_t op, uint64_t ts) {
    memset(h, 0, 128); memcpy(h, &size, 4); h[4] = op; memcpy(h + 8, &ts, 8);
    float w = 1088, hh = 480; if (op == 1) { memcpy(h + 0x10, &w, 4); memcpy(h + 0x14, &hh, 4); }
}
static void send_all(int fd, const void *p, size_t n) { const char *c = p; while (n) { ssize_t k = send(fd, c, n, MSG_NOSIGNAL); if (k <= 0) return; c += k; n -= (size_t)k; } }

static int phone_hold(int port, uint64_t cid, const unsigned char sk[16], int frames, int hold) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0) { perror("phone connect"); return -1; }
    unsigned char key[16], iv[16], h[128];
    derive("AirPlayStreamKey", cid, sk, key);
    derive("AirPlayStreamIV", cid, sk, iv);
    hdr(h, sizeof AVCC, 1, 0); send_all(fd, h, 128); send_all(fd, AVCC, sizeof AVCC);
    EVP_CIPHER_CTX *e = EVP_CIPHER_CTX_new();
    EVP_EncryptInit_ex(e, EVP_aes_128_ctr(), NULL, key, iv);
    for (int i = 0; i < frames; i++) {
        size_t n = 4 + 29 + (size_t)i * 77;
        unsigned char *p = malloc(n), *w = malloc(n); int ol;
        uint32_t nal = (uint32_t)(n - 4);
        p[0] = nal >> 24; p[1] = nal >> 16; p[2] = nal >> 8; p[3] = nal;
        for (size_t k = 4; k < n; k++) p[k] = (unsigned char)(k * 13 + i);
        want[i] = p; want_n[i] = n;
        EVP_EncryptUpdate(e, w, &ol, p, (int)n);
        hdr(h, (uint32_t)n, 0, 1000ull * (uint64_t)(i + 1)); send_all(fd, h, 128); send_all(fd, w, n);
        free(w);
    }
    EVP_CIPHER_CTX_free(e);
    if (hold) { char c; while (recv(fd, &c, 1, 0) > 0) {} }   /* until the receiver closes */
    else usleep(200000);
    shutdown(fd, SHUT_RDWR); close(fd);
    return 0;
}
static int phone(int port, uint64_t cid, const unsigned char sk[16], int frames) { return phone_hold(port, cid, sk, frames, 0); }

/* the pair-verify path: the phone derives the stream key from the pairing's
 * shared secret (HKDF-SHA512, salt "DataStream-Salt<connID>", info
 * "DataStream-Output-Encryption-Key") and sends ChaCha20-Poly1305 frames */
static int phone_chacha(int port, uint64_t cid, const unsigned char secret[32], int frames) {
    unsigned char key[32]; size_t kl = 32; char salt[64];
    int sn = snprintf(salt, sizeof salt, "DataStream-Salt%llu", (unsigned long long)cid);
    EVP_PKEY_CTX *k = EVP_PKEY_CTX_new_id(EVP_PKEY_HKDF, NULL);
    EVP_PKEY_derive_init(k);
    EVP_PKEY_CTX_set_hkdf_md(k, EVP_sha512());
    EVP_PKEY_CTX_set1_hkdf_salt(k, (unsigned char *)salt, sn);
    EVP_PKEY_CTX_set1_hkdf_key(k, secret, 32);
    EVP_PKEY_CTX_add1_hkdf_info(k, (unsigned char *)"DataStream-Output-Encryption-Key", 32);
    int ok = EVP_PKEY_derive(k, key, &kl) == 1;
    EVP_PKEY_CTX_free(k);
    if (!ok) return -1;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
    if (connect(fd, (struct sockaddr *)&a, sizeof a) != 0) { perror("phone connect"); return -1; }
    unsigned char h[128];
    hdr(h, sizeof AVCC, 1, 0); send_all(fd, h, 128); send_all(fd, AVCC, sizeof AVCC);
    for (int i = 0; i < frames; i++) {
        size_t n = 4 + 41 + (size_t)i * 63;
        unsigned char *p = malloc(n), *w = malloc(n + 16); int ol;
        uint32_t nal = (uint32_t)(n - 4);
        p[0] = nal >> 24; p[1] = nal >> 16; p[2] = nal >> 8; p[3] = nal;
        for (size_t q = 4; q < n; q++) p[q] = (unsigned char)(q * 5 + i);
        want[i] = p; want_n[i] = n;
        unsigned char nonce[12] = {0}; uint64_t ctr = (uint64_t)i; memcpy(nonce + 4, &ctr, 8);
        hdr(h, (uint32_t)(n + 16), 0, 1000ull * (uint64_t)(i + 1));
        EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
        EVP_EncryptInit_ex(c, EVP_chacha20_poly1305(), NULL, NULL, NULL);
        EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_IVLEN, 12, NULL);
        EVP_EncryptInit_ex(c, NULL, NULL, key, nonce);
        EVP_EncryptUpdate(c, NULL, &ol, h, 128);
        EVP_EncryptUpdate(c, w, &ol, p, (int)n);
        EVP_EncryptFinal_ex(c, w + ol, &ol);
        EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_GET_TAG, 16, w + n);
        EVP_CIPHER_CTX_free(c);
        send_all(fd, h, 128); send_all(fd, w, n + 16);
        free(w);
    }
    memset(key, 0, sizeof key);
    usleep(200000);
    shutdown(fd, SHUT_RDWR); close(fd);
    return 0;
}

/* the phone's end of the events connection: one HTTP-style request
 * (request line, headers, Content-Length body), answered 200 */
static int read_request(int fd, char *line, size_t nline, unsigned char **body, size_t *nbody, char *ctype, size_t nctype) {
    char buf[8192]; size_t n = 0; char *end = NULL;
    struct timeval tv = { 3, 0 }; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    while (!(end = memmem(buf, n, "\r\n\r\n", 4))) {
        if (n == sizeof buf) return -1;
        ssize_t k = recv(fd, buf + n, sizeof buf - n, 0);
        if (k <= 0) return -1;
        n += (size_t)k;
    }
    size_t hl = (size_t)(end - buf) + 4;
    char *eol = memmem(buf, hl, "\r\n", 2);
    snprintf(line, nline, "%.*s", (int)(eol - buf), buf);
    size_t clen = 0; char cseq[32] = "";
    for (char *h = eol + 2; h < end; ) {
        char *e = memmem(h, (size_t)(end + 2 - h), "\r\n", 2);
        if (!strncasecmp(h, "Content-Length:", 15)) clen = strtoul(h + 15, NULL, 10);
        if (!strncasecmp(h, "Content-Type:", 13)) snprintf(ctype, nctype, "%.*s", (int)(e - h - 14), h + 14);
        if (!strncasecmp(h, "CSeq:", 5)) snprintf(cseq, sizeof cseq, "%.*s", (int)(e - h - 6), h + 6);
        h = e + 2;
    }
    *body = malloc(clen + 1); *nbody = clen;
    size_t have = n - hl < clen ? n - hl : clen;
    memcpy(*body, buf + hl, have);
    while (have < clen) { ssize_t k = recv(fd, *body + have, clen - have, 0); if (k <= 0) return -1; have += (size_t)k; }
    char ok[128];
    int m = snprintf(ok, sizeof ok, "RTSP/1.0 200 OK\r\nCSeq: %s\r\nContent-Length: 0\r\n\r\n", cseq[0] ? cseq : "0");
    send_all(fd, ok, (size_t)m);
    return 0;
}

static void set_mode(const char *path, const char *m) { FILE *f = fopen(path, "w"); if (f) { fputs(m, f); fclose(f); } }

static void sink_reset(void) {
    got_avcc_n = 0; got_start = got_stop = got_frames = bad_frames = 0;
    for (int i = 0; i < 16; i++) { free(want[i]); want[i] = NULL; }
}
struct phone_args { int port; uint64_t cid; const unsigned char *sk; int frames; };
static void *phone_thread(void *a_) { struct phone_args *a = a_; phone_hold(a->port, a->cid, a->sk, a->frames, 1); return NULL; }
static double now_s(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (double)t.tv_sec + t.tv_nsec / 1e9; }
static int port_free(int port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0), one = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
    int ok = bind(fd, (struct sockaddr *)&a, sizeof a) == 0;
    close(fd);
    return ok;
}

/* ---- the phone's timing (NTP-like) port ----
 * A session with a screen runs timing (_TimingNegotiate in 0x17c0e0, then the
 * timing thread 0x17b460): 32-byte requests {0x80, 0xd2, ..., transmit time at
 * +24}, answered {0x80, 0xd3, ..., origin = the request's transmit time at +8,
 * receive time at +16, transmit time at +24} (0x17aee0 / 0x17b050). The
 * session's timing socket goes to the peer address (+0x100, 0.0.0.0 here: this
 * host) at the request's timingPort, default 6002. */
static volatile int timing_replies;
static void ntp_now(unsigned char out[8]) {
    struct timespec t; clock_gettime(CLOCK_REALTIME, &t);
    uint32_t s = (uint32_t)(t.tv_sec + 2208988800u), f = (uint32_t)(((uint64_t)t.tv_nsec << 32) / 1000000000u);
    s = htonl(s); f = htonl(f); memcpy(out, &s, 4); memcpy(out + 4, &f, 4);
}
static void *timing_peer(void *arg) {
    int fd = *(int *)arg;
    for (;;) {
        unsigned char q[64], r[32]; struct sockaddr_storage from; socklen_t fl = sizeof from;
        ssize_t n = recvfrom(fd, q, sizeof q, 0, (struct sockaddr *)&from, &fl);
        if (n < 32 || q[1] != 0xd2) continue;
        memset(r, 0, sizeof r); r[0] = 0x80; r[1] = 0xd3; r[3] = 7;
        memcpy(r + 8, q + 24, 8); ntp_now(r + 16); ntp_now(r + 24);
        sendto(fd, r, sizeof r, 0, (struct sockaddr *)&from, fl);
        timing_replies++;
    }
    return NULL;
}
static int start_timing_peer(int port) {
    static int fd; static pthread_t t;
    fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in a = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
    if (bind(fd, (struct sockaddr *)&a, sizeof a) != 0) { perror("timing peer bind"); return -1; }
    return pthread_create(&t, NULL, timing_peer, &fd);
}

/* ---- a fake Cinemo configuration with one "displays" item ---- */
/* the caller's stack buffer in the list builder (0x10c050): exactly 0x48 bytes,
 * its stack canary right after (local_88 .. local_48) */
struct item { char name[40]; int type; int pad0; uint32_t id; int pad1; uint32_t arg; int pad2; uint64_t len; };
_Static_assert(sizeof(struct item) == 0x48, "config item layout");
static const char *DISPLAY_URL =
    "?uuid=11111111-2222-3333-4444-555555555555&widthPixels=1280&heightPixels=480"
    "&widthPhysical=300&heightPhysical=112&maxFPS=60&features=2&primaryInputDevice=1";
static long p_noop(void *t) { (void)t; return 0; }
static unsigned long p_count(void *t) { (void)t; return 1; }
static int p_get(void *t, unsigned long idx, struct item *it) {
    (void)t;
    if (idx != 1) return -1;
    memset(it, 0, sizeof *it);
    strcpy(it->name, "displays"); it->type = 1; it->id = 1; it->len = strlen(DISPLAY_URL) + 1;
    return 0;
}
static int p_read(void *t, void *buf, uint32_t id, int z, unsigned long len) {
    (void)t; (void)z;
    if (id != 1 || !buf) return -1;
    memcpy(buf, DISPLAY_URL, len < strlen(DISPLAY_URL) + 1 ? len : strlen(DISPLAY_URL) + 1);
    return 0;
}
static void *vtable[16];
static struct { void **vt; } provider = { vtable };

static void dump_display(CF d, const char *label) {
    static const struct { const char *n; uintptr_t k; } keys[] = {
        {"widthPixels", 0x1a0af4}, {"heightPixels", 0x1a0ac8}, {"widthPhysical", 0x1a0b08},
        {"heightPhysical", 0x1a0add}, {"maxFPS", 0x1a0ab9}, {"features", 0x1a0aa8}, {"primaryInputDevice", 0x1a0b1e} };
    printf("  %s:", label);
    for (unsigned i = 0; i < sizeof keys / sizeof *keys; i++) {
        int e = 0; int64_t v = CFDictGetI64(d, AT(keys[i].k), &e);
        if (!e) printf(" %s=%lld", keys[i].n, (long long)v);
    }
    printf("\n");
}

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: %s <libNmeCarPlay.so>\n", argv[0]); return 2; }
    setvbuf(stdout, NULL, _IONBF, 0);
    if (!dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL)) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 2; }
    uintptr_t b = hook111_find();
    CHECK("library is the expected build", b != 0);
    if (!b) return 1;
    CHECK("hook installs (all prologues as expected)", hook111_install(b, &test_sink, &test_disp) == 0);
    struct sigaction sa = { .sa_sigaction = on_segv, .sa_flags = SA_SIGINFO };
    sigaction(SIGSEGV, &sa, NULL); sigaction(SIGBUS, &sa, NULL);
    sigaction(SIGALRM, &sa, NULL);   /* the watchdog: a hang dumps the same way */
    alarm(60);
    char logdir[] = "/tmp/hook111-log.XXXXXX";
    hook111_log_to(mkdtemp(logdir));   /* the plist log, checked at the end */
    char modefile[600]; snprintf(modefile, sizeof modefile, "%s.mode", logdir);
    set_mode(modefile, "full");          /* the tests below until "modes" are for full */
    hook111_mode_file(modefile);
    CHECK("the phone's timing port (6002) is up", start_timing_peer(6002) == 0);

    /* ---------- SETUP ---------- */
    unsigned char *server = calloc(1, 0x200);
    *(int *)(server + 0xac) = 5;                       /* screen timeout, seconds */
    unsigned char *session = calloc(1, 0x1d00);
    *(void **)(session + 0x10) = server;
    *(uint16_t *)(session + 0x100) = AF_INET;
    unsigned char sk[16];
    for (int i = 0; i < 16; i++) sk[i] = (unsigned char)(0x5a ^ (i * 11));
    memcpy(session + 0x288, sk, 16);
    /* what the session constructor (0x17e0f0) sets: no sockets yet, +0x490 = 1.
     * With fd 0 at +0x1b68 the idle transition (0x17c0e0) thinks keep-alive is
     * running and walks the null +0x18. */
    *(uint16_t *)(session + 0x490) = 1;
    static const int fds32[] = { 0x488, 0x1b68, 0x1b70, 0x1adc, 0x1b20, 0x1b50, 0x1cd8 };
    for (unsigned i = 0; i < sizeof fds32 / sizeof *fds32; i++) *(int *)(session + fds32[i]) = -1;
    *(int64_t *)(session + 0x4c0) = -1;
    *(int64_t *)(session + 0xdd8) = -1;
    /* Cinemo's platform object (setUpStreams, 0x173a30 / 0x172ba0): with no
     * audio stream in the request it is only read, and zero means "none" */
    *(void **)(session + 0x20) = calloc(1, 0x200);

    const uint64_t cid = 6644744161078495396ull;       /* the size the phone uses */
    CF req = CFDictCreate(), streams = CFArrayCreate(), st = CFDictCreate(), feats = CFArrayCreate(), s;
    CFDictSetI64(st, K_TYPE, 111);
    CFDictSetI64(st, K_CONNID, (int64_t)cid);
    CFArrayAppend(streams, st);
    CFDictSet(req, K_STREAMS, streams);
    const char *offered[] = { "uiContext", "viewAreas", "altScreen", "hevc" };
    for (int i = 0; i < 4; i++) { s = CFStr(offered[i]); CFArrayAppend(feats, s); CFRelease(s); }
    CFDictSet(req, K_FEATURES, feats);

    CF resp = NULL;
    int rc = FN(int (*)(void *, CF, CF *), 0x180670)(session, req, &resp);   /* the library's own entry */
    CHECK("SETUP returns 0", rc == 0);
    CHECK("SETUP produced a response", resp != NULL);
    int err = 0, port = 0;
    CF rs = resp ? CFDictGetTyped(resp, K_STREAMS, CFArrayTypeID(), &err) : NULL;
    if (rs && CFArrayCount(rs) > 0) {
        CF e0 = CFArrayAt(rs, 0);
        int64_t t = CFDictGetI64(e0, K_TYPE, &err);
        port = (int)CFDictGetI64(e0, K_DATAPORT, &err);
        printf("  response streams[0]: type=%lld dataPort=%d\n", (long long)t, port);
        CHECK("response stream is type 111", t == 111);
    } else CHECK("response has a streams entry", 0);
    CHECK("dataPort is the requested one (6031)", port == 6031);
    CF ef = resp ? CFDictGetTyped(resp, CFStr("enabledFeatures"), CFArrayTypeID(), &err) : NULL;
    int has_alt = 0, has_va = 0, n_ef = ef ? CFArrayCount(ef) : 0;
    if (ef) { has_alt = CFArrayIndexOf(ef, CFStr("altScreen")) >= 0; has_va = CFArrayIndexOf(ef, CFStr("viewAreas")) >= 0; }
    CHECK("enabledFeatures = [altScreen, viewAreas]", n_ef == 2 && has_alt && has_va);

    if (port > 0) phone(port, cid, sk, 10);
    for (int i = 0; i < 100 && !hook111_stats.pump_done; i++) usleep(50000);
    printf("  screen B: accepted=%d pump rc=%d\n", hook111_stats.accepted, hook111_stats.pump_rc);
    CHECK("phone connection accepted on the dataPort", hook111_stats.accepted == 1);
    CHECK("sink got the AVCC", got_avcc_n == sizeof AVCC && !memcmp(got_avcc, AVCC, sizeof AVCC));
    CHECK("sink got 10/10 frames, byte-exact (key derived from streamConnectionID)", got_frames == 10 && bad_frames == 0);
    CHECK("stream started and stopped", got_start == 1 && got_stop == 1);

    /* ---------- lifecycle: repeat SETUP, TEARDOWN {111}, full TEARDOWN ---------- */
    void (*teardown)(void *, CF, int, void *) = FN(void (*)(void *, CF, int, void *), 0x17e840);  /* the library's own entry */
    CF req111 = CFDictCreate(), streams111 = CFArrayCreate(), st111 = CFDictCreate();
    CFDictSetI64(st111, K_TYPE, 111);
    CFArrayAppend(streams111, st111);
    CFDictSet(req111, K_STREAMS, streams111);

    /* 1. a repeat SETUP while the first screen B still exists (its stream ended) */
    sink_reset();
    const uint64_t cid2 = 1234567890123ull;
    CFDictSetI64(st, K_CONNID, (int64_t)cid2);
    resp = NULL;
    rc = FN(int (*)(void *, CF, CF *), 0x180670)(session, req, &resp);
    port = 0;
    rs = resp ? CFDictGetTyped(resp, K_STREAMS, CFArrayTypeID(), &err) : NULL;
    if (rs && CFArrayCount(rs) > 0) port = (int)CFDictGetI64(CFArrayAt(rs, 0), K_DATAPORT, &err);
    CHECK("repeat SETUP: the old screen B torn down first", hook111_stats.teardowns == 1);
    CHECK("repeat SETUP: port 6031 again (old listener closed)", rc == 0 && port == 6031);

    /* 2. TEARDOWN {streams:[{type:111}]} mid-stream, the phone holding the connection */
    pthread_t pt;
    struct phone_args pa = { port, cid2, sk, 5 };
    pthread_create(&pt, NULL, phone_thread, &pa);
    for (int i = 0; i < 100 && got_frames < 5; i++) usleep(20000);
    CHECK("second stream: 5/5 frames byte-exact (new key)", got_frames == 5 && bad_frames == 0);
    double t0 = now_s();
    teardown(session, req111, 0, NULL);
    double dt = now_s() - t0;
    pthread_join(pt, NULL);
    printf("  TEARDOWN {111} mid-stream took %.3f s\n", dt);
    CHECK("TEARDOWN {111}: screen B down, promptly", hook111_stats.teardowns == 2 && dt < 1.0);
    CHECK("TEARDOWN {111}: sink stopped, phone's connection closed", got_stop == 1);
    CHECK("TEARDOWN {111}: port 6031 free", port_free(6031));

    /* 3. full TEARDOWN (the connection closing) while screen B waits in accept */
    sink_reset();
    CFDictSetI64(st, K_CONNID, (int64_t)cid);
    resp = NULL;
    rc = FN(int (*)(void *, CF, CF *), 0x180670)(session, req, &resp);
    CHECK("third SETUP returns 0", rc == 0 && hook111_stats.setups_111 == 3);
    t0 = now_s();
    teardown(session, NULL, 0, NULL);
    dt = now_s() - t0;
    printf("  full TEARDOWN, screen B in accept, took %.3f s\n", dt);
    CHECK("full TEARDOWN: screen B down without waiting out accept", hook111_stats.teardowns == 3 && dt < 1.0);
    CHECK("full TEARDOWN: port 6031 free", port_free(6031));

    /* 4. the pair-verify key path: a PairingSession at session+0x498 as
     * 0x15b260 reads it (+0x48 type 3 = verify server, +0x60 state 5 = done,
     * +0x1ba the 32-byte shared secret) */
    sink_reset();
    unsigned char *pairing = calloc(1, 0x400), secret[32];
    for (int i = 0; i < 32; i++) secret[i] = (unsigned char)(0xa5 ^ (i * 29));
    *(int *)(pairing + 0x48) = 3; pairing[0x60] = 5; memcpy(pairing + 0x1ba, secret, 32);
    *(void **)(session + 0x498) = pairing;
    const uint64_t cid3 = 9988776655443322110ull;
    CFDictSetI64(st, K_CONNID, (int64_t)cid3);
    resp = NULL; port = 0;
    rc = FN(int (*)(void *, CF, CF *), 0x180670)(session, req, &resp);
    rs = resp ? CFDictGetTyped(resp, K_STREAMS, CFArrayTypeID(), &err) : NULL;
    if (rs && CFArrayCount(rs) > 0) port = (int)CFDictGetI64(CFArrayAt(rs, 0), K_DATAPORT, &err);
    CHECK("pair-verify SETUP: 111 on 6031", rc == 0 && port == 6031);
    if (port > 0) phone_chacha(port, cid3, secret, 8);
    for (int i = 0; i < 100 && !hook111_stats.pump_done; i++) usleep(20000);
    printf("  pair-verify: frames %d, bad %d, pump rc %d\n", got_frames, bad_frames, hook111_stats.pump_rc);
    CHECK("pair-verify: AVCC + 8/8 ChaCha20-Poly1305 frames byte-exact (HKDF key from connID)",
          got_avcc_n == sizeof AVCC && got_frames == 8 && bad_frames == 0);
    teardown(session, req111, 0, NULL);
    CHECK("pair-verify: torn down", hook111_stats.teardowns == 4);
    *(void **)(session + 0x498) = NULL;   /* ours, not a CF object: keep it from the stock teardown */

    /* 4b. the idle state: a session the way the phone sets one up (keep-alive
     * asked for), then the car's sequence from the unit (2026-11-04): 111 up,
     * the main screen up and torn down when the iDrive takes the screen back.
     * Stock, the session then goes idle: timing stops and the keep-alive
     * receiver (0x17a7b0) starts, and with no beacon from the phone (it is
     * streaming 111, so it isn't idle) it ends the session after 30 s. With
     * screen B counted as a screen the session must stay active. */
    {
        unsigned char *s2 = calloc(1, 0x1d00);
        *(void **)(s2 + 0x10) = server;
        *(uint16_t *)(s2 + 0x100) = AF_INET;
        memcpy(s2 + 0x288, sk, 16);
        *(uint16_t *)(s2 + 0x490) = 1;
        for (unsigned i = 0; i < sizeof fds32 / sizeof *fds32; i++) *(int *)(s2 + fds32[i]) = -1;
        *(int64_t *)(s2 + 0x4c0) = -1;
        *(int64_t *)(s2 + 0xdd8) = -1;
        *(void **)(s2 + 0x20) = calloc(1, 0x200);
        /* the idle branch sets keep-alive on Cinemo's control socket, [[+0x18]+8]+0x78 */
        unsigned char *c1 = calloc(1, 0x100), *c2 = calloc(1, 0x100);
        *(void **)(c1 + 8) = c2; *(int *)(c2 + 0x78) = socket(AF_INET, SOCK_STREAM, 0);
        *(void **)(s2 + 0x18) = c1;
        /* the stock screen object, as the constructor makes it (0x185440 into +0x1cd0) */
        FN(int (*)(void **), 0x185440)((void **)(s2 + 0x1cd0));
        #define KA_RUNNING() (*(void **)(s2 + 0x1b80) != NULL)   /* the keep-alive receiver thread */
        #define TIMING()     (*(void **)(s2 + 0x1b60) != NULL)   /* the timing thread */
        #define SCREEN_FLAG() (*(char *)(s2 + 0x1cc8))
        CF r2;
        int (*setup)(void *, CF, CF *) = FN(int (*)(void *, CF, CF *), 0x180670);

        /* the phone's first SETUP: no streams, keepAliveLowPower */
        CF first = CFDictCreate(), kalp = CFStr("keepAliveLowPower");
        CFDictSet(first, K_FEATURES, feats);
        CFDictSetI64(first, kalp, 1);
        r2 = NULL; rc = setup(s2, first, &r2);
        int e2 = 0;
        int kap = r2 ? (int)CFDictGetI64(r2, CFStr("keepAlivePort"), &e2) : 0;
        printf("  idle: first SETUP rc %d, keepAlivePort %d, keep-alive %s, timing %s\n", rc, kap, KA_RUNNING() ? "running" : "stopped", TIMING() ? "running" : "stopped");
        CHECK("idle: the first SETUP sets up keep-alive, and the session starts idle (keep-alive receiver running)",
              rc == 0 && *(int *)(s2 + 0x1b68) >= 0 && kap > 0 && KA_RUNNING() && !TIMING());

        /* SETUP {111} */
        int held0 = hook111_stats.idle_held;
        CFDictSetI64(st, K_CONNID, (int64_t)cid);
        r2 = NULL; rc = setup(s2, req, &r2);
        printf("  idle: SETUP {111} rc %d, keep-alive %s, timing %s, idle_rc %d, timing replies %d\n", rc, KA_RUNNING() ? "running" : "stopped", TIMING() ? "running" : "stopped", hook111_stats.idle_rc, timing_replies);
        CHECK("idle: SETUP {111} makes the session active: keep-alive receiver stopped, timing running",
              rc == 0 && current_b && current_b->session == s2 && !KA_RUNNING() && TIMING() && hook111_stats.idle_held > held0 && hook111_stats.idle_rc == 0);
        CHECK("idle: the screen flag is left clear (a 110 SETUP isn't refused)", SCREEN_FLAG() == 0);

        /* SETUP {110}, the main screen, while screen B is up */
        CF req110 = CFDictCreate(), streams110 = CFArrayCreate(), st110 = CFDictCreate();
        CFDictSetI64(st110, K_TYPE, 110);
        CFDictSetI64(st110, K_CONNID, 777777777ll);
        CFArrayAppend(streams110, st110);
        CFDictSet(req110, K_STREAMS, streams110);
        r2 = NULL; rc = setup(s2, req110, &r2);
        int p110 = 0;
        CF rs2 = r2 ? CFDictGetTyped(r2, K_STREAMS, CFArrayTypeID(), &err) : NULL;
        if (rs2 && CFArrayCount(rs2) > 0 && CFDictGetI64(CFArrayAt(rs2, 0), K_TYPE, &err) == 110) p110 = (int)CFDictGetI64(CFArrayAt(rs2, 0), K_DATAPORT, &err);
        printf("  idle: SETUP {110} rc %d, dataPort %d\n", rc, p110);
        CHECK("idle: SETUP {110} with screen B up: set up (stock screen flag set), still active",
              rc == 0 && p110 > 0 && SCREEN_FLAG() == 1 && !KA_RUNNING() && TIMING() && current_b);

        /* TEARDOWN {110}: the iDrive takes its screen back (the car's case) */
        teardown(s2, req110, 0, NULL);
        printf("  idle: after TEARDOWN {110}: keep-alive %s, timing %s, screen B %s\n", KA_RUNNING() ? "running" : "stopped", TIMING() ? "running" : "stopped", current_b ? "up" : "down");
        CHECK("idle: TEARDOWN {110} with screen B up: the session stays active (no keep-alive receiver, timing running)",
              SCREEN_FLAG() == 0 && current_b && !KA_RUNNING() && TIMING());

        /* the main screen comes back, and goes again */
        r2 = NULL; rc = setup(s2, req110, &r2);
        CHECK("idle: the main screen set up again after its teardown", rc == 0 && SCREEN_FLAG() == 1);
        teardown(s2, req110, 0, NULL);
        CHECK("idle: and torn down again, still active", SCREEN_FLAG() == 0 && current_b && !KA_RUNNING() && TIMING());

        /* TEARDOWN {111}: no stream left, idle again */
        teardown(s2, req111, 0, NULL);
        printf("  idle: after TEARDOWN {111}: keep-alive %s, timing %s\n", KA_RUNNING() ? "running" : "stopped", TIMING() ? "running" : "stopped");
        CHECK("idle: TEARDOWN {111}, nothing left: idle again (keep-alive receiver running, timing stopped)",
              !current_b && KA_RUNNING() && !TIMING());

        /* the stock behaviour without screen B, as a control: the main screen
         * alone, up and down, ends idle (what the test above guards against) */
        r2 = NULL; rc = setup(s2, req110, &r2);
        CHECK("idle (control, no screen B): SETUP {110} makes the session active", rc == 0 && !KA_RUNNING() && TIMING());
        teardown(s2, req110, 0, NULL);
        CHECK("idle (control, no screen B): TEARDOWN {110} goes idle, keep-alive receiver running", KA_RUNNING() && !TIMING());

        /* the session ends */
        teardown(s2, NULL, 0, NULL);
        FN(int (*)(void *), 0x179d20)(s2);   /* keep-alive stop (finalize does it on the unit) */
        CHECK("idle: full TEARDOWN: timing stopped, the flag clear", !TIMING() && SCREEN_FLAG() == 0 && !KA_RUNNING());
        FN(int (*)(void *), 0x17c990)(s2);
        #undef KA_RUNNING
        #undef TIMING
        #undef SCREEN_FLAG
    }

    /* 5. suggestUI from the phone -> showUI back on the events connection.
     * The events side as the constructor (0x17e0f0) and _ControlStart (0x17ec00)
     * set it up: queues at +8 and +0x468, a timer at +0x480, then an HTTP
     * client on the accepted events socket at +0x470 (here a socketpair), +0x466 */
    void *(*queue_create)(const char *, void *) = FN(void *(*)(const char *, void *), 0x148110);
    void *evq = queue_create("AirPlayReceiverSessionEventQueue", NULL);
    *(void **)(session + 0x468) = evq;
    if (!*(void **)(session + 8)) *(void **)(session + 8) = queue_create("hook111-test-session", NULL);
    *(void **)(session + 0x480) = FN(void *(*)(int, long, long, void *), 0x146240)(2, 0, 0, evq);
    CHECK("showUI before the events connection: refused (-6709)", hook111_send_command(session, "showUI", NULL) == -6709);
    int sv[2];
    socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
    rc = FN(int (*)(void *, int), 0x14a040)(session + 0x470, sv[0]);
    FN(void (*)(void *, void *), 0x14a1b0)(*(void **)(session + 0x470), evq);
    FN(void (*)(void *), 0x14a230)(*(void **)(session + 0x470));
    *(char *)(session + 0x466) = 1;
    CHECK("events connection up (library HTTP client)", rc == 0 && *(void **)(session + 0x470));
    CF sparams = CFDictCreate(), surl = CFStr("maps:/car/instrumentcluster/map"), sresp = NULL;
    CFDictSet(sparams, K_URL, surl);
    CF scmd = CFStr("suggestUI");
    int sent_before = hook111_stats.commands_sent;
    rc = FN(int (*)(void *, int, CF, CF, CF, CF *), 0x183bf0)(session, 1, scmd, NULL, sparams, &sresp);   /* as /command does */
    CHECK("suggestUI accepted (0)", rc == 0 && hook111_stats.suggest_ui == 1);
    char line[256] = "", ctype[128] = ""; unsigned char *body = NULL; size_t nbody = 0;
    int got = read_request(sv[1], line, sizeof line, &body, &nbody, ctype, sizeof ctype);   /* waits 3 s */
    CHECK("suggestUI: nothing sent back (on the car a showUI cost the main screen)", got != 0 && hook111_stats.commands_sent == sent_before);
    int perr2 = 0;
    CF cmd = NULL, ctyp = NULL, cpar = NULL;
    (void)surl;
    /* forceKeyFrame for screen B, rate-limited */
    resp = NULL;
    rc = FN(int (*)(void *, CF, CF *), 0x180670)(session, req, &resp);
    int kr1 = hook111_request_keyframe(), kr2 = hook111_request_keyframe();
    free(body); body = NULL;
    got = read_request(sv[1], line, sizeof line, &body, &nbody, ctype, sizeof ctype);
    cmd = got == 0 ? FN(CF (*)(const void *, size_t, int *), 0x13a550)(body, nbody, &perr2) : NULL;
    ctyp = cmd ? CFDictGetTyped(cmd, K_TYPE, CFStrTypeID(), &err) : NULL;
    CF fkf = CFStr("forceKeyFrame");
    CHECK("keyframe request: forceKeyFrame reaches the phone", rc == 0 && kr1 == 0 && ctyp && CFEqual(ctyp, fkf));
    {
        CF kp = cmd ? CFDictGetTyped(cmd, K_PARAMS, CFDictTypeID(), &err) : NULL, ku = CFStr(test_disp.uuid);
        CHECK("keyframe request: names screen B's display ({uuid}), as the phone needs", kp && CFEqual(CFDictGetTyped(kp, K_UUID, CFStrTypeID(), &err), ku));
    }
    CHECK("keyframe request: a second within the second is refused", kr2 == -6721 && hook111_stats.keyframe_requests == 1);
    teardown(session, req111, 0, NULL);
    CHECK("other commands still reach the stock code", FN(int (*)(void *, int, CF, CF, CF, CF *), 0x183bf0)(session, 1, CFStr("noSuchCommand"), NULL, NULL, &sresp) != 0);

    /* commands from the bench: <log dir>/send.plist, sent on the phone's next command */
    {
        char sp[700], done[700];
        snprintf(sp, sizeof sp, "%s/send.plist", logdir);
        CF bc = CFDictCreate(), bp = CFDictCreate(), bt = CFStr("requestUI"), bu = CFStr("maps:/car/instrumentcluster");
        CFDictSet(bp, K_URL, bu); CFDictSet(bc, K_TYPE, bt); CFDictSet(bc, K_PARAMS, bp);
        size_t bl = 0; void *bb = FN(void *(*)(CF, size_t *, int *), 0x139750)(bc, &bl, NULL);
        FILE *bf = fopen(sp, "wb"); fwrite(bb, 1, bl, bf); fclose(bf); free(bb);
        int sent0 = hook111_stats.sent_files;
        FN(int (*)(void *, int, CF, CF, CF, CF *), 0x183bf0)(session, 1, CFStr("noSuchCommand"), NULL, NULL, &sresp);   /* the phone's next command */
        free(body); body = NULL;
        got = read_request(sv[1], line, sizeof line, &body, &nbody, ctype, sizeof ctype);
        cmd = got == 0 ? FN(CF (*)(const void *, size_t, int *), 0x13a550)(body, nbody, &perr2) : NULL;
        ctyp = cmd ? CFDictGetTyped(cmd, K_TYPE, CFStrTypeID(), &err) : NULL;
        cpar = cmd ? CFDictGetTyped(cmd, K_PARAMS, CFDictTypeID(), &err) : NULL;
        snprintf(done, sizeof done, "%s/send.%d.done", logdir, sent0 + 1);
        CHECK("bench send.plist: reaches the phone as it is", ctyp && CFEqual(ctyp, bt) && cpar && CFEqual(CFDictGetTyped(cpar, K_URL, CFStrTypeID(), &err), bu));
        CHECK("bench send.plist: consumed (renamed .done), rc 0 in the status", access(sp, F_OK) != 0 && access(done, F_OK) == 0 && hook111_stats.last_send_rc == 0);
        bf = fopen(sp, "wb"); fputs("not a plist", bf); fclose(bf);
        FN(int (*)(void *, int, CF, CF, CF, CF *), 0x183bf0)(session, 1, CFStr("noSuchCommand"), NULL, NULL, &sresp);
        CHECK("bench send.plist that isn't a command: consumed once, kFormatErr, nothing sent", access(sp, F_OK) != 0 && hook111_stats.last_send_rc == -6705);
        /* the noisy commands' own cap */
        int before = hook111_stats.logged;
        CF iap = CFStr("iAPSendMessage");
        for (int k = 0; k < 6; k++) log_command("command", iap, NULL);
        CHECK("iAPSendMessage: only the first 3 logged", hook111_stats.logged - before == 3);
        /* the status file */
        status_now(1);
        char stp[700], sl[256]; snprintf(stp, sizeof stp, "%s/status", logdir);
        FILE *sf = fopen(stp, "r"); int have_setups = 0, have_sent = 0;
        while (sf && fgets(sl, sizeof sl, sf)) {
            int v;
            if (sscanf(sl, "setups_111=%d", &v) == 1 && v == hook111_stats.setups_111) have_setups = 1;
            if (sscanf(sl, "sent_files=%d", &v) == 1 && v == hook111_stats.sent_files) have_sent = 1;
        }
        if (sf) fclose(sf);
        CHECK("status file: the counters as they are", have_setups && have_sent);
    }

    /* ---------- /info ---------- */
    for (int i = 0; i < 16; i++) vtable[i] = (void *)p_noop;
    vtable[0x28 / 8] = (void *)p_count; vtable[0x30 / 8] = (void *)p_get; vtable[0x40 / 8] = (void *)p_read;
    unsigned char *cfg = calloc(1, 0x1000);
    pthread_mutex_init((pthread_mutex_t *)(cfg + 0x8e8), NULL);
    *(void **)(cfg + 0x818) = &provider;
    int perr = 0;
    CF displays = FN(CF (*)(void *, CF, void *, int *, void *), 0x10d270)(NULL, K_DISPLAYS, NULL, &perr, cfg);
    int nd = displays && CFTypeOf(displays) == CFArrayTypeID() ? CFArrayCount(displays) : -1;
    printf("  /info displays: %d record(s), err %d\n", nd, perr);
    if (nd >= 1) dump_display(CFArrayAt(displays, 0), "[0] stock, from the configuration");
    if (nd >= 2) dump_display(CFArrayAt(displays, 1), "[1] hook111");
    CHECK("/info displays has the stock record and hook111's", nd == 2);
    if (nd == 2) {
        CF d1 = CFArrayAt(displays, 1);
        int e = 0;
        CHECK("second record: 1088x480, features 2", CFDictGetI64(d1, K_WPX, &e) == 1088 && CFDictGetI64(d1, K_HPX, &e) == 480 && CFDictGetI64(d1, K_FEATURES, &e) == 2 && !e);
        CF urls = CFDictGetTyped(d1, CFStr("altScreenSuggestUIURLs"), CFArrayTypeID(), &e);
        CHECK("second record: 3 altScreenSuggestUIURLs", urls && CFArrayCount(urls) == 3);
    }
    /* ---------- the second display's size, per target (/run/hook111/display) ---------- */
    {
        char dfile[640]; snprintf(dfile, sizeof dfile, "%s.display", logdir);
        hook111_display_file(dfile);
        #define REC1() ({ int pe = 0; CF dd = FN(CF (*)(void *, CF, void *, int *, void *), 0x10d270)(NULL, K_DISPLAYS, NULL, &pe, cfg); \
                          dd && CFTypeOf(dd) == CFArrayTypeID() && CFArrayCount(dd) == 2 ? CFArrayAt(dd, 1) : NULL; })
        int e = 0;
        CF r = REC1();
        CHECK("display file configured but missing: the configured 1088x480", r && CFDictGetI64(r, K_WPX, &e) == 1088 && CFDictGetI64(r, K_HPX, &e) == 480);
        set_mode(dfile, "1056x384@30\n");
        r = REC1();
        CHECK("1056x384@30 (the HUD): advertised, physical size at the same density (194x70 mm), maxFPS 30",
              r && CFDictGetI64(r, K_WPX, &e) == 1056 && CFDictGetI64(r, K_HPX, &e) == 384 &&
              CFDictGetI64(r, K_WMM, &e) == 200 * 1056 / 1088 && CFDictGetI64(r, K_HMM, &e) == 88 * 384 / 480 && CFDictGetI64(r, K_MAXFPS, &e) == 30 && !e);
        status_now(1);
        char stp[700], sl[256]; snprintf(stp, sizeof stp, "%s/status", logdir);
        FILE *sf = fopen(stp, "r"); int said = 0;
        while (sf && fgets(sl, sizeof sl, sf)) if (!strcmp(sl, "display=1056x384@30\n")) said = 1;
        if (sf) fclose(sf);
        CHECK("the status says what was offered (display=1056x384@30)", said);
        set_mode(dfile, "1088x480@15");
        r = REC1();
        CHECK("1088x480@15: the cluster size at 15 fps", r && CFDictGetI64(r, K_WPX, &e) == 1088 && CFDictGetI64(r, K_MAXFPS, &e) == 15);
        static const char *bad[] = { "1001x384@30", "1056x385@30", "1056x384@90", "4000x384@30", "1056x384@30x", "garbage", "" };
        int all_default = 1;
        for (unsigned i = 0; i < sizeof bad / sizeof *bad; i++) {
            set_mode(dfile, bad[i]);
            r = REC1();
            if (!r || CFDictGetI64(r, K_WPX, &e) != 1088 || CFDictGetI64(r, K_HPX, &e) != 480 || CFDictGetI64(r, K_MAXFPS, &e) != 30) { all_default = 0; printf("  not refused: \"%s\"\n", bad[i]); }
        }
        CHECK("not a multiple of 8, odd, fps out of range, too wide, trailing junk, garbage, empty: the configured display", all_default);
        unlink(dfile);
        hook111_display_file(NULL);

        /* the view (style): /run/hook111/view, cluster | map | card -> initialURL */
        char vfile[640]; snprintf(vfile, sizeof vfile, "%s.view", logdir);
        hook111_view_file(vfile);
        CF iu = CFStr("initialURL"), url;
        #define VIEW_URL() (r = REC1(), url = r ? CFDictGetTyped(r, iu, CFStrTypeID(), &e) : NULL, url)
        #define URL_IS(u) ({ CF _w = CFStr(u); int _eq = VIEW_URL() && CFEqual(url, _w); CFRelease(_w); _eq; })
        CHECK("view file configured but missing: the configured initialURL", URL_IS("maps:/car/instrumentcluster"));
        set_mode(vfile, "card\n");
        CHECK("view card: initialURL .../instructioncard (the turn card alone)", URL_IS("maps:/car/instrumentcluster/instructioncard"));
        set_mode(vfile, "map");
        CHECK("view map: initialURL .../map", URL_IS("maps:/car/instrumentcluster/map"));
        {
            CF us = r ? CFDictGetTyped(r, CFStr("altScreenSuggestUIURLs"), CFArrayTypeID(), &e) : NULL;
            CHECK("view map: the three suggestUI URLs unchanged", us && CFArrayCount(us) == 3);
        }
        status_now(1);
        {
            char stp[700], sl[256]; snprintf(stp, sizeof stp, "%s/status", logdir);
            FILE *sf = fopen(stp, "r"); int said = 0;
            while (sf && fgets(sl, sizeof sl, sf)) if (!strcmp(sl, "view=map\n")) said = 1;
            if (sf) fclose(sf);
            CHECK("the status says which view was offered (view=map)", said);
        }
        set_mode(vfile, "cluster");
        CHECK("view cluster: initialURL maps:/car/instrumentcluster", URL_IS("maps:/car/instrumentcluster"));
        static const char *badv[] = { "cards", "Card", "card x", "", "maps:/car/instrumentcluster/map" };
        int vdef = 1;
        for (unsigned i = 0; i < sizeof badv / sizeof *badv; i++) {
            set_mode(vfile, "card"); (void)VIEW_URL();
            set_mode(vfile, badv[i]);
            if (!URL_IS("maps:/car/instrumentcluster")) { vdef = 0; printf("  view not refused: \"%s\"\n", badv[i]); }
        }
        CHECK("view: anything else (a near miss, a URL, empty) gives the configured initialURL", vdef);
        #undef VIEW_URL
        #undef URL_IS
        CFRelease(iu);
        unlink(vfile);
        hook111_view_file(NULL);

        /* the trial files: view areas merged into the records (the bytes
         * bench/make_viewareas.py writes for 936x480 x,y,w,h 168,48,600,400) */
        static const unsigned char INFO_B[] = {
            0x62,0x70,0x6c,0x69,0x73,0x74,0x30,0x30,0xa4,0x01,0x02,0x14,0x0d,0x59,0x76,0x69,0x65,0x77,0x41,0x72,0x65,0x61,0x73,0xa1,0x03,0xd7,0x04,0x05,0x06,0x07,0x08,0x09,0x0a,0x0b,0x0c,0x0d,0x0d,0x0e,0x0b,0x13,0x5f,0x10,0x15,0x64,0x72,0x61,0x77,0x55,0x49,0x4f,0x75,0x74,0x73,0x69,0x64,0x65,0x53,0x61,0x66,0x65,0x41,0x72,0x65,0x61,0x5c,0x68,0x65,0x69,0x67,0x68,0x74,0x50,0x69,0x78,0x65,0x6c,0x73,0x5d,0x6f,0x72,0x69,0x67,0x69,0x6e,0x58,0x50,0x69,0x78,0x65,0x6c,0x73,0x5d,0x6f,0x72,0x69,0x67,0x69,0x6e,0x59,0x50,0x69,0x78,0x65,0x6c,0x73,0x58,0x73,0x61,0x66,0x65,0x41,0x72,0x65,0x61,0x5f,0x10,0x19,0x76,0x69,0x65,0x77,0x41,0x72,0x65,0x61,0x54,0x72,0x61,0x6e,0x73,0x69,0x74,0x69,0x6f,0x6e,0x43,0x6f,0x6e,0x74,0x72,0x6f,0x6c,0x5b,0x77,0x69,0x64,0x74,0x68,0x50,0x69,0x78,0x65,0x6c,0x73,0x08,0x11,0x01,0xe0,0x10,0x00,0xd4,0x05,0x06,0x07,0x0a,0x0f,0x10,0x11,0x12,0x11,0x01,0x90,0x10,0xa8,0x10,0x30,0x11,0x02,0x58,0x11,0x03,0xa8,0x5f,0x10,0x0f,0x69,0x6e,0x69,0x74,0x69,0x61,0x6c,0x56,0x69,0x65,0x77,0x41,0x72,0x65,0x61,0x08,0x0d,0x17,0x19,0x28,0x40,0x4d,0x5b,0x69,0x72,0x8e,0x9a,0x9b,0x9e,0xa0,0xa9,0xac,0xae,0xb0,0xb3,0xb6,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x15,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0xc8 };
        char tdir[600]; snprintf(tdir, sizeof tdir, "%s.trial", logdir);
        mkdir(tdir, 0755);
        hook111_trial_dir(tdir);
        char tp[700];
        snprintf(tp, sizeof tp, "%s/info-b.plist", tdir);
        FILE *tf = fopen(tp, "wb"); fwrite(INFO_B, 1, sizeof INFO_B, tf); fclose(tf);
        {   /* info-a.plist: [testKeyA, 7], written with the library's own writer */
            CF pa = CFArrayCreate(), ka = CFStr("testKeyA"), seven = CFNumI64(7);
            CFArrayAppend(pa, ka); CFArrayAppend(pa, seven);
            size_t bl = 0; void *bb = FN(void *(*)(CF, size_t *, int *), 0x139750)(pa, &bl, NULL);
            snprintf(tp, sizeof tp, "%s/info-a.plist", tdir);
            tf = fopen(tp, "wb"); fwrite(bb, 1, bl, tf); fclose(tf); free(bb);
        }
        int pe = 0;
        CF dd = FN(CF (*)(void *, CF, void *, int *, void *), 0x10d270)(NULL, K_DISPLAYS, NULL, &pe, cfg);
        CF rb = dd && CFArrayCount(dd) == 2 ? CFArrayAt(dd, 1) : NULL, ra = dd ? CFArrayAt(dd, 0) : NULL;
        CF vas = rb ? CFDictGetTyped(rb, CFStr("viewAreas"), CFArrayTypeID(), &e) : NULL;
        CF va0 = vas && CFArrayCount(vas) == 1 ? CFArrayAt(vas, 0) : NULL;
        CF safe = va0 ? CFDictGetTyped(va0, CFStr("safeArea"), CFDictTypeID(), &e) : NULL;
        int e2 = 0;
        CHECK("trial info-b.plist: viewAreas [{936x480 at 0,0, safeArea 600x400 at 168,48}] and initialViewArea 0 in the second record",
              va0 && CFDictGetI64(va0, CFStr("widthPixels"), &e2) == 936 && CFDictGetI64(va0, CFStr("heightPixels"), &e2) == 480 &&
              safe && CFDictGetI64(safe, CFStr("originXPixels"), &e2) == 168 && CFDictGetI64(safe, CFStr("widthPixels"), &e2) == 600 &&
              CFDictGetI64(safe, CFStr("originYPixels"), &e2) == 48 && CFDictGetI64(safe, CFStr("heightPixels"), &e2) == 400 && !e2 &&
              CFDictGetI64(rb, CFStr("initialViewArea"), &e2) == 0 && !e2 && hook111_stats.info_extra_b == 2);
        CHECK("trial info-b.plist: the booleans came through (drawUIOutsideSafeArea, viewAreaTransitionControl)",
              va0 && (e2 = 0, CFDictGetI64(va0, CFStr("drawUIOutsideSafeArea"), &e2) == 0) && !e2 &&
              (e2 = 0, CFDictGetI64(va0, CFStr("viewAreaTransitionControl"), &e2) == 0) && !e2 &&
              (e2 = 0, CFDictGetI64(va0, CFStr("noSuchKey"), &e2), e2 != 0));
        CHECK("trial info-a.plist: merged into the main display's record", ra && CFDictGetI64(ra, CFStr("testKeyA"), &e2) == 7 && hook111_stats.info_extra_a == 1);
        snprintf(tp, sizeof tp, "%s/info-b.plist", tdir);
        tf = fopen(tp, "wb"); fputs("not a plist", tf); fclose(tf);
        dd = FN(CF (*)(void *, CF, void *, int *, void *), 0x10d270)(NULL, K_DISPLAYS, NULL, &pe, cfg);
        CHECK("trial info-b.plist that isn't a plist array: ignored, the record as before",
              dd && CFArrayCount(dd) == 2 && !CFDictGetTyped(CFArrayAt(dd, 1), CFStr("viewAreas"), CFArrayTypeID(), &e) && hook111_stats.info_extra_b == 0);
        unlink(tp);
        snprintf(tp, sizeof tp, "%s/info-a.plist", tdir); unlink(tp);

        /* the safe area, baked in: /run/hook111/safearea "x,y,w,h" -> viewAreas records */
        char sfile[640], dfile2[640];
        snprintf(sfile, sizeof sfile, "%s.safearea", logdir);
        snprintf(dfile2, sizeof dfile2, "%s.display2", logdir);
        hook111_safearea_file(sfile);
        hook111_display_file(dfile2);
        set_mode(dfile2, "984x480@30\n");
        CF r2 = REC1();
        CHECK("safe area file configured but missing: no viewAreas", r2 && !CFDictGetTyped(r2, CFStr("viewAreas"), CFArrayTypeID(), &e));
        set_mode(sfile, "322,80,340,330\n");
        r2 = REC1();
        CF vs = r2 ? CFDictGetTyped(r2, CFStr("viewAreas"), CFArrayTypeID(), &e) : NULL;
        CF v0 = vs && CFArrayCount(vs) == 1 ? CFArrayAt(vs, 0) : NULL;
        CF sa = v0 ? CFDictGetTyped(v0, CFStr("safeArea"), CFDictTypeID(), &e) : NULL;
        e2 = 0;
        CHECK("safe area 322,80,340,330 on 984x480: one view area, the whole display, with that safe area; initialViewArea 0",
              v0 && CFDictGetI64(v0, CFStr("widthPixels"), &e2) == 984 && CFDictGetI64(v0, CFStr("heightPixels"), &e2) == 480 &&
              CFDictGetI64(v0, CFStr("originXPixels"), &e2) == 0 && CFDictGetI64(v0, CFStr("originYPixels"), &e2) == 0 &&
              sa && CFDictGetI64(sa, CFStr("originXPixels"), &e2) == 322 && CFDictGetI64(sa, CFStr("originYPixels"), &e2) == 80 &&
              CFDictGetI64(sa, CFStr("widthPixels"), &e2) == 340 && CFDictGetI64(sa, CFStr("heightPixels"), &e2) == 330 && !e2 &&
              CFDictGetI64(r2, CFStr("initialViewArea"), &e2) == 0 && !e2);
        CHECK("safe area: drawUIOutsideSafeArea and viewAreaTransitionControl false (the library's own false)",
              v0 && (e2 = 0, CFDictGetI64(v0, CFStr("drawUIOutsideSafeArea"), &e2) == 0) && !e2 &&
              (e2 = 0, CFDictGetI64(v0, CFStr("viewAreaTransitionControl"), &e2) == 0) && !e2);
        status_now(1);
        {
            char stp[700], sl[256]; snprintf(stp, sizeof stp, "%s/status", logdir);
            FILE *sf = fopen(stp, "r"); int said = 0;
            while (sf && fgets(sl, sizeof sl, sf)) if (!strcmp(sl, "safearea=322,80,340,330\n")) said = 1;
            if (sf) fclose(sf);
            CHECK("the status says which safe area was offered", said);
        }
        static const char *bads[] = { "700,80,340,330", "322,200,340,330", "-1,80,340,330", "322,80,40,330", "322,80,340", "322,80,340,330x", "" };
        int sdef = 1;
        for (unsigned i = 0; i < sizeof bads / sizeof *bads; i++) {
            set_mode(sfile, bads[i]);
            r2 = REC1();
            if (!r2 || CFDictGetTyped(r2, CFStr("viewAreas"), CFArrayTypeID(), &e)) { sdef = 0; printf("  safe area not refused: \"%s\"\n", bads[i]); }
        }
        CHECK("safe area outside the display, negative, under 64 px, short, trailing junk, empty: no viewAreas", sdef);
        set_mode(dfile2, "936x480@30\n");
        set_mode(sfile, "322,80,640,330\n");   /* fits 984 wide, not 936: checked against the size offered now */
        r2 = REC1();
        CHECK("safe area checked against the size offered now (fits 984, not 936): no viewAreas", r2 && !CFDictGetTyped(r2, CFStr("viewAreas"), CFArrayTypeID(), &e));
        unlink(sfile); unlink(dfile2);
        hook111_display_file(NULL);
    }
    /* ---------- modes, and the fallback when the phone refuses ---------- */
    {
        /* the phone's first SETUP: no streams, the features it offers (as on the unit) */
        CF ctl = CFDictCreate(), ef_key = CFStr("enabledFeatures");
        CFDictSet(ctl, K_FEATURES, feats);
        CF empty = CFDictCreate();
        #define CTL_SETUP() (resp = NULL, FN(int (*)(void *, CF, CF *), 0x180670)(session, ctl, &resp))
        #define EF_COUNT() (resp && CFDictGetTyped(resp, ef_key, CFArrayTypeID(), &err) ? CFArrayCount(CFDictGetTyped(resp, ef_key, CFArrayTypeID(), &err)) : 0)
        #define INFO_N() ({ int pe = 0; CF dd = FN(CF (*)(void *, CF, void *, int *, void *), 0x10d270)(NULL, K_DISPLAYS, NULL, &pe, cfg); \
                            dd && CFTypeOf(dd) == CFArrayTypeID() ? CFArrayCount(dd) : -1; })
        set_mode(modefile, "off");
        rc = CTL_SETUP();
        CHECK("mode off: SETUP answered as stock (no enabledFeatures)", rc == 0 && resp && EF_COUNT() == 0);
        CHECK("mode off: /info has the stock display only", INFO_N() == 1);
        teardown(session, empty, 0, NULL);
        set_mode(modefile, "alt");
        rc = CTL_SETUP();
        CF efa = resp ? CFDictGetTyped(resp, ef_key, CFArrayTypeID(), &err) : NULL;
        CHECK("mode alt: enabledFeatures [altScreen] only", rc == 0 && efa && CFArrayCount(efa) == 1 && CFArrayIndexOf(efa, CFStr("altScreen")) >= 0);
        CHECK("mode alt: /info has both displays", INFO_N() == 2);
        teardown(session, empty, 0, NULL);
        CHECK("a refusal counted (alt, no stream SETUP)", hook111_stats.refusals == 1 && !hook111_fell_back());
        set_mode(modefile, "full");
        rc = CTL_SETUP();
        CHECK("mode full: enabledFeatures [altScreen, viewAreas]", rc == 0 && EF_COUNT() == 2);
        resp = NULL;
        rc = FN(int (*)(void *, CF, CF *), 0x180670)(session, req, &resp);   /* a stream SETUP in this session */
        teardown(session, empty, 0, NULL);
        CHECK("a session with a stream SETUP resets the count", hook111_stats.refusals == 0 && !hook111_fell_back());
        for (int k = 0; k < 3; k++) { CTL_SETUP(); (void)INFO_N(); teardown(session, empty, 0, NULL); }
        char fb[700]; snprintf(fb, sizeof fb, "%s/fallback", logdir);
        printf("  after 3 refused sessions: refusals %d, fell back %d\n", hook111_stats.refusals, hook111_fell_back());
        CHECK("3 refused sessions in a row: off for this run, and it says so", hook111_fell_back() && hook111_mode() == 0 && access(fb, F_OK) == 0);
        rc = CTL_SETUP();
        CHECK("after the fallback: SETUP as stock, though the file says full", rc == 0 && resp && EF_COUNT() == 0);
        CHECK("after the fallback: /info stock", INFO_N() == 1);
        teardown(session, empty, 0, NULL);
        /* the trial files: unfallback clears it; features replaces the mode's list */
        char tdir2[600], tp2[700];
        snprintf(tdir2, sizeof tdir2, "%s.trial", logdir);
        snprintf(tp2, sizeof tp2, "%s/unfallback", tdir2);
        FILE *uf = fopen(tp2, "w"); fclose(uf);
        set_mode(modefile, "alt");
        rc = CTL_SETUP();
        CHECK("trial unfallback: the fallback cleared at the next SETUP, the file consumed, its note gone",
              rc == 0 && !hook111_fell_back() && hook111_mode() == 1 && access(tp2, F_OK) != 0 && access(fb, F_OK) != 0 && EF_COUNT() == 1);
        teardown(session, empty, 0, NULL);
        snprintf(tp2, sizeof tp2, "%s/features", tdir2);
        set_mode(tp2, "altScreen viewAreas\ncornerMasks\n");   /* cornerMasks isn't offered here */
        rc = CTL_SETUP();
        CF eft = resp ? CFDictGetTyped(resp, ef_key, CFArrayTypeID(), &err) : NULL;
        CHECK("trial features altScreen viewAreas cornerMasks, mode alt: enabledFeatures [altScreen, viewAreas] (only what was offered)",
              rc == 0 && eft && CFArrayCount(eft) == 2 && CFArrayIndexOf(eft, CFStr("altScreen")) >= 0 && CFArrayIndexOf(eft, CFStr("viewAreas")) >= 0);
        status_now(1);
        {
            char stp[700], sl[256]; snprintf(stp, sizeof stp, "%s/status", logdir);
            FILE *sf = fopen(stp, "r"); int said = 0;
            while (sf && fgets(sl, sizeof sl, sf)) if (!strcmp(sl, "features=altScreen,viewAreas\n")) said = 1;
            if (sf) fclose(sf);
            CHECK("the status says which features were answered", said);
        }
        teardown(session, empty, 0, NULL);
        unlink(tp2);
        /* the safe area decides viewAreas in mode alt (no trial features file);
         * each ctl-only session counts as a refusal: the fallback cleared before each */
        snprintf(tp2, sizeof tp2, "%s/unfallback", tdir2);
        #define UNFALL() do { FILE *u_ = fopen(tp2, "w"); if (u_) fclose(u_); } while (0)
        char sfile2[640]; snprintf(sfile2, sizeof sfile2, "%s.safearea", logdir);
        set_mode(sfile2, "298,80,340,330\n");   /* inside the configured 1088x480 */
        UNFALL();
        rc = CTL_SETUP();
        CF efs = resp ? CFDictGetTyped(resp, ef_key, CFArrayTypeID(), &err) : NULL;
        CHECK("mode alt with a safe area: enabledFeatures [altScreen, viewAreas]",
              rc == 0 && efs && CFArrayCount(efs) == 2 && CFArrayIndexOf(efs, CFStr("viewAreas")) >= 0);
        teardown(session, empty, 0, NULL);
        set_mode(sfile2, "2000,80,340,330\n");
        UNFALL();
        rc = CTL_SETUP();
        CHECK("mode alt with a safe area that doesn't fit: [altScreen] only (no viewAreas without its records)", rc == 0 && EF_COUNT() == 1);
        teardown(session, empty, 0, NULL);
        unlink(sfile2);
        UNFALL();
        rc = CTL_SETUP();
        CHECK("mode alt without a safe area: [altScreen] only, as before", rc == 0 && EF_COUNT() == 1);
        teardown(session, empty, 0, NULL);
        hook111_safearea_file(NULL);
        unlink(tp2);
        hook111_trial_dir(NULL);
        #undef UNFALL
    }

    /* ---------- the plist log ---------- */
    {
        int counts[6] = {0}, parsed = 0, total = 0, streams_ok = 0, suggest_ok = 0;
        static const char *kinds[6] = { "setup-request", "setup-response", "command", "teardown", "info-displays", "sent" };
        DIR *d = opendir(logdir); struct dirent *e;
        CF su = CFStr("suggestUI");
        while (d && (e = readdir(d))) {
            if (e->d_name[0] == '.' || !strstr(e->d_name, ".bplist")) continue;
            total++;
            char p[512]; snprintf(p, sizeof p, "%s/%s", logdir, e->d_name);
            FILE *f = fopen(p, "rb"); if (!f) continue;
            static unsigned char buf[1 << 16]; size_t n = fread(buf, 1, sizeof buf, f); fclose(f);
            int perr = 0;
            CF o = FN(CF (*)(const void *, size_t, int *), 0x13a550)(buf, n, &perr);
            if (o && !perr) parsed++;
            for (int k = 0; k < 6; k++) if (strstr(e->d_name, kinds[k]) && (k != 0 || !strstr(e->d_name, "response"))) counts[k]++;
            if (o && strstr(e->d_name, "setup-request") && CFDictGetTyped(o, K_STREAMS, CFArrayTypeID(), &perr)) streams_ok++;
            if (o && strstr(e->d_name, "-command") && CFTypeOf(o) == CFDictTypeID()) {
                int e2 = 0; CF t = CFDictGetTyped(o, K_TYPE, CFStrTypeID(), &e2);
                if (t && CFEqual(t, su)) suggest_ok++;
            }
        }
        if (d) closedir(d);
        printf("  log: %d file(s): %d setup-request, %d setup-response, %d command, %d teardown, %d info-displays, %d sent\n",
               total, counts[0], counts[1], counts[2], counts[3], counts[4], counts[5]);
        CHECK("plist log: every file parses back (the library's own reader)", total > 0 && parsed == total && total == hook111_stats.logged);
        CHECK("plist log: SETUP requests with their streams, responses, TEARDOWNs, /info, commands both ways",
              counts[0] >= 4 && streams_ok >= 4 && counts[1] >= 4 && counts[3] >= 1 && counts[4] >= 1 && counts[2] >= 2 && counts[5] >= 2);
        CHECK("plist log: the phone's suggestUI, as it came", suggest_ok == 1);
    }
    printf("%s\n", fail ? "FAIL" : "PASS");
    return fail;
}
