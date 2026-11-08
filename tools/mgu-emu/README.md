# mgu-emu: the head unit in a window

The pulled unit (`I_21w12.2-1-4`, [knowledge/bench.md](../../knowledge/bench.md))
booted whole in a QEMU VM on Windows: its own systemd, Winston, the HMI
(`HmiMain3D`) and the services that don't need the car's hardware. The
centre screen (1920x720) is the VM's window; the mouse is its touchscreen.

## Where it stands (2026-11-08)

- **Shows:** a clean boot reaches the HMI's home screen in English in about
  3 minutes: the main menu (MEDIA, COM, NAV, CAR, APPS), the status bar,
  drawn by `HmiMain3D` (RAMSES) through Winston on llvmpipe. The first boot
  on a fresh disk may show the "Component protection" pop-up (the unit sees
  none of its car); it is gone once closed or after the next HMI start.
- **The car is played by [carsim](carsim/carsim.js)** ("Stand-in services"
  below): lifecycle, the centre display's monitor, vehicle condition (PWF
  Wohnen), key, vehicle (units, language), the iDrive controller. With them
  the HMI leaves "not in use" (`PWF change Parken -> Wohnen`), gets a
  display language and takes touch.
- **Touch works:** a click in the window is a tap on the centre screen (a
  drag a swipe), through the HMI's own touch path ("Touch" below).
