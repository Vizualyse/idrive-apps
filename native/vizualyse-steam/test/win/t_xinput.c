// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The bench's controller check, as a game reads pads: XInputGetState on the
 * four slots every 10 ms for T_SECONDS (default 8). Prints
 * "t_xinput: connected N" when a slot first answers, and each change of the
 * buttons ("buttons 0x1000" = A) or of the left stick past a quarter.
 * "t_xinput: ok A lx" at the end if A was pressed and the left stick moved
 * (what test/usbip_pad.c does once a second), else "t_xinput: FAIL ...".
 * libs: -lxinput
 */
#include <windows.h>
#include <xinput.h>
#include <stdio.h>
#include <stdlib.h>
#include "tlog.h"

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    int seconds = getenv("T_SECONDS") ? atoi(getenv("T_SECONDS")) : 8;
    int seen[4] = { 0 }, any = 0, saw_a = 0, saw_lx = 0;
    WORD last_buttons[4] = { 0 };
    int last_lx_bucket[4] = { 0 };
    tlog("t_xinput: %d-bit, %d s\n", (int)(sizeof(void *) * 8), seconds);
    DWORD end = GetTickCount() + (DWORD)seconds * 1000;
    while ((LONG)(end - GetTickCount()) > 0) {
        for (DWORD i = 0; i < 4; i++) {
            XINPUT_STATE st;
            if (XInputGetState(i, &st) != ERROR_SUCCESS) continue;
            if (!seen[i]) {
                seen[i] = 1; any = 1;
                XINPUT_CAPABILITIES caps;
                XInputGetCapabilities(i, 0, &caps);
                tlog("t_xinput: connected %lu (type %u subtype %u)\n", i, caps.Type, caps.SubType);
            }
            if (st.Gamepad.wButtons != last_buttons[i]) {
                tlog("t_xinput: %lu buttons 0x%04x\n", i, st.Gamepad.wButtons);
                if (st.Gamepad.wButtons & XINPUT_GAMEPAD_A) saw_a = 1;
                last_buttons[i] = st.Gamepad.wButtons;
            }
            int b = st.Gamepad.sThumbLX / 8192;
            if (b != last_lx_bucket[i]) {
                tlog("t_xinput: %lu lx %d\n", i, st.Gamepad.sThumbLX);
                if (b) saw_lx = 1;
                last_lx_bucket[i] = b;
            }
        }
        Sleep(10);
    }
    if (!any) { tlog("t_xinput: FAIL no pad\n"); return 1; }
    if (!saw_a || !saw_lx) { tlog("t_xinput: FAIL A %d lx %d\n", saw_a, saw_lx); return 1; }
    tlog("t_xinput: ok A lx\n");
    return 0;
}
