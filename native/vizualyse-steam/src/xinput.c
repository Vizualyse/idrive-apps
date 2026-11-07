// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * XInput for the car: a Windows DLL (built 64- and 32-bit with mingw,
 * src/xinput.def) installed in the Wine prefix as xinput1_4.dll, xinput1_3,
 * xinput9_1_0, xinput1_2 and xinput1_1, ahead of Wine's own (the tool's
 * WINEDLLOVERRIDES "=n"). Wine's reads controllers through its winebus,
 * which has nothing to read on the car (no evdev, HID or SDL there);
 * steam-pads reads XInput USB pads through usbfs and writes their state to
 * the pads file (src/vzs_pads.h), which this reads on each call:
 * Z:\dev\shm\vizualyse-steam\pads (VZS_PADS_FILE overrides it).
 *
 * The state is what a game reads; vibration is accepted and dropped (the
 * pads' rumble is not driven yet), keystrokes are never queued, a pad is
 * wired and full.
 */
#include <windows.h>
#include "vzs_pads.h"

/* XInput's own structures (not xinput.h: these functions are ours) */
typedef struct { WORD wButtons; BYTE bLeftTrigger, bRightTrigger; SHORT sThumbLX, sThumbLY, sThumbRX, sThumbRY; } XGAMEPAD;
typedef struct { DWORD dwPacketNumber; XGAMEPAD Gamepad; } XSTATE;
typedef struct { WORD wLeftMotorSpeed, wRightMotorSpeed; } XVIBRATION;
typedef struct { BYTE Type, SubType; WORD Flags; XGAMEPAD Gamepad; XVIBRATION Vibration; } XCAPS;
typedef struct { BYTE BatteryType, BatteryLevel; } XBATTERY;
typedef struct { WORD VirtualKey; WCHAR Unicode; WORD Flags; BYTE UserIndex, HidCode; } XKEYSTROKE;

#define GUIDE 0x0400
#define ERROR_EMPTY_ 4306L

static HANDLE file = INVALID_HANDLE_VALUE;
static DWORD opened_at;
static BOOL enabled = TRUE;
static CRITICAL_SECTION lock;

static void open_file(void) {
    DWORD now = GetTickCount();
    if (file != INVALID_HANDLE_VALUE && now - opened_at < 2000) return;
    if (file != INVALID_HANDLE_VALUE) { CloseHandle(file); file = INVALID_HANDLE_VALUE; }
    WCHAR path[MAX_PATH];
    if (!GetEnvironmentVariableW(L"VZS_PADS_FILE", path, MAX_PATH))
        lstrcpyW(path, L"Z:\\dev\\shm\\vizualyse-steam\\pads");
    file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING, 0, NULL);
    opened_at = now;
}

/* One slot's state: TRUE when a pad is in it. */
static BOOL read_slot(DWORD i, struct vzs_pad *out) {
    if (i >= VZS_PADS_SLOTS) return FALSE;
    struct vzs_pads_file f;
    DWORD got = 0;
    BOOL ok = FALSE;
    EnterCriticalSection(&lock);
    open_file();
    if (file != INVALID_HANDLE_VALUE) {
        OVERLAPPED ov;
        ZeroMemory(&ov, sizeof(ov));
        ok = ReadFile(file, &f, sizeof(f), &got, &ov) && got == sizeof(f) && f.magic == VZS_PADS_MAGIC;
    }
    LeaveCriticalSection(&lock);
    if (!ok || !f.pad[i].connected) return FALSE;
    *out = f.pad[i];
    return TRUE;
}

static void fill(XSTATE *st, const struct vzs_pad *p, BOOL guide) {
    st->dwPacketNumber = p->packet;
    if (!enabled) { ZeroMemory(&st->Gamepad, sizeof(st->Gamepad)); return; }   /* XInputEnable(FALSE): neutral */
    st->Gamepad.wButtons = guide ? p->buttons : (WORD)(p->buttons & ~GUIDE);
    st->Gamepad.bLeftTrigger = p->lt;
    st->Gamepad.bRightTrigger = p->rt;
    st->Gamepad.sThumbLX = p->lx; st->Gamepad.sThumbLY = p->ly;
    st->Gamepad.sThumbRX = p->rx; st->Gamepad.sThumbRY = p->ry;
}

DWORD WINAPI XInputGetState(DWORD i, XSTATE *st) {
    struct vzs_pad p;
    if (!st) return ERROR_BAD_ARGUMENTS;
    if (i >= VZS_PADS_SLOTS) return ERROR_BAD_ARGUMENTS;
    if (!read_slot(i, &p)) return ERROR_DEVICE_NOT_CONNECTED;
    fill(st, &p, FALSE);
    return ERROR_SUCCESS;
}