- **The controller works, on the window's keyboard** ("The controller"
  below): carsim offers it (FrontCCU, 0xB508) and the HMI takes it since
  carsim's SOME/IP policy let it subscribe (`[CCS] Sending
  CHmiControllerEvent`). The arrow keys turn and tilt, Enter pushes,
  Backspace / Esc are BACK: the whole HMI and the Store's page.
- **The HMI's test interface** (`HmiTest`, SOME/IP 0xB066, `sendCommand`;
  [hmitest.js](hmitest.js)): registered, root allowed to call it, still no
  answer.
- **The app platform and the Store work** (2026-11-08, "The Store" below):
  oapcontroller and MainApp run on a software keystore, MainApp installs
  apps (the stock ones and ours), mgu-store installs with its own installer,
  the uplink is online through a second network card, and the updater
  installs apps from GitHub through it, from our fork
  (`Vizualyse/idrive-apps`) too. The Store's page draws (blank at first on
  2026-11-08, drawn later the same day without a change of ours); its touch
  does not work (mgu-render's nft rule fails to load).
- **What's missing against the car** (its `ps`, `car-state.txt`):
  `ipcServer` (`hdlc_ipc4`, the SPI link to the IOC), `ioclcproxy`,
  `CodingShmApp` (the pulled coding stands in), eCryptfs for
  `/var/opt/public` and `personal` (plain folders here).
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
| Monitor (`Front`, the CID) | 0xFA61 | display on, monitor ready, picture visible (else the HMI drops touch) |
| VehicleCondition | 0x1531 | PWF `WOHNEN` (`--pwf`), qualifier valid, alive counter each second |
| Key | 0x5535 | defaults |
| Vehicle | 0xB510 | units / language (`--lang`), stores what the HMI sets |
| FrontCCU (the controller) | 0xB508 | turn / press / tilt / buttons from the keyboard and `/run/carsim/ctl` |

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

## The controller

carsim fires FrontCCU's `statusRotaryEncoderState` (turn, push, tilt) and
`statusPushButtonsState` (the eight buttons) on input only. The HMI turns
them into `CHmiControllerEvent`s (`[CCS]` in its log); the Store's page,
while it has the HMI's focus, follows them too.

| key in the QEMU window | controller | carsim command |
|---|---|---|
| Left / Right (held: repeats) | turn one detent | `rot -1` / `rot 1` |
| Enter (held 0.8 s or more: long) | push | `press` / `longpress` |
| Up / Down | tilt north / south | `tilt N` / `tilt S` |
| Shift+Left / Shift+Right | tilt west / east | `tilt W` / `tilt E` |
| Backspace / Esc | BACK | `button 2` |
| F1..F8 | the buttons | `button 1` .. `button 8` |

- carsim reads `QEMU Virtio Keyboard` (`event2`) itself, without a grab:
  nothing else in the VM reads it (Winston reads only tap2touch's device).
  `--keys none` turns it off, `--keys NAME` reads another input device.
- By hand, in the VM: `echo "rot 1" > /run/carsim/ctl`.
- **The buttons** (found by firing each one): button 2 is BACK (the HMI
  walks back through its screens; keycode 2, which CarPlay hooks too). The
  others switch screens (MEDIA, COM and the like); their keycodes, read
  while the HMI lagged, were about 1, 3, 6, 4, 7, 17 for buttons 1, 3, 4, 5,
  6, 7, and none for 8. Not named yet.
- A carsim restart sets the turn position to 0: the HMI takes the jump as
  one big turn (`old position=32767`) and the focus moves once.
- Keys typed into the window from a script need the virtual-key code as
  well as the scan code (`SendInput`); QEMU's GTK window drops
  `SendKeys`' Esc, Enter and letters.

## Touch

`HmiMain3D` has no Wayland touch: on the car the centre display (CID) sends
its touch over Ethernet (vlan73; `touchactivator` keeps the link up with ARP)
as AUTOSAR PDUs in UDP to the HMI's `hmitouch::CTouchDataClient`, which
listens on `0.0.0.0:30567` (`Starting to listen on socket` in its log).

- **The format** (disassembly of `processSocketStream` and
  `decodeTouchScreenPduData`; [cidtouch.js](cidtouch.js) has it byte by
  byte): a 16-byte big-endian header with the PDU id (`0xB0048002`: the
  touchscreen; `0xB509...`, `0xB530...`: the controller's touchpad), then 96
  bytes, of which the HMI reads the second half of each 8-byte word. Up to 5
  fingers of X, Y (screen pixels), Z, type, event (1 down, 2 held, 3 up) and
  touch id. Several PDUs may share a datagram.
- **The gate** that kept taps from doing anything although the client
  decoded them (`Touch data: src=1 ... send=true` at info level):
  `CHmiHomeTouchHandling::touchEvent` drops CID touch when the coding
  feature `CID_HMI_ACTIVATION_VIA_TOUCH` (HMI_SPEECH, off on this car) is off
  and `IHmiDisplayService` says the CID is off. The display service follows
  `CDevCarMonitor`, the proxy of the lifecycle `Monitor` service, which the
  display controller offers on the car (masked here). carsim's Monitor with
  `userMonitorControl` DISPLAY_ON and `statusPicture` PICTURE_IS_VISIBLE
  turns it on (`monitorOn=1`, `hideBlackscreen`).
- [tap2touch](tap2touch/tap2touch.c) sends the mouse there: down, held
  every 20 ms and while dragging, up. By hand:
  `node /usr/lib/mgu-emu/cidtouch.js tap X Y`.
- **How it was found:** strings, then `objdump` of the stripped binary
  around the code that loads each log string, then `gdbserver` (Ubuntu
  18.04's, run through the unit's `/lib/ld-linux-x86-64.so.2`) attached to
  `HmiMain3D` for breakpoints that print and continue, with `gdb` in a
  container (`target remote | ssh ... gdbserver --attach - PID`). Detach
  within the HMI's 30 s watchdog. The HMI's debug log stays off:
  `DLT_INITIAL_LOG_LEVEL` changes nothing, dlt-daemon has no TCP port here,
  and a set-log-level message on `/run/dlt-files/dlt-ctrl.sock` made it exit
  (`systemctl start dlt` brings it back).

## The Store (mgu-store) and the uplink

Installed with upstream's own installer, against the VM as against a car:

```sh
node mgu-install.js first-install --identity tools/mgu-emu/build/emu_key \
    --host 127.0.0.1 --port 2222 --ssh-opt StrictHostKeyChecking=no \
    --ssh-opt UserKnownHostsFile=/dev/null --no-restart-prompt
