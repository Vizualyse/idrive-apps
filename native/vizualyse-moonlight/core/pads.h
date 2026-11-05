// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * Game controllers, mapped to Moonlight's Xbox-style gamepad state: from
 * evdev (/dev/input/event*), or straight from USB through usbfs for XInput
 * (Xbox 360) pads, as on the car, whose kernel has no input drivers. The
 * mappings (pad_event, pad_xinput_report) are pure, so the tests feed them
 * events and reports without a device.
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

enum pad_kind { PAD_EVDEV, PAD_XINPUT };

struct pad {
    int fd;                      /* -1 when free */
    enum pad_kind kind;
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

/* XInput over usbfs: the vendor interface class ff, subclass 5d, protocol 01
 * (Xbox 360 pads and the many pads that act as one, e.g. a Flydigi Vader 4
 * Pro wired: 045e:028e). */
bool pad_xinput_match(int iclass, int isubclass, int iprotocol);

/* One report from the pad's interrupt IN endpoint. Input reports (type 0x00,
 * 20 bytes) set the state; others (LED status, ...) are ignored. Returns true
 * when the state changed since the last pad_sent(). */
bool pad_xinput_report(struct pad *p, const unsigned char *r, int len);

/* The LED command for a player slot 0..3 (3 bytes, on the OUT endpoint). */
void pad_xinput_led(int slot, unsigned char out[3]);
