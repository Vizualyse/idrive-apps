// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * Direct3D 11 the way a game starts it, for DXVK on the unit's Vulkan (ANV):
 * a window, the adapter DXGI reports, a hardware device and swapchain at
 * the best feature level offered, 60 frames cleared to a colour that changes
 * each frame and presented, then the last back buffer read back through a
 * staging texture. Prints one "t_d3d11: ..." line a step (tlog.h, T_LOG)
 * and "t_d3d11: ok" at the end; exit 0 on success. The read-back pixels
 * are checked only with T_D3D11_CHECK_PIXELS=1 (a GPU that runs things:
 * the car, lavapipe); on the bench's stub they are printed.
 * libs: -ld3d11 -ldxgi -lgdi32 -luser32
 */
#define COBJMACROS
#define INITGUID   /* the interface IDs defined here, not from libuuid */
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <stdio.h>
#include <stdlib.h>
#include "tlog.h"

#define FAIL(...) do { tlog("t_d3d11: FAIL " __VA_ARGS__); tlog("\n"); return 1; } while (0)
#define W 640
#define H 360
#define FRAMES 60

int main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    tlog("t_d3d11: %d-bit\n", (int)(sizeof(void *) * 8));
    WNDCLASSA wc = { 0 };
    wc.lpfnWndProc = DefWindowProcA; wc.hInstance = GetModuleHandleA(NULL); wc.lpszClassName = "t_d3d11";
    RegisterClassA(&wc);
    RECT r = { 0, 0, W, H };
    AdjustWindowRect(&r, WS_OVERLAPPEDWINDOW, FALSE);
    HWND hwnd = CreateWindowA("t_d3d11", "t_d3d11", WS_OVERLAPPEDWINDOW | WS_VISIBLE, 0, 0,
                              r.right - r.left, r.bottom - r.top, NULL, NULL, wc.hInstance, NULL);
    if (!hwnd) FAIL("CreateWindow %lu", GetLastError());

    IDXGIFactory *fac = NULL;
    if (FAILED(CreateDXGIFactory(&IID_IDXGIFactory, (void **)&fac))) FAIL("CreateDXGIFactory");
    IDXGIAdapter *ad = NULL;
    if (FAILED(IDXGIFactory_EnumAdapters(fac, 0, &ad))) FAIL("EnumAdapters: no adapter");
    DXGI_ADAPTER_DESC desc;
    IDXGIAdapter_GetDesc(ad, &desc);
    char name[128];
    WideCharToMultiByte(CP_UTF8, 0, desc.Description, -1, name, sizeof name, NULL, NULL);
    tlog("t_d3d11: adapter \"%s\" vendor 0x%04x device 0x%04x video memory %lu MB\n", name, desc.VendorId, desc.DeviceId,
         (unsigned long)(desc.DedicatedVideoMemory >> 20));

    DXGI_SWAP_CHAIN_DESC sd = { 0 };
    sd.BufferDesc.Width = W; sd.BufferDesc.Height = H; sd.BufferDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    sd.SampleDesc.Count = 1; sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT; sd.BufferCount = 2;
    sd.OutputWindow = hwnd; sd.Windowed = TRUE; sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
    const D3D_FEATURE_LEVEL want[] = { D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1,
                                       D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_9_3 };
    ID3D11Device *dev = NULL;
    ID3D11DeviceContext *ctx = NULL;
    IDXGISwapChain *sc = NULL;
    D3D_FEATURE_LEVEL got = 0;
    HRESULT hr = D3D11CreateDeviceAndSwapChain(ad, D3D_DRIVER_TYPE_UNKNOWN, NULL, 0, want, sizeof want / sizeof *want,
                                               D3D11_SDK_VERSION, &sd, &sc, &dev, &got, &ctx);
    if (FAILED(hr)) FAIL("D3D11CreateDeviceAndSwapChain 0x%08lx", hr);
    tlog("t_d3d11: device, feature level %d_%d\n", (got >> 12) & 0xf, (got >> 8) & 0xf);

    ID3D11Texture2D *bb = NULL;
    if (FAILED(IDXGISwapChain_GetBuffer(sc, 0, &IID_ID3D11Texture2D, (void **)&bb))) FAIL("GetBuffer");
    ID3D11RenderTargetView *rtv = NULL;
    if (FAILED(ID3D11Device_CreateRenderTargetView(dev, (ID3D11Resource *)bb, NULL, &rtv))) FAIL("CreateRenderTargetView");
    DWORD t0 = GetTickCount();
    float last[4] = { 0 };
    for (int i = 0; i < FRAMES; i++) {
        MSG m;
        while (PeekMessageA(&m, NULL, 0, 0, PM_REMOVE)) { TranslateMessage(&m); DispatchMessageA(&m); }
        /* a colour that changes each frame; the last one is checked */
        float c[4] = { (float)i / (FRAMES - 1), 0.25f, 1.0f - (float)i / (FRAMES - 1), 1.0f };
        ID3D11DeviceContext_ClearRenderTargetView(ctx, rtv, c);
        hr = IDXGISwapChain_Present(sc, 1, 0);
        if (FAILED(hr)) FAIL("Present %d 0x%08lx", i, hr);
        memcpy(last, c, sizeof last);
    }
    DWORD ms = GetTickCount() - t0;
    tlog("t_d3d11: %d frames presented in %lu ms\n", FRAMES, ms);

    /* the last frame's back buffer: draw it once more (DISCARD left buffer 0
     * undefined) and read it back */
    ID3D11DeviceContext_ClearRenderTargetView(ctx, rtv, last);
    D3D11_TEXTURE2D_DESC td;
    ID3D11Texture2D_GetDesc(bb, &td);
    td.Usage = D3D11_USAGE_STAGING; td.BindFlags = 0; td.CPUAccessFlags = D3D11_CPU_ACCESS_READ; td.MiscFlags = 0;
    ID3D11Texture2D *st = NULL;
    if (FAILED(ID3D11Device_CreateTexture2D(dev, &td, NULL, &st))) FAIL("CreateTexture2D staging");
    ID3D11DeviceContext_CopyResource(ctx, (ID3D11Resource *)st, (ID3D11Resource *)bb);
    D3D11_MAPPED_SUBRESOURCE map;
    if (FAILED(ID3D11DeviceContext_Map(ctx, (ID3D11Resource *)st, 0, D3D11_MAP_READ, 0, &map))) FAIL("Map");
    const unsigned char *p = (const unsigned char *)map.pData + (H / 2) * map.RowPitch + (W / 2) * 4;
    int b = p[0], g = p[1], rr = p[2];
    int want_r = (int)(last[0] * 255 + 0.5), want_g = (int)(last[1] * 255 + 0.5), want_b = (int)(last[2] * 255 + 0.5);
    ID3D11DeviceContext_Unmap(ctx, (ID3D11Resource *)st, 0);
    tlog("t_d3d11: read back the centre: %d %d %d (want %d %d %d)\n", rr, g, b, want_r, want_g, want_b);
    const char *chk = getenv("T_D3D11_CHECK_PIXELS");
    if (chk && *chk == '1' && (abs(rr - want_r) > 1 || abs(g - want_g) > 1 || abs(b - want_b) > 1)) FAIL("pixels");

    ID3D11Texture2D_Release(st);
    ID3D11RenderTargetView_Release(rtv);
    ID3D11Texture2D_Release(bb);
    IDXGISwapChain_Release(sc);
    ID3D11DeviceContext_Release(ctx);
    ID3D11Device_Release(dev);
    IDXGIAdapter_Release(ad);
    IDXGIFactory_Release(fac);
    DestroyWindow(hwnd);
    tlog("t_d3d11: ok\n");
    return 0;
}
