// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * moonlight-core: the streaming side of the vizualyse-moonlight tool, on
 * moonlight-common-c. server.js does the GameStream HTTP side (serverinfo,
 * pairing, applist, launch) and starts this for the stream itself.
 *
 *   moonlight-core gencert <cert.pem> <key.pem>
 *       a client certificate (RSA 2048, self-signed, 20 years), as Moonlight's
 *   moonlight-core pads
 *       the game controllers found, one JSON object a line
 *   moonlight-core stream --address A --appversion V --gfeversion G
 *       --rtsp URL --codecs N --width W --height H --fps F --bitrate KBPS
 *       --rikey HEX32 --rikeyid N [--packet-size N] [--remote 0|1|2]
 *       [--no-pads]
 *
 * While streaming: H.264 Annex B on stdout (fd 1); S16LE 48 kHz stereo on
 * fd 3 when it is open; on stderr log lines and events, each event one line
 * "@{json}". Commands on stdin, one a line:
 *   phonepad <buttons> <lt> <rt> <lx> <ly> <rx> <ry>   the phone page's pad
 *   phonepad off
 *   key <code> <0|1> <modifiers>
 *   idr
 *   quit
 * End of stdin stops the stream too (the tool went away).
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <glob.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#include <linux/input.h>

#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>
#include <openssl/x509.h>
#include <opus/opus_multistream.h>

#include <Limelight.h>
#include "pads.h"

#define AUDIO_FD 3
#define NBITS(x) ((((x) - 1) / (8 * sizeof(long))) + 1)

static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static volatile sig_atomic_t stopping = 0;
static volatile int connected = 0;
static volatile int terminated = 0;
static int term_code = 0;
static int audio_ok = 0;

/* ---- events -------------------------------------------------------------- */

static void event(const char *fmt, ...) {
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof(buf), fmt, ap);
    va_end(ap);
    pthread_mutex_lock(&out_lock);
    fprintf(stderr, "@%s\n", buf);
    fflush(stderr);
    pthread_mutex_unlock(&out_lock);
}

/* A string for JSON: quotes, backslashes and control characters escaped. */
static void jstr(char *out, size_t n, const char *s) {
    size_t o = 0;
    for (; *s && o + 7 < n; s++) {
        unsigned char c = (unsigned char)*s;
        if (c == '"' || c == '\\') { out[o++] = '\\'; out[o++] = c; }
        else if (c < 0x20) o += snprintf(out + o, n - o, "\\u%04x", c);
        else out[o++] = c;
    }
    out[o] = 0;
}

static void log_message(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    pthread_mutex_lock(&out_lock);
    vfprintf(stderr, fmt, ap);
    size_t l = strlen(fmt);
    if (!l || fmt[l - 1] != '\n') fputc('\n', stderr);
    fflush(stderr);
    pthread_mutex_unlock(&out_lock);
    va_end(ap);
}

static int write_all(int fd, const void *buf, size_t n) {
    const char *p = buf;
    while (n) {
        ssize_t w = write(fd, p, n);
        if (w < 0) { if (errno == EINTR) continue; return -1; }
        p += w; n -= (size_t)w;
    }
    return 0;
}

/* ---- gencert ------------------------------------------------------------- */

static int gencert(const char *certfile, const char *keyfile) {
    EVP_PKEY *pk = EVP_PKEY_new();
    RSA *rsa = RSA_new();
    BIGNUM *e = BN_new();
    X509 *x = X509_new();
    if (!pk || !rsa || !e || !x) return 1;
    BN_set_word(e, RSA_F4);
    if (RSA_generate_key_ex(rsa, 2048, e, NULL) != 1) { fprintf(stderr, "gencert: RSA failed\n"); return 1; }
    EVP_PKEY_assign_RSA(pk, rsa);
    X509_set_version(x, 2);
    ASN1_INTEGER_set(X509_get_serialNumber(x), 0);
    X509_gmtime_adj(X509_get_notBefore(x), 0);
    X509_gmtime_adj(X509_get_notAfter(x), 60L * 60 * 24 * 365 * 20);
    X509_set_pubkey(x, pk);
    X509_NAME *name = X509_get_subject_name(x);
    X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, (const unsigned char *)"NVIDIA GameStream Client", -1, -1, 0);
    X509_set_issuer_name(x, name);
    if (!X509_sign(x, pk, EVP_sha256())) { fprintf(stderr, "gencert: sign failed\n"); return 1; }

    umask(077);
    FILE *f = fopen(keyfile, "w");
    if (!f || !PEM_write_PrivateKey(f, pk, NULL, NULL, 0, NULL, NULL)) { perror(keyfile); return 1; }
    fclose(f);
    f = fopen(certfile, "w");
    if (!f || !PEM_write_X509(f, x)) { perror(certfile); return 1; }
    fclose(f);
    X509_free(x); EVP_PKEY_free(pk); BN_free(e);
    return 0;
}

