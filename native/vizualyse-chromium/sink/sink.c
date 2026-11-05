// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * chromium-sink: the browser's pictures onto mgu-render's frame file, and the
 * centre display's touches back.
 *
 *   chromium-sink --frame FILE [--touch-iface vlan73 --touch-src 160.48.199.115 | --touch-file F]
 *
 * stdin: pictures, each a u32 LE length then a JPEG (Chromium's screencast
 * frames, which server.js takes off the DevTools pipe). Each is decoded
 * (libjpeg-turbo) straight into the frame file's next slot as I420 at the
 * file's size (cut off or black around a picture of another size) and shown.
 * JPEG's YCbCr is BT.601 full range, and the file says so.
 *
 * stdout: one JSON event a line: {"ev":"ready",...}, {"ev":"touch","p":1|2|3,
 * "x":..,"y":..} (down / move / up, screen pixels 1920x720 on the car),
 * {"ev":"stats","frames":n,"ms":avg decode,"bad":n} once a second while
 * pictures come, {"ev":"error",...}.
 *
 * Touch is read passively (an AF_PACKET copy of the display's UDP PDUs on
 * vlan73; the HMI still gets every one, nothing is claimed: a claim through
 * mgu-render restarted the head unit, knowledge/central-screen.md). The
 * socket needs root; once it and the frame file are open the sink drops to
 * nobody. --touch-file replays a capture (the tests: "t src len hex" lines,
 * as moonlight's test/fixtures).
 */
#define _GNU_SOURCE
#include "frame_out.h"
#include "touch.h"
#include "yuv.h"

#include <arpa/inet.h>
#include <errno.h>
#include <getopt.h>
#include <grp.h>
#include <linux/if_ether.h>
#include <linux/if_packet.h>
#include <net/if.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <turbojpeg.h>
#include <unistd.h>

#define MAX_JPEG (16 << 20)

static pthread_mutex_t out_lock = PTHREAD_MUTEX_INITIALIZER;
static volatile int done = 0;

static void event(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    pthread_mutex_lock(&out_lock);
    vfprintf(stdout, fmt, ap);
    fputc('\n', stdout);
    fflush(stdout);
    pthread_mutex_unlock(&out_lock);
    va_end(ap);
}

static long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}

/* ---- touch ------------------------------------------------------------- */

static int touch_sock = -1;
static unsigned touch_saddr = 0;
static const char *touch_file = NULL;

static int touch_open(const char *iface) {
    int fd = socket(AF_PACKET, SOCK_DGRAM | SOCK_CLOEXEC | SOCK_NONBLOCK, htons(ETH_P_IP));
    if (fd < 0) return -1;
    struct sockaddr_ll a;
    memset(&a, 0, sizeof(a));
    a.sll_family = AF_PACKET;
    a.sll_protocol = htons(ETH_P_IP);
    a.sll_ifindex = (int)if_nametoindex(iface);
    if (!a.sll_ifindex || bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0) { close(fd); return -1; }
    return fd;
}

static int last_phase = TOUCH_UP;
static long last_touch = 0;

static void touch_feed(const unsigned char *udp, int len) {
    int ph, x, y;
    if (!touch_decode(udp, len, &ph, &x, &y)) return;
    /* a move without its down (it went down before we listened) starts a touch */
    if (ph == TOUCH_MOVE && last_phase == TOUCH_UP) ph = TOUCH_DOWN;
    if (ph == TOUCH_UP && last_phase == TOUCH_UP) return;
    last_phase = ph;
    last_touch = now_ms();
    event("{\"ev\":\"touch\",\"p\":%d,\"x\":%d,\"y\":%d}", ph, x, y);
}

/* a finger "down" with no PDU for a second: its up was lost */
static void touch_lost(void) {
    if (last_phase != TOUCH_UP && now_ms() - last_touch > 1000) {
        last_phase = TOUCH_UP;
        event("{\"ev\":\"touch\",\"p\":3,\"x\":-1,\"y\":-1,\"lost\":true}");
    }
}

