/*
 * screen_b: drive a second AirPlay screen object inside the unit's real
 * libNmeCarPlay.so, off the car (re/run.sh harness).
 *
 * It is the core of the planned stream-111 hook, minus the phone:
 *   create a screen object -> set it up -> set a stream key -> start it with
 *   its own context -> run the library's frame pump on a local socket,
 * while the four ScreenStream functions are redirected, so this screen's
 * frames reach our sink instead of Cinemo's (single) video sink.
 *
 * A writer thread plays the phone: one codec-config message (AVCC), then
 * encrypted frames, in the wire format read from the frame pump
 * (re/findings-20.40.2.md). The run passes when the sink receives exactly the
 * AVCC and the plaintext frames that were sent.
 *
 *   screen_b <libNmeCarPlay.so> aes|chacha|chacha-tamper [frames]
 *
 * chacha-tamper corrupts frame 2's ciphertext: the library must reject it
 * (Poly1305) and, since its nonce then stays behind the sender's, every later
 * frame too. Frames 0-1 arrive intact; the stream is dead after that.
 *
 * Addresses are Ghidra's (image base 0x100000) for one build only; the
 * library's GNU build-id is checked before any of them is used.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <elf.h>
#include <link.h>
#include <openssl/evp.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>

static const char BUILD_ID[] = "8e502fa40b7fbfb79c36acdd9905da6a1d000254";
static uintptr_t base;
#define AT(a) ((void *)(base + (uintptr_t)(a) - 0x100000))

/* The library's functions this uses (findings-20.40.2.md). */
#define SCREEN_CREATE      0x185440  /* int (void **obj) */
#define SCREEN_SETUP       0x185570  /* int (void *obj, CFDictionary *streamDesc) */
#define SCREEN_KEY_AESCTR  0x185510  /* void (void *obj, const u8 key[16], const u8 iv[16]) */
#define SCREEN_KEY_CHACHA  0x1854c0  /* int (void *obj, const u8 key[32], long 32) */
#define SCREEN_DELEGATE    0x185490  /* void (void *obj, const delegate *) */
#define SCREEN_START       0x185ef0  /* int (void *obj, void *ctx) */
#define SCREEN_FRAMES      0x1855d0  /* int (void *obj, NetSocket *, int timeout_s) */
#define SCREEN_FINALIZE    0x185360  /* void (void *obj) */
#define NETSOCKET_WRAP     0x156a20  /* int (NetSocket **out, int fd) */
#define CFDICT_CREATE      0x134280  /* CFDictionary *(alloc, cap, keyCB, valCB) */
#define CF_KEY_CALLBACKS   0x3dbb60
#define CF_VALUE_CALLBACKS 0x3dbb20
/* ScreenStream, redirected for our context */
#define SS_SET_AVCC        0x172960  /* int (ss, const void *avcc, size_t len) */
#define SS_START           0x172a50  /* int (ss) */
#define SS_STOP            0x172ab0  /* void (ss) */
#define SS_FRAME           0x172b20  /* int (ss, data, len, ts, ?, cb, cbArg) */

static char SCREEN_B_CTX[] = "screen-b";  /* our context: a unique address */

/* ---- the sink: what screen B delivered ---- */
static unsigned char got_avcc[256];
static size_t got_avcc_len;
static int got_start, got_stop, got_frames, bad_frames, foreign_calls;
static unsigned char *want_frames[64];
static size_t want_len[64];
static unsigned char *sent_wire[64];  /* what went on the wire, for diagnosis */
static int tamper_index = -1;          /* chacha-tamper: this frame's ciphertext is corrupted */

static void *ss_ctx(void *ss) { return *(void **)((char *)ss + 8); }

