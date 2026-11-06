# Windows games (Proton / Wine)

Found building vizualyse-steam, off the car on the bench (the unit's own
root filesystem and Mesa 19, tools/gpu-bench's stand-ins for the GPU),
2026-11-06. **Nothing here has run on the car yet.** Index: [index.md](index.md).

- **The path:** GE-Proton 11 with `PROTON_USE_WINED3D=1` (Direct3D on
  OpenGL: no Vulkan on the 4.14 kernel, [browser.md](browser.md)) and its
  Wayland driver (the unit's EGL has no X11), into our own compositor
  (wl-sink) and mgu-render's frame file ([central-screen.md](central-screen.md)).
  32-bit programs through new WoW64 (`PROTON_USE_WOW64=1`): no 32-bit glibc or
  Mesa needed.
- **Wine's GL frames reach the compositor as PRIME (dmabuf) buffers** through
  Mesa 19's own Wayland EGL (`wl_drm.create_prime_buffer`), imported by
  wl-sink through the unit's EGL on the render node: 60 of 60 frames on the
  stub, 29 pictures/s in the tool's test. An earlier "frames arrive as
  shared memory" was the bench, not Wine: llvmpipe (swrast) uses `wl_shm`,
  and Mesa's no-op DRM shim lacked PRIME export (`DRM_SHIM: unhandled core
  DRM ioctl 0x2D`), so on the stub the marshalling failed and Wine's Wayland
  connection died (exit 1). The shim has PRIME now (tools/gpu-bench).
- Wine's `egldrv_make_current HACK: Using swap interval 0` is Proton's own
  message, not a failure.
- **Proton's full-screen gamma shader** (`fs_hack_setup_gamma_shader`) needs
  GLSL 3.30 and fails on Mesa 19's compatibility contexts (i965: GL 3.0 compat,
  4.5 core only; llvmpipe 3.1): only gamma ramps (`SetDeviceGammaRamp`) are
  lost, everything draws. Proton sets `WINE_DISABLE_FULLSCREEN_HACK=1` with
  the Wayland driver anyway.
- **The adapter's name:** WineD3D's table has no HD 505 (Broxton) and falls
  back to "HD 4000" (i965) or "GeForce 8800" (llvmpipe), by which games pick
  settings. `HKCU\Software\Wine\Direct3D` `VideoPciVendorID` 0x8086,
  `VideoPciDeviceID` 0x1902 make it **Intel(R) HD Graphics 510**, the
  closest Gen9 part it knows. `VideoMemorySize` is read as a **string**
  (REG_SZ "1024"); a DWORD gives "VideoMemorySize is 0 but must be >0".
- **Proton without Python on the car:** its launcher's work (prefix, DLL
  overrides, environment) can be done once at build time; it runs
  `steam-runtime-launcher-interface-0 proton ARGV...` when that is on PATH, so
  a stand-in there captures the exact environment and command
  (`wine-preloader`, `wine`, `c:\windows\system32\steam.exe`, the game).
  Its prefix setup copies DXVK / VKD3D-Proton / NVAPI files and
  `share/openxr` whatever the renderer: keep them, or it fails.
- **wineboot without Mono / Gecko** waits forever on their installers'
  dialogs: `WINEDLLOVERRIDES=mscoree=;mshtml=`.
- **The prefix:** two builds differ only in registry time stamps, the
  `MachineGuid` / `MachineId`, the device `ContainerId`s
  (`{0001845e-0000-ffff-XXXX-XXXXXXXXXXXX}`: the last 8 bytes are a time
  stamp) and the computer name (the container's host name): zero / fix those
  and it is reproducible. Wine wants the prefix to be
  owned by the user running it.
- **wineserver's socket is in `/tmp/.wine-<uid>`**, a fixed place: `/tmp` must
  be 1777 (the unit's is a tmpfs).
- **Our programs on the unit:** every ELF program of Proton and .NET pointed
  at a bundled glibc 2.41 loader (`patchelf --set-interpreter`), the
  libraries on `LD_LIBRARY_PATH` only on their exec; the unit's Mesa 19
  (libEGL, libgbm, libglapi, libGLESv2) linked ahead, as the browser's GPU
  mode. Mesa 19 runs on the newer libwayland (1.23) Wine needs.
- **DNS for a bundled glibc:** glibc reads only `/etc/resolv.conf`; the
  bundle's `libc.so.6` has that string replaced (same length) by
  `/dev/shm/vzs.dns`, which the tool writes with the phone's DNS
  ([internet.md](internet.md)).
- **DepotDownloader 3.4.0** (on .NET 10, framework-dependent; the self-
  contained build can't be re-pointed at another loader) runs in the unit's
  root filesystem. With stdin redirected it reads the password as a line;
  Steam Guard asks on stderr without a newline ("STEAM GUARD! Please enter
  ..."), or waits for approval in the Steam app. `-remember-password` keeps
  a token in `~/.local/share/IsolatedStorage`.
- **Godot 4 games** (a `.pck` beside the exe) default to Vulkan / D3D12:
  `--rendering-driver opengl3` uses their OpenGL renderer (no WineD3D in the
  way). Steam's client doesn't run here, so `SteamAPI_Init` fails (Proton's
  `lsteamclient` finds no `steamclient.so`): a game that quits on that won't
  start; most carry on without achievements and cloud saves.
