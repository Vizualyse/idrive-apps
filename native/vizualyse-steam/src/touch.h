// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * Hold-to-stop on the centre screen, read passively: a copy of the display's
 * touch PDUs (UDP 30567 from the display, on vlan73), which the HMI keeps
 * getting unchanged. Nothing is diverted or claimed (claiming touch through
 * mgu-render restarted the head unit, 2026-11-05).
 *
 * The iDrive 7 PDU (112 bytes, captured on the car: test/fixtures): a 16-byte
 * header (u32 BE id 0xB0048002, u32 BE length, 8 bytes), then 8-byte records
 * (a 4-byte tag, 4 data bytes). The first finger: X u16 BE at 54, Y u16 BE at
 * 60 (screen px, 1920x720), the event in the high nibble of 63 (1 down, 2
 * move, 3 up). mgu-render reads iDrive 8's layout, the same fields 16 bytes
 * earlier (38, 44, 47), which is why it saw no touch on this unit.
 *
 * The decode and the hold are pure, so touch_test.c replays the capture.
 */
#pragma once
#include <stdbool.h>

#define TOUCH_PORT 30567
#define TOUCH_HOLD_MS 2000
#define TOUCH_SLOP_PX 60    /* a hold may wander this far from where it went down */

enum { TOUCH_DOWN = 1, TOUCH_MOVE = 2, TOUCH_UP = 3 };

/* A UDP payload: 1 and phase, x, y for a touch PDU, else 0. */
int touch_decode(const unsigned char *p, int len, int *phase, int *x, int *y);

struct touch_hold {
    bool down, fired;
    long t0, last;
    int x0, y0;
};

/* One decoded touch at now_ms: true when this makes a hold (once per hold). */
bool touch_step(struct touch_hold *h, int phase, int x, int y, long now_ms);
/* Time passing with the finger still down (PDUs every 8 ms on the car, but a
 * still finger may send fewer): true when the hold is reached. */
bool touch_tick(struct touch_hold *h, long now_ms);
