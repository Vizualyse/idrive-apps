// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Yousaf Khan
/*
 * A game's Steam start-up, for "Run without Steam" (server.js: gbe_fork's
 * steam_api in place of Steam's): loads steam_api64.dll / steam_api.dll from
 * beside it and calls SteamAPI_Init, as a game does before anything else.
 * "t_steam: SteamAPI_Init 1" when it would carry on (gbe_fork answers),
 * "t_steam: SteamAPI_Init 0" when it would quit ("run the game from Steam").
 * libs: -luser32
 */
#include <windows.h>
#include <stdio.h>
#include "tlog.h"

int main(void) {
    const char *name = sizeof(void *) == 8 ? "steam_api64.dll" : "steam_api.dll";
    tlog("t_steam: %d-bit\n", (int)(sizeof(void *) * 8));
    HMODULE h = LoadLibraryA(name);
    if (!h) { tlog("t_steam: FAIL LoadLibrary %s %lu\n", name, GetLastError()); return 1; }
    typedef int (__cdecl *init_fn)(void);
    typedef void (__cdecl *shutdown_fn)(void);
    init_fn init = (init_fn)GetProcAddress(h, "SteamAPI_Init");
    if (!init) { tlog("t_steam: FAIL no SteamAPI_Init in %s\n", name); return 1; }
    int ok = init() & 0xff;
    tlog("t_steam: SteamAPI_Init %d\n", ok);
    shutdown_fn shutdown = (shutdown_fn)GetProcAddress(h, "SteamAPI_Shutdown");
    if (ok && shutdown) shutdown();
    return ok ? 0 : 1;
}
