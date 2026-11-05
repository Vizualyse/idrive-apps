// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * A virtual gamepad for the off-car tests, through /dev/uinput: an xpad-like
 * pad ("Test Xbox Pad": A/B/X/Y, shoulders, start/back/guide, sticks
 * -32768..32767, triggers Z/RZ 0..255, the hat). Prints "ready <event node>",
 * then presses A and pushes the left stick once a second until stdin closes
 * or `seconds` pass, then removes the device.
 *
 *   uinput_pad [seconds]
 */
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <linux/uinput.h>

static void emit(int fd, int type, int code, int value) {
    struct input_event e;
    memset(&e, 0, sizeof(e));
    e.type = type; e.code = code; e.value = value;
    if (write(fd, &e, sizeof(e)) != sizeof(e)) perror("write");
}

static void absax(int fd, int code, int min, int max, int flat) {
    struct uinput_abs_setup a;
    memset(&a, 0, sizeof(a));
    a.code = code; a.absinfo.minimum = min; a.absinfo.maximum = max; a.absinfo.flat = flat;
    ioctl(fd, UI_SET_ABSBIT, code);
    if (ioctl(fd, UI_ABS_SETUP, &a) < 0) perror("UI_ABS_SETUP");
}

int main(int argc, char **argv) {
    int seconds = argc > 1 ? atoi(argv[1]) : 30;
    int fd = open("/dev/uinput", O_WRONLY | O_NONBLOCK);
    if (fd < 0) { perror("/dev/uinput"); return 77; }
    ioctl(fd, UI_SET_EVBIT, EV_KEY);
    ioctl(fd, UI_SET_EVBIT, EV_ABS);
    int keys[] = { BTN_SOUTH, BTN_EAST, BTN_NORTH, BTN_WEST, BTN_TL, BTN_TR, BTN_SELECT, BTN_START, BTN_MODE, BTN_THUMBL, BTN_THUMBR };
    for (unsigned i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) ioctl(fd, UI_SET_KEYBIT, keys[i]);
    absax(fd, ABS_X, -32768, 32767, 128);
    absax(fd, ABS_Y, -32768, 32767, 128);
    absax(fd, ABS_RX, -32768, 32767, 128);
    absax(fd, ABS_RY, -32768, 32767, 128);
    absax(fd, ABS_Z, 0, 255, 0);
    absax(fd, ABS_RZ, 0, 255, 0);
    absax(fd, ABS_HAT0X, -1, 1, 0);
    absax(fd, ABS_HAT0Y, -1, 1, 0);
    struct uinput_setup s;
    memset(&s, 0, sizeof(s));
    s.id.bustype = BUS_USB; s.id.vendor = 0x045e; s.id.product = 0x028e; s.id.version = 1;
    snprintf(s.name, sizeof(s.name), "Test Xbox Pad");
    if (ioctl(fd, UI_DEV_SETUP, &s) < 0 || ioctl(fd, UI_DEV_CREATE) < 0) { perror("UI_DEV_CREATE"); return 1; }
    char sys[64] = "";
    ioctl(fd, UI_GET_SYSNAME(sizeof(sys)), sys);
    /* the event node under /sys/devices/virtual/input/<sys>/ */
    char node[64] = "?";
    for (int i = 0; i < 20 && node[0] == '?'; i++) {
        char path[160];
        for (int n = 0; n < 64; n++) {
            snprintf(path, sizeof(path), "/sys/devices/virtual/input/%s/event%d", sys, n);
            if (access(path, F_OK) == 0) { snprintf(node, sizeof(node), "/dev/input/event%d", n); break; }
        }
        if (node[0] == '?') usleep(100000);
    }
    printf("ready %s\n", node);
    fflush(stdout);
    time_t end = time(NULL) + seconds;
    int on = 0;
    while (time(NULL) < end) {
        struct pollfd p = { 0, POLLIN, 0 };
        if (poll(&p, 1, 1000) > 0) { char c; if (read(0, &c, 1) <= 0) break; }
        on = !on;
        emit(fd, EV_KEY, BTN_SOUTH, on);
        emit(fd, EV_ABS, ABS_X, on ? 32767 : 0);
        emit(fd, EV_SYN, SYN_REPORT, 0);
    }
    ioctl(fd, UI_DEV_DESTROY);
    close(fd);
    return 0;
}