/* ---- controllers --------------------------------------------------------- */

static struct pad pads[PADS_MAX];
static pthread_mutex_t pad_lock = PTHREAD_MUTEX_INITIALIZER;
static int phone_slot = -1;           /* the phone page's pad, or -1 */
static struct pad_state phone_state;

static int active_mask(void) {
    int m = 0;
    for (int i = 0; i < PADS_MAX; i++) if (pads[i].fd >= 0 || i == phone_slot) m |= 1 << i;
    return m;
}

struct abs_ctx { unsigned long bits[NBITS(ABS_CNT)]; };
static bool abs_has(void *ctx, int code) {
    struct abs_ctx *c = ctx;
    return (c->bits[code / (8 * sizeof(long))] >> (code % (8 * sizeof(long)))) & 1UL;
}

static bool path_open(const char *path) {
    for (int i = 0; i < PADS_MAX; i++) if (pads[i].fd >= 0 && strcmp(pads[i].path, path) == 0) return true;
    return false;
}

/* Open the gamepad at path in a free slot: its slot, or -1. With open_it
 * false only checks and fills name (for `pads`). */
static int pad_probe(const char *path, char *name, size_t nlen, int open_it) {
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) return -1;
    unsigned long keybits[NBITS(KEY_CNT)] = { 0 };
    struct abs_ctx abs = { { 0 } };
    if (ioctl(fd, EVIOCGBIT(EV_KEY, sizeof(keybits)), keybits) < 0 ||
        ioctl(fd, EVIOCGBIT(EV_ABS, sizeof(abs.bits)), abs.bits) < 0 ||
        !pad_is_gamepad(keybits, abs.bits)) { close(fd); return -1; }
    name[0] = 0;
    if (ioctl(fd, EVIOCGNAME(nlen - 1), name) < 0) snprintf(name, nlen, "gamepad");
    name[nlen - 1] = 0;
    if (!open_it) { close(fd); return 0; }

    int slot = -1;
    for (int i = 0; i < PADS_MAX; i++) if (pads[i].fd < 0 && i != phone_slot) { slot = i; break; }
    if (slot < 0) { close(fd); return -1; }
    struct pad *p = &pads[slot];
    memset(p, 0, sizeof(*p));
    p->fd = fd;
    snprintf(p->path, sizeof(p->path), "%s", path);
    snprintf(p->name, sizeof(p->name), "%s", name);
    pad_layout(p, abs_has, &abs);
    for (int code = 0; code < ABS_CNT; code++) {
        if (!abs_has(&abs, code)) continue;
        struct input_absinfo ai;
        if (ioctl(fd, EVIOCGABS(code), &ai) == 0) pad_axis_range(p, code, ai.minimum, ai.maximum, ai.flat);
    }
    return slot;
}

static void pad_announce(int slot) {
    if (!connected) return;
    int all = A_FLAG | B_FLAG | X_FLAG | Y_FLAG | UP_FLAG | DOWN_FLAG | LEFT_FLAG | RIGHT_FLAG |
              LB_FLAG | RB_FLAG | PLAY_FLAG | BACK_FLAG | LS_CLK_FLAG | RS_CLK_FLAG | SPECIAL_FLAG;
    LiSendControllerArrivalEvent((uint8_t)slot, (uint16_t)active_mask(), LI_CTYPE_XBOX, all,
                                 LI_CCAP_ANALOG_TRIGGERS);
    if (slot != phone_slot) pads[slot].announced = true;
}

static void pad_send(int slot, const struct pad_state *s) {
    if (!connected) return;
    LiSendMultiControllerEvent((short)slot, (short)active_mask(), s->buttons, s->lt, s->rt, s->lx, s->ly, s->rx, s->ry);
}