static int my_set_avcc(void *ss, const void *p, size_t n) {
    if (ss_ctx(ss) != SCREEN_B_CTX) { foreign_calls++; return -1; }
    if (n <= sizeof got_avcc) { memcpy(got_avcc, p, n); got_avcc_len = n; }
    return 0;
}
static int my_start(void *ss) {
    if (ss_ctx(ss) != SCREEN_B_CTX) { foreign_calls++; return -1; }
    got_start++;
    return 0;
}
static void my_stop(void *ss) {
    if (ss_ctx(ss) != SCREEN_B_CTX) { foreign_calls++; return; }
    got_stop++;
}
static int my_frame(void *ss, const unsigned char *p, size_t n, uint64_t ts, void *x,
                    void (*cb)(void *), void *cb_arg) {
    (void)ts; (void)x;
    if (ss_ctx(ss) != SCREEN_B_CTX) { foreign_calls++; return -1; }
    int i = got_frames++;
    if (i >= 64 || n != want_len[i] || memcmp(p, want_frames[i], n) != 0) {
        bad_frames++;
        fprintf(stderr, "frame %d: %zu bytes, want %zu\n  got   ", i, n, i < 64 ? want_len[i] : 0);
        for (int k = 0; k < 8 && k < (int)n; k++) fprintf(stderr, "%02x ", p[k]);
        if (i < 64) {
            fprintf(stderr, "\n  plain ");
            for (int k = 0; k < 8; k++) fprintf(stderr, "%02x ", want_frames[i][k]);
            if (sent_wire[i]) {
                fprintf(stderr, "\n  wire  ");
                for (int k = 0; k < 8; k++) fprintf(stderr, "%02x ", sent_wire[i][k]);
            }
        }
        fprintf(stderr, "\n");
    }
    if (cb) cb(cb_arg);
    return 0;
}

/* Replace a function's entry with an absolute jump to ours. Harness only: no
 * trampoline back, since screen A does not exist here (any other caller is
 * counted in foreign_calls). The real hook needs trampolines. */
