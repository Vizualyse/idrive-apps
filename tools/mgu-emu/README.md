# mgu-emu: the head unit in a window

The pulled unit (`I_21w12.2-1-4`, [knowledge/bench.md](../../knowledge/bench.md))
booted whole in a QEMU VM on Windows: its own systemd, Winston, the HMI
(`HmiMain3D`) and the services that don't need the car's hardware. The
centre screen (1920x720) is the VM's window; the mouse is its touchscreen.

## Where it stands (2026-11-07)

- **Shows:** a clean boot reaches the HMI's home screen in English in about
  3 minutes: the main menu (MEDIA, COM, NAV, CAR, APPS), the status bar,
  drawn by `HmiMain3D` (RAMSES) through Winston on llvmpipe. The first boot
  on a fresh disk may show the "Component protection" pop-up (the unit sees
  none of its car); it is gone once closed or after the next HMI start.
- **The car is played by [carsim](carsim/carsim.js)** ("Stand-in services"
  below): lifecycle, vehicle condition (PWF Wohnen), key, vehicle (units,
  language), the iDrive controller. With them the HMI leaves "not in use"
  (`PWF change Parken -> Wohnen`) and gets a display language.
- **No input yet:** carsim offers the controller (FrontCCU, 0xB508) and
  takes commands (`echo press > /run/carsim/ctl`), and the HMI sees the
  service (`[CCS] onFrontProxyAvailabilityStatus available`), but it never
  subscribes to its events: `[CCS] Cannot set configuration: (pu, active
  front active fond, alive)=(1, 1, 0, 0)`. Something else has to say the
  controller is alive (next to find). Touch: `HmiMain3D` has no `wl_touch`
  code; on the car touch comes over SOME/IP too. A tap does reach Winston
  (`input = /dev/input/tap2touch`).
- **The HMI's test interface** (`HmiTest`, SOME/IP 0xB066, `sendCommand`;
  [hmitest.js](hmitest.js)): registered, root allowed to call it, still no
  answer.
- **What's missing against the car** (its `ps`, `car-state.txt`):
  `ipcServer` (`hdlc_ipc4`, the SPI link to the IOC), `ioclcproxy`, and what
  needs the keystore device (`dev-keystore.device`): `persod`,
  `CodingShmApp`, `oapcontroller`.
- Logs: the HMI's application log is in the journal (DLT local print, the
  hmi drop-in); the in-RAM journal rotates within minutes, `journal.log` on
  the host keeps everything.

## Stand-in services (carsim)

On the car the HMI's car data comes from the IOC (through ioclcproxy and
SignalGateway) or other ECUs over SOME/IP. [carsim.js](carsim/carsim.js)
serves the ones the HMI waits for with the unit's own `/usr/lib/someip.node`
(`registerService(cfg, instance, impl)`, `impl[method]()`, `impl[field] =
{getValue, setValue}`, `service.fire(field, value)`; enums by name):

| service | id | what carsim sets |
|---|---|---|
| Lifecycle (`Front`) | 0xB015 | `powerStateDetailed` FULL_ON_USER_ON |
| VehicleCondition | 0x1531 | PWF `WOHNEN` (`--pwf`), qualifier valid, alive counter each second |
| Key | 0x5535 | defaults |
| Vehicle | 0xB510 | units / language (`--lang`), stores what the HMI sets |
| FrontCCU (the controller) | 0xB508 | turn / press / tilt / buttons from `/run/carsim/ctl` |

- The interface JSONs are made by `build-image.sh` from the unit's catalog
  (`/etc/oap/someip/someip-interfaces.json`, 591 interfaces) with
  `tools/someip_iface.py ... gen <interface> "" X.json`, into the disk only
  (BMW definitions: git-ignored, never committed).