static void pad_close(int slot, const char *why) {
    struct pad *p = &pads[slot];
    char n[256];
    jstr(n, sizeof(n), p->name);
    close(p->fd);
    p->fd = -1;
    event("{\"ev\":\"pad\",\"slot\":%d,\"name\":\"%s\",\"present\":false,\"why\":\"%s\"}", slot, n, why);
    /* a last neutral state with the pad gone from the mask */
    static const struct pad_state zero;
    pad_send(slot, &zero);
}

static void pads_scan(void) {
    glob_t g;
    if (glob("/dev/input/event*", 0, NULL, &g) != 0) return;
    for (size_t i = 0; i < g.gl_pathc; i++) {
        if (path_open(g.gl_pathv[i])) continue;
        char name[128];
        int slot = pad_probe(g.gl_pathv[i], name, sizeof(name), 1);
        if (slot < 0) continue;
        char n[256];
        jstr(n, sizeof(n), name);
        event("{\"ev\":\"pad\",\"slot\":%d,\"name\":\"%s\",\"path\":\"%s\",\"present\":true}", slot, n, g.gl_pathv[i]);
        pad_announce(slot);
    }
    globfree(&g);
}

static void *pads_thread(void *arg) {
    (void)arg;
    time_t last_scan = 0;
    while (!stopping && !terminated) {
        time_t now = time(NULL);
        pthread_mutex_lock(&pad_lock);
        if (now - last_scan >= 2) { pads_scan(); last_scan = now; }
        struct pollfd pf[PADS_MAX];
        int slot_of[PADS_MAX], n = 0;
        for (int i = 0; i < PADS_MAX; i++) if (pads[i].fd >= 0) { pf[n].fd = pads[i].fd; pf[n].events = POLLIN; slot_of[n++] = i; }
        pthread_mutex_unlock(&pad_lock);

        int r = poll(pf, (nfds_t)n, 500);
        if (r <= 0) continue;
        pthread_mutex_lock(&pad_lock);
        for (int k = 0; k < n; k++) {
            struct pad *p = &pads[slot_of[k]];
            if (p->fd < 0) continue;
            if (pf[k].revents & (POLLERR | POLLHUP | POLLNVAL)) { pad_close(slot_of[k], "gone"); continue; }
            if (!(pf[k].revents & POLLIN)) continue;
            struct input_event ev[64];
            ssize_t got = read(p->fd, ev, sizeof(ev));
            if (got < 0) { if (errno != EAGAIN) pad_close(slot_of[k], "read failed"); continue; }
            if (connected && !p->announced) pad_announce(slot_of[k]);
            for (size_t e = 0; e < (size_t)got / sizeof(ev[0]); e++) {
                if (pad_event(p, ev[e].type, ev[e].code, ev[e].value)) { pad_send(slot_of[k], &p->st); pad_sent(p); }
            }
        }
        pthread_mutex_unlock(&pad_lock);
    }
    return NULL;
}

static int list_pads(void) {
    glob_t g;
    if (glob("/dev/input/event*", 0, NULL, &g) != 0) return 0;
    for (size_t i = 0; i < g.gl_pathc; i++) {
        char name[128], n[256];
        if (pad_probe(g.gl_pathv[i], name, sizeof(name), 0) < 0) continue;
        jstr(n, sizeof(n), name);
        printf("{\"name\":\"%s\",\"path\":\"%s\"}\n", n, g.gl_pathv[i]);
    }
    globfree(&g);
    return 0;
}

/* ---- video --------------------------------------------------------------- */

static unsigned long frames = 0, idr_frames = 0;

static int dr_setup(int fmt, int w, int h, int rate, void *ctx, int flags) {
    (void)ctx; (void)flags;
    event("{\"ev\":\"video\",\"format\":%d,\"width\":%d,\"height\":%d,\"fps\":%d}", fmt, w, h, rate);
    return (fmt & VIDEO_FORMAT_MASK_H264) ? 0 : -1;
}

static int dr_submit(PDECODE_UNIT du) {
    for (PLENTRY e = du->bufferList; e; e = e->next) {
        if (write_all(STDOUT_FILENO, e->data, (size_t)e->length) < 0) {
            if (!stopping) log_message("video: write failed: %s", strerror(errno));
            stopping = 1;
            return DR_OK;
        }
    }
    frames++;
    if (du->frameType == FRAME_TYPE_IDR) idr_frames++;
    return DR_OK;
}

