// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The pads file: steam-pads (root, src/pads_main.c) writes the state of up
 * to four XInput USB pads into /dev/shm/vizualyse-steam/pads while a game
 * runs; our xinput1_4.dll (src/xinput.c, in Wine) reads it as
 * Z:\dev\shm\vizualyse-steam\pads for XInputGetState. Shared by the Linux
 * and the Windows build: fixed-size types, no padding surprises (static
 * asserts), little-endian on both sides.
 *
 * The buttons are XInput's XINPUT_GAMEPAD_* bits (pads.c's flags are the
 * same: platform native/pad_flags.h), 0x0400 the guide button; the sticks
 * -32768..32767, up positive; the triggers 0..255. `packet` counts the
 * slot's state changes (XINPUT_STATE.dwPacketNumber). A slot is written
 * whole with one pwrite.
 */
#pragma once
#include <stdint.h>

#define VZS_PADS_MAGIC 0x31505a56u   /* "VZP1" */
#define VZS_PADS_SLOTS 4

struct vzs_pad {
    uint32_t packet;
    uint32_t connected;          /* 1 while a pad is in the slot */
    uint16_t buttons;
    uint8_t lt, rt;
    int16_t lx, ly, rx, ry;
    uint8_t reserved[12];
};

struct vzs_pads_file {
    uint32_t magic;
    uint32_t version;            /* 1 */
    uint32_t slots;              /* VZS_PADS_SLOTS */
    uint32_t reserved;
    struct vzs_pad pad[VZS_PADS_SLOTS];
};

_Static_assert(sizeof(struct vzs_pad) == 32, "vzs_pad is 32 bytes");
_Static_assert(sizeof(struct vzs_pads_file) == 16 + 4 * 32, "vzs_pads_file is 144 bytes");
