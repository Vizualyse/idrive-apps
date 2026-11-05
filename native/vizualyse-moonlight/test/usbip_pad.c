// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * A virtual XInput (Xbox 360) USB pad for the off-car tests, through USB/IP:
 * this process answers the kernel's vhci_hcd as the device (one end of a
 * socketpair handed to vhci's attach), so a real USB device appears, with a
 * /dev/bus/usb node and no driver bound, as the car's Vader 4 Pro: interface
 * ff/5d/01, interrupt IN 0x81 and OUT 0x05, 20-byte input reports.
 * Needs vhci_hcd in the running kernel (modprobe vhci-hcd) and its sysfs.
 *
 * As uinput_pad: prints "ready /dev/bus/usb/BBB/DDD", then presses A and
 * pushes the left stick once a second until stdin closes or `seconds` pass,
 * then unplugs. A line "combo" on stdin holds Start + Back + LB + RB (the
 * quit combo) for 3 s instead. What the host writes to the OUT endpoint (the
 * LED) goes to stderr as "usbip_pad: out 01 03 06".
 *
 *   usbip_pad [seconds]
 */
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/socket.h>

#define VHCI "/sys/devices/platform/vhci_hcd.0"
#define PRODUCT "Test USB Pad"

static int sock = -1;

static void put32(unsigned char *b, uint32_t v) { b[0] = v >> 24; b[1] = v >> 16; b[2] = v >> 8; b[3] = v; }
static uint32_t get32(const unsigned char *b) { return (uint32_t)b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]; }

static int read_full(int fd, void *buf, size_t n) {
    unsigned char *p = buf;
    while (n) {
        ssize_t r = read(fd, p, n);
        if (r <= 0) { if (r < 0 && errno == EINTR) continue; return -1; }
        p += r; n -= (size_t)r;
    }
    return 0;
}

static void write_full(int fd, const void *buf, size_t n) {
    const unsigned char *p = buf;
    while (n) {
        ssize_t r = write(fd, p, n);
        if (r <= 0) { if (r < 0 && errno == EINTR) continue; perror("usbip_pad: write"); exit(1); }
        p += r; n -= (size_t)r;
    }
}

/* USBIP_RET_SUBMIT: IN data follows when in and len > 0 */
static void ret_submit(uint32_t seq, int32_t status, const unsigned char *data, int len, int in) {
    unsigned char h[48];
    memset(h, 0, sizeof(h));
    put32(h, 3); put32(h + 4, seq);
    put32(h + 20, (uint32_t)status); put32(h + 24, (uint32_t)len);
    write_full(sock, h, sizeof(h));
    if (in && len > 0) write_full(sock, data, (size_t)len);
}

/* ---- the device ---- */

static const unsigned char dev_desc[18] = {
    18, 1, 0x00, 0x02, 0xff, 0xff, 0xff, 8, 0x5e, 0x04, 0x8e, 0x02, 0x14, 0x01, 1, 2, 3, 1,
};
static const unsigned char cfg_desc[32] = {
    9, 2, 32, 0, 1, 1, 0, 0xa0, 0xfa,
    9, 4, 0, 0, 2, 0xff, 0x5d, 0x01, 0,          /* the XInput interface */
    7, 5, 0x81, 3, 0x20, 0, 4,                   /* interrupt IN, as the car's pad */
    7, 5, 0x05, 3, 0x20, 0, 8,                   /* interrupt OUT */
};

static int string_desc(int idx, unsigned char *out) {
    static const char *s[] = { NULL, "Test", PRODUCT, "TEST0001" };
    if (idx == 0) { out[0] = 4; out[1] = 3; out[2] = 0x09; out[3] = 0x04; return 4; }
    if (idx < 1 || idx > 3) return -1;
    int n = 0;
    for (const char *c = s[idx]; *c; c++) { out[2 + 2 * n] = (unsigned char)*c; out[3 + 2 * n] = 0; n++; }
    out[0] = (unsigned char)(2 + 2 * n); out[1] = 3;
    return out[0];
}