static void redirect(uintptr_t ghidra_addr, void *to) {
    unsigned char *at = AT(ghidra_addr);
    uintptr_t page = (uintptr_t)at & ~(uintptr_t)0xfff;
    if (mprotect((void *)page, 0x2000, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) { perror("mprotect"); exit(2); }
    at[0] = 0x48; at[1] = 0xb8; memcpy(at + 2, &to, 8);  /* movabs rax, to */
    at[10] = 0xff; at[11] = 0xe0;                         /* jmp rax */
    mprotect((void *)page, 0x2000, PROT_READ | PROT_EXEC);
}

/* ---- finding the library and checking it is the build the addresses are for ---- */
static int build_id_ok;
static int find_lib(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size;
    if (!strstr(info->dlpi_name, (const char *)data)) return 0;
    base = info->dlpi_addr;
    for (int i = 0; i < info->dlpi_phnum; i++) {
        const ElfW(Phdr) *ph = &info->dlpi_phdr[i];
        if (ph->p_type != PT_NOTE) continue;
        const unsigned char *p = (const unsigned char *)(info->dlpi_addr + ph->p_vaddr);
        const unsigned char *end = p + ph->p_memsz;
        while (p + 12 <= end) {
            const ElfW(Nhdr) *n = (const ElfW(Nhdr) *)p;
            const unsigned char *desc = p + 12 + ((n->n_namesz + 3) & ~3u);
            if (n->n_type == NT_GNU_BUILD_ID) {
                char hex[2 * 64 + 1] = "";
                for (unsigned k = 0; k < n->n_descsz && k < 64; k++) sprintf(hex + 2 * k, "%02x", desc[k]);
                build_id_ok = strcmp(hex, BUILD_ID) == 0;
                printf("build-id %s (%s)\n", hex, build_id_ok ? "expected" : "NOT the expected build");
            }
            p = desc + ((n->n_descsz + 3) & ~3u);
        }
    }
    return 1;
}

/* ---- the phone side ---- */
struct phone { int fd; int chacha; int frames; unsigned char key[32]; unsigned char iv[16]; };

static void put_header(unsigned char h[128], uint32_t size, uint8_t opcode, uint64_t ts, float w, float hgt) {
    memset(h, 0, 128);
    memcpy(h, &size, 4);
    h[4] = opcode;
    memcpy(h + 8, &ts, 8);
    memcpy(h + 0x10, &w, 4);
    memcpy(h + 0x14, &hgt, 4);
}

static void send_all(int fd, const void *p, size_t n) {
    const char *c = p;
    while (n) { ssize_t k = send(fd, c, n, MSG_NOSIGNAL); if (k <= 0) { perror("send"); return; } c += k; n -= (size_t)k; }
}

static const unsigned char AVCC[] = {  /* avcC: profile 100, level 3.1, one SPS, one PPS (dummy) */
    0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x08, 0x67, 0x64, 0x00, 0x1f, 0xac, 0xd9, 0x40, 0x50,
    0x01, 0x00, 0x04, 0x68, 0xeb, 0xe3, 0xcb };

static void *phone_main(void *arg) {
    struct phone *ph = arg;
    unsigned char h[128];
    put_header(h, sizeof AVCC, 1, 0, 1088.0f, 480.0f);
    send_all(ph->fd, h, 128);
    send_all(ph->fd, AVCC, sizeof AVCC);

    EVP_CIPHER_CTX *aes = NULL;
    if (!ph->chacha) {
        aes = EVP_CIPHER_CTX_new();
        EVP_EncryptInit_ex(aes, EVP_aes_128_ctr(), NULL, ph->key, ph->iv);
    }
    for (int i = 0; i < ph->frames; i++) {
        /* an AVCC-framed NAL unit, distinct per frame, odd sizes on purpose */
        size_t n = 4 + 37 + (size_t)i * 101;
        unsigned char *plain = malloc(n), *wire = malloc(n + 16);
        uint32_t nal = (uint32_t)(n - 4);
        plain[0] = nal >> 24; plain[1] = nal >> 16; plain[2] = nal >> 8; plain[3] = nal;
        for (size_t k = 4; k < n; k++) plain[k] = (unsigned char)(k * 7 + i);
        plain[4] = i == 0 ? 0x65 : 0x41;
        want_frames[i] = plain; want_len[i] = n;
        uint64_t ts = 1000000ull * (uint64_t)(i + 1);
        int outl = 0;
        if (!ph->chacha) {
            EVP_EncryptUpdate(aes, wire, &outl, plain, (int)n);
            put_header(h, (uint32_t)n, 0, ts, 0, 0);
            send_all(ph->fd, h, 128);
            send_all(ph->fd, wire, n);
            sent_wire[i] = malloc(n); memcpy(sent_wire[i], wire, n);
        } else {
            /* RFC 7539 ChaCha20-Poly1305; the 8-byte frame counter (little-endian,
             * from 0) as the last 8 bytes of the 12-byte nonce; AAD: the header as
             * sent, its size field counting the 16-byte tag. */
            unsigned char nonce[12] = {0};
            uint64_t ctr = (uint64_t)i;
            memcpy(nonce + 4, &ctr, 8);
            put_header(h, (uint32_t)(n + 16), 0, ts, 0, 0);
            EVP_CIPHER_CTX *c = EVP_CIPHER_CTX_new();
            EVP_EncryptInit_ex(c, EVP_chacha20_poly1305(), NULL, NULL, NULL);
            EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_SET_IVLEN, 12, NULL);
            EVP_EncryptInit_ex(c, NULL, NULL, ph->key, nonce);
            EVP_EncryptUpdate(c, NULL, &outl, h, 128);
            EVP_EncryptUpdate(c, wire, &outl, plain, (int)n);
            EVP_EncryptFinal_ex(c, wire + outl, &outl);
            EVP_CIPHER_CTX_ctrl(c, EVP_CTRL_AEAD_GET_TAG, 16, wire + n);
            EVP_CIPHER_CTX_free(c);
            if (i == tamper_index) wire[n / 2] ^= 0x01;
            send_all(ph->fd, h, 128);
            send_all(ph->fd, wire, n + 16);
            sent_wire[i] = malloc(n); memcpy(sent_wire[i], wire, n);
        }
        free(wire);
    }
    if (aes) EVP_CIPHER_CTX_free(aes);
    usleep(200000);
    shutdown(ph->fd, SHUT_RDWR);  /* the phone hangs up: the pump returns */
    close(ph->fd);
    return NULL;
}

/* the delegate's timing callback (+0x18): stock converts the sender's clock;
 * the harness only needs a "now" (unused while header flag bit 1 is clear) */
static uint64_t my_time(void *ctx, uint64_t ts) { (void)ctx; return ts; }
static void my_cb1(void *ctx) { (void)ctx; }