/* ordinal 100: the guide button too */
DWORD WINAPI XInputGetStateEx(DWORD i, XSTATE *st) {
    struct vzs_pad p;
    if (!st) return ERROR_BAD_ARGUMENTS;
    if (i >= VZS_PADS_SLOTS) return ERROR_BAD_ARGUMENTS;
    if (!read_slot(i, &p)) return ERROR_DEVICE_NOT_CONNECTED;
    fill(st, &p, TRUE);
    return ERROR_SUCCESS;
}

DWORD WINAPI XInputSetState(DWORD i, XVIBRATION *v) {
    struct vzs_pad p;
    (void)v;
    if (i >= VZS_PADS_SLOTS) return ERROR_BAD_ARGUMENTS;
    return read_slot(i, &p) ? ERROR_SUCCESS : ERROR_DEVICE_NOT_CONNECTED;
}

DWORD WINAPI XInputGetCapabilities(DWORD i, DWORD flags, XCAPS *c) {
    struct vzs_pad p;
    (void)flags;
    if (!c || i >= VZS_PADS_SLOTS) return ERROR_BAD_ARGUMENTS;
    if (!read_slot(i, &p)) return ERROR_DEVICE_NOT_CONNECTED;
    ZeroMemory(c, sizeof(*c));
    c->Type = 1;                  /* XINPUT_DEVTYPE_GAMEPAD */
    c->SubType = 1;               /* XINPUT_DEVSUBTYPE_GAMEPAD */
    c->Gamepad.wButtons = 0xf3ff;
    c->Gamepad.bLeftTrigger = c->Gamepad.bRightTrigger = 0xff;
    c->Gamepad.sThumbLX = c->Gamepad.sThumbLY = c->Gamepad.sThumbRX = c->Gamepad.sThumbRY = (SHORT)0xffc0;
    c->Vibration.wLeftMotorSpeed = c->Vibration.wRightMotorSpeed = 0xff;
    return ERROR_SUCCESS;
}

void WINAPI XInputEnable(BOOL on) { enabled = on; }

DWORD WINAPI XInputGetBatteryInformation(DWORD i, BYTE type, XBATTERY *b) {
    struct vzs_pad p;
    if (!b || i >= VZS_PADS_SLOTS) return ERROR_BAD_ARGUMENTS;
    if (!read_slot(i, &p)) return ERROR_DEVICE_NOT_CONNECTED;
    if (type == 0) { b->BatteryType = 1; b->BatteryLevel = 3; }   /* the pad: wired, full */
    else { b->BatteryType = 0; b->BatteryLevel = 0; }              /* a headset: none */
    return ERROR_SUCCESS;
}

DWORD WINAPI XInputGetKeystroke(DWORD i, DWORD reserved, XKEYSTROKE *k) {
    struct vzs_pad p;
    (void)reserved;
    if (!k) return ERROR_BAD_ARGUMENTS;
    if (i == 0xff) { for (DWORD s = 0; s < VZS_PADS_SLOTS; s++) if (read_slot(s, &p)) return ERROR_EMPTY_; return ERROR_DEVICE_NOT_CONNECTED; }
    if (i >= VZS_PADS_SLOTS) return ERROR_BAD_ARGUMENTS;
    return read_slot(i, &p) ? ERROR_EMPTY_ : ERROR_DEVICE_NOT_CONNECTED;
}

DWORD WINAPI XInputGetDSoundAudioDeviceGuids(DWORD i, GUID *render, GUID *capture) {
    struct vzs_pad p;
    if (i >= VZS_PADS_SLOTS) return ERROR_BAD_ARGUMENTS;
    if (!read_slot(i, &p)) return ERROR_DEVICE_NOT_CONNECTED;
    if (render) ZeroMemory(render, sizeof(*render));
    if (capture) ZeroMemory(capture, sizeof(*capture));
    return ERROR_SUCCESS;
}

DWORD WINAPI XInputGetAudioDeviceIds(DWORD i, LPWSTR render, UINT *rn, LPWSTR capture, UINT *cn) {
    (void)render; (void)capture;
    if (rn) *rn = 0;
    if (cn) *cn = 0;
    return i >= VZS_PADS_SLOTS ? ERROR_BAD_ARGUMENTS : ERROR_DEVICE_NOT_CONNECTED;
}

DWORD WINAPI XInputWaitForGuideButton(DWORD i, DWORD flags, void *listen) { (void)i; (void)flags; (void)listen; return ERROR_SUCCESS; }
DWORD WINAPI XInputCancelGuideButtonWait(DWORD i) { (void)i; return ERROR_SUCCESS; }
DWORD WINAPI XInputPowerOffController(DWORD i) { (void)i; return ERROR_SUCCESS; }

BOOL WINAPI DllMain(HINSTANCE h, DWORD reason, LPVOID r) {
    (void)r;
    if (reason == DLL_PROCESS_ATTACH) { DisableThreadLibraryCalls(h); InitializeCriticalSection(&lock); }
    else if (reason == DLL_PROCESS_DETACH) {
        if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
        DeleteCriticalSection(&lock);
    }
    return TRUE;
}
