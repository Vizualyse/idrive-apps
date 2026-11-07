// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The evdev and XInput to Moonlight gamepad mappings (pads.h). No I/O here. */
#include "pads.h"
#include <string.h>
#include <linux/input.h>
#include "pad_flags.h"   /* Moonlight's gamepad flags: XInput's bits */

#ifndef BTN_DPAD_UP
#define BTN_DPAD_UP 0x220
#define BTN_DPAD_DOWN 0x221
#define BTN_DPAD_LEFT 0x222
#define BTN_DPAD_RIGHT 0x223
#endif

#define TEST_BIT(bits, n) ((bits[(n) / (8 * sizeof(long))] >> ((n) % (8 * sizeof(long)))) & 1UL)

bool pad_is_gamepad(const unsigned long *keybits, const unsigned long *absbits) {
    /* a gamepad's face button, or a joystick's trigger with two axes */
    bool face = TEST_BIT(keybits, BTN_SOUTH) || TEST_BIT(keybits, BTN_GAMEPAD);
    bool stick = TEST_BIT(absbits, ABS_X) && TEST_BIT(absbits, ABS_Y);
    return face && stick;
}

void pad_layout(struct pad *p, bool (*has)(void *ctx, int code), void *ctx) {
    if (has(ctx, ABS_RX)) {
        p->code_rx = ABS_RX; p->code_ry = ABS_RY;
        p->code_lt = ABS_Z; p->code_rt = ABS_RZ;
    } else {
        p->code_rx = ABS_Z; p->code_ry = ABS_RZ;
        p->code_lt = ABS_BRAKE; p->code_rt = ABS_GAS;
    }
}

static struct pad_axis *axis_for(struct pad *p, int code) {
    if (code == ABS_X) return &p->ax;
    if (code == ABS_Y) return &p->ay;
    if (code == ABS_HAT0X) return &p->hatx;
    if (code == ABS_HAT0Y) return &p->haty;
    if (code == p->code_rx) return &p->arx;
    if (code == p->code_ry) return &p->ary;
    if (code == p->code_lt) return &p->alt;
    if (code == p->code_rt) return &p->art;
    return NULL;
}

void pad_axis_range(struct pad *p, int code, int min, int max, int flat) {
    struct pad_axis *a = axis_for(p, code);
    if (!a || max <= min) return;
    a->present = 1; a->min = min; a->max = max; a->flat = flat;
}

/* An axis to -32768..32767, inside its dead zone 0. */
static short stick(const struct pad_axis *a, int v) {
    long range = (long)a->max - a->min;
    long centre = ((long)a->max + a->min) / 2;
    if (a->flat > 0 && (v - centre <= a->flat && centre - v <= a->flat)) return 0;
    long s = ((long)v - a->min) * 65535 / range - 32768;
    if (s < -32768) s = -32768;
    if (s > 32767) s = 32767;
    return (short)s;
}

/* Up positive: an evdev Y grows downwards. */
static short flip(short s) { return s == -32768 ? 32767 : (short)-s; }

static unsigned char trigger(const struct pad_axis *a, int v) {
    long range = (long)a->max - a->min;
    long t = ((long)v - a->min) * 255 / range;
    if (t < 0) t = 0;
    if (t > 255) t = 255;
    return (unsigned char)t;
}

static int button_flag(int code) {
    switch (code) {
    case BTN_SOUTH: return A_FLAG;
    case BTN_EAST: return B_FLAG;
    case BTN_NORTH: return X_FLAG;   /* BTN_X: xpad's X */
    case BTN_WEST: return Y_FLAG;    /* BTN_Y */
    case BTN_TL: return LB_FLAG;
    case BTN_TR: return RB_FLAG;
    case BTN_SELECT: return BACK_FLAG;
    case BTN_START: return PLAY_FLAG;
    case BTN_MODE: return SPECIAL_FLAG;
    case BTN_THUMBL: return LS_CLK_FLAG;
    case BTN_THUMBR: return RS_CLK_FLAG;
    case BTN_DPAD_UP: return UP_FLAG;
    case BTN_DPAD_DOWN: return DOWN_FLAG;
    case BTN_DPAD_LEFT: return LEFT_FLAG;
    case BTN_DPAD_RIGHT: return RIGHT_FLAG;
    default: return 0;
    }
}

#define DPAD_FLAGS (UP_FLAG | DOWN_FLAG | LEFT_FLAG | RIGHT_FLAG)

