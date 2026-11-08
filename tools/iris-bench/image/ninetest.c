// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
//
// ninetest: Gallium Nine's native side (Mesa's d3dadapter9.so) on the
// render node, as a Wine front end would ask it (bench only): the "drm"
// interface makes an ID3DAdapter9 on the fd; its identifier and caps.
// Presenting (Nine's front end's part) isn't tried: see tools/iris-bench.
//
//   ninetest /path/d3dadapter9.so.1 [/dev/dri/renderD128]
#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <unistd.h>
#include <d3dadapter/drm.h>

int main(int argc, char **argv) {
    if (argc < 2) { fprintf(stderr, "usage: ninetest d3dadapter9.so.1 [node]\n"); return 2; }
    setvbuf(stdout, NULL, _IONBF, 0);
    void *h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!h) { printf("FAIL: dlopen: %s\n", dlerror()); return 1; }
    /* WINAPI: ms_abi on x86-64, as Wine calls it */
    const void *(WINAPI *getproc)(const char *) = (const void *(WINAPI *)(const char *))dlsym(h, "D3DAdapter9GetProc");
    const struct D3DAdapter9DRM *drm = getproc ? getproc(D3DADAPTER9DRM_NAME) : NULL;
    if (!drm) { printf("FAIL: no \"drm\" interface\n"); return 1; }
    printf("nine: drm interface %u.%u\n", drm->major_version, drm->minor_version);
    int fd = open(argc > 2 ? argv[2] : "/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (fd < 0) { printf("FAIL: open the render node\n"); return 1; }
    ID3DAdapter9 *a = NULL;
    HRESULT hr = drm->create_adapter(fd, &a);
    if (hr != D3D_OK || !a) { printf("FAIL: create_adapter: 0x%lx\n", (unsigned long)hr); return 1; }
    D3DADAPTER_IDENTIFIER9 id;
    if (ID3DAdapter9_GetAdapterIdentifier(a, 0, &id) == D3D_OK)
        printf("nine: adapter \"%s\" driver \"%s\" vendor 0x%04x device 0x%04x\n",
               id.Description, id.Driver, (unsigned)id.VendorId, (unsigned)id.DeviceId);
    D3DCAPS9 caps;
    if (ID3DAdapter9_GetDeviceCaps(a, D3DDEVTYPE_HAL, &caps) == D3D_OK)
        printf("nine: HAL caps: VS %lu.%lu, PS %lu.%lu, max texture %lux%lu, %lu simultaneous render targets\n",
               (unsigned long)((caps.VertexShaderVersion >> 8) & 0xff), (unsigned long)(caps.VertexShaderVersion & 0xff),
               (unsigned long)((caps.PixelShaderVersion >> 8) & 0xff), (unsigned long)(caps.PixelShaderVersion & 0xff),
               (unsigned long)caps.MaxTextureWidth, (unsigned long)caps.MaxTextureHeight,
               (unsigned long)caps.NumSimultaneousRTs);
    else { printf("FAIL: GetDeviceCaps\n"); return 1; }
    ID3DAdapter9_Release(a);
    printf("PASS: Nine's adapter on the render node\n");
    return 0;
}
