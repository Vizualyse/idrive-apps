// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * steam-pads: the game's controllers, while it runs.
 *
 *   steam-pads --out /dev/shm/vizualyse-steam/pads
 *
 * XInput (Xbox 360-style) USB pads read straight through usbfs (the
 * platform's usb_pads.c and pads.c, vizualyse-moonlight's code: the car's
 * kernel has no input drivers), up to four, hot-plugged (a scan every 2 s),
 * each claimed while the game runs, its LED lit for its player. Their
 * state goes into the pads file (src/vzs_pads.h), which our xinput1_4.dll
 * reads in Wine. Root (usbfs); the file is world-readable (the game runs as
 * the tool's uid). Ends when stdin closes (game.js stops it): the slots
 * marked unplugged, the pads released.
 *
 * stdout: one JSON event a line: {"ev":"ready"}, {"ev":"pad","slot":n,
 * "name":..,"present":true|false}, {"ev":"error",...}.
 */
#define _GNU_SOURCE
#include "usb_pads.h"
#include "vzs_pads.h"

#include <errno.h>
#include <fcntl.h>
#include <getopt.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int out_fd = -1;
static struct usb_pad pads[VZS_PADS_SLOTS];
static uint32_t packets[VZS_PADS_SLOTS];

static void event(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    putchar('\n');
    fflush(stdout);
}

/* a name for JSON: quotes and control characters out */
static void jname(char *out, size_t n, const char *in) {
    size_t j = 0;
    for (size_t i = 0; in[i] && j + 1 < n; i++) {
        unsigned char c = (unsigned char)in[i];
        out[j++] = (c < 0x20 || c == '"' || c == '\\') ? ' ' : (char)c;
    }
    out[j] = 0;
}

static void write_slot(int slot) {
    struct vzs_pad s;
    memset(&s, 0, sizeof(s));
    const struct pad *p = &pads[slot].pad;
    s.packet = ++packets[slot];
    if (p->fd >= 0) {
        s.connected = 1;
        s.buttons = (uint16_t)p->st.buttons;
        s.lt = p->st.lt; s.rt = p->st.rt;
        s.lx = p->st.lx; s.ly = p->st.ly; s.rx = p->st.rx; s.ry = p->st.ry;
    }
    off_t off = (off_t)offsetof(struct vzs_pads_file, pad) + (off_t)slot * (off_t)sizeof(s);
    if (pwrite(out_fd, &s, sizeof(s), off) != (ssize_t)sizeof(s))
        event("{\"ev\":\"error\",\"error\":\"pads file: %s\"}", strerror(errno));
}

static int open_out(const char *path) {
    char tmp[512];
    snprintf(tmp, sizeof(tmp), "%s.tmp", path);
    int fd = open(tmp, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd < 0) return -1;
    fchmod(fd, 0644);
    struct vzs_pads_file f;
    memset(&f, 0, sizeof(f));
    f.magic = VZS_PADS_MAGIC; f.version = 1; f.slots = VZS_PADS_SLOTS;
    if (write(fd, &f, sizeof(f)) != (ssize_t)sizeof(f) || rename(tmp, path) < 0) { close(fd); return -1; }
    return fd;
}

static bool node_open(const char *node) {
    for (int i = 0; i < VZS_PADS_SLOTS; i++)
        if (pads[i].pad.fd >= 0 && strcmp(pads[i].pad.path, node) == 0) return true;
    return false;
}

static void scan(void) {
    struct usb_found f[VZS_PADS_SLOTS];
    int n = usb_xinput_find(f, VZS_PADS_SLOTS);
    for (int i = 0; i < n; i++) {
        if (node_open(f[i].node)) continue;
        int slot = -1;
        for (int k = 0; k < VZS_PADS_SLOTS; k++) if (pads[k].pad.fd < 0) { slot = k; break; }
        if (slot < 0) return;
        char name[160];
        jname(name, sizeof(name), f[i].name);
        if (usb_pad_open(&pads[slot], &f[i], slot) < 0) {
            event("{\"ev\":\"error\",\"error\":\"%s (%s): %s\"}", name, f[i].node, strerror(errno));
            continue;
        }
        write_slot(slot);
        event("{\"ev\":\"pad\",\"slot\":%d,\"name\":\"%s\",\"path\":\"%s\",\"present\":true}", slot, name, f[i].node);
    }
}

static void gone(int slot) {
    char name[160];
    jname(name, sizeof(name), pads[slot].pad.name);
    usb_pad_close(&pads[slot]);
    write_slot(slot);
    event("{\"ev\":\"pad\",\"slot\":%d,\"name\":\"%s\",\"present\":false}", slot, name);
}

int main(int argc, char **argv) {
    const char *out = NULL;
    static const struct option opts[] = { { "out", 1, 0, 'o' }, { 0, 0, 0, 0 } };
    for (int c; (c = getopt_long(argc, argv, "", opts, NULL)) != -1;) {
        if (c == 'o') out = optarg;
        else { fprintf(stderr, "usage: steam-pads --out FILE\n"); return 2; }
    }
    if (!out) { fprintf(stderr, "usage: steam-pads --out FILE\n"); return 2; }
    signal(SIGPIPE, SIG_IGN);
    umask(022);
    out_fd = open_out(out);
    if (out_fd < 0) { event("{\"ev\":\"error\",\"error\":\"%s: %s\"}", out, strerror(errno)); return 1; }
    for (int i = 0; i < VZS_PADS_SLOTS; i++) usb_pad_init(&pads[i]);
    event("{\"ev\":\"ready\",\"out\":\"%s\"}", out);

    time_t last_scan = 0;
    for (;;) {
        time_t now = time(NULL);
        if (now - last_scan >= 2) { scan(); last_scan = now; }
        struct pollfd pf[VZS_PADS_SLOTS + 1];
        int slot_of[VZS_PADS_SLOTS + 1], n = 0;
        pf[n].fd = 0; pf[n].events = POLLIN; slot_of[n++] = -1;   /* stdin: its end stops us */
        for (int i = 0; i < VZS_PADS_SLOTS; i++) if (pads[i].pad.fd >= 0) {
            pf[n].fd = pads[i].pad.fd; pf[n].events = POLLOUT; slot_of[n++] = i;   /* usbfs: POLLOUT when a URB completed */
        }
        int r = poll(pf, (nfds_t)n, 500);
        if (r < 0) { if (errno == EINTR) continue; break; }
        if (r == 0) continue;
        if (pf[0].revents) {
            char b[64];
            ssize_t got = read(0, b, sizeof(b));
            if (got <= 0) break;
        }
        for (int k = 1; k < n; k++) {
            int s = slot_of[k];
            if (pads[s].pad.fd < 0) continue;
            if (pf[k].revents & (POLLERR | POLLHUP | POLLNVAL)) { gone(s); continue; }
            if (!(pf[k].revents & POLLOUT)) continue;
            int c = usb_pad_read(&pads[s]);
            if (c < 0) gone(s);
            else if (c > 0) { write_slot(s); pad_sent(&pads[s].pad); }
        }
    }
    for (int i = 0; i < VZS_PADS_SLOTS; i++) if (pads[i].pad.fd >= 0) { usb_pad_close(&pads[i]); write_slot(i); }
    close(out_fd);
    return 0;
}