```

then a restart (`poweroff` in the VM, `run.ps1 -Keep`: without `-Keep` the
next boot starts from the built disks). It ends with "Setup is done": all
seven components, the Store's tile in APPS > Installed apps, the updater
reading its four sources through the uplink, and
`node /var/opt/mgu-updater/current/updater.js install <id>` installing an
app (gforce 1.6.20 from idrive7-apps). Each boot after takes ~4 minutes to
MainApp.

What the car has and the emulator had to be given, in the order they block:

- **The keystore** (`/dev/keystore`, Intel IAS): oapcontroller, cadaemon,
  persod, necemad and MainApp's keychain script make their keys with it
  (`libmgucrypto`). [keystore/kspreload.c](keystore/kspreload.c) replaces
  the 12 `ias_keystore_*` client functions libmgucrypto calls through its
  PLT (signatures from its disassembly): keys wrapped with a fixed emulator
  key (AES-256-GCM, the unit's libgcrypt). It is in `/etc/ld.so.preload`,
  since oapcontroller starts MainApp through `uidrun`, which clears the
  environment. `99-emu-keystore.rules` aliases `/dev/zero` as the device
  systemd waits for.
- **Devices early**: the unit's full udev coldplug runs after
  `early.target`, past systemd's 90 s for a device; `/dev/keystore` and
  the `/var/opt` disk would time out and take their users down
  ([emu-early-devices.service](overlay/etc/systemd/system/emu-early-devices.service)).
- **MainApp's stock `main.js`**: on the car the Store's deploy tool
  bind-mounts its "fallback" copy over it, so the pull holds the copy and
  the installer refuses it. [mainapp/unfallback.js](mainapp/unfallback.js)
  takes out the snippets mgu-deploy 0.7.16's `fallback_build.js` put in and
  proves the result (built again it gives the car's file byte for byte).
- **`/var/opt` on its own disk with quotas** (`opt.qcow2`, vdb): MainApp gives
  an app a uid only when `repquota /var/opt` answers, which quota-tools never
  do for a bind mount ("No free user Ids left").
- **`/var/opt`'s folders**: the unit's tmpfiles runs for it are conditioned
  on the car's partition layout (hdshare a mount point) or a factory reset;
  [emu-var-opt.service](overlay/etc/systemd/system/emu-var-opt.service)
  applies the unit's own tmpfiles.d (MainApp dies without
  `hdshare/oap/hu`).
- **No eCryptfs**: `persistencydecryptiontool` mounts `/var/opt/public` and
  `personal` encrypted on the car; here it emptied `public` at every boot
  (a new key, nothing mounted), so every app was gone at the next start. Its
  two units are no-ops (drop-ins); the folders stay plain.
- **The HMI first**: MainApp initializes only once the HMI is up, and
  oapcontroller counts a MainApp that does not as a crash (three wipe every
  app): oapcontroller starts after `hmi.service` (drop-in), and the HMI may
  take 5 minutes to report ready.
- **carsim's SOME/IP policy**: the unit's vsomeip took our allow-all entry
  for nobody (string uid ranges), and judges a uid with a policy of its own
  only by that: MainApp's Vehicle units getter timed out ("Cannot
  initialize oap-mainapp"), and the HMI got none of carsim's data either.
  [policy.js](carsim/policy.js) has the rules.
- **Our fork as a source**: the build seeds
  `/var/opt/mgu-updater/updater.local.conf` with `default_sources`, the
  upstream three plus `Vizualyse/idrive-apps:releases`. The updater reads
  `sources.json` only when it starts, and adds each default source once
  (`state/default-sources.json`), here as `s-xxxx` (the name `idrive-apps`
  is upstream's). No id clashes: our catalog lists only `vizualyse-*`
  (and the old `vizualyse_*` apps) and hook111 (an id two sources list
  would show beside as `<id>2`). A requirement comes from the requiring
  source, else the first that has it: vizualyse-moonlight took
  cluster-render 0.4.2 from upstream's.
- **The uplink**: run.ps1 gives the VM two user networks. eth0 is SSH only
  (`restrict=on`, no way out, as root on the car); eth1 (10.0.3.0/24, a
  subnet of its own: two networks both leasing 10.0.2.15 break SSH) is
  unmanaged, and mgu-uplink takes it (`uplink = netdev:eth1`,
  seeded in `/var/opt/mgu-uplink/mgu-uplink.local.conf` by the build).
  `/run/mgu-uplink/status.json` says `online` with a lease from QEMU.

Debugging MainApp: its output goes to oapcontroller through a pipe and its
log to DLT only (the DLT daemon here has no TCP port and no offline trace).
A throwaway preload that, in MainApp's process only, sends stdout to a file
and sets `DLT_LOCAL_PRINT_MODE=FORCE_ON` shows its whole log.

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
sh tools/mgu-emu/build-image.sh      # the disks -> ../idrive-rootfs/20.40.2/emu/mgu.qcow2, opt.qcow2
```