int main(int argc, char **argv) {
    if (argc < 3) { fprintf(stderr, "usage: %s <libNmeCarPlay.so> aes|chacha [frames]\n", argv[0]); return 2; }
    int chacha = strncmp(argv[2], "chacha", 6) == 0;
    int tamper = strcmp(argv[2], "chacha-tamper") == 0;
    int frames = argc > 3 ? atoi(argv[3]) : 12;
    if (frames < 1 || frames > 64) frames = 12;
    if (tamper) { if (frames < 4) frames = 4; tamper_index = 2; }

    if (!dlopen(argv[1], RTLD_NOW | RTLD_GLOBAL)) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 2; }
    dl_iterate_phdr(find_lib, "libNmeCarPlay");
    if (!base || !build_id_ok) { fprintf(stderr, "not the build these addresses are for: stopping\n"); return 2; }

    redirect(SS_SET_AVCC, (void *)my_set_avcc);
    redirect(SS_START, (void *)my_start);
    redirect(SS_STOP, (void *)my_stop);
    redirect(SS_FRAME, (void *)my_frame);

    void *obj = NULL;
    int rc = ((int (*)(void **))AT(SCREEN_CREATE))(&obj);
    printf("create: %d obj=%p\n", rc, obj);
    if (rc) return 1;

    void *desc = ((void *(*)(void *, long, void *, void *))AT(CFDICT_CREATE))(NULL, 0, AT(CF_KEY_CALLBACKS), AT(CF_VALUE_CALLBACKS));
    rc = ((int (*)(void *, void *))AT(SCREEN_SETUP))(obj, desc);
    printf("setup: %d\n", rc);

    struct phone ph = { .chacha = chacha, .frames = frames };
    for (int i = 0; i < 32; i++) ph.key[i] = (unsigned char)(0xa0 + i);
    for (int i = 0; i < 16; i++) ph.iv[i] = (unsigned char)(0x10 * i + 3);
    if (chacha) rc = ((int (*)(void *, const unsigned char *, long))AT(SCREEN_KEY_CHACHA))(obj, ph.key, 32);
    else { ((void (*)(void *, const unsigned char *, const unsigned char *))AT(SCREEN_KEY_AESCTR))(obj, ph.key, ph.iv); rc = 0; }
    printf("key (%s): %d\n", chacha ? "chacha20-poly1305" : "aes-128-ctr", rc);

    void *delegate[3] = { SCREEN_B_CTX, (void *)my_cb1, (void *)my_time };
    ((void (*)(void *, void **))AT(SCREEN_DELEGATE))(obj, delegate);

    rc = ((int (*)(void *, void *))AT(SCREEN_START))(obj, SCREEN_B_CTX);
    printf("start: %d (stream started: %d)\n", rc, got_start);
    if (rc) return 1;

    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) != 0) { perror("socketpair"); return 2; }
    void *ns = NULL;
    rc = ((int (*)(void **, int))AT(NETSOCKET_WRAP))(&ns, sv[0]);
    printf("netsocket: %d\n", rc);
    if (rc) return 1;

    ph.fd = sv[1];
    pthread_t t;
    pthread_create(&t, NULL, phone_main, &ph);
    rc = ((int (*)(void *, void *, int))AT(SCREEN_FRAMES))(obj, ns, 5);
    pthread_join(t, NULL);
    printf("frame pump returned: %d\n", rc);
    ((void (*)(void *))AT(SCREEN_FINALIZE))(obj);

    int avcc_ok = got_avcc_len == sizeof AVCC && memcmp(got_avcc, AVCC, sizeof AVCC) == 0;
    printf("sink: avcc %s, start %d, stop %d, frames %d/%d, mismatched %d, foreign calls %d\n",
           avcc_ok ? "ok" : "WRONG", got_start, got_stop, got_frames, frames, bad_frames, foreign_calls);
    /* tamper: the library advances its nonce only on a frame that authenticates,
     * so after the corrupted frame no later frame can authenticate either:
     * exactly the frames before it arrive (observed 2026-11-03). */
    int expect = tamper ? tamper_index : frames;
    printf("expected frames: %d%s\n", expect, tamper ? " (frame 2 corrupted)" : "");
    int pass = avcc_ok && got_start == 1 && got_frames == expect && bad_frames == 0 && foreign_calls == 0;
    printf("%s\n", pass ? "PASS" : "FAIL");
    return pass ? 0 : 1;
}