/* ---- audio --------------------------------------------------------------- */

static OpusMSDecoder *opus = NULL;
static int a_channels = 2, a_frame = 240;
static opus_int16 pcm[8 * 5760];

static int ar_init(int config, const POPUS_MULTISTREAM_CONFIGURATION c, void *ctx, int flags) {
    (void)config; (void)ctx; (void)flags;
    int err = 0;
    a_channels = c->channelCount;
    a_frame = c->samplesPerFrame;
    opus = opus_multistream_decoder_create(c->sampleRate, c->channelCount, c->streams, c->coupledStreams, c->mapping, &err);
    event("{\"ev\":\"audio\",\"rate\":%d,\"channels\":%d,\"frame\":%d,\"ok\":%s}", c->sampleRate, c->channelCount,
          c->samplesPerFrame, opus ? "true" : "false");
    return opus ? 0 : -1;
}

static void ar_cleanup(void) {
    if (opus) opus_multistream_decoder_destroy(opus);
    opus = NULL;
}

static void ar_play(char *data, int len) {
    if (!opus || !audio_ok) return;
    int n = opus_multistream_decode(opus, (unsigned char *)data, len, pcm, (int)(sizeof(pcm) / sizeof(pcm[0]) / a_channels), 0);
    if (n <= 0) return;
    if (write_all(AUDIO_FD, pcm, (size_t)n * a_channels * sizeof(opus_int16)) < 0) {
        log_message("audio: write failed: %s; audio off", strerror(errno));
        audio_ok = 0;
    }
}

/* ---- the connection ------------------------------------------------------ */

static void cl_stage_failed(int stage, int code) {
    char ports[256];
    LiStringifyPortFlags(LiGetPortFlagsFromStage(stage), ",", ports, sizeof(ports));
    event("{\"ev\":\"stage-failed\",\"stage\":\"%s\",\"code\":%d,\"ports\":\"%s\"}", LiGetStageName(stage), code, ports);
}
static void cl_started(void) {
    connected = 1;
    event("{\"ev\":\"started\"}");
    pthread_mutex_lock(&pad_lock);
    for (int i = 0; i < PADS_MAX; i++) if (pads[i].fd >= 0) pad_announce(i);
    if (phone_slot >= 0) pad_announce(phone_slot);
    pthread_mutex_unlock(&pad_lock);
}
static void cl_terminated(int code) {
    term_code = code;
    terminated = 1;
    char ports[256];
    LiStringifyPortFlags(LiGetPortFlagsFromTerminationErrorCode(code), ",", ports, sizeof(ports));
    event("{\"ev\":\"terminated\",\"code\":%d,\"ports\":\"%s\"}", code, ports);
}
static void cl_status(int status) {
    event("{\"ev\":\"status\",\"poor\":%s}", status == CONN_STATUS_POOR ? "true" : "false");
}
static void cl_rumble(unsigned short n, unsigned short lo, unsigned short hi) {
    event("{\"ev\":\"rumble\",\"slot\":%u,\"low\":%u,\"high\":%u}", n, lo, hi);
}

/* ---- stdin commands ------------------------------------------------------ */

