/*
 * tap2touch: the emulator's mouse as the centre screen's touch.
 *
 * QEMU on Windows sends the host mouse to its absolute "tablet" device
 * (ABS_X / ABS_Y with BTN_LEFT); Winston only takes touch (BTN_TOUCH, multi
 * touch slots). This grabs the tablet and replays it through uinput as a
 * one-finger direct touchscreen with the same axis range, so a click is a tap
 * and a drag is a swipe. Built static, runs inside the VM only.
 *
 * The HMI does not read Winston's touch: on the car the centre display (CID)
 * sends its touch frames over Ethernet as AUTOSAR PDUs to HmiMain3D's
 * CTouchDataClient (UDP port 30567). Each touch frame also goes there, in that
 * format (cidtouch.js has the layout), every 20 ms while the button is held.
 *
 *   tap2touch [/dev/input/eventN]     (default: the first device with
 *                                      ABS_X and BTN_LEFT and no multi touch axes:
 *                                      QEMU's tablet also lists BTN_TOUCH)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <netinet/in.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>

#define CID_W 1920
#define CID_H 720
#define CID_PORT 30567
#define PDU_TOUCHSCREEN 0xB0048002u
enum { CID_DOWN = 1, CID_HELD = 2, CID_UP = 3 };

static int cid_sock = -1;
static struct sockaddr_in cid_addr;

static void put16(unsigned char *p, unsigned v) { p[0] = v >> 8; p[1] = v; }
static void put32(unsigned char *p, unsigned v) { put16(p, v >> 16); put16(p + 2, v); }

/* One touch frame, one finger at screen pixel (px, py). The payload is 12 words of
 * 8 bytes of which the HMI reads only bytes 4..7; their concatenation D holds the
 * finger count at D[16..17] and finger 0 at D[18..23]: X, Y (u16), Z, then
 * type (bits 7-6), event (bits 5-4), touch id (bits 3-0). */
static void cid_send(int event, int px, int py)
{
    unsigned char d[48] = {0}, pkt[16 + 96] = {0};
    put16(d + 16, 1);
    put16(d + 18, px);
    put16(d + 20, py);
    d[23] = (event & 3) << 4;
    put32(pkt, PDU_TOUCHSCREEN);
    put32(pkt + 4, 96);
    for (int w = 0; w < 12; w++) memcpy(pkt + 16 + 8 * w + 4, d + 4 * w, 4);
    if (cid_sock >= 0)
        sendto(cid_sock, pkt, sizeof pkt, 0, (struct sockaddr *)&cid_addr, sizeof cid_addr);
}

static int scale(int v, const struct input_absinfo *a, int n)
{
    long r = a->maximum > a->minimum ? (long)(v - a->minimum) * (n - 1) / (a->maximum - a->minimum) : 0;
    return r < 0 ? 0 : r >= n ? n - 1 : (int)r;
}

#define BIT(arr, n) ((arr)[(n) / 8] & (1 << ((n) % 8)))

static int is_tablet(int fd)
{
    unsigned char ev[EV_MAX / 8 + 1] = {0}, key[KEY_MAX / 8 + 1] = {0}, abs[ABS_MAX / 8 + 1] = {0};
    if (ioctl(fd, EVIOCGBIT(0, sizeof ev), ev) < 0) return 0;
    if (!BIT(ev, EV_ABS) || !BIT(ev, EV_KEY)) return 0;
    ioctl(fd, EVIOCGBIT(EV_KEY, sizeof key), key);
    ioctl(fd, EVIOCGBIT(EV_ABS, sizeof abs), abs);
    return BIT(abs, ABS_X) && BIT(abs, ABS_Y) && BIT(key, BTN_LEFT) && !BIT(abs, ABS_MT_POSITION_X);
}

static int find_tablet(char *path, size_t n)
{
    DIR *d = opendir("/dev/input");
    struct dirent *e;
    if (!d) return -1;
    while ((e = readdir(d))) {
        if (strncmp(e->d_name, "event", 5)) continue;
        snprintf(path, n, "/dev/input/%s", e->d_name);
        int fd = open(path, O_RDONLY);
        if (fd < 0) continue;
        if (is_tablet(fd)) { closedir(d); return fd; }
        close(fd);
    }
    closedir(d);
    return -1;
}