static void *touch_thread(void *arg) {
    (void)arg;
    unsigned char pkt[2048];
    while (!done) {
        if (touch_file) {
            FILE *f = fopen(touch_file, "r");
            if (!f) { struct timespec ts = { 0, 100 * 1000 * 1000 }; nanosleep(&ts, NULL); continue; }
            char line[1024], src[64], hex[600];
            int t, len;
            long start = now_ms(), first = -1;
            while (!done && fgets(line, sizeof line, f)) {
                if (sscanf(line, "%d %63s %d %599s", &t, src, &len, hex) != 4) continue;
                if (first < 0) first = t;
                long due = start + (t - first);
                while (now_ms() < due) { struct timespec ts = { 0, 2 * 1000 * 1000 }; nanosleep(&ts, NULL); }
                int n = 0;
                for (const char *q = hex; q[0] && q[1] && n < (int)sizeof(pkt); q += 2) { unsigned v; sscanf(q, "%2x", &v); pkt[n++] = (unsigned char)v; }
                touch_feed(pkt, n);
            }
            fclose(f);
            unlink(touch_file);
            continue;
        }
        struct pollfd pf = { touch_sock, POLLIN, 0 };
        if (poll(&pf, 1, 100) > 0) {
            ssize_t n;
            while ((n = recv(touch_sock, pkt, sizeof(pkt), 0)) > 0) {
                if (n < 28 || (pkt[0] >> 4) != 4 || pkt[9] != 17) continue;
                int ihl = (pkt[0] & 15) * 4;
                if (n < ihl + 8) continue;
                unsigned saddr;
                memcpy(&saddr, pkt + 12, 4);
                if (touch_saddr && saddr != touch_saddr) continue;
                if ((pkt[ihl + 2] << 8 | pkt[ihl + 3]) != TOUCH_PORT) continue;
                touch_feed(pkt + ihl + 8, (int)n - ihl - 8);
            }
        }
        touch_lost();
    }
    return NULL;
}

/* ---- pictures ---------------------------------------------------------- */

static int read_full(unsigned char *p, size_t n) {
    while (n) {
        ssize_t r = read(0, p, n);
        if (r == 0) return 0;
        if (r < 0) { if (errno == EINTR) continue; return -1; }
        p += r; n -= (size_t)r;
    }
    return 1;
}

static void drop_root(void) {
    if (getuid() != 0) return;
    if (setgroups(0, NULL) < 0 || setgid(65534) < 0 || setuid(65534) < 0) {
        event("{\"ev\":\"error\",\"error\":\"cannot drop to nobody: %s\"}", strerror(errno));
        exit(1);
    }
}

