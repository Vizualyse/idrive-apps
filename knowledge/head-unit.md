# The head unit

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- x86-64 Linux, kernel 4.14, Intel Atom A3960 (4 cores), about 5.6 GB RAM,
  Node 8.16 for apps. The root filesystem is read-only; `/var/opt` is
  writable (9 GB free) and is where Store tools live.
- The journal is in RAM (`/var/log` -> `volatile/log`): nothing survives a
  restart, and it can rotate within minutes. Anything you need after a crash
  has to be written to `/var/opt` (or `/run` for one boot).
- A `var-opt-ro` drop-in (run just before `/var/opt` goes read-only) was
  missed at the first `systemctl reboot` after it was installed, and ran at
  later ones. Don't rely on a clean-shutdown mark alone to detect a crash;
  watch the service instead. Whether it runs at a real switch-off is not yet
  checked.
- The debug image regenerates its SSH host key at every boot: expect SSH's
  "host identification has changed" after each restart, and check the new
  fingerprint before accepting it.
- An unlisted program that dumps core can make the crash handler restart the
  head unit. Run hand-started test processes with `RLIMIT_CORE=1`; Store
  tools get it from the deploy tool's drop-in.
- **Stopping a systemd service that is not on recmgr's whitelist restarts
  the head unit** (`/etc/recmgr.ini`: EnableWhitelistRestartList and
  EnableExitSuccessWhitelist; an orderly shutdown, no core dump, nothing in
  the journal from recmgr itself). Store tools are listed through
  `component.json` `"recmgr"` (mgu-deploy writes the list at boot,
  `/var/opt/mgu-deploy/recmgr-at-boot.json`). A hand-made trial unit (e.g. in
  `/run/systemd/system`) must not be stopped or restarted: four restarts on
  2026-11-05 until this was found.
- Firewall: nftables `ip filter input` ends in a drop. New ports from the
  phone's hotspot (`wlan0`) need a rule; an inserted rule is in memory only.
- The dynamic loader is `/lib/ld-linux-x86-64.so.2`; there is no `/lib64`.
  An executable linked on a stock distro (which asks for `/lib64/...`) fails
  with "not found"; link with `-Wl,--dynamic-linker=/lib/ld-linux-x86-64.so.2`.
  Shared libraries (hook111) and static binaries (ffmpeg) are not affected.
- No `systemd-run`, BusyBox `ps` / `ip` (no `ip rule`), no `getent`. A unit
  file in `/run/systemd/system/` is a trial that is gone at reboot.
- Store apps run each as their own uid (`/var/opt/public/oap/oap_<uid>/`,
  primary group = that uid), all in the group `tm_oap_app` (12202): a socket
  in that group is open to every app. Give a tool's socket its app's own
  group (found by the package name in `oap_<uid>/source/package.json`).
- `nft` prints well-known ports by name (`tcp dport ssh`, not `22`). The
  MGU-SSH firewall keeper matched the number, so it added a duplicate rule
  every 15 s (641 per chain); fixed locally to match both spellings.

## From the reference repos

Not yet seen on ours ([reference-repos.md](reference-repos.md)).

