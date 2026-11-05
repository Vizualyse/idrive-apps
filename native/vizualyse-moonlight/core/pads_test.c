// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/* The evdev mapping (pads.c) without a device: the layouts of xpad and of a
 * Bluetooth Xbox One pad (hid-generic), sticks, triggers, the hat. Built and
 * run by build.sh before moonlight-core. */
#include <stdio.h>
#include <string.h>
#include <linux/input.h>
#include <Limelight.h>
#include "pads.h"

static int fails = 0, checks = 0;
#define OK(what, cond) do { checks++; if (!(cond)) { fails++; printf("FAIL %s\n", what); } } while (0)

static bool has_rx(void *c, int code) { (void)c; return code == ABS_RX; }
static bool no_rx(void *c, int code) { (void)c; (void)code; return false; }

static void syn(struct pad *p) { if (pad_event(p, EV_SYN, SYN_REPORT, 0)) pad_sent(p); }

int main(void) {
    /* xpad (a wired Xbox 360 / One pad): sticks -32768..32767, triggers Z/RZ 0..255, hat d-pad */
    struct pad p;
    memset(&p, 0, sizeof(p));
    pad_layout(&p, has_rx, NULL);
    pad_axis_range(&p, ABS_X, -32768, 32767, 128);
    pad_axis_range(&p, ABS_Y, -32768, 32767, 128);
    pad_axis_range(&p, ABS_RX, -32768, 32767, 128);
    pad_axis_range(&p, ABS_RY, -32768, 32767, 128);
    pad_axis_range(&p, ABS_Z, 0, 255, 0);
    pad_axis_range(&p, ABS_RZ, 0, 255, 0);
    pad_axis_range(&p, ABS_HAT0X, -1, 1, 0);
    pad_axis_range(&p, ABS_HAT0Y, -1, 1, 0);

    pad_event(&p, EV_KEY, BTN_SOUTH, 1);
    OK("no change reported before SYN_REPORT", !p.dirty);
    OK("SYN_REPORT reports A", pad_event(&p, EV_SYN, SYN_REPORT, 0) && p.st.buttons == A_FLAG);
    pad_sent(&p);
    OK("the same state again is not a change", !pad_event(&p, EV_SYN, SYN_REPORT, 0));
    pad_event(&p, EV_KEY, BTN_SOUTH, 0);
    pad_event(&p, EV_KEY, BTN_NORTH, 1); pad_event(&p, EV_KEY, BTN_WEST, 1); pad_event(&p, EV_KEY, BTN_EAST, 1);
    syn(&p);
    OK("xpad X / Y / B", p.st.buttons == (X_FLAG | Y_FLAG | B_FLAG));
    pad_event(&p, EV_KEY, BTN_NORTH, 0); pad_event(&p, EV_KEY, BTN_WEST, 0); pad_event(&p, EV_KEY, BTN_EAST, 0);
    pad_event(&p, EV_KEY, BTN_START, 1); pad_event(&p, EV_KEY, BTN_SELECT, 1); pad_event(&p, EV_KEY, BTN_MODE, 1);
    pad_event(&p, EV_KEY, BTN_TL, 1); pad_event(&p, EV_KEY, BTN_THUMBR, 1);
    syn(&p);
    OK("start / back / guide / LB / RS", p.st.buttons == (PLAY_FLAG | BACK_FLAG | SPECIAL_FLAG | LB_FLAG | RS_CLK_FLAG));

    pad_event(&p, EV_ABS, ABS_X, 32767); pad_event(&p, EV_ABS, ABS_Y, -32768);
    syn(&p);
    OK("left stick right", p.st.lx == 32767);
    OK("left stick up is positive", p.st.ly == 32767);
    pad_event(&p, EV_ABS, ABS_X, 100); pad_event(&p, EV_ABS, ABS_Y, -100);
    syn(&p);
    OK("inside the dead zone is centre", p.st.lx == 0 && p.st.ly == 0);
    pad_event(&p, EV_ABS, ABS_RY, 32767);
    syn(&p);
    OK("right stick down is negative", p.st.ry == -32767);
    pad_event(&p, EV_ABS, ABS_Z, 255); pad_event(&p, EV_ABS, ABS_RZ, 128);
    syn(&p);
    OK("triggers 0..255", p.st.lt == 255 && p.st.rt == 128);

    pad_event(&p, EV_ABS, ABS_HAT0X, -1); pad_event(&p, EV_ABS, ABS_HAT0Y, 1);
    syn(&p);
    OK("hat left + down", (p.st.buttons & (UP_FLAG | DOWN_FLAG | LEFT_FLAG | RIGHT_FLAG)) == (LEFT_FLAG | DOWN_FLAG));
    pad_event(&p, EV_ABS, ABS_HAT0X, 0); pad_event(&p, EV_ABS, ABS_HAT0Y, 0);
    syn(&p);
    OK("hat centred", (p.st.buttons & (UP_FLAG | DOWN_FLAG | LEFT_FLAG | RIGHT_FLAG)) == 0);
    OK("other buttons kept through the hat", (p.st.buttons & PLAY_FLAG) != 0);

    /* Bluetooth Xbox One pad on hid-generic: no RX; right stick Z/RZ 0..65535, triggers BRAKE/GAS 0..1023 */
    struct pad q;
    memset(&q, 0, sizeof(q));
    pad_layout(&q, no_rx, NULL);
    pad_axis_range(&q, ABS_X, 0, 65535, 0);
    pad_axis_range(&q, ABS_Y, 0, 65535, 0);
    pad_axis_range(&q, ABS_Z, 0, 65535, 0);
    pad_axis_range(&q, ABS_RZ, 0, 65535, 0);
    pad_axis_range(&q, ABS_BRAKE, 0, 1023, 0);
    pad_axis_range(&q, ABS_GAS, 0, 1023, 0);
    pad_event(&q, EV_ABS, ABS_Z, 0); pad_event(&q, EV_ABS, ABS_RZ, 65535);
    pad_event(&q, EV_ABS, ABS_BRAKE, 1023); pad_event(&q, EV_ABS, ABS_GAS, 0);
    pad_event(&q, EV_ABS, ABS_X, 0);
    syn(&q);
    OK("BT: right stick from Z / RZ", q.st.rx == -32768 && q.st.ry == -32767);
    OK("BT: triggers from BRAKE / GAS", q.st.lt == 255 && q.st.rt == 0);
    OK("BT: left stick full left", q.st.lx == -32768);
    pad_event(&q, EV_KEY, BTN_DPAD_UP, 1);
    syn(&q);
    OK("d-pad buttons", (q.st.buttons & UP_FLAG) != 0);

    /* digital triggers only */
    struct pad d;
    memset(&d, 0, sizeof(d));
    pad_layout(&d, no_rx, NULL);
    pad_axis_range(&d, ABS_X, 0, 255, 0);
    pad_axis_range(&d, ABS_Y, 0, 255, 0);
    pad_event(&d, EV_KEY, BTN_TL2, 1);
    syn(&d);
    OK("digital LT is a full pull", d.st.lt == 255 && d.st.rt == 0);

    /* the quit combo: Start + Back + LB + RB held PAD_COMBO_MS, once per hold */
    struct pad c;
    memset(&c, 0, sizeof(c));
    pad_layout(&c, has_rx, NULL);
    pad_event(&c, EV_KEY, BTN_START, 1); pad_event(&c, EV_KEY, BTN_SELECT, 1); pad_event(&c, EV_KEY, BTN_TL, 1);
    syn(&c);
    OK("three of the four is not the combo", !pad_combo(&c, 1000) && !pad_combo(&c, 9000));
    pad_event(&c, EV_KEY, BTN_TR, 1);
    syn(&c);
    OK("the combo just pressed: not yet", !pad_combo(&c, 10000));
    OK("held 1.9 s: not yet", !pad_combo(&c, 11900));
    OK("held 2 s: stop", pad_combo(&c, 12000));
    OK("still held: only once", !pad_combo(&c, 15000));
    pad_event(&c, EV_KEY, BTN_TR, 0);
    syn(&c);
    OK("let go: reset", !pad_combo(&c, 16000));
    pad_event(&c, EV_KEY, BTN_TR, 1);
    syn(&c);
    OK("pressed again: a new hold", !pad_combo(&c, 17000) && pad_combo(&c, 19000));

    unsigned long keys[(KEY_CNT + 63) / 64] = { 0 }, abs[(ABS_CNT + 63) / 64] = { 0 };
    OK("no buttons is not a gamepad", !pad_is_gamepad(keys, abs));
    keys[BTN_SOUTH / 64] |= 1UL << (BTN_SOUTH % 64);
    abs[0] |= 1UL << ABS_X | 1UL << ABS_Y;
    OK("A and two axes is a gamepad", pad_is_gamepad(keys, abs));

    /* XInput over usbfs: reports as the car read them from a Vader 4 Pro (x360 mode) */
    OK("ff/5d/01 is XInput", pad_xinput_match(0xff, 0x5d, 0x01));
    OK("other vendor interfaces are not", !pad_xinput_match(0xff, 0xff, 0xff) && !pad_xinput_match(0xff, 0x47, 0xd0) && !pad_xinput_match(0x03, 0x00, 0x00));
    struct pad x;
    memset(&x, 0, sizeof(x));
    unsigned char r[20] = { 0x00, 0x14 };
    #define REPORT(btn, lt, rt, lx, ly, rx, ry) do { r[2] = (btn) & 0xff; r[3] = (btn) >> 8; r[4] = (lt); r[5] = (rt); \
        short v_[4] = { (lx), (ly), (rx), (ry) }; for (int i_ = 0; i_ < 4; i_++) { r[6 + 2 * i_] = v_[i_] & 0xff; r[7 + 2 * i_] = (v_[i_] >> 8) & 0xff; } } while (0)
    REPORT(0, 0, 0, 128, -128, -128, 0);
    OK("the first report at rest: nothing to send (inside the flat)", !pad_xinput_report(&x, r, 20) && x.st.lx == 0 && x.st.ly == 0 && x.st.rx == 0);
    REPORT(0, 0, 0, 128, -128, -128, 384);
    OK("a resting stick at 384 is past the flat: sent", pad_xinput_report(&x, r, 20) && x.st.ry == 384);
    pad_sent(&x);
    REPORT(0x1000 | 0x4000, 0, 27, -64, 192, -128, -64);
    OK("A + X with RT and a stick: a change", pad_xinput_report(&x, r, 20));
    OK("A + X", x.st.buttons == (A_FLAG | X_FLAG));
    OK("RT 27, LT 0", x.st.rt == 27 && x.st.lt == 0);
    OK("left stick 192 up", x.st.lx == 0 && x.st.ly == 192);
    pad_sent(&x);
    OK("the same report again: no change", !pad_xinput_report(&x, r, 20));
    REPORT(0x0001 | 0x0004, 255, 0, -32768, 32767, 16128, -18560);
    pad_xinput_report(&x, r, 20); pad_sent(&x);
    OK("up + left (the d-pad)", x.st.buttons == (UP_FLAG | LEFT_FLAG));
    OK("full LT; sticks pass through, up positive", x.st.lt == 255 && x.st.lx == -32768 && x.st.ly == 32767 && x.st.rx == 16128 && x.st.ry == -18560);
    REPORT(0x0002 | 0x0008 | 0x0040 | 0x0080 | 0x0400 | 0x2000 | 0x8000, 0, 0, 0, 0, 0, 0);
    pad_xinput_report(&x, r, 20); pad_sent(&x);
    OK("down, right, both stick clicks, guide, B, Y",
       x.st.buttons == (DOWN_FLAG | RIGHT_FLAG | LS_CLK_FLAG | RS_CLK_FLAG | SPECIAL_FLAG | B_FLAG | Y_FLAG));
    REPORT(0x0010 | 0x0020 | 0x0100 | 0x0200, 0, 0, 0, 0, 0, 0);
    pad_xinput_report(&x, r, 20);
    OK("start + back + LB + RB is the quit combo's set", x.st.buttons == (PLAY_FLAG | BACK_FLAG | LB_FLAG | RB_FLAG));
    OK("...and held 2 s it fires", !pad_combo(&x, 1000) && pad_combo(&x, 3000));
    pad_sent(&x);
    const unsigned char led[3] = { 0x01, 0x03, 0x02 };
    OK("an LED status report is ignored", !pad_xinput_report(&x, led, 3) && x.st.buttons == (PLAY_FLAG | BACK_FLAG | LB_FLAG | RB_FLAG));
    unsigned char odd[20] = { 0x08, 0x03 };
    OK("other report types are ignored", !pad_xinput_report(&x, odd, 20));
    OK("a short input report is ignored", !pad_xinput_report(&x, r, 13));
    unsigned char cmd[3];
    pad_xinput_led(0, cmd);
    OK("player 1's LED: 01 03 06 (what the car's pad accepted)", cmd[0] == 1 && cmd[1] == 3 && cmd[2] == 6);
    pad_xinput_led(3, cmd);
    OK("player 4's LED: 01 03 09", cmd[2] == 9);

    printf("pads_test: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