static void control(uint32_t seq, int in, const unsigned char *setup, int len) {
    int req = setup[1], type = setup[3], idx = setup[2];
    int wlen = setup[6] | setup[7] << 8;
    unsigned char buf[256];
    const unsigned char *d = NULL;
    int n = 0;
    if (req == 6) {                                  /* GET_DESCRIPTOR */
        if (type == 1) { d = dev_desc; n = sizeof(dev_desc); }
        else if (type == 2) { d = cfg_desc; n = sizeof(cfg_desc); }
        else if (type == 3 && (n = string_desc(idx, buf)) > 0) d = buf;
        if (!d) { ret_submit(seq, -32, NULL, 0, in); return; }   /* -EPIPE: a stall */
    } else if (req == 0 && in) {                     /* GET_STATUS */
        memset(buf, 0, 2); d = buf; n = 2;
    }
    if (n > wlen) n = wlen;
    if (n > len) n = len;
    ret_submit(seq, 0, d, in ? n : 0, in);
}

/* the pad's state, as a 20-byte report */
static unsigned buttons;
static short lx;
static int changed = 1;
static uint32_t pending[16];
static int npending;

static void send_report(void) {
    if (!changed || !npending) return;
    unsigned char r[20];
    memset(r, 0, sizeof(r));
    r[0] = 0x00; r[1] = 0x14;
    r[2] = buttons & 0xff; r[3] = buttons >> 8;
    r[6] = (unsigned char)(lx & 0xff); r[7] = (unsigned char)((lx >> 8) & 0xff);
    uint32_t seq = pending[0];
    memmove(pending, pending + 1, (size_t)--npending * sizeof(pending[0]));
    ret_submit(seq, 0, r, sizeof(r), 1);
    changed = 0;
}

/* one command from vhci: -1 when the socket closed */
static int serve(void) {
    unsigned char h[48];
    if (read_full(sock, h, sizeof(h)) < 0) return -1;
    uint32_t cmd = get32(h), seq = get32(h + 4), dir = get32(h + 12), ep = get32(h + 16);
    if (cmd == 1) {                                  /* USBIP_CMD_SUBMIT */
        int len = (int)get32(h + 24);
        unsigned char out[512];
        if (dir == 0 && len > 0) {
            if (len > (int)sizeof(out) || read_full(sock, out, (size_t)len) < 0) return -1;
        }
        if (ep == 0) control(seq, dir == 1, h + 40, len);
        else if (ep == 1 && dir == 1) {
            if (npending < 16) pending[npending++] = seq;
            send_report();
        } else if (ep == 5 && dir == 0) {
            fprintf(stderr, "usbip_pad: out");
            for (int i = 0; i < len; i++) fprintf(stderr, " %02x", out[i]);
            fprintf(stderr, "\n");
            ret_submit(seq, 0, NULL, len, 0);
        } else ret_submit(seq, -32, NULL, 0, (int)dir);
    } else if (cmd == 2) {                           /* USBIP_CMD_UNLINK */
        uint32_t victim = get32(h + 20);
        int status = 0;
        for (int i = 0; i < npending; i++) if (pending[i] == victim) {
            memmove(pending + i, pending + i + 1, (size_t)(npending - i - 1) * sizeof(pending[0]));
            npending--; status = -104;               /* -ECONNRESET: unlinked before it completed */
            break;
        }
        unsigned char r[48];
        memset(r, 0, sizeof(r));
        put32(r, 4); put32(r + 4, seq); put32(r + 20, (uint32_t)status);
        write_full(sock, r, sizeof(r));
    }
    return 0;
}

/* ---- attach, find, detach ---- */

static int sysread(const char *path, char *buf, size_t n) {
    FILE *f = fopen(path, "r");
    if (!f) return -1;
    size_t got = fread(buf, 1, n - 1, f);
    fclose(f);
    buf[got] = 0;
    while (got && (buf[got - 1] == '\n' || buf[got - 1] == ' ')) buf[--got] = 0;
    return 0;
}

static int syswrite(const char *path, const char *s) {
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -1;
    ssize_t r = write(fd, s, strlen(s));
    close(fd);
    return r == (ssize_t)strlen(s) ? 0 : -1;
}

/* a free high-speed port in vhci's status: "hs  0003 004 ..." (004: free) */
static int free_port(void) {
    FILE *f = fopen(VHCI "/status", "r");
    if (!f) return -1;
    char line[256];
    int port = -1;
    while (port < 0 && fgets(line, sizeof(line), f)) {
        int p, st;
        if (strncmp(line, "hs", 2) == 0 && sscanf(line + 2, "%d %d", &p, &st) == 2 && st == 4) port = p;
    }
    fclose(f);
    return port;
}