- **How the unit goes down:** recmgr or crashhandler ask NSM for a fast shutdown, which runs `var-opt-ro.service`, then the IOC resets the SoC; services get no SIGTERM. Records: `/var/opt/public/sin/{recmgr,crashhandler}/restartInfo.xml`. *(ref: upstream `native/waze-on-cluster/patch/PATCH.md:699-711`)*
- **Restart with `/usr/bin/nsm_control --requestRestart 7 --normal`, not `systemctl reboot`** (which stops BMW services with SIGABRT and doesn't run `var-opt-ro.service`, matching the missed drop-in above). It exits 0 even when refused, printing `[Error. …]`. recmgr answers repeated failed starts with a data wipe. *(ref: upstream PATCH.md:384; mgu-store `native/mgu-updater/README.md:658-691`)*
- **A core dump reboots the unit** unless the executable's name is on crashhandler's whitelist, `/etc/crashhandler-restartlist.conf`; `component.json` `"crashNames"` adds names, shipped ELFs are listed automatically. *(ref: mgu-store `deploy/README.md:1428-1467`)*
- **oapcontroller:** a third death of MainApp's node child within ~33 s of a respawn deletes every installed app, its data and MainApp's data. Never stop `oapcontroller`. *(ref: mgu-store `deploy/README.md:1074-1096`)*
- **Restarting `hmi.service` reboots the unit** (the HMI aborts, the crash monitor reboots; two cars). **Stopping or killing a renderer with apps' surfaces up can too** (hence `"keepRunning"`). Clearing all fault codes can too. *(ref: idrive7-apps, mgu-store)*
- `carplay`: SIGTERM makes it dump core (restart); any failed end runs `OnFailure=mediaddpserver_kill`, which restarts the unit; SIGKILL only with a `SuccessExitStatus=SIGKILL` drop-in loaded and carplay whitelisted at this boot. *(ref: upstream PATCH.md:319-347)*
- `--arm-debug` invalidates the MyBMW login and personal settings; a hard reset is the volume knob held ~25 s; MainApp starts only with valid non-default coding (`/dev/shm/rawcodingdata`); a firmware update wipes units, drop-ins and the recmgr / crash-list entries. *(ref: mgu-store `deploy/README.md:96-106`)*
- The journal held about 4 minutes on upstream's car. An OAP app's own log goes to DLT. Firmware line: `/etc/os-release-id-dlt`.
- systemd 237: `DefaultStandardOutput=null` (a unit needs `StandardOutput=journal`); `User=` is refused for a uid with no passwd entry; `BindReadOnlyPaths=` fails the unit while the file is missing. Every Store tool service gets `StartLimitIntervalSec=600`, `Burst=20`, `LimitCORE=1`. No TUN in the kernel. Linux is suspended while the car sleeps. *(ref: IterioDev, mgu-store)*
- cgroup v1 limits work in units (upstream `native/waze-on-cluster/systemd/waze-on-cluster-journal.service`): the way to cap a big process (Chromium).
- GPU: Intel HD Graphics 505 (Gen9, Broxton, `8086:5a84`), 18 execution
  units, up to 750 MHz (Intel's spec for the A3960), about 0.2 TFLOPS: memory
  shared with the CPU. Games on the car were GPU / memory bound rather than
  CPU bound once Steam 0.1.10 held frames to 30 (the user's test, 2026-11-08).
- Mesa 19.0.6 with only the old `i965` GL driver, no Vulkan (the image's;
  Steam ships its own ANV 19.0.6: [games.md](games.md)); render node
  group `video` = gid 44 (from the rootfs: [browser.md](browser.md)).
- Groups: `video` (the DRI render node), `mgu_wayland` (Winston's Wayland, `/run/wayland/wayland-0`, `root:mgu_wayland 0770`), `mgu_ufipc` (AVB), `tm_oap_app` (every app), `hmi_resourceaccess` 5001. MainApp's app uids: 12203-12450 and 12453-12700.
- A native GL client can get onto the centre screen through Winston: root, `Group=mgu_wayland`, `XDG_RUNTIME_DIR=/run/wayland`, an `ivi_application` surface + `wl_egl_window`, an `ivi_controller` layer on the lowest-id screen (centre). The HMI is ivi surface/layer 100; HmiMain3D has its own compositor at `wayland-1`. *(ref: idrive7-apps `deploy/mgu-app-install.sh:451-478`)*
- Radios differ: Broadcom bcmdhd (`wlan0`) or NXP 88W9098 (`wlan1`). Another car (P18 firmware) had a writable ~90 GB `/var/opt/hdshare` on a 2.5" disk.
- Others test in head-unit emulators: mgu-store's private `mgu-emulator` (a Lima VM with the real HmiMain3D / Winston), IterioDev's QEMU VM.