- **vsomeip security is checked in the serving process, against that
  process's own policy file** (`/etc/vsomeip/<uid>_<gid>/vsomeip_security.json`):
  carsim runs as root, whose file didn't let the HMI (uid 5000) call
  anything of carsim's (`isn't allowed to send a request ... ~> Skip
  message!`, seen only with `DLT_LOCAL_PRINT_MODE=FORCE_ON` on carsim).
  [policy.js](carsim/policy.js) adds the entries at boot (from `*.orig`).
- **The display language** is the HMI's choice, confirmed by the car:
  `HMIControl.selectLanguage` -> `CDevCarLanguageCa::setDisplayLanguage` ->
  `Vehicle.newCurrentUnitsConfigExt` (setter 107). carsim selects `--lang`
  whenever `HMIContext.currentDisplayLanguage` is `KEINE_SPRACHE`; the HMI
  keeps it in `/var/opt/public/hmi`.
- `var-opt-ro.service` is masked: it remounted `/var/opt` read-only at boot,
  which here is the root disk (no saved state, nothing writable).
- [someip-call.js](someip-call.js) `IFACE.json INSTANCE get|set|call NAME [JSON]`
  pokes any service by hand (in the VM: `/usr/lib/mgu-emu/iface/`:
  HMIContext, HMIControl, DiagHMI).

**No BMW bytes in this repository.** The disk is built from the pull into
`../idrive-rootfs/<version>/emu/` and the docker volume `mgu-emu-root`.

## What it needs

- QEMU for Windows (`winget install SoftwareFreedomConservancy.QEMU`) and the
  Windows Hypervisor Platform (WHPX). WSL's own KVM does not work on this PC
  (AMD, VBS on: WSL gets "Nested features: 0x0" even with
  `nestedVirtualization=true`).
- Docker (the kernel, the disk).
- The Mesa llvmpipe build of [gpu-bench](../gpu-bench/README.md)
  (`build/swrast/`): Winston and the HMI draw with it (`kms_swrast`), since
  nothing emulates the unit's i965 GPU.
- The pull: `rootfs.tar` ([re/pull_unit.sh](../../re/pull_unit.sh)) and
  `hmidata.tar`, what the HMI loads that the root file system lacks
  (read-only on the unit, ~850 MB):

  ```sh
  ssh root@<unit> 'cd / && tar -cf - mnt/dataro/dataro1/hmi mnt/dataro/dataro1/ent \
      mnt/dataro/hddata/hmi/iba1/IBA-DATA-LK-3.squashfs var/sys var/opt/hdshare/hmi \
      dev/shm/rawcodingdata' > ../idrive-rootfs/20.40.2/hmidata.tar
  ```

  Optional, the HMI's saved state (`build-image.sh` loads it when present;
  2.6 MB):

  ```sh
  ssh root@<unit> 'cd / && tar -cf - var/opt/public/hmi var/opt/public/sps' \
      > ../idrive-rootfs/20.40.2/persist.tar
  ```

  Not pulled: the maps (`hddata/nav`, 30 GB), speech (`dataro1/spe`, 4.7 GB),
  the owner's manual videos.

## Use

```sh
sh tools/mgu-emu/kernel/build.sh     # once: Linux 6.6 for the VM -> build/bzImage
sh tools/mgu-emu/build-image.sh      # the disk -> ../idrive-rootfs/20.40.2/emu/mgu.qcow2
```

```powershell
powershell -File tools\mgu-emu\run.ps1          # a fresh boot each time
powershell -File tools\mgu-emu\run.ps1 -Keep    # keep the last run's disk changes
```

- Shell: `telnet 127.0.0.1 4552` (the unit's own serial getty, root).
- SSH: `ssh -p 2222 -i tools/mgu-emu/build/emu_key root@127.0.0.1`.
- Logs on the host: `emu/console.log` (kernel), `emu/journal.log` (the whole
  journal, forwarded to the second serial port: readable after a crash).
- A reboot or power-off inside the VM ends QEMU (`-no-reboot`) instead of
  looping.
- A tap without the mouse: `ssh ... node /usr/lib/mgu-emu/tap.js X Y`
  ([tap.js](tap.js), screen pixels).
- Winston logs to DLT once DLT is up (not the journal). To see it, run it by
  hand without the plugin: `--param "plugin=drm-output, notify, genivi"
  --param stdlog-level=3`.
- Rebuilding the disk while the VM runs leaves `mgu.qcow2.new`; `run.ps1`
  swaps it in at the next boot.

## How the disk differs from the car

- The eMMC partitions (`/mnt/dataro`, `/var/opt`, `/var/sys`) are
  directories under `/emu`, bind-mounted by [our fstab](overlay/etc/fstab), so
  the targets requiring their mount units still start. `/var/opt` holds only
  `hdshare/hmi`: no Store apps, no personal data.
- `codingshm.service` is [ours](overlay/etc/systemd/system/codingshm.service):
  it copies the car's pulled `rawcodingdata` to `/dev/shm` (the real
  CodingShmApp needs the keystore device).
- Winston drives `Virtual-1` (virtio-gpu) instead of `HDMI-A-1`
  ([drop-in](overlay/etc/systemd/system/winston.service.d/emu.conf)); the
  kernel line adds the 1920x720 mode (`video=Virtual-1:1920x720@60`: QEMU's
  GTK window otherwise makes 640x480 the preferred mode), and `-vga none`
  keeps q35's default VGA card from taking the window.
- [eglfix](eglfix/eglfix.c), preloaded into Winston: Winston takes the first
  EGL config and makes its GBM surface ARGB8888. On llvmpipe the first config
  is another format (`EGL_BAD_MATCH`, "No output was setup"), and
  virtio-gpu's plane scans out XRGB8888 only (atomic commit `EINVAL`). The
  shim puts the XRGB8888 configs first and makes the surface XRGB8888. It
  finds the real functions with `dlopen(..., RTLD_NOLOAD)`: Winston loads
  `drm-output.so` with local scope, so `RTLD_NEXT` returns NULL (a segfault
  at address 0, its core dump taking 30 s to write).
- [tap2touch](tap2touch/tap2touch.c) turns QEMU's tablet (where Windows sends
  the mouse) into a one-finger touchscreen through uinput: Winston takes touch
  only. A real touchscreen on the host goes to `virtio-multitouch` directly.
- Masked (`build-image.sh`): what restarts the unit (recmgr, crashhandler),
  what needs its hardware (IOC link, AVB, APIX display controller, HDCP,
  Wi-Fi/BT, the i915 module), and Store tools whose binaries are in the real
  `/var/opt`. There is no IOC, no other ECU, no SOME/IP peer: the iDrive
  controller, vehicle data and anything from the car's network are absent.
- The hardware watchdog is off and the journal goes to the serial port
  ([system.conf.d](overlay/etc/systemd/system.conf.d/emu.conf)).
