// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * A game that draws with OpenGL itself, through WGL (FTL, MonoGame's
 * Stardew Valley, GoldSrc): Wine's GL on the unit's EGL, its pictures to
 * wl-sink as GPU buffers. Stardew Valley quit on the car (Steam 0.2.0,
 * 2026-11-09) when Wine's EGL (Mesa 19) sent wl-sink an X-tiled linux-dmabuf
 * buffer it hadn't offered ("modifier 0x100000000000001 not offered"):
 * that is what this one walks into. Logs its bitness and GL_VERSION, then
 * "t_gl: drew N" every 100 frames of glClear in alternating colours, for T_MS
 * (default: until closed).
 * libs: -lopengl32 -lgdi32 -luser32
 */
#include <windows.h>
#include <GL/gl.h>
#include <stdio.h>
#include <stdlib.h>
#include "tlog.h"

static LRESULT CALLBACK wndproc(HWND h, UINT m, WPARAM w, LPARAM l) {
    if (m == WM_CLOSE) { PostQuitMessage(0); return 0; }
    return DefWindowProcA(h, m, w, l);
}

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    tlog("t_gl: %s\n", sizeof(void *) == 8 ? "64-bit" : "32-bit");
    WNDCLASSA wc = { 0 };
    wc.style = CS_OWNDC;
    wc.lpfnWndProc = wndproc; wc.hInstance = GetModuleHandleA(NULL); wc.lpszClassName = "t_gl";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("t_gl", "t_gl", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, 640, 360, NULL, NULL, wc.hInstance, NULL);
    if (!hwnd) { tlog("t_gl: FAIL CreateWindow %lu\n", GetLastError()); return 1; }
    HDC dc = GetDC(hwnd);
    PIXELFORMATDESCRIPTOR pfd = { sizeof pfd, 1, PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER, PFD_TYPE_RGBA, 32 };
    pfd.cDepthBits = 24;
    int pf = ChoosePixelFormat(dc, &pfd);
    if (!pf || !SetPixelFormat(dc, pf, &pfd)) { tlog("t_gl: FAIL pixel format %lu\n", GetLastError()); return 1; }
    HGLRC rc = wglCreateContext(dc);
    if (!rc || !wglMakeCurrent(dc, rc)) { tlog("t_gl: FAIL context %lu\n", GetLastError()); return 1; }
    tlog("t_gl: GL_VERSION %s, GL_RENDERER %s\n", (const char *)glGetString(GL_VERSION), (const char *)glGetString(GL_RENDERER));
    DWORD end = getenv("T_MS") ? GetTickCount() + (DWORD)atoi(getenv("T_MS")) : 0;
    unsigned long n = 0;
    for (;;) {
        MSG msg;
        while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) {
            if (msg.message == WM_QUIT) goto done;
            TranslateMessage(&msg); DispatchMessageA(&msg);
        }
        if (end && (LONG)(end - GetTickCount()) <= 0) break;
        if (n & 1) glClearColor(0.2f, 0.4f, 0.6f, 1.0f); else glClearColor(1.0f, 0.25f, 0.0f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        SwapBuffers(dc);
        if (++n % 100 == 0) tlog("t_gl: drew %lu\n", n);
    }
done:
    wglMakeCurrent(NULL, NULL);
    wglDeleteContext(rc);
    tlog("t_gl: ok, %lu frames\n", n);
    return 0;
}
