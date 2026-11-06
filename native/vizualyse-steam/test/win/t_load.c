// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * The bench's DLL check: loads the DLLs a Direct3D game pulls in, one at a
 * time at run time (a program importing them dies before main if one fails
 * to load), printing "t_load: NAME" before each and "ok" or the error after.
 * T_LOAD=a.dll,b.dll replaces the list. "t_load: ok" when all loaded.
 * libs: -luser32
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "tlog.h"

int main(void) {
    char list[1024] = "libvkd3d-shader-1.dll,opengl32.dll,wined3d.dll,d3d9.dll,d3d11.dll,dxgi.dll,xinput1_3.dll";
    if (getenv("T_LOAD")) snprintf(list, sizeof list, "%s", getenv("T_LOAD"));
    int fails = 0;
    tlog("t_load: %d-bit\n", (int)(sizeof(void *) * 8));
    for (char *name = strtok(list, ","); name; name = strtok(NULL, ",")) {
        tlog("t_load: %s ...\n", name);
        HMODULE h = LoadLibraryA(name);
        if (h) tlog("t_load: %s ok\n", name);
        else { tlog("t_load: %s FAIL error %lu\n", name, GetLastError()); fails++; }
    }
    if (fails) { tlog("t_load: FAIL %d\n", fails); return 1; }
    tlog("t_load: ok\n");
    return 0;
}
