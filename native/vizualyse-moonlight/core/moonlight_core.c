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
 *       --rikey HEX32 --rikeyid N --frame-file F [--decoder auto|msdk|msdk-sw|av]
 *       [--out-fps N] [--bt709] [--full-range]
 *       [--packet-size N] [--remote 0|1|2] [--no-pads] [--uid N --gid N]
 *       [--touch-iface vlan73 --touch-src 160.48.199.115 | --touch-file F]
 *
 * --frame-file: mgu-render's frame file (frame_out.h), made by server.js at
 * the size the pictures should have; the video is decoded here (decode.h:
 * the GPU through Intel Media SDK, else the unit's libavcodec) and each
 * picture written straight into its next slot, scaled to that size. A frame
 * gets no picture (decoded only) while moonlight-common-c holds more frames
 * behind it, so a late frame is replaced, never queued; --out-fps caps the
 * pictures a second (the cluster and the HUD want 15). --bt709 /
 * --full-range: the colours asked of the PC, written into the file's header.
 *
 * --touch-*: hold-to-stop on the centre screen (touch.h): a copy of the
 * display's touch PDUs, read passively on that interface (the HMI still gets
 * every one); a finger held still 2 s sends @{"ev":"exit-hold"}. --touch-file:
 * the tests' stand-in; when F appears, its "t_ms src len hex" lines (as
 * test/fixtures) are replayed at their times, then F is removed.
 *
 * --uid / --gid: the stream's threads run as that user, the tool's uplink
 * uid: mgu-uplink routes only listed uids through wlan0, root has no route
 * to the PC there (seen on the car). The gamepad thread stays root, to open
 * hot-plugged /dev/input and /dev/bus/usb devices: the drop is per thread (raw setresuid,
 * not glibc's process-wide setuid), made after that thread starts and before
 * moonlight-common-c starts its own, which inherit it.
 *
 * While streaming: S16LE 48 kHz stereo on fd 3 when it is open; on stderr
 * log lines and events, each event one line "@{json}" (a "stats" one every
 * second: frames received, pictures written, frames decoded without one,
 * failures, ms per decode). Commands on stdin, one a line:
 *   phonepad <buttons> <lt> <rt> <lx> <ly> <rx> <ry>   the phone page's pad
 *   phonepad off
 *   key <code> <0|1> <modifiers>
 *   idr
 *   quit
 * End of stdin stops the stream too (the tool went away). Start + Back + LB +
 * RB held 2 s on a gamepad sends @{"ev":"exit-combo"}: the tool stops.
 *
 * Gamepads: evdev ones, and XInput (Xbox 360) USB pads read straight through
 * usbfs, with no kernel driver: the car's kernel has no evdev, HID or xpad
 * and loads only BMW-signed modules. A USB pad is an interface ff/5d/01 under
 * /sys/bus/usb/devices that no driver holds; while streaming it is claimed,
 * its LED set to its player, and its interrupt IN endpoint read with one
 * URB at a time (the fd polls POLLOUT when it completes).
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
#include <sys/syscall.h>
#include <net/if.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <linux/if_ether.h>
#include <linux/if_packet.h>
#include <time.h>
#include <unistd.h>
#include <dirent.h>
#include <linux/input.h>
#include <linux/usbdevice_fs.h>

#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/rsa.h>
#include <openssl/x509.h>
#include <opus/opus_multistream.h>

#include <Limelight.h>
#include "decode.h"
#include "frame_out.h"
#include "pads.h"
#include "touch.h"

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

/* A USB pad's usbfs side, by slot. The URB is the kernel's while submitted;
 * closing the fd kills it and releases the interface. */
static struct usbio {
    struct usbdevfs_urb *urb;    /* allocated once per slot, kept */
    unsigned char buf[64];
    unsigned char ep_in;
} usbio[PADS_MAX];

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

/* ---- USB pads through usbfs ---- */

#define USB_SYS "/sys/bus/usb/devices"

/* A sysfs attribute, without its newline: 0, or -1. */
static int sysfs_read(const char *dir, const char *name, char *buf, size_t n) {
    char path[512];
    snprintf(path, sizeof(path), "%s/%s", dir, name);
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t got = read(fd, buf, n - 1);
    close(fd);
    if (got < 0) return -1;
    buf[got] = 0;
    while (got > 0 && (buf[got - 1] == '\n' || buf[got - 1] == ' ')) buf[--got] = 0;
    return 0;
}

static int sysfs_num(const char *dir, const char *name, int base) {
    char b[32];
    if (sysfs_read(dir, name, b, sizeof(b)) < 0 || !b[0]) return -1;
    return (int)strtol(b, NULL, base);
}

struct usb_found {
    char node[64];               /* /dev/bus/usb/BBB/DDD */
    char name[128];
    int iface;
    int ep_in, ep_out;           /* interrupt endpoints, -1 when none */
};

/* The XInput interfaces no driver holds, up to max. */
static int usb_xinput_find(struct usb_found *out, int max) {
    DIR *d = opendir(USB_SYS);
    if (!d) return 0;
    int n = 0;
    struct dirent *e;
    while (n < max && (e = readdir(d)) != NULL) {
        const char *colon = strchr(e->d_name, ':');
        if (!colon) continue;
        char ifdir[300], devdir[300], path[320];
        snprintf(ifdir, sizeof(ifdir), USB_SYS "/%s", e->d_name);
        if (!pad_xinput_match(sysfs_num(ifdir, "bInterfaceClass", 16), sysfs_num(ifdir, "bInterfaceSubClass", 16),
                              sysfs_num(ifdir, "bInterfaceProtocol", 16))) continue;
        snprintf(path, sizeof(path), "%s/driver", ifdir);
        if (access(path, F_OK) == 0) continue;            /* a kernel driver has it (xpad) */
        snprintf(devdir, sizeof(devdir), USB_SYS "/%.*s", (int)(colon - e->d_name), e->d_name);
        int bus = sysfs_num(devdir, "busnum", 10), dev = sysfs_num(devdir, "devnum", 10);
        if (bus < 0 || dev < 0) continue;
        struct usb_found *f = &out[n];
        memset(f, 0, sizeof(*f));
        snprintf(f->node, sizeof(f->node), "/dev/bus/usb/%03d/%03d", bus, dev);
        f->iface = sysfs_num(ifdir, "bInterfaceNumber", 16);
        if (sysfs_read(devdir, "product", f->name, sizeof(f->name)) < 0 || !f->name[0]) {
            char v[8] = "?", pr[8] = "?";
            sysfs_read(devdir, "idVendor", v, sizeof(v));
            sysfs_read(devdir, "idProduct", pr, sizeof(pr));
            snprintf(f->name, sizeof(f->name), "USB gamepad %s:%s", v, pr);
        }
        f->ep_in = f->ep_out = -1;
        DIR *ed = opendir(ifdir);
        struct dirent *ee;
        while (ed && (ee = readdir(ed)) != NULL) {
            if (strncmp(ee->d_name, "ep_", 3) != 0) continue;
            char epdir[600], type[32];
            snprintf(epdir, sizeof(epdir), "%s/%s", ifdir, ee->d_name);
            if (sysfs_read(epdir, "type", type, sizeof(type)) < 0 || strcmp(type, "Interrupt") != 0) continue;
            int addr = sysfs_num(epdir, "bEndpointAddress", 16);
            if (addr < 0) continue;
            if (addr & 0x80) { if (f->ep_in < 0) f->ep_in = addr; }
            else if (f->ep_out < 0) f->ep_out = addr;
        }
        if (ed) closedir(ed);
        if (f->iface < 0 || f->ep_in < 0) continue;
        n++;
    }
    closedir(d);
    return n;
}

static int usb_submit(int slot) {
    struct usbio *u = &usbio[slot];
    memset(u->urb, 0, sizeof(*u->urb));
    u->urb->type = USBDEVFS_URB_TYPE_INTERRUPT;
    u->urb->endpoint = u->ep_in;
    u->urb->buffer = u->buf;
    u->urb->buffer_length = sizeof(u->buf);
    return ioctl(pads[slot].fd, USBDEVFS_SUBMITURB, u->urb);
}

/* Claim the pad, light its LED, start reading: its slot, or -1. */
static int usb_pad_open(const struct usb_found *f) {
    int slot = -1;
    for (int i = 0; i < PADS_MAX; i++) if (pads[i].fd < 0 && i != phone_slot) { slot = i; break; }
    if (slot < 0) return -1;
    if (!usbio[slot].urb && !(usbio[slot].urb = calloc(1, sizeof(struct usbdevfs_urb)))) return -1;
    int fd = open(f->node, O_RDWR | O_CLOEXEC);
    if (fd < 0) return -1;
    unsigned int iface = (unsigned int)f->iface;
    if (ioctl(fd, USBDEVFS_CLAIMINTERFACE, &iface) < 0) { close(fd); return -1; }
    if (f->ep_out >= 0) {
        unsigned char led[3];
        pad_xinput_led(slot, led);
        struct usbdevfs_bulktransfer bt = { (unsigned int)f->ep_out, sizeof(led), 100, led };
        ioctl(fd, USBDEVFS_BULK, &bt);   /* only the LED: a pad that refuses it still works */
    }
    struct pad *p = &pads[slot];
    memset(p, 0, sizeof(*p));
    p->fd = fd;
    p->kind = PAD_XINPUT;
    snprintf(p->path, sizeof(p->path), "%s", f->node);
    snprintf(p->name, sizeof(p->name), "%s", f->name);
    usbio[slot].ep_in = (unsigned char)f->ep_in;
    if (usb_submit(slot) < 0) { close(fd); p->fd = -1; return -1; }
    return slot;
}

/* Completed reads: map them, send, read again. False when the pad is gone. */
static bool usb_pad_read(int slot) {
    struct pad *p = &pads[slot];
    struct usbdevfs_urb *done;
    while (ioctl(p->fd, USBDEVFS_REAPURBNDELAY, &done) == 0) {
        if (done->status == 0) {
            if (connected && !p->announced) pad_announce(slot);
            if (pad_xinput_report(p, usbio[slot].buf, done->actual_length)) { pad_send(slot, &p->st); pad_sent(p); }
        } else if (done->status == -ENODEV || done->status == -ESHUTDOWN) {
            pad_close(slot, "gone");
            return false;
        }
        /* anything else (a CRC or babble error): read on */
        if (usb_submit(slot) < 0) { pad_close(slot, errno == ENODEV ? "gone" : "read failed"); return false; }
    }
    if (errno != EAGAIN) { pad_close(slot, errno == ENODEV ? "gone" : "read failed"); return false; }
    return true;
}

static void pad_found(int slot, const char *name, const char *path) {
    char n[256];
    jstr(n, sizeof(n), name);
    event("{\"ev\":\"pad\",\"slot\":%d,\"name\":\"%s\",\"path\":\"%s\",\"present\":true}", slot, n, path);
    pad_announce(slot);
}

static void pads_scan(void) {
    glob_t g;
    if (glob("/dev/input/event*", 0, NULL, &g) == 0) {
        for (size_t i = 0; i < g.gl_pathc; i++) {
            if (path_open(g.gl_pathv[i])) continue;
            char name[128];
            int slot = pad_probe(g.gl_pathv[i], name, sizeof(name), 1);
            if (slot >= 0) pad_found(slot, name, g.gl_pathv[i]);
        }
        globfree(&g);
    }
    struct usb_found f[PADS_MAX];
    int n = usb_xinput_find(f, PADS_MAX);
    for (int i = 0; i < n; i++) {
        if (path_open(f[i].node)) continue;
        int slot = usb_pad_open(&f[i]);
        if (slot >= 0) pad_found(slot, f[i].name, f[i].node);
    }
}

static long now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000L + t.tv_nsec / 1000000L;
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
        for (int i = 0; i < PADS_MAX; i++) if (pads[i].fd >= 0) {
            /* usbfs: POLLOUT when a URB has completed */
            pf[n].fd = pads[i].fd; pf[n].events = pads[i].kind == PAD_XINPUT ? POLLOUT : POLLIN; slot_of[n++] = i;
        }
        pthread_mutex_unlock(&pad_lock);

        int r = poll(pf, (nfds_t)n, 200);
        pthread_mutex_lock(&pad_lock);
        /* the quit combo, held: checked on every wake, events or not */
        for (int k = 0; k < n; k++) {
            if (pads[slot_of[k]].fd >= 0 && pad_combo(&pads[slot_of[k]], now_ms())) {
                event("{\"ev\":\"exit-combo\",\"slot\":%d}", slot_of[k]);
            }
        }
        if (r <= 0) { pthread_mutex_unlock(&pad_lock); continue; }
        for (int k = 0; k < n; k++) {
            struct pad *p = &pads[slot_of[k]];
            if (p->fd < 0) continue;
            if (pf[k].revents & (POLLERR | POLLHUP | POLLNVAL)) { pad_close(slot_of[k], "gone"); continue; }
            if (p->kind == PAD_XINPUT) { if (pf[k].revents & POLLOUT) usb_pad_read(slot_of[k]); continue; }
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
    if (glob("/dev/input/event*", 0, NULL, &g) == 0) {
        for (size_t i = 0; i < g.gl_pathc; i++) {
            char name[128], n[256];
            if (pad_probe(g.gl_pathv[i], name, sizeof(name), 0) < 0) continue;
            jstr(n, sizeof(n), name);
            printf("{\"name\":\"%s\",\"path\":\"%s\"}\n", n, g.gl_pathv[i]);
        }
        globfree(&g);
    }
    /* only listed: claimed while streaming */
    struct usb_found f[PADS_MAX];
    int n = usb_xinput_find(f, PADS_MAX);
    for (int i = 0; i < n; i++) {
        char nm[256];
        jstr(nm, sizeof(nm), f[i].name);
        printf("{\"name\":\"%s\",\"path\":\"%s\"}\n", nm, f[i].node);
    }
    return 0;
}

/* ---- touch: hold-to-stop, read passively ---------------------------------- */

static int touch_sock = -1;              /* AF_PACKET on the display's interface, opened as root */
static unsigned touch_saddr = 0;         /* network order; 0 = any sender */
static const char *touch_file = NULL;

/* A packet socket on iface for IPv4 (no link header): -1 when it can't be had. */
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

static void touch_feed(struct touch_hold *h, const unsigned char *udp, int len, long now) {
    int ph, x, y;
    if (!touch_decode(udp, len, &ph, &x, &y)) return;
    if (touch_step(h, ph, x, y, now)) event("{\"ev\":\"exit-hold\",\"x\":%d,\"y\":%d}", x, y);
}

static void *touch_thread(void *arg) {
    (void)arg;
    struct touch_hold h;
    memset(&h, 0, sizeof(h));
    unsigned char pkt[2048];
    while (!stopping && !terminated) {
        if (touch_file) {
            /* the tests' replay */
            FILE *f = fopen(touch_file, "r");
            if (!f) { struct timespec ts = { 0, 100 * 1000 * 1000 }; nanosleep(&ts, NULL); continue; }
            char line[1024], src[64], hex[600];
            int t, len;
            long start = now_ms(), first = -1;
            while (!stopping && fgets(line, sizeof line, f)) {
                if (sscanf(line, "%d %63s %d %599s", &t, src, &len, hex) != 4) continue;
                if (first < 0) first = t;
                long due = start + (t - first);
                while (now_ms() < due) { struct timespec ts = { 0, 2 * 1000 * 1000 }; nanosleep(&ts, NULL); }
                int n = 0;
                for (const char *q = hex; q[0] && q[1] && n < (int)sizeof(pkt); q += 2) { unsigned v; sscanf(q, "%2x", &v); pkt[n++] = (unsigned char)v; }
                touch_feed(&h, pkt, n, now_ms());
            }
            fclose(f);
            unlink(touch_file);
            continue;
        }
        struct pollfd pf = { touch_sock, POLLIN, 0 };
        if (poll(&pf, 1, 100) > 0) {
            ssize_t n;
            while ((n = recv(touch_sock, pkt, sizeof(pkt), 0)) > 0) {
                /* IPv4, UDP, to the HMI's touch port, from the display */
                if (n < 28 || (pkt[0] >> 4) != 4 || pkt[9] != 17) continue;
                int ihl = (pkt[0] & 15) * 4;
                if (n < ihl + 8) continue;
                unsigned saddr;
                memcpy(&saddr, pkt + 12, 4);
                if (touch_saddr && saddr != touch_saddr) continue;
                if ((pkt[ihl + 2] << 8 | pkt[ihl + 3]) != TOUCH_PORT) continue;
                touch_feed(&h, pkt + ihl + 8, (int)n - ihl - 8, now_ms());
            }
        }
        if (touch_tick(&h, now_ms())) event("{\"ev\":\"exit-hold\",\"x\":%d,\"y\":%d}", h.x0, h.y0);
    }
    return NULL;
}

/* ---- video --------------------------------------------------------------- */

static struct decoder *dec = NULL;
static struct frame_out fout;
static const char *dec_which = "auto";
static int out_fps = 0;                  /* pictures a second at most; 0: every frame */
static unsigned char *au_buf = NULL;     /* the access unit, its buffers joined */
static size_t au_cap = 0;
/* the decoder's thread writes these, the main thread reads them once a second */
static volatile unsigned long frames = 0, pictures = 0, skipped = 0, dec_failed = 0, dec_us = 0;
static int dec_fail_run = 0, dec_had_picture = 0;
static long last_pic_ms = -100000;

static int dr_setup(int fmt, int w, int h, int rate, void *ctx, int flags) {
    (void)ctx; (void)flags;
    event("{\"ev\":\"video\",\"format\":%d,\"width\":%d,\"height\":%d,\"fps\":%d,\"out\":\"%dx%d\"}", fmt, w, h, rate, fout.w, fout.h);
    return (fmt & VIDEO_FORMAT_MASK_H264) ? 0 : -1;
}

/* The GPU's decoder failed from the start (it can't once its session runs
 * as the uplink uid, say): libavcodec instead, for the rest of the stream. */
static void dec_fallback(const char *why) {
    char err[256], w[256], n[256];
    struct decoder *av = av_open(fout.w, fout.h, err, sizeof(err));
    jstr(w, sizeof(w), why);
    if (!av) { jstr(n, sizeof(n), err); event("{\"ev\":\"decoder\",\"fallback\":false,\"why\":\"%s\",\"error\":\"%s\"}", w, n); return; }
    decoder_close(dec);
    dec = av;
    jstr(n, sizeof(n), decoder_name(dec));
    event("{\"ev\":\"decoder\",\"name\":\"%s\",\"fallback\":true,\"why\":\"%s\"}", n, w);
}

static int dr_submit(PDECODE_UNIT du) {
    if ((size_t)du->fullLength > au_cap) {
        size_t c = (size_t)du->fullLength + 65536;
        unsigned char *b = realloc(au_buf, c);
        if (!b) return DR_NEED_IDR;
        au_buf = b; au_cap = c;
    }
    size_t len = 0;
    for (PLENTRY e = du->bufferList; e; e = e->next) { memcpy(au_buf + len, e->data, (size_t)e->length); len += (size_t)e->length; }
    frames++;
    /* a picture only when nothing waits behind this frame, at most out_fps a second */
    long now = now_ms();
    int want = LiGetPendingVideoFrames() == 0 && (!out_fps || now - last_pic_ms >= 1000 / out_fps - 2);
    char err[512];
    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    int r = decoder_decode(dec, au_buf, len, want ? frame_out_next(&fout) : NULL, err, sizeof(err));
    clock_gettime(CLOCK_MONOTONIC, &t1);
    dec_us += (unsigned long)((t1.tv_sec - t0.tv_sec) * 1000000L + (t1.tv_nsec - t0.tv_nsec) / 1000);
    if (r > 0) {
        frame_out_publish(&fout);
        last_pic_ms = now;
        if (!pictures++) event("{\"ev\":\"first-picture\",\"frame\":%lu}", frames);
        dec_had_picture = 1;
    } else if (r == 0 && !want) {
        skipped++;
    }
    if (r >= 0) { dec_fail_run = 0; return DR_OK; }
    dec_failed++;
    if (dec_fail_run++ < 3 || dec_fail_run % 30 == 0) {
        char e[600];
        jstr(e, sizeof(e), err);
        event("{\"ev\":\"decode-failed\",\"frame\":%lu,\"run\":%d,\"error\":\"%s\"}", frames, dec_fail_run, e);
    }
    if (!dec_had_picture && dec_fail_run >= 5 && strncmp(decoder_name(dec), "msdk", 4) == 0) dec_fallback(err);
    return DR_NEED_IDR;
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
    long run_uid = -1, run_gid = -1;
    const char *touch_iface = NULL;
    const char *frame_file = NULL;

    static struct option opts[] = {
        { "address", 1, 0, 'a' }, { "appversion", 1, 0, 'v' }, { "gfeversion", 1, 0, 'g' }, { "rtsp", 1, 0, 'r' },
        { "codecs", 1, 0, 'c' }, { "width", 1, 0, 'W' }, { "height", 1, 0, 'H' }, { "fps", 1, 0, 'f' },
        { "bitrate", 1, 0, 'b' }, { "packet-size", 1, 0, 'p' }, { "remote", 1, 0, 'R' }, { "rikey", 1, 0, 'k' },
        { "rikeyid", 1, 0, 'i' }, { "no-pads", 0, 0, 'n' }, { "uid", 1, 0, 'u' }, { "gid", 1, 0, 'G' },
        { "touch-iface", 1, 0, 'T' }, { "touch-src", 1, 0, 'S' }, { "touch-file", 1, 0, 'F' },
        { "frame-file", 1, 0, 'o' }, { "decoder", 1, 0, 'd' }, { "out-fps", 1, 0, 'O' }, { "bt709", 0, 0, '7' },
        { "full-range", 0, 0, 'X' }, { 0, 0, 0, 0 }
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
        case 'u': run_uid = strtol(optarg, NULL, 10); break;
        case 'G': run_gid = strtol(optarg, NULL, 10); break;
        case 'T': touch_iface = optarg; break;
        case 'S': touch_saddr = inet_addr(optarg); break;
        case 'F': touch_file = optarg; break;
        case 'o': frame_file = optarg; break;
        case 'd': dec_which = optarg; break;
        case 'O': out_fps = atoi(optarg); break;
        case '7': sc.colorSpace = COLORSPACE_REC_709; break;
        case 'X': sc.colorRange = COLOR_RANGE_FULL; break;
        default: return 2;
        }
    }
    if (!si.address || !si.serverInfoAppVersion || !rikey || hexbytes(rikey, sc.remoteInputAesKey, 16) < 0 || !frame_file) {
        fprintf(stderr, "stream: --address, --appversion, --rikey (32 hex digits) and --frame-file are required\n");
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

    /* the picture's way out, opened as root: the frame file (root's), the
     * render node (group video) and the decoder's libraries */
    char err[512], e[600];
    if (frame_out_open(&fout, frame_file, err, sizeof(err)) < 0) {
        jstr(e, sizeof(e), err);
        event("{\"ev\":\"failed\",\"code\":-1,\"why\":\"%s\"}", e);
        return 1;
    }
    frame_out_colour(&fout, sc.colorSpace == COLORSPACE_REC_709, sc.colorRange == COLOR_RANGE_FULL);
    dec = decoder_open(dec_which, fout.w, fout.h, err, sizeof(err));
    jstr(e, sizeof(e), dec ? decoder_name(dec) : err);
    if (!dec) { event("{\"ev\":\"failed\",\"code\":-1,\"why\":\"no decoder: %s\"}", e); return 1; }
    event("{\"ev\":\"decoder\",\"name\":\"%s\",\"out\":\"%dx%d\",\"outFps\":%d}", e, fout.w, fout.h, out_fps);

    DECODER_RENDERER_CALLBACKS dr;
    LiInitializeVideoCallbacks(&dr);
    dr.setup = dr_setup;
    dr.submitDecodeUnit = dr_submit;
    /* slices: libavcodec decodes each frame on several threads */
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
    /* the touch watch: its socket needs root (CAP_NET_RAW), so before the drop below */
    pthread_t ttouch;
    int use_touch = 0;
    if (touch_iface) {
        touch_sock = touch_open(touch_iface);
        if (touch_sock < 0) event("{\"ev\":\"touch\",\"ok\":false,\"why\":\"%s: %s\"}", touch_iface, strerror(errno));
        else { event("{\"ev\":\"touch\",\"ok\":true,\"iface\":\"%s\"}", touch_iface); use_touch = 1; }
    } else if (touch_file) {
        event("{\"ev\":\"touch\",\"ok\":true,\"file\":true}");
        use_touch = 1;
    }
    if (use_touch) pthread_create(&ttouch, NULL, touch_thread, NULL);
    /* this thread (and the threads it starts) as the uplink uid; the pads
     * thread above keeps root */
    if (run_uid >= 0) {
        long g = run_gid >= 0 ? run_gid : run_uid;
        if (syscall(SYS_setgroups, 0, NULL) != 0 || syscall(SYS_setresgid, g, g, g) != 0 || syscall(SYS_setresuid, run_uid, run_uid, run_uid) != 0) {
            event("{\"ev\":\"failed\",\"code\":-1,\"why\":\"setresuid %ld: %s\"}", run_uid, strerror(errno));
            stopping = 1;
            if (use_pads) pthread_join(tpads, NULL);
            return 1;
        }
        event("{\"ev\":\"uid\",\"uid\":%ld,\"gid\":%ld}", (long)syscall(SYS_getuid), (long)syscall(SYS_getgid));
    }

    event("{\"ev\":\"connecting\",\"width\":%d,\"height\":%d,\"fps\":%d,\"bitrate\":%d}", sc.width, sc.height, sc.fps, sc.bitrate);
    int rc = LiStartConnection(&si, &sc, &cl, &dr, &ar, NULL, 0, NULL, 0);
    if (rc != 0) {
        event("{\"ev\":\"failed\",\"code\":%d}", rc);
        stopping = 1;
        if (use_pads) pthread_join(tpads, NULL);
        return 1;
    }
    unsigned long last = 0, last_pics = 0, last_us = 0;
    time_t t0 = time(NULL), tl = t0;
    while (!stopping && !terminated) {
        struct timespec ts = { 0, 200 * 1000 * 1000 };
        nanosleep(&ts, NULL);
        time_t now = time(NULL);
        if (now - tl >= 1) {
            uint32_t rtt = 0, var = 0;
            LiGetEstimatedRttInfo(&rtt, &var);
            unsigned long f = frames, p = pictures, us = dec_us, dt = (unsigned long)(now - tl);
            event("{\"ev\":\"stats\",\"frames\":%lu,\"fps\":%lu,\"pictures\":%lu,\"pps\":%lu,\"skipped\":%lu,\"failed\":%lu,\"decodeMs\":%.1f,\"rtt\":%u}",
                  f, (f - last) / dt, p, (p - last_pics) / dt, skipped, dec_failed,
                  f > last ? (double)(us - last_us) / 1000.0 / (double)(f - last) : 0.0, rtt);
            last = f; last_pics = p; last_us = us; tl = now;
        }
    }
    LiStopConnection();
    stopping = 1;
    if (use_pads) pthread_join(tpads, NULL);
    if (use_touch) pthread_join(ttouch, NULL);
    if (touch_sock >= 0) close(touch_sock);
    decoder_close(dec);
    frame_out_close(&fout);
    event("{\"ev\":\"stopped\",\"frames\":%lu,\"pictures\":%lu,\"code\":%d}", frames, pictures, term_code);
    return terminated && term_code != ML_ERROR_GRACEFUL_TERMINATION ? 3 : 0;
}

int main(int argc, char **argv) {
    if (argc == 4 && strcmp(argv[1], "gencert") == 0) return gencert(argv[2], argv[3]);
    if (argc == 2 && strcmp(argv[1], "pads") == 0) return list_pads();
    if (argc >= 2 && strcmp(argv[1], "stream") == 0) return stream(argc, argv);
    fprintf(stderr, "usage: moonlight-core gencert <cert.pem> <key.pem> | pads | stream --address ... (see the source)\n");
    return 2;
}
