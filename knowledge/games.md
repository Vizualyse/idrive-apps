# Windows games (Proton / Wine)

Found building vizualyse-steam, off the car on the bench (the unit's own
root filesystem and Mesa 19, tools/gpu-bench's stand-ins for the GPU),
2026-11-06, and on the car since 2026-11-07 (FTL, Gunpoint, STS2, DXVK
under Proton): a line says which. Index: [index.md](index.md).

- **The path:** GE-Proton 11 with `PROTON_USE_WINED3D=1` (Direct3D on
  OpenGL; from Steam 0.1.9 64-bit games on DXVK and ANV instead, "Vulkan"
  below) and its
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
- **A prefix links out of itself: never `chown -R` it without `-h`.**
  `dosdevices/z:` is `/`, `com1`..`com4` are `/dev/ttyS0..3`, and ~1300
  files of `drive_c` are symlinks into Proton's own `files/lib/wine` and
  `share`. BusyBox's `chown -R` without `-h` changes the targets: on the car
  (2026-11-07, vk-trial's DXVK setup) it gave Proton's files and the serial
  ports to the trial's uid and tried `/` (read-only, refused); put back by
  hand (Proton's tree `0:0`, `ttyS*` `root:dialout` per the unit's udev
  rule). The Steam tool's `unpack.chownR` skips links (lstat), as it must.
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
- **On the car (2026-11-07): DepotDownloader aborted at start** with
  `AccountSettingsStore` / IsolatedStorage: "cannot open ...
  'Global\...'": `lstat("<XDG_RUNTIME_DIR>") ENOENT`. .NET keeps
  IsolatedStorage's named mutex in `XDG_RUNTIME_DIR`, which must exist;
  /dev/shm is empty after every start of the unit and only a game made the
  folder. The bench missed it: it ran DepotDownloader without arguments
  (usage only, no account store).
- **On the car (2026-11-07): 64-bit games start, 32-bit don't.** Slay the
  Spire 2 drew through the unit's i965 and was shown, no GPU errors. It then
  died on the tool's own `WINEDLLOVERRIDES=mscoree=`: Wine's loader needs
  its built-in mscoree.dll for every IL-only DLL, even with the game's own
  .NET 9 runtime ("IL-only binary sts2.dll cannot be loaded"). FTL
  (32-bit): `Failed to create process ...: 731`, the new process dying
  (SIGSEGV) after loading syswow64's ntdll. **The unit's 4.14 kernel has no
  IA32 emulation:** `int $0x80` faults (no `ia32_sys_call_table`, no
  `/proc/sys/abi/vsyscall32`), and Wine's new WoW64 makes two i386 system
  calls through it in `signal_x86_64.c` (`alloc_fs_sel`:
  set_thread_area; `modify_ldt`). 32-bit code itself runs (a far return to
  selector 0x23 works), and the 64-bit `modify_ldt` (154) works; the 64-bit
  `set_thread_area` (205) is ENOSYS on any kernel.
- **The fix: Wine's source, not its binary.** Swapping the two `int $0x80`
  isn't enough: on Linux Wine assumes a GDT `fs32_sel` (16 places read it:
  restoring glibc's `%fs` base in signal handlers and the syscall
  dispatcher, reloading the 32-bit `%fs`). Its per-thread LDT fallback
  (`signal_alloc_thread`, as on macOS) works on Linux once those spots use
  the thread's own selector (`thread_data->fs`) and `pthread_teb` is saved
  (`patches/wine-no-ia32.patch`). GE-Proton's Wine rebuilds from its tag:
  Valve's Wine at the submodule commit, Staging, then GE's
  `protonprep-valve-staging.sh` Wine section (it reverts one commit:
  fetch it, a shallow clone lacks it); then Proton's
  `make_vulkan -x vk.xml -X video.xml` and `make_specfiles`; configure
  without `--enable-archs` (no PE compiler needed for ntdll.so) and with
  Proton's CFLAGS (`-march=nocona -mtune=core-avx2 -O2 -fwrapv ...`). Built
  unpatched, the stripped `ntdll.so` is the shipped one's size, exports and
  `.text` / `.bss` (only `.rodata` 256 bytes apart).
- **On the car with 0.1.3 (2026-11-07): FTL runs** (32-bit, the rebuilt
  ntdll.so): its window, 15 pictures/s through PRIME buffers, wl-sink 34 ms
  a picture, no GPU errors; memory 2.0 GB of the 2.5 GB cgroup cap. **Slay
  the Spire 2** got to its own window, then quit: "Game launched with Steam
  failed to initialize: make sure you run the game from Steam"
  (`SteamAPI_Init`, no Steam client here): gbe_fork's steam_api64.dll is the
  way (0.1.4's Run without Steam).
- **A kept prefix and wineboot:** the tool keeps the prefix over updates
  (saves), so one unpacked by an early version still had a time in
  `.update-timestamp`; a new proton.tgz (wine.inf dated 0) then made Wine run
  `wineboot --update` at the next start, which with mscoree on opened "Wine
  Mono Installer". `disable` in `.update-timestamp` stops that for good.
- **Sound through a FIFO needs a clock:** Wine's ALSA into a file plugin
  over "null" has none, so Wine wrote ~3.6x real time and the player
  (`pcm_play.py --live`) dropped nearly everything (`0.1 s played`). Read
  the FIFO at the sound's own rate (48 kHz S16 stereo) and keep it small
  (F_SETPIPE_SZ 8 KB): Wine then waits as on a sound card.
- **Wine's window frame:** a Direct3D / OpenGL game's client area is a
  wl_subsurface over the toplevel, which carries the Win32 frame and title
  bar (shm, drawn by Wine): showing only the largest subsurface hides the
  title bar. Pointer input goes to the toplevel in its own coordinates
  (subsurface position + local); Wine wants the keyboard's enter too to
  treat the window as foreground.
- **gbe_fork on the PC:** Windows Defender locks its DLL archive on the
  Windows drive (read: permission denied): keep it in a Docker volume, as
  Proton.
- **USB sticks on the unit:** udisks2 (for the HMI) mounts them at
  `/media/<label or uuid>` (`99-usb-udisks-mountpath.rules`): `ro,nosuid,
  nodev,noexec`, FAT32 as `uid=2010,gid=2010,fmask=0000,dmask=0000`
  (con_2010, every file 0777). The kernel has vfat, Tuxera's `texfat` and
  `tntfs` (read-write) and ext4. The unit's hard disk is `sda`
  (`removable` 0), sticks `sdb`... (`removable` 1, under `usb1`). The tool
  runs in the same mount namespace as udisks (`/media` is a shared mount).
- **DepotDownloader 3.4.0** (on .NET 10, framework-dependent; the self-
  contained build can't be re-pointed at another loader) runs in the unit's
  root filesystem. With stdin redirected it reads the password as a line;
  Steam Guard asks on stderr without a newline ("STEAM GUARD! Please enter
  ..."), or waits for approval in the Steam app. `-remember-password` keeps
  a token in `~/.local/share/IsolatedStorage`.
- **Godot 4 games** (a `.pck` beside the exe) default to Vulkan / D3D12:
  `--rendering-driver opengl3` uses their OpenGL renderer (no WineD3D in the
  way), `--rendering-driver vulkan` their Vulkan one on ANV (STS2 on the car,
  2026-11-08: Forward+, playable). Adding `--rendering-method mobile` made
  STS2 choose D3D12 (no adapter): swap only the driver. Steam's client doesn't run here, so `SteamAPI_Init` fails (Proton's
  `lsteamclient` finds no `steamclient.so`): a game that quits on that won't
  start; most carry on without achievements and cloud saves.

## Vulkan (from Steam 0.1.9)

- **ANV 19.0.6 + the Khronos loader + DXVK 1.9.4 ship in Steam's
  `vulkan.tgz`;** a 64-bit game (the exe's PE machine field) gets Vulkan by
  default: DXVK's `d3d11, d3d10core, d3d9, dxgi` native in the prefix, the
  ICD file only in `/dev/shm/vizualyse-steam` while the game runs, every DRM
  ioctl logged (O_DSYNC) to `state/vulkan-crumbs.log` by `vk_crumbs.so`. A
  restart during a Vulkan game turns Vulkan off for it. Proven first with
  `tools/vk-trial` (gated, one start; [bench.md](bench.md)).
- **DXVK versions:** 1.10.x needs `VK_EXT_host_query_reset`, 2.x and
  GE-Proton's own (3.x) need Vulkan 1.3: 1.9.4 is the newest for the ANV
  we ship (19.0.6). Newer ANV is a choice, not a wall: 19.1+ has
  host_query_reset (1.10.x), Mesa 22+ has Vulkan 1.3 (2.x); see
  [browser.md](browser.md), "Vulkan on this kernel", for what stands in the
  way of each. DXVK 1.9.4 has no LOD-bias option (2.x's `samplerLodBias`).
- **32-bit DXVK needs ANV 19.1+ (bench, 2026-11-08):** under new WoW64 a
  32-bit program's mapped GPU memory must sit below 4 GB. Wine (win32u's
  `vulkan.c`) gets that through `VK_EXT_map_memory_placed` (Mesa 23.3+) or
  else `VK_EXT_external_memory_host` (its own low allocation imported into
  ANV, `I915_GEM_USERPTR` in the kernel); ANV 19.0.6 has neither, so every
  `vkMapMemory` lands above 4 GB and is refused: DXVK logs `Mapping memory
  failed with VK_ERROR_OUT_OF_HOST_MEMORY`, `CreateDevice` gives
  `D3DERR_NOTAVAILABLE` (0x8876086a), D3D11 `E_FAIL`. **ANV 19.1.8 has
  external_memory_host** (and host_query_reset): `t_d3d932` and `t_d3d1132`
  pass on it, on the bench and through the car's steps
  (`MESA_VER=19.1.8 DXVK_PROGRAMS=... sh tools/vk-trial/dxvk/car_test.sh`),
  DXVK 1.9.4 and 1.10.3 alike; 64-bit unchanged; vk-trial's stages ask the
  kernel nothing new (the probe doesn't use USERPTR: the 32-bit path is the
  first user). Wine also warns "Cannot export WOW64 memory without
  VK_EXT_map_memory_placed": a 32-bit game can't share D3D resources with
  another process (rare). Not on the car yet: vk-trial first (TODO).
- **Mesa 19.1 builds with meson 0.61** (18.04's 0.45 is too old) once
  `src/util/xmlpool/options.h` is built first (else "No such file":
  vk-trial's `image/Dockerfile`, `MESA_VER`).
- **Newer ANV on the bench (2026-11-08, tools/vk-trial `MESA_VER`, the stub
  behind kernel414):**
  - **19.3.5** builds and runs the stages (Vulkan 1.1.102, as 19.1.8), adds
    only shader-level extensions DXVK 1.x doesn't use, and sends
    **`I915_QUERY` (i915 ioctl 0x39), which on the unit's IOTG 4.14 is
    `GEM_GVTBUFFER`** (another call, another struct). 19.1.8 doesn't: it
    stays the 1.x candidate.
  - **22.3.7 builds for glibc 2.27** (`image/anv_new.sh`, Ubuntu 18.04):
    meson 0.61, glslang 12.3.1 at build time only, **libdrm 2.4.114 static
    and hidden inside** (the unit's libdrm lacks `drmSyncobjTimelineWait`,
    and a second `libdrm.so.2` would lose to the unit's, which i965 loads
    first), **wayland 1.18's headers and scanner** (the unit's
    libwayland-client is older than 1.17: no `wl_proxy_marshal_flags`);
    every `wl_*` / `XML_*` import is in the unit's libraries, the rest
    within its libstdc++ 6.0.24, zlib 1.2.11, glibc 2.27. On the stub it
    **starts without context isolation**: "HD Graphics 505 (APL 3)",
    **Vulkan 1.3.230**, every stage (compute, draw, present) passes. It
    too sends `I915_QUERY` (topology, engines, memory regions), so it is
    built with `image/mesa-no-i915-query.patch` (EINVAL before the kernel,
    as a kernel without QUERY answers; it falls back to GETPARAM).
  - **Its Vulkan WSI speaks only linux-dmabuf v3** (no wl_drm since Mesa
    22): `VK_ERROR_SURFACE_LOST_KHR` on wl-sink until **`wl-sink --dmabuf`**
    (one plane, ARGB / XRGB, only `DRM_FORMAT_MOD_INVALID`, the same buffers
    as wl_drm's). Offered only when asked (vkprobe, run.js and the Steam
    tool ask for Mesa 20+, by `lib/mesa`): Mesa 19's EGL, every WineD3D
    game, might take it over wl_drm.
  - **DXVK on 22.3.7** (Proton, D3D11 + D3D9, 64- and 32-bit): **1.10.3:
    all four pass. 2.6.2: all four pass.** 2.3.1 makes the device (feature
    level 11_1) but Present fails `DXGI_ERROR_DEVICE_RESET` after 10 (64-bit)
    / 3 (32-bit) frames and D3D9 hangs: not understood, fixed by 2.6.
    **2.7.x needs `VK_KHR_maintenance5`** (not in 22.3; "No adapters
    found"): 2.6.2 is the newest for it.
  - **23.1.9:** needs Python's `dataclasses` (3.7; the backport for 18.04's
    3.6 is in `anv_new.sh`); its image build was stopped by the host running
    out of memory: untested.
- **The DXVK bench before 2026-11-08** ran 32-bit programs without
  `PROTON_USE_WOW64=1` (they never started: "Failed to create process": 731)
  and turned `t_d3d932` into `t_d3d93264`; fixed in `dxvk/bench.sh`,
  `in_bench.sh` (its prefix volume is now `...-wow64`, Proton's `i386-unix`
  64-bit-only as the Steam bench's).
- **WineD3D 32-bit on the stub** passes through wl-sink (`COMPOSITOR=wl-sink
  sh test/run_bench.sh stub t_d3d932`, exit 0; the "Context array not
  freed!" line remains at teardown). The bench's default, weston, fails on
  the stub ("Failed to find a suitable pixel format"): a bench limit, not the
  tool (which uses wl-sink).
- **wl-sink forwards DXVK's buffers to Winston as they are (120 fwd), but
  not Godot's** (STS2: 0 fwd, each picture read back, ~109 ms): not yet
  understood. Up to 0.1.9 wl-sink read back any surface with a viewport or
  shown at another size than its buffer; if Godot's area is scaled that way,
  0.1.10 forwards it (below). Check `scaled` in wl-sink's stats on the car.
- **On the stub, DXVK runs at ~17 frames a second** whatever its options
  (`maxFrameRate` 30 or none, `maxFrameLatency` 1 or the default: 17.8,
  17.0, 7.0 in one run each, 2026-11-08), probably the crumbs log's
  synchronous writes: the bench can't show DXVK being held to 30.

## Frames nobody sees (Steam 0.1.10, bench 2026-11-08)

- **WineD3D draws as fast as it can without a cap:** Proton's Wine sets swap
  interval 0 (`egldrv_make_current HACK: Using swap interval 0`), so
  eglSwapBuffers never waits and wl-sink, which shows 30 a second, drops the
  rest. **`vblank_mode=3`** (i965's driconf option, read from the
  environment by Mesa 19's EGL: "always sync") clamps the interval to at least
  1, so each swap waits for the surface's frame callback, which wl-sink
  answers at its `--fps`: t_d3d9 (D3DPRESENT_INTERVAL_IMMEDIATE) went to 29.0
  frames a second on the stub. llvmpipe (swrast) has no such option and stays
  unthrottled.
- **Wine emulates a display mode the screen lacks with a viewport:** t_d3d9
  full screen at 640x480 on wl-sink's 960x540 output: Wine's client area is a
  640x480 buffer with `wp_viewport` scaling it to the output. Winston can
  scale it (the ivi surface's source and destination rectangles), so wl-sink
  0.1.10 forwards it as it is (167 of 167 pictures, `scaled`, no read-back).
- **DXVK's adapter as games see it** is whatever `dxvk.conf` says:
  `dxgi.customDeviceId`, `customVendorId`, `customDeviceDesc`,
  `maxDeviceMemory` (and the `d3d9.` ones; `d3d9.maxAvailableMemory` only
  reports while `d3d9.memoryTrackTest` is off). Without it, ANV's "HD 505
  (Broxton)" with 4209 MB, which few games' tables know. `DXVK_CONFIG_FILE`
  is opened through Windows' file calls: give it a `Z:\` path.

## Steam's CDN (2026-11-08)

- **London's servers (lhr1) present the wrong TLS certificates** from the
  car's connection (DNS the same through the phone and 8.8.8.8); Amsterdam
  and Frankfurt are fine. DepotDownloader's `-cellid` steers content
  servers, not the manifest requests. `-depot <the game's own depot>` works
  around it (skipping Steamworks Common Redistributables, app 228980):
  Gunpoint came down that way (507 MB).
