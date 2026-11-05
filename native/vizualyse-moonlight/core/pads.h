// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * Game controllers from evdev (/dev/input/event*), mapped to Moonlight's
 * Xbox-style gamepad state. The mapping (pad_event) is pure, so the tests
 * feed it events without a device.
 */
#pragma once
#include <stdint.h>
#include <stdbool.h>

#define PADS_MAX 4

/* An axis's range, as EVIOCGABS reports it. */
struct pad_axis { int present, min, max, flat; };

struct pad_state {
    int buttons;                 /* Moonlight's *_FLAG bits */
    unsigned char lt, rt;        /* 0..255 */
    short lx, ly, rx, ry;        /* -32768..32767, up positive */
};

struct pad {
    int fd;                      /* -1 when free */
    char path[64];
    char name[128];
    /* axes by role, after the layout below is chosen */
    struct pad_axis ax, ay, arx, ary, alt, art, hatx, haty;
    int code_rx, code_ry, code_lt, code_rt;   /* the evdev codes those roles use */
    int dpad_hat;                /* d-pad buttons from the hat, kept apart from BTN_DPAD_* */
    int dpad_btn;
    bool digital_lt, digital_rt; /* BTN_TL2 / BTN_TR2 held (no analogue trigger) */
    struct pad_state st, sent;
    bool dirty, announced;
    long combo_since;            /* ms when the quit combo was first held, or 0 */
    bool combo_fired;
};

/* The quit combo (as Moonlight's): Start + Back + LB + RB held this long
 * stops the stream; the picture can cover the iDrive's own controls. */
#define PAD_COMBO_MS 2000

/* Whether the quit combo has now been held PAD_COMBO_MS (once per hold);
 * now_ms is a monotonic clock in ms. */
bool pad_combo(struct pad *p, long now_ms);

/* Choose which evdev codes are the right stick and the triggers from the
 * axes a device has: with ABS_RX the right stick is RX/RY and the triggers
 * Z/RZ (xpad, hid-sony, hid-nintendo); without it the right stick is Z/RZ and
 * the triggers BRAKE/GAS (hid-generic over Bluetooth, e.g. an Xbox One pad).
 * `has(code)` says whether the device has that ABS axis. */
void pad_layout(struct pad *p, bool (*has)(void *ctx, int code), void *ctx);

/* Set the range of one evdev ABS axis (from EVIOCGABS). */
void pad_axis_range(struct pad *p, int code, int min, int max, int flat);

/* One evdev event. Returns true on EV_SYN/SYN_REPORT when the state changed
 * since the last pad_sent(). */
bool pad_event(struct pad *p, int type, int code, int value);

/* The state was sent. */
void pad_sent(struct pad *p);

/* Whether a device with these key and abs bits is a gamepad. */
bool pad_is_gamepad(const unsigned long *keybits, const unsigned long *absbits);
