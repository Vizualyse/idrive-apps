// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The bench's Direct3D 9 check, as an indie DX9 game starts: a window, the
 * adapter's name (WineD3D's report of the GL renderer), a HAL device, a few
 * cleared and presented frames, a rendered triangle read back. Prints one
 * "t_d3d9: ..." line a step and "t_d3d9: ok" at the end; exit 0 on success.
 * On a no-op GPU the pixels read back are meaningless, so they are printed,
 * not checked, unless T_D3D9_CHECK_PIXELS=1 (swrast, the car).
 * libs: -ld3d9 -lgdi32 -luser32
 */
#include <windows.h>
#include <d3d9.h>
#include <stdio.h>
#include <stdlib.h>
#include "tlog.h"

static LRESULT CALLBACK wndproc(HWND h, UINT m, WPARAM w, LPARAM l) { return DefWindowProcA(h, m, w, l); }

#define FAIL(...) do { tlog("t_d3d9: FAIL " __VA_ARGS__); tlog("\n"); fflush(stdout); return 1; } while (0)

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    tlog("t_d3d9: %d-bit\n", (int)(sizeof(void *) * 8));
    WNDCLASSA wc = { 0 };
    wc.lpfnWndProc = wndproc; wc.hInstance = GetModuleHandleA(NULL); wc.lpszClassName = "t_d3d9";
    RegisterClassA(&wc);
    HWND hwnd = CreateWindowA("t_d3d9", "t_d3d9", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0, 640, 360, NULL, NULL, wc.hInstance, NULL);
    if (!hwnd) FAIL("CreateWindow %lu", GetLastError());

    IDirect3D9 *d3d = Direct3DCreate9(D3D_SDK_VERSION);
    if (!d3d) FAIL("Direct3DCreate9");
    D3DADAPTER_IDENTIFIER9 id;
    if (FAILED(IDirect3D9_GetAdapterIdentifier(d3d, D3DADAPTER_DEFAULT, 0, &id))) FAIL("GetAdapterIdentifier");
    tlog("t_d3d9: adapter \"%s\" driver \"%s\" vendor 0x%04lx device 0x%04lx\n",
           id.Description, id.Driver, id.VendorId, id.DeviceId);
    D3DCAPS9 caps;
    if (FAILED(IDirect3D9_GetDeviceCaps(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, &caps))) FAIL("GetDeviceCaps");
    tlog("t_d3d9: vs %lu.%lu ps %lu.%lu max texture %lux%lu\n",
           (caps.VertexShaderVersion >> 8) & 0xff, caps.VertexShaderVersion & 0xff,
           (caps.PixelShaderVersion >> 8) & 0xff, caps.PixelShaderVersion & 0xff,
           caps.MaxTextureWidth, caps.MaxTextureHeight);

    D3DPRESENT_PARAMETERS pp = { 0 };
    pp.Windowed = TRUE; pp.SwapEffect = D3DSWAPEFFECT_DISCARD; pp.BackBufferFormat = D3DFMT_X8R8G8B8;
    pp.BackBufferWidth = 640; pp.BackBufferHeight = 360; pp.hDeviceWindow = hwnd;
    pp.PresentationInterval = D3DPRESENT_INTERVAL_IMMEDIATE;
    IDirect3DDevice9 *dev = NULL;
    HRESULT hr = IDirect3D9_CreateDevice(d3d, D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, hwnd,
                                         D3DCREATE_HARDWARE_VERTEXPROCESSING, &pp, &dev);
    if (FAILED(hr)) FAIL("CreateDevice 0x%08lx", hr);
    tlog("t_d3d9: device\n");

    struct { float x, y, z, rhw; DWORD c; } tri[3] = {
        { 320, 40, 0.5f, 1, 0xffff0000 }, { 600, 320, 0.5f, 1, 0xff00ff00 }, { 40, 320, 0.5f, 1, 0xff0000ff },
    };
    int frames = getenv("T_FRAMES") ? atoi(getenv("T_FRAMES")) : 60;
    DWORD t0 = GetTickCount();
    for (int f = 0; f < frames; f++) {
        MSG msg;
        while (PeekMessageA(&msg, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&msg); DispatchMessageA(&msg); }
        IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET, D3DCOLOR_XRGB(51, 102, 153), 1.0f, 0);
        IDirect3DDevice9_BeginScene(dev);
        IDirect3DDevice9_SetFVF(dev, D3DFVF_XYZRHW | D3DFVF_DIFFUSE);
        IDirect3DDevice9_DrawPrimitiveUP(dev, D3DPT_TRIANGLELIST, 1, tri, sizeof tri[0]);
        IDirect3DDevice9_EndScene(dev);
        hr = IDirect3DDevice9_Present(dev, NULL, NULL, NULL, NULL);
        if (FAILED(hr)) FAIL("Present 0x%08lx at frame %d", hr, f);
    }
    DWORD ms = GetTickCount() - t0;
    tlog("t_d3d9: %d frames in %lu ms\n", frames, ms);

    /* Read the back buffer: the clear colour at a corner, the triangle's middle. */
    IDirect3DSurface9 *bb = NULL, *sys = NULL;
    IDirect3DDevice9_GetBackBuffer(dev, 0, 0, D3DBACKBUFFER_TYPE_MONO, &bb);
    IDirect3DDevice9_CreateOffscreenPlainSurface(dev, 640, 360, D3DFMT_X8R8G8B8, D3DPOOL_SYSTEMMEM, &sys, NULL);
    IDirect3DDevice9_Clear(dev, 0, NULL, D3DCLEAR_TARGET, D3DCOLOR_XRGB(51, 102, 153), 1.0f, 0);
    IDirect3DDevice9_BeginScene(dev);
    IDirect3DDevice9_DrawPrimitiveUP(dev, D3DPT_TRIANGLELIST, 1, tri, sizeof tri[0]);
    IDirect3DDevice9_EndScene(dev);
    if (!bb || !sys || FAILED(IDirect3DDevice9_GetRenderTargetData(dev, bb, sys))) FAIL("GetRenderTargetData");
    D3DLOCKED_RECT lr;
    if (FAILED(IDirect3DSurface9_LockRect(sys, &lr, NULL, D3DLOCK_READONLY))) FAIL("LockRect");
    DWORD corner = ((DWORD *)lr.pBits)[2 * (lr.Pitch / 4) + 2] & 0xffffff;
    DWORD middle = ((DWORD *)((BYTE *)lr.pBits + 220 * lr.Pitch))[320] & 0xffffff;
    IDirect3DSurface9_UnlockRect(sys);
    tlog("t_d3d9: pixels corner %06lx middle %06lx\n", corner, middle);
    if (getenv("T_D3D9_CHECK_PIXELS") && atoi(getenv("T_D3D9_CHECK_PIXELS"))) {
        if (corner != 0x336699) FAIL("corner %06lx, not 336699", corner);
        if (middle == 0x336699) FAIL("no triangle");
    }
    IDirect3DSurface9_Release(sys); IDirect3DSurface9_Release(bb);
    IDirect3DDevice9_Release(dev); IDirect3D9_Release(d3d);
    DestroyWindow(hwnd);
    tlog("t_d3d9: ok\n");
    return 0;
}