int main(int argc, char **argv) {
    const char *frame = NULL, *iface = NULL;
    static const struct option opts[] = {
        { "frame", 1, 0, 'f' }, { "touch-iface", 1, 0, 'T' }, { "touch-src", 1, 0, 'S' }, { "touch-file", 1, 0, 'F' }, { 0, 0, 0, 0 },
    };
    int c;
    while ((c = getopt_long(argc, argv, "", opts, NULL)) != -1) {
        switch (c) {
        case 'f': frame = optarg; break;
        case 'T': iface = optarg; break;
        case 'S': touch_saddr = inet_addr(optarg); break;
        case 'F': touch_file = optarg; break;
        default: fprintf(stderr, "usage: chromium-sink --frame FILE [--touch-iface I --touch-src IP | --touch-file F]\n"); return 2;
        }
    }
    if (!frame) { fprintf(stderr, "chromium-sink: --frame is needed\n"); return 2; }
    signal(SIGPIPE, SIG_IGN);

    struct frame_out fo;
    char err[256];
    if (frame_out_open(&fo, frame, err, sizeof err) < 0) { event("{\"ev\":\"error\",\"error\":\"%s\"}", err); return 1; }
    frame_out_colour(&fo, 0, 1);

    int use_touch = 0;
    if (iface && *iface) {
        touch_sock = touch_open(iface);
        if (touch_sock < 0) event("{\"ev\":\"error\",\"error\":\"touch: %s: %s\"}", iface, strerror(errno));
        else use_touch = 1;
    } else if (touch_file) {
        use_touch = 1;
    }
    drop_root();
    pthread_t tt;
    if (use_touch && pthread_create(&tt, NULL, touch_thread, NULL) != 0) use_touch = 0;
    event("{\"ev\":\"ready\",\"w\":%d,\"h\":%d,\"touch\":%s,\"uid\":%d}", fo.w, fo.h, use_touch ? "true" : "false", (int)getuid());

    tjhandle tj = tjInitDecompress();
    unsigned char *jpeg = malloc(MAX_JPEG);
    size_t ysz = (size_t)fo.w * fo.h * 4;   /* room for a picture up to twice the file's size each way, 4:4:4 */
    unsigned char *scratch = malloc(ysz * 3);
    if (!tj || !jpeg || !scratch) { event("{\"ev\":\"error\",\"error\":\"out of memory\"}"); return 1; }

    long tick = now_ms(), spent = 0;
    int frames = 0, bad = 0;
    for (;;) {
        unsigned char hdr[4];
        int r = read_full(hdr, 4);
        if (r <= 0) break;
        uint32_t len = (uint32_t)hdr[0] | (uint32_t)hdr[1] << 8 | (uint32_t)hdr[2] << 16 | (uint32_t)hdr[3] << 24;
        if (len == 0 || len > MAX_JPEG) { event("{\"ev\":\"error\",\"error\":\"picture of %u bytes\"}", len); break; }
        if (read_full(jpeg, len) <= 0) break;

        long t0 = now_ms();
        int w, h, sub, cs;
        if (tjDecompressHeader3(tj, jpeg, len, &w, &h, &sub, &cs) < 0 || w > fo.w * 2 || h > fo.h * 2) { bad++; continue; }
        int sx = 2, sy = 2;
        switch (sub) {
        case TJSAMP_420: break;
        case TJSAMP_422: sy = 1; break;
        case TJSAMP_444: sx = 1; sy = 1; break;
        case TJSAMP_GRAY: break;
        default: bad++; continue;
        }
        unsigned char *dst = frame_out_next(&fo);
        int cw = tjPlaneWidth(1, w, sub), ch = tjPlaneHeight(1, h, sub);
        unsigned char *planes[3];
        int strides[3] = { w, sub == TJSAMP_GRAY ? 0 : cw, sub == TJSAMP_GRAY ? 0 : cw };
        planes[0] = scratch;
        planes[1] = sub == TJSAMP_GRAY ? NULL : scratch + (size_t)w * h;
        planes[2] = sub == TJSAMP_GRAY ? NULL : planes[1] + (size_t)cw * ch;
        if (tjDecompressToYUVPlanes(tj, jpeg, len, planes, w, strides, h, 0) < 0) { bad++; continue; }
        struct yuv_src s = { planes[0], planes[1], planes[2], w, cw, w, h, sx, sy };
        if (yuv_to_i420(&s, dst, fo.w, fo.h) < 0) { bad++; continue; }
        frame_out_publish(&fo);
        frames++;
        spent += now_ms() - t0;

        long now = now_ms();
        if (now - tick >= 1000) {
            event("{\"ev\":\"stats\",\"frames\":%d,\"ms\":%.1f,\"bad\":%d,\"w\":%d,\"h\":%d}", frames, frames ? (double)spent / frames : 0.0, bad, w, h);
            frames = 0; bad = 0; spent = 0; tick = now;
        }
    }
    done = 1;
    if (use_touch) pthread_join(tt, NULL);
    tjDestroy(tj);
    frame_out_close(&fo);
    return 0;
}