/* QEMU's virtio multitouch device: it lists BTN_LEFT too, and QEMU sends the
 * mouse buttons there (only the motion goes to the tablet). */
static int find_multitouch(void)
{
    char path[288];
    DIR *d = opendir("/dev/input");
    struct dirent *e;
    if (!d) return -1;
    while ((e = readdir(d))) {
        if (strncmp(e->d_name, "event", 5)) continue;
        snprintf(path, sizeof path, "/dev/input/%s", e->d_name);
        int fd = open(path, O_RDONLY);
        if (fd < 0) continue;
        unsigned char abs[ABS_MAX / 8 + 1] = {0}, key[KEY_MAX / 8 + 1] = {0};
        char name[64] = "";
        ioctl(fd, EVIOCGBIT(EV_ABS, sizeof abs), abs);
        ioctl(fd, EVIOCGBIT(EV_KEY, sizeof key), key);
        ioctl(fd, EVIOCGNAME(sizeof name), name);
        if (BIT(abs, ABS_MT_POSITION_X) && (BIT(key, BTN_LEFT) || BIT(key, BTN_TOUCH)) &&
            strcmp(name, "tap2touch")) {
            fprintf(stderr, "tap2touch: buttons and touch also from %s (%s)\n", path, name);
            closedir(d);
            return fd;
        }
        close(fd);
    }
    closedir(d);
    return -1;
}

static void emit(int fd, int type, int code, int value)
{
    struct input_event ie = {0};
    ie.type = type; ie.code = code; ie.value = value;
    if (write(fd, &ie, sizeof ie) != sizeof ie) perror("tap2touch: write");
}

static void setup_abs(int ufd, int code, struct input_absinfo *src)
{
    struct uinput_abs_setup a = {0};
    a.code = code;
    a.absinfo = *src;
    a.absinfo.value = 0;
    ioctl(ufd, UI_SET_ABSBIT, code);
    if (ioctl(ufd, UI_ABS_SETUP, &a) < 0) perror("tap2touch: UI_ABS_SETUP");
}