bool pad_event(struct pad *p, int type, int code, int value) {
    if (type == EV_KEY) {
        if (code == BTN_TL2 || code == BTN_TR2) {
            bool *d = code == BTN_TL2 ? &p->digital_lt : &p->digital_rt;
            *d = value != 0;
            /* a pad with analogue triggers sends those too; keep the larger */
            if (code == BTN_TL2 && !p->alt.present) p->st.lt = value ? 255 : 0;
            if (code == BTN_TR2 && !p->art.present) p->st.rt = value ? 255 : 0;
            return false;
        }
        int f = button_flag(code);
        if (!f) return false;
        if (f & DPAD_FLAGS) {
            if (value) p->dpad_btn |= f; else p->dpad_btn &= ~f;
        } else {
            if (value) p->st.buttons |= f; else p->st.buttons &= ~f;
        }
    } else if (type == EV_ABS) {
        struct pad_axis *a = axis_for(p, code);
        if (!a || !a->present) return false;
        if (a == &p->ax) p->st.lx = stick(a, value);
        else if (a == &p->ay) p->st.ly = flip(stick(a, value));
        else if (a == &p->arx) p->st.rx = stick(a, value);
        else if (a == &p->ary) p->st.ry = flip(stick(a, value));
        else if (a == &p->alt) p->st.lt = trigger(a, value);
        else if (a == &p->art) p->st.rt = trigger(a, value);
        else if (a == &p->hatx) {
            p->dpad_hat &= ~(LEFT_FLAG | RIGHT_FLAG);
            if (value < 0) p->dpad_hat |= LEFT_FLAG; else if (value > 0) p->dpad_hat |= RIGHT_FLAG;
        } else if (a == &p->haty) {
            p->dpad_hat &= ~(UP_FLAG | DOWN_FLAG);
            if (value < 0) p->dpad_hat |= UP_FLAG; else if (value > 0) p->dpad_hat |= DOWN_FLAG;
        }
    } else if (type == EV_SYN && code == SYN_REPORT) {
        p->st.buttons = (p->st.buttons & ~DPAD_FLAGS) | p->dpad_hat | p->dpad_btn;
        if (memcmp(&p->st, &p->sent, sizeof(p->st)) != 0) p->dirty = true;
        return p->dirty;
    }
    return false;
}

#define COMBO_FLAGS (PLAY_FLAG | BACK_FLAG | LB_FLAG | RB_FLAG)

bool pad_combo(struct pad *p, long now_ms) {
    if ((p->st.buttons & COMBO_FLAGS) != COMBO_FLAGS) { p->combo_since = 0; p->combo_fired = false; return false; }
    if (!p->combo_since) p->combo_since = now_ms ? now_ms : 1;
    if (p->combo_fired || now_ms - p->combo_since < PAD_COMBO_MS) return false;
    p->combo_fired = true;
    return true;
}

void pad_sent(struct pad *p) {
    p->sent = p->st;
    p->dirty = false;
}

bool pad_xinput_match(int iclass, int isubclass, int iprotocol) {
    return iclass == 0xff && isubclass == 0x5d && iprotocol == 0x01;
}

/* The report's button bits, in order (bit 11 is unused). */
static const int xinput_buttons[16] = {
    UP_FLAG, DOWN_FLAG, LEFT_FLAG, RIGHT_FLAG, PLAY_FLAG, BACK_FLAG, LS_CLK_FLAG, RS_CLK_FLAG,
    LB_FLAG, RB_FLAG, SPECIAL_FLAG, 0, A_FLAG, B_FLAG, X_FLAG, Y_FLAG,
};

/* As xpad's flat: a stick at rest reads a little off centre (seen on the car). */
#define XINPUT_FLAT 128

static short xstick(const unsigned char *b) {
    short v = (short)(b[0] | b[1] << 8);
    return (v <= XINPUT_FLAT && v >= -XINPUT_FLAT) ? 0 : v;
}

bool pad_xinput_report(struct pad *p, const unsigned char *r, int len) {
    if (len < 14 || r[0] != 0x00 || r[1] < 14) return false;
    int bits = r[2] | r[3] << 8, b = 0;
    for (int i = 0; i < 16; i++) if (bits >> i & 1) b |= xinput_buttons[i];
    p->st.buttons = b;
    p->st.lt = r[4];
    p->st.rt = r[5];
    /* already up positive, as Moonlight's */
    p->st.lx = xstick(r + 6);
    p->st.ly = xstick(r + 8);
    p->st.rx = xstick(r + 10);
    p->st.ry = xstick(r + 12);
    if (memcmp(&p->st, &p->sent, sizeof(p->st)) != 0) p->dirty = true;
    return p->dirty;
}

void pad_xinput_led(int slot, unsigned char out[3]) {
    out[0] = 0x01; out[1] = 0x03;
    out[2] = (unsigned char)(0x06 + (slot & 3));   /* 6..9: the ring's quarter for players 1..4 */
}