static void *stdin_thread(void *arg) {
    (void)arg;
    char line[256];
    FILE *in = fdopen(STDIN_FILENO, "r");
    while (in && fgets(line, sizeof(line), in)) {
        int b, lt, rt, lx, ly, rx, ry, code, down, mods;
        if (sscanf(line, "phonepad %d %d %d %d %d %d %d", &b, &lt, &rt, &lx, &ly, &rx, &ry) == 7) {
            pthread_mutex_lock(&pad_lock);
            if (phone_slot < 0) {
                for (int i = PADS_MAX - 1; i >= 0; i--) if (pads[i].fd < 0) { phone_slot = i; break; }
                if (phone_slot >= 0) { event("{\"ev\":\"pad\",\"slot\":%d,\"name\":\"Phone\",\"present\":true}", phone_slot); pad_announce(phone_slot); }
            }
            if (phone_slot >= 0) {
                phone_state.buttons = b & 0xffff;
                phone_state.lt = (unsigned char)(lt < 0 ? 0 : lt > 255 ? 255 : lt);
                phone_state.rt = (unsigned char)(rt < 0 ? 0 : rt > 255 ? 255 : rt);
                phone_state.lx = (short)lx; phone_state.ly = (short)ly; phone_state.rx = (short)rx; phone_state.ry = (short)ry;
                pad_send(phone_slot, &phone_state);
            }
            pthread_mutex_unlock(&pad_lock);
        } else if (strncmp(line, "phonepad off", 12) == 0) {
            pthread_mutex_lock(&pad_lock);
            if (phone_slot >= 0) {
                static const struct pad_state zero;
                int s = phone_slot;
                phone_slot = -1;
                pad_send(s, &zero);
                event("{\"ev\":\"pad\",\"slot\":%d,\"name\":\"Phone\",\"present\":false}", s);
            }
            pthread_mutex_unlock(&pad_lock);
        } else if (sscanf(line, "key %d %d %d", &code, &down, &mods) == 3) {
            if (connected) LiSendKeyboardEvent((short)code, down ? KEY_ACTION_DOWN : KEY_ACTION_UP, (char)mods);
        } else if (strncmp(line, "idr", 3) == 0) {
            LiRequestIdrFrame();
        } else if (strncmp(line, "quit", 4) == 0) {
            break;
        }
    }
    stopping = 1;
    return NULL;
}

static void on_signal(int s) { (void)s; stopping = 1; }

static int hexbytes(const char *hex, char *out, int n) {
    if ((int)strlen(hex) != n * 2) return -1;
    for (int i = 0; i < n; i++) {
        unsigned v;
        if (sscanf(hex + 2 * i, "%2x", &v) != 1) return -1;
        out[i] = (char)v;
    }
    return 0;
}