```powershell
powershell -File tools\mgu-emu\run.ps1          # a fresh boot each time
powershell -File tools\mgu-emu\run.ps1 -Keep    # keep the last run's disk changes (the Store, apps)
powershell -File tools\mgu-emu\run.ps1 -Display 'gtk,zoom-to-fit=on,show-cursor=on'   # the Windows cursor stays visible
```

- Shell: `telnet 127.0.0.1 4552` (the unit's own serial getty, root).
- SSH: `ssh -p 2222 -i tools/mgu-emu/build/emu_key root@127.0.0.1`.
- Logs on the host: `emu/console.log` (kernel), `emu/journal.log` (the whole
  journal, forwarded to the second serial port: readable after a crash).
- A reboot or power-off inside the VM ends QEMU (`-no-reboot`) instead of
  looping.
- The controller: the arrow keys, Enter and Backspace in the window ("The
  controller").
- Our tools: `node /var/opt/mgu-updater/current/updater.js install
  vizualyse-chromium`, then a restart (`poweroff`, `run.ps1 -Keep`).
- A tap without the mouse: `ssh ... node /usr/lib/mgu-emu/tap.js X Y`
  ([tap.js](tap.js), screen pixels, through QEMU's tablet like the mouse), or
  straight to the HMI: `node /usr/lib/mgu-emu/cidtouch.js tap X Y`.
- Winston logs to DLT once DLT is up (not the journal). To see it, run it by
  hand without the plugin: `--param "plugin=drm-output, notify, genivi"
  --param stdlog-level=3`.
- Rebuilding the disks while the VM runs leaves `mgu.qcow2.new` and
  `opt.qcow2.new`; `run.ps1` swaps them in at the next boot (and drops
  `-Keep`: a new disk means a fresh start).

## How the disk differs from the car

- The eMMC partitions `/mnt/dataro` and `/var/sys` are directories under
  `/emu`, bind-mounted by [our fstab](overlay/etc/fstab), so the targets
  requiring their mount units still start. `/var/opt` is a disk of its own
  (vdb, user and group quotas: "The Store") holding only `hdshare/hmi`,
  the HMI's saved state and the uplink's setting: none of the car's Store
  tools or apps, no personal data.
- The car's Store tools left units and drop-ins in `/etc` (mgu-updater,
  mgu-uplink, mgu-render, app-privacy, idrive7-renderd, ...) for binaries in
  its `/var/opt`: the build removes them, so the Store installs as on a
  unit that never had it.
- `codingshm.service` is [ours](overlay/etc/systemd/system/codingshm.service):
  it copies the car's pulled `rawcodingdata` to `/dev/shm` (the real
  CodingShmApp needs the keystore device).
- The keystore, eCryptfs and the boot order of the app platform: "The Store".
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
  the mouse) into the CID's touch frames for the HMI ("Touch" above) and into
  a one-finger touchscreen through uinput for Winston (Wayland clients; the
  HMI reads none). QEMU splits the mouse: motion goes to the tablet, the
  buttons to `virtio-multitouch` (it lists BTN_LEFT too), so tap2touch reads
  both, and takes a real host touchscreen's contacts from the latter.
  `tap.js` writes the button into the tablet itself, so it works either way.
- Masked (`build-image.sh`): what restarts the unit (recmgr, crashhandler),
  what needs its hardware (IOC link, AVB, APIX display controller, HDCP,
  Wi-Fi/BT, the i915 module). There is no IOC, no other ECU, no SOME/IP
  peer: carsim stands in for what the HMI and MainApp wait for; anything
  else from the car's network is absent.
- The hardware watchdog is off and the journal goes to the serial port
  ([system.conf.d](overlay/etc/systemd/system.conf.d/emu.conf)).
