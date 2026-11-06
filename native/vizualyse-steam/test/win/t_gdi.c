// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The bench's plainest check: a window painted with GDI (Wine draws it into
 * shared-memory buffers for the compositor, no GL), shown for T_MS (default
 * 1500) ms. Prints "t_gdi: painted" from WM_PAINT and "t_gdi: ok".
 * libs: -lgdi32 -luser32
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include "tlog.h"

static int painted;

static LRESULT CALLBACK wndproc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_PAINT) {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(h, &ps);
        HBRUSH br = CreateSolidBrush(RGB(51, 102, 153));
        FillRect(dc, &ps.rcPaint, br);
        DeleteObject(br);
        TextOutA(dc, 20, 20, "vizualyse-steam bench", 21);
        EndPaint(h, &ps);
        if (!painted++) tlog("t_gdi: painted\n");
        return 0;
    }
    return DefWindowProcA(h, m, w, l);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    WNDCLASSA wc = { 0 };
    wc.lpfnWndProc = wndproc; wc.hInstance = GetModuleHandleA(NULL); wc.lpszClassName = "t_gdi";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("t_gdi", "t_gdi", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, 640, 360, NULL, NULL, wc.hInstance, NULL);
    if (!hwnd) { tlog("t_gdi: FAIL CreateWindow %lu\n", GetLastError()); return 1; }
    UpdateWindow(hwnd);
    DWORD end = GetTickCount() + (getenv("T_MS") ? (DWORD)atoi(getenv("T_MS")) : 1500);
    while ((LONG)(end - GetTickCount()) > 0) {
        MSG msg;
        while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageA(&msg); }
        Sleep(10);
    }
    DestroyWindow(hwnd);
    if (!painted) { tlog("t_gdi: FAIL never painted\n"); return 1; }
    tlog("t_gdi: ok\n");
    return 0;
}
