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

    unsigned long keys[(KEY_CNT + 63) / 64] = { 0 }, abs[(ABS_CNT + 63) / 64] = { 0 };
    OK("no buttons is not a gamepad", !pad_is_gamepad(keys, abs));
    keys[BTN_SOUTH / 64] |= 1UL << (BTN_SOUTH % 64);
    abs[0] |= 1UL << ABS_X | 1UL << ABS_Y;
    OK("A and two axes is a gamepad", pad_is_gamepad(keys, abs));

    printf("pads_test: %d checks, %d failed\n", checks, fails);
    return fails ? 1 : 0;
}