int main(int argc, char **argv)
{
    char path[288];
    int in;
    if (argc > 1) { snprintf(path, sizeof path, "%s", argv[1]); in = open(path, O_RDONLY); }
    else {
        /* the tablet can appear after us at boot: wait for it a while */
        for (int i = 0; (in = find_tablet(path, sizeof path)) < 0 && i < 60; i++) sleep(1);
    }
    if (in < 0) { fprintf(stderr, "tap2touch: no tablet device\n"); return 1; }

    struct input_absinfo ax, ay;
    ioctl(in, EVIOCGABS(ABS_X), &ax);
    ioctl(in, EVIOCGABS(ABS_Y), &ay);
    if (ioctl(in, EVIOCGRAB, 1) < 0) perror("tap2touch: EVIOCGRAB");

    int u = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (u < 0) { perror("tap2touch: /dev/uinput"); return 1; }
    ioctl(u, UI_SET_EVBIT, EV_SYN);
    ioctl(u, UI_SET_EVBIT, EV_KEY);
    ioctl(u, UI_SET_EVBIT, EV_ABS);
    ioctl(u, UI_SET_KEYBIT, BTN_TOUCH);
    ioctl(u, UI_SET_PROPBIT, INPUT_PROP_DIRECT);
    setup_abs(u, ABS_X, &ax);
    setup_abs(u, ABS_Y, &ay);
    struct input_absinfo slot = {0, 0, 0, 0, 0, 0}, tid = {0, 0, 65535, 0, 0, 0};
    setup_abs(u, ABS_MT_SLOT, &slot);
    setup_abs(u, ABS_MT_TRACKING_ID, &tid);
    setup_abs(u, ABS_MT_POSITION_X, &ax);
    setup_abs(u, ABS_MT_POSITION_Y, &ay);

    struct uinput_setup us = {0};
    us.id.bustype = BUS_VIRTUAL;
    us.id.vendor = 0x1d6b;
    us.id.product = 0x7470;
    snprintf(us.name, sizeof us.name, "tap2touch");
    if (ioctl(u, UI_DEV_SETUP, &us) < 0 || ioctl(u, UI_DEV_CREATE) < 0) {
        perror("tap2touch: create");
        return 1;
    }
    cid_sock = socket(AF_INET, SOCK_DGRAM, 0);
    cid_addr.sin_family = AF_INET;
    cid_addr.sin_port = htons(CID_PORT);
    cid_addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    fprintf(stderr, "tap2touch: %s (x %d..%d, y %d..%d) -> uinput touch, CID touch to udp %d\n",
            path, ax.minimum, ax.maximum, ay.minimum, ay.maximum, CID_PORT);

    /* the multitouch device's axes, mapped onto the tablet's */
    int mt = find_multitouch();
    struct input_absinfo mx = ax, my = ay;
    if (mt >= 0) {
        ioctl(mt, EVIOCGABS(ABS_MT_POSITION_X), &mx);
        ioctl(mt, EVIOCGABS(ABS_MT_POSITION_Y), &my);
    }

    int down = 0, x = 0, y = 0, moved = 0, track = 0;
    struct input_event ev;
#define CID(e) cid_send((e), scale(x, &ax, CID_W), scale(y, &ay, CID_H))
#define TO_TABLET(v, m, a) ((a).minimum + scale((v), &(m), (a).maximum - (a).minimum + 1))
    for (;;) {
        /* while held, the CID keeps reporting the finger: every 20 ms */
        struct pollfd pf[2] = {{in, POLLIN, 0}, {mt, POLLIN, 0}};
        int n = poll(pf, mt >= 0 ? 2 : 1, down ? 20 : -1);
        if (n == 0) { CID(CID_HELD); continue; }
        if (n < 0) { if (errno == EINTR) continue; perror("tap2touch: poll"); return 1; }
        int from_mt = !(pf[0].revents & POLLIN);
        if (from_mt && !(pf[1].revents & POLLIN)) {
            fprintf(stderr, "tap2touch: input device gone\n");
            return 1;
        }
        ssize_t r = read(from_mt ? mt : in, &ev, sizeof ev);
        if (r != sizeof ev) {
            if (r < 0 && errno == EINTR) continue;
            fprintf(stderr, "tap2touch: input device gone\n");
            return 1;
        }
        if (ev.type == EV_ABS && ev.code == ABS_X && !from_mt) { x = ev.value; moved = 1; }
        else if (ev.type == EV_ABS && ev.code == ABS_Y && !from_mt) { y = ev.value; moved = 1; }
        else if (ev.type == EV_ABS && ev.code == ABS_MT_POSITION_X && from_mt) { x = TO_TABLET(ev.value, mx, ax); moved = 1; }
        else if (ev.type == EV_ABS && ev.code == ABS_MT_POSITION_Y && from_mt) { y = TO_TABLET(ev.value, my, ay); moved = 1; }
        else if (ev.type == EV_KEY && (ev.code == BTN_LEFT || ev.code == BTN_TOUCH)) {
            if (ev.value && !down) {
                down = 1;
                emit(u, EV_ABS, ABS_MT_SLOT, 0);
                emit(u, EV_ABS, ABS_MT_TRACKING_ID, track++ & 0xffff);
                emit(u, EV_ABS, ABS_MT_POSITION_X, x);
                emit(u, EV_ABS, ABS_MT_POSITION_Y, y);
                emit(u, EV_KEY, BTN_TOUCH, 1);
                emit(u, EV_ABS, ABS_X, x);
                emit(u, EV_ABS, ABS_Y, y);
                emit(u, EV_SYN, SYN_REPORT, 0);
                moved = 0;
                CID(CID_DOWN);
            } else if (!ev.value && down) {
                down = 0;
                emit(u, EV_ABS, ABS_MT_SLOT, 0);
                emit(u, EV_ABS, ABS_MT_TRACKING_ID, -1);
                emit(u, EV_KEY, BTN_TOUCH, 0);
                emit(u, EV_SYN, SYN_REPORT, 0);
                CID(CID_UP);
            }
        } else if (ev.type == EV_SYN && ev.code == SYN_REPORT && down && moved) {
            emit(u, EV_ABS, ABS_MT_SLOT, 0);
            emit(u, EV_ABS, ABS_MT_POSITION_X, x);
            emit(u, EV_ABS, ABS_MT_POSITION_Y, y);
            emit(u, EV_ABS, ABS_X, x);
            emit(u, EV_ABS, ABS_Y, y);
            emit(u, EV_SYN, SYN_REPORT, 0);
            moved = 0;
            CID(CID_HELD);
        }
    }
}
