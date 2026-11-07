// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The gamepad button flags pads.c sets: moonlight-common-c's (Limelight.h),
 * which are XInput's XINPUT_GAMEPAD_* bits, so a tool without Moonlight
 * (vizualyse-steam's XInput) uses them as they are. Only the ones not
 * defined already: a component with Limelight.h gets the same values.
 */
#pragma once

#ifndef A_FLAG
#define UP_FLAG       0x0001
#define DOWN_FLAG     0x0002
#define LEFT_FLAG     0x0004
#define RIGHT_FLAG    0x0008
#define PLAY_FLAG     0x0010   /* Start */
#define BACK_FLAG     0x0020
#define LS_CLK_FLAG   0x0040
#define RS_CLK_FLAG   0x0080
#define LB_FLAG       0x0100
#define RB_FLAG       0x0200
#define SPECIAL_FLAG  0x0400   /* the guide button (XInputGetStateEx) */
#define A_FLAG        0x1000
#define B_FLAG        0x2000
#define X_FLAG        0x4000
#define Y_FLAG        0x8000
#endif
