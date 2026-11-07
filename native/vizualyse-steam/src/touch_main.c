// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * steam-touch: the centre display's touches, while a game is shown (a copy of vizualyse-chromium's sink/touch_main.c).
 *
 *   steam-touch [--touch-iface vlan73 --touch-src 160.48.199.115 | --touch-file F]
 *
 * stdout: one JSON event a line: {"ev":"ready",...}, {"ev":"touch","p":1|2|3,
 * "x":..,"y":..} (down / move / up, screen pixels 1920x720 on the car),
 * {"ev":"error",...}. It ends when its stdin closes (server.js hides).
 *
 * Touch is read passively (an AF_PACKET copy of the display's UDP PDUs on
 * vlan73; the HMI still gets every one, nothing is claimed: a claim through
 * mgu-render restarted the head unit, knowledge/central-screen.md). The
 * socket needs root; once it is open the helper drops to nobody.
 * --touch-file replays a capture (the tests: "t src len hex" lines, as
 * moonlight's test/fixtures).
 *
 */
#define _GNU_SOURCE
#include "touch.h"

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
#include <unistd.h>

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

/* ---- main -------------------------------------------------------------- */

static void drop_root(void) {
    if (getuid() != 0) return;
    if (setgroups(0, NULL) < 0 || setgid(65534) < 0 || setuid(65534) < 0) {
        event("{\"ev\":\"error\",\"error\":\"cannot drop to nobody: %s\"}", strerror(errno));
        exit(1);
    }
}

int main(int argc, char **argv) {
    const char *iface = NULL;
    static const struct option opts[] = {
        { "touch-iface", 1, 0, 'T' }, { "touch-src", 1, 0, 'S' }, { "touch-file", 1, 0, 'F' }, { 0, 0, 0, 0 },
    };
    int c;
    while ((c = getopt_long(argc, argv, "", opts, NULL)) != -1) {
        switch (c) {
        case 'T': iface = optarg; break;
        case 'S': touch_saddr = inet_addr(optarg); break;
        case 'F': touch_file = optarg; break;
        default: fprintf(stderr, "usage: steam-touch [--touch-iface I --touch-src IP | --touch-file F]\n"); return 2;
        }
    }
    signal(SIGPIPE, SIG_IGN);

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
    event("{\"ev\":\"ready\",\"touch\":%s,\"uid\":%d}", use_touch ? "true" : "false", (int)getuid());

    /* until server.js closes stdin */
    char buf[256];
    for (;;) {
        ssize_t r = read(0, buf, sizeof buf);
        if (r == 0 || (r < 0 && errno != EINTR)) break;
    }
    done = 1;
    if (use_touch) pthread_join(tt, NULL);
    return 0;
}
