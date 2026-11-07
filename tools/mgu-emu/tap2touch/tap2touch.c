/*
 * tap2touch: the emulator's mouse as the centre screen's touch.
 *
 * QEMU on Windows sends the host mouse to its absolute "tablet" device
 * (ABS_X / ABS_Y with BTN_LEFT); Winston only takes touch (BTN_TOUCH, multi
 * touch slots). This grabs the tablet and replays it through uinput as a
 * one-finger direct touchscreen with the same axis range, so a click is a tap
 * and a drag is a swipe. Built static, runs inside the VM only.
 *
 *   tap2touch [/dev/input/eventN]     (default: the first device with
 *                                      ABS_X and BTN_LEFT and no multi touch axes:
 *                                      QEMU's tablet also lists BTN_TOUCH)
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/input.h>
#include <linux/uinput.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

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
    fprintf(stderr, "tap2touch: %s (x %d..%d, y %d..%d) -> uinput touch\n",
            path, ax.minimum, ax.maximum, ay.minimum, ay.maximum);

    int down = 0, x = 0, y = 0, moved = 0, track = 0;
    struct input_event ev;
    for (;;) {
        ssize_t r = read(in, &ev, sizeof ev);
        if (r != sizeof ev) {
            if (r < 0 && errno == EINTR) continue;
            fprintf(stderr, "tap2touch: tablet gone\n");
            return 1;
        }
        if (ev.type == EV_ABS && ev.code == ABS_X) { x = ev.value; moved = 1; }
        else if (ev.type == EV_ABS && ev.code == ABS_Y) { y = ev.value; moved = 1; }
        else if (ev.type == EV_KEY && ev.code == BTN_LEFT) {
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
            } else if (!ev.value && down) {
                down = 0;
                emit(u, EV_ABS, ABS_MT_SLOT, 0);
                emit(u, EV_ABS, ABS_MT_TRACKING_ID, -1);
                emit(u, EV_KEY, BTN_TOUCH, 0);
                emit(u, EV_SYN, SYN_REPORT, 0);
            }
        } else if (ev.type == EV_SYN && ev.code == SYN_REPORT && down && moved) {
            emit(u, EV_ABS, ABS_MT_SLOT, 0);
            emit(u, EV_ABS, ABS_MT_POSITION_X, x);
            emit(u, EV_ABS, ABS_MT_POSITION_Y, y);
            emit(u, EV_ABS, ABS_X, x);
            emit(u, EV_ABS, ABS_Y, y);
            emit(u, EV_SYN, SYN_REPORT, 0);
            moved = 0;
        }
    }
}