/* the device's node, once the kernel has configured it */
static int find_node(char *node, size_t n) {
    char path[256], v[64];
    for (int bus = 1; bus < 64; bus++) for (int port = 1; port <= 16; port++) {
        snprintf(path, sizeof(path), "/sys/bus/usb/devices/%d-%d/product", bus, port);
        if (sysread(path, v, sizeof(v)) < 0 || strcmp(v, PRODUCT) != 0) continue;
        snprintf(path, sizeof(path), "/sys/bus/usb/devices/%d-%d/%d-%d:1.0", bus, port, bus, port);
        if (access(path, F_OK) != 0) continue;
        char b[16], d[16];
        snprintf(path, sizeof(path), "/sys/bus/usb/devices/%d-%d/busnum", bus, port);
        if (sysread(path, b, sizeof(b)) < 0) continue;
        snprintf(path, sizeof(path), "/sys/bus/usb/devices/%d-%d/devnum", bus, port);
        if (sysread(path, d, sizeof(d)) < 0) continue;
        snprintf(node, n, "/dev/bus/usb/%03d/%03d", atoi(b), atoi(d));
        return 0;
    }
    return -1;
}

static long ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
}

int main(int argc, char **argv) {
    int seconds = argc > 1 ? atoi(argv[1]) : 30;
    if (access(VHCI "/attach", W_OK) != 0) { printf("no vhci_hcd (modprobe vhci-hcd)\n"); return 77; }
    int port = free_port();
    if (port < 0) { printf("no free vhci port\n"); return 77; }
    int sv[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sv) < 0) { perror("socketpair"); return 1; }
    char att[64];
    snprintf(att, sizeof(att), "%d %d %d %d", port, sv[0], (1 << 16) | (port + 2), 2 /* USB_SPEED_FULL */);
    if (syswrite(VHCI "/attach", att) < 0) { printf("vhci attach refused: %s\n", strerror(errno)); return 77; }
    close(sv[0]);                                    /* vhci holds its own reference */
    sock = sv[1];

    char node[64] = "";
    long until = ms() + 10000, end = ms() + seconds * 1000L, next = 0, combo_end = 0;
    int ready = 0, on = 0;
    for (;;) {
        long now = ms();
        if (!ready && find_node(node, sizeof(node)) == 0) { printf("ready %s\n", node); fflush(stdout); ready = 1; next = now + 1000; }
        if (!ready && now > until) { printf("the device did not appear\n"); fflush(stdout); break; }
        if (ready && now >= end) break;
        if (ready && combo_end && now >= combo_end) { buttons = 0; changed = 1; combo_end = 0; next = now + 1000; send_report(); }
        if (ready && !combo_end && now >= next) {
            on = !on;
            buttons = on ? 0x1000 : 0;               /* A */
            lx = on ? 32767 : 0;
            changed = 1; next = now + 1000;
            send_report();
        }
        struct pollfd pf[2] = { { sock, POLLIN, 0 }, { 0, ready ? POLLIN : 0, 0 } };
        if (poll(pf, 2, 100) < 0 && errno != EINTR) break;
        if (pf[0].revents & (POLLIN | POLLHUP)) { if (serve() < 0) { fprintf(stderr, "usbip_pad: vhci closed the connection\n"); break; } }
        if (pf[1].revents & (POLLIN | POLLHUP)) {
            char line[32];
            ssize_t n = read(0, line, sizeof(line) - 1);
            if (n <= 0) break;
            line[n] = 0;
            if (strncmp(line, "combo", 5) == 0) {
                buttons = 0x0010 | 0x0020 | 0x0100 | 0x0200;   /* Start, Back, LB, RB */
                lx = 0; changed = 1; combo_end = ms() + 3000;
                send_report();
            }
        }
    }
    char det[16];
    snprintf(det, sizeof(det), "%d", port);
    if (syswrite(VHCI "/detach", det) < 0) fprintf(stderr, "usbip_pad: detach: %s\n", strerror(errno));
    close(sock);
    return 0;
}