static int stream(int argc, char **argv) {
    SERVER_INFORMATION si;
    STREAM_CONFIGURATION sc;
    LiInitializeServerInformation(&si);
    LiInitializeStreamConfiguration(&sc);
    sc.width = 1280; sc.height = 720; sc.fps = 60; sc.bitrate = 10000; sc.packetSize = 1392;
    sc.streamingRemotely = STREAM_CFG_AUTO;
    sc.audioConfiguration = AUDIO_CONFIGURATION_STEREO;
    sc.supportedVideoFormats = VIDEO_FORMAT_H264;
    sc.colorSpace = COLORSPACE_REC_601;
    sc.colorRange = COLOR_RANGE_LIMITED;
    sc.encryptionFlags = ENCFLG_AUDIO;
    int use_pads = 1;
    const char *rikey = NULL;
    long rikeyid = 0;

    static struct option opts[] = {
        { "address", 1, 0, 'a' }, { "appversion", 1, 0, 'v' }, { "gfeversion", 1, 0, 'g' }, { "rtsp", 1, 0, 'r' },
        { "codecs", 1, 0, 'c' }, { "width", 1, 0, 'W' }, { "height", 1, 0, 'H' }, { "fps", 1, 0, 'f' },
        { "bitrate", 1, 0, 'b' }, { "packet-size", 1, 0, 'p' }, { "remote", 1, 0, 'R' }, { "rikey", 1, 0, 'k' },
        { "rikeyid", 1, 0, 'i' }, { "no-pads", 0, 0, 'n' }, { 0, 0, 0, 0 }
    };
    int o;
    optind = 2;
    while ((o = getopt_long(argc, argv, "", opts, NULL)) != -1) {
        switch (o) {
        case 'a': si.address = optarg; break;
        case 'v': si.serverInfoAppVersion = optarg; break;
        case 'g': si.serverInfoGfeVersion = optarg; break;
        case 'r': si.rtspSessionUrl = optarg; break;
        case 'c': si.serverCodecModeSupport = atoi(optarg); break;
        case 'W': sc.width = atoi(optarg); break;
        case 'H': sc.height = atoi(optarg); break;
        case 'f': sc.fps = atoi(optarg); break;
        case 'b': sc.bitrate = atoi(optarg); break;
        case 'p': sc.packetSize = atoi(optarg); break;
        case 'R': sc.streamingRemotely = atoi(optarg); break;
        case 'k': rikey = optarg; break;
        case 'i': rikeyid = strtol(optarg, NULL, 10); break;
        case 'n': use_pads = 0; break;
        default: return 2;
        }
    }
    if (!si.address || !si.serverInfoAppVersion || !rikey || hexbytes(rikey, sc.remoteInputAesKey, 16) < 0) {
        fprintf(stderr, "stream: --address, --appversion and --rikey (32 hex digits) are required\n");
        return 2;
    }
    /* The launch's rikeyid is the IV's first 4 bytes, big-endian. */
    memset(sc.remoteInputAesIv, 0, sizeof(sc.remoteInputAesIv));
    uint32_t id = (uint32_t)rikeyid;
    sc.remoteInputAesIv[0] = (char)(id >> 24); sc.remoteInputAesIv[1] = (char)(id >> 16);
    sc.remoteInputAesIv[2] = (char)(id >> 8); sc.remoteInputAesIv[3] = (char)id;
    sc.clientRefreshRateX100 = sc.fps * 100;

    audio_ok = fcntl(AUDIO_FD, F_GETFD) >= 0;
    signal(SIGPIPE, SIG_IGN);
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    for (int i = 0; i < PADS_MAX; i++) pads[i].fd = -1;

    DECODER_RENDERER_CALLBACKS dr;
    LiInitializeVideoCallbacks(&dr);
    dr.setup = dr_setup;
    dr.submitDecodeUnit = dr_submit;
    /* slices, so ffmpeg decodes each frame on several cores */
    dr.capabilities = CAPABILITY_SLICES_PER_FRAME(4);
    AUDIO_RENDERER_CALLBACKS ar;
    LiInitializeAudioCallbacks(&ar);
    ar.init = ar_init;
    ar.cleanup = ar_cleanup;
    ar.decodeAndPlaySample = ar_play;
    ar.capabilities = CAPABILITY_DIRECT_SUBMIT;
    CONNECTION_LISTENER_CALLBACKS cl;
    LiInitializeConnectionCallbacks(&cl);
    cl.stageFailed = cl_stage_failed;
    cl.connectionStarted = cl_started;
    cl.connectionTerminated = cl_terminated;
    cl.logMessage = log_message;
    cl.rumble = cl_rumble;
    cl.connectionStatusUpdate = cl_status;

    pthread_t tin, tpads;
    pthread_create(&tin, NULL, stdin_thread, NULL);
    pthread_detach(tin);
    if (use_pads) { pthread_create(&tpads, NULL, pads_thread, NULL); }

    event("{\"ev\":\"connecting\",\"width\":%d,\"height\":%d,\"fps\":%d,\"bitrate\":%d}", sc.width, sc.height, sc.fps, sc.bitrate);
    int rc = LiStartConnection(&si, &sc, &cl, &dr, &ar, NULL, 0, NULL, 0);
    if (rc != 0) {
        event("{\"ev\":\"failed\",\"code\":%d}", rc);
        stopping = 1;
        if (use_pads) pthread_join(tpads, NULL);
        return 1;
    }
    unsigned long last = 0;
    time_t t0 = time(NULL), tl = t0;
    while (!stopping && !terminated) {
        struct timespec ts = { 0, 200 * 1000 * 1000 };
        nanosleep(&ts, NULL);
        time_t now = time(NULL);
        if (now - tl >= 1) {
            uint32_t rtt = 0, var = 0;
            LiGetEstimatedRttInfo(&rtt, &var);
            event("{\"ev\":\"stats\",\"frames\":%lu,\"fps\":%lu,\"rtt\":%u}", frames, (frames - last) / (unsigned long)(now - tl), rtt);
            last = frames; tl = now;
        }
    }
    LiStopConnection();
    if (use_pads) { stopping = 1; pthread_join(tpads, NULL); }
    event("{\"ev\":\"stopped\",\"frames\":%lu,\"code\":%d}", frames, term_code);
    return terminated && term_code != ML_ERROR_GRACEFUL_TERMINATION ? 3 : 0;
}

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "gencert") == 0) return gencert(argv[2], argv[3]);
    if (argc == 2 && strcmp(argv[1], "pads") == 0) return list_pads();
    if (argc >= 2 && strcmp(argv[1], "stream") == 0) return stream(argc, argv);
    fprintf(stderr, "usage: moonlight-core gencert <cert.pem> <key.pem> | pads | stream --address ... (see the source)\n");
    return 2;
}
