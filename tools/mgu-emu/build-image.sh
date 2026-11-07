#!/bin/sh
# Builds the emulator's disk from the pulled unit:
#
#   sh tools/mgu-emu/build-image.sh [<rootfs dir>]
#
# <rootfs dir> (default ../idrive-rootfs/20.40.2) holds rootfs.tar
# (re/pull_unit.sh) and hmidata.tar (the HMI's data, README "Pulling").
# Writes <rootfs dir>/emu/mgu.qcow2, outside the repository: it holds BMW
# binaries and the car's coding.
#
# The unpacked unit stays in the docker volume mgu-emu-root (owners kept;
# never on the Windows drive). Delete it to re-unpack after a new pull:
# docker volume rm mgu-emu-root.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
TOOLS=$(cd "$HERE/.." && pwd) # tools/someip_iface.py
SRC=$(cd "${1:-$HERE/../../../idrive-rootfs/20.40.2}" && pwd)
OUT="$SRC/emu"
MESA="${MESA:-$HERE/../gpu-bench/build/swrast}"
mkdir -p "$OUT" "$HERE/build"

w() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

[ -f "$MESA/swrast_dri.so" ] || {
    # the main checkout's gpu-bench build (worktrees share the docker images, not build/)
    MESA="$HERE/../../../idrive-apps/tools/gpu-bench/build/swrast"
}
[ -f "$MESA/swrast_dri.so" ] || { echo "no Mesa swrast build: sh tools/gpu-bench/build.sh" >&2; exit 1; }

# eglfix is preloaded into the unit's Winston: build it against glibc 2.27
# (the unit's), so it asks for no newer symbol versions.
MSYS_NO_PATHCONV=1 docker run --rm -v "$(w "$HERE"):/m" ubuntu:18.04 sh -eu -c '
apt-get -qq update >/dev/null && apt-get -qq install -y --no-install-recommends gcc libc6-dev >/dev/null
gcc -O2 -Wall -shared -fPIC -o /m/build/eglfix.so /m/eglfix/eglfix.c -ldl'

docker volume create mgu-emu-root >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm \
    -v mgu-emu-root:/root-fs \
    -v "$(w "$SRC"):/src:ro" \
    -v "$(w "$HERE"):/emu-src:ro" \
    -v "$(w "$TOOLS"):/tools:ro" \
    -v "$(w "$MESA"):/mesa:ro" \
    -v "$(w "$HERE/build"):/build" \
    -v "$(w "$OUT"):/out" \
    debian:bookworm sh -eu -c '
apt-get -qq update >/dev/null
apt-get -qq install -y --no-install-recommends e2fsprogs qemu-utils gcc libc6-dev openssh-client python3 >/dev/null

# 1. the unit, unpacked once (tar warnings about SCHILY.fflags are harmless;
#    never pipe tar into head: SIGPIPE stops it half way)
if [ ! -e /root-fs/.unpacked ]; then
    echo "unpacking rootfs.tar and hmidata.tar..."
    cd /root-fs
    tar --numeric-owner -xpf /src/rootfs.tar 2>/dev/null || true
    tar --numeric-owner -xpf /src/hmidata.tar 2>/dev/null || true
    [ -x usr/bin/HmiMain3D ] && [ -f dev/shm/rawcodingdata ] || { echo "unpack incomplete" >&2; exit 1; }
    touch .unpacked
fi

# 2. a fresh stage
echo "staging..."
S=/stage
rm -rf $S && mkdir $S
cp -a /root-fs/. $S/
rm -f $S/.unpacked
cd $S
# the saved HMI state from the car (README, Pulling), when pulled
[ ! -f /src/persist.tar ] || tar --numeric-owner -xpf /src/persist.tar 2>/dev/null || true

# the eMMC partitions become /emu/* (bind-mounted back by our fstab)
mkdir -p emu
mv mnt/dataro emu/dataro && ln -s dataro1 emu/dataro/data
mv var/sys emu/sys
mkdir -p emu/opt && mv var/opt/* emu/opt/ 2>/dev/null || true; rm -rf var/opt
mv dev/shm/rawcodingdata emu/rawcodingdata && rm -rf dev

# what the pull leaves out (it takes bin sbin lib usr etc opt var/lib only)
mkdir -p dev proc sys run tmp media home/root boot \
    mnt/dataro mnt/iba/ibaroot var/opt var/sys var/volatile var/spool var/local \
    var/cache/mapramdisk var/cache/mediaramdisk var/cache/projectedmodes var/cache/contactbook
chmod 1777 tmp
ln -sfn volatile/log var/log
ln -sfn volatile/tmp var/tmp
ln -sfn ../run var/run
ln -sfn ../run/lock var/lock
ln -sfn /mnt/dataro/hddata mnt/data
ln -sfn /var/opt/hdshare mnt/share

# 3. ours
cp -a /emu-src/overlay/. $S/
(cd /emu-src/overlay && find . -mindepth 1) | while IFS= read -r p; do chown -h 0:0 "$S/$p"; done
# Mesa 19.0.6 llvmpipe (gpu-bench): one megadriver, both entry points
install -m 0755 /mesa/swrast_dri.so usr/lib/dri/swrast_dri.so
ln -sf swrast_dri.so usr/lib/dri/kms_swrast_dri.so
install -m 0644 /mesa/libtinfo.so.5 usr/lib/libtinfo.so.5
install -D -m 0755 /build/eglfix.so usr/lib/mgu-emu/eglfix.so
install -m 0644 /emu-src/tap.js /emu-src/hmitest.js /emu-src/someip-call.js usr/lib/mgu-emu/
mkdir -p usr/lib/mgu-emu/carsim usr/lib/mgu-emu/iface
install -m 0644 /emu-src/carsim/*.js usr/lib/mgu-emu/carsim/
# interface JSONs for someip.node, made here from the unit catalog (BMW
# definitions: never in the repository)
gen() { python3 /tools/someip_iface.py etc/oap/someip/someip-interfaces.json gen "$1" "" "$2" >/dev/null; }
gen de.bmw.infotainment.hmi.hmitest.HmiTest usr/lib/mgu-emu/HmiTest.json
for i in lifecycle.lifecycle.Lifecycle:Lifecycle vehicle.Vehicle:Vehicle controlelements.FrontCCU:FrontCCU          hmi.hmicontext.HMIContext:HMIContext hmi.hmicontrol.HMIControl:HMIControl; do
    gen "de.bmw.infotainment.${i%%:*}" "usr/lib/mgu-emu/carsim/${i##*:}.json"
done
gen de.bmw.infrastructure.VehicleCondition usr/lib/mgu-emu/carsim/VehicleCondition.json
gen de.bmw.body.Key usr/lib/mgu-emu/carsim/Key.json
cp usr/lib/mgu-emu/carsim/HMIContext.json usr/lib/mgu-emu/carsim/HMIControl.json usr/lib/mgu-emu/iface/
gen de.bmw.infotainment.systemfunctions.diagnostics.job.HMI.DiagHMI usr/lib/mgu-emu/iface/DiagHMI.json
# tap2touch, static
gcc -O2 -static -o usr/bin/tap2touch /emu-src/tap2touch/tap2touch.c
# SSH: a key of the emulator'"'"'s own (build/emu_key), on sshd'"'"'s key path
[ -f /build/emu_key ] || ssh-keygen -q -t ed25519 -N "" -C mgu-emu -f /build/emu_key
mkdir -p usr/share/sshd
cat /build/emu_key.pub >> usr/share/sshd/authorized_keys.root

# 4. services: masked (reboot the unit, or need its hardware, or are Store
#    tools whose binaries live in the real /var/opt), and enabled
MASK="recmgr crashhandler crashkernel modprobe_i915 modprobe_igb_avb modprobe_inap560t modprobe_ptp modprobe_spi
 avbstreamhandler avbsourcesinkcontroller dasvideo display-controller eth-ctrl eth-ctrl_18 gptp hdlc_ipc4
 ioclcproxy ufipc_daemon vlan hdcpd hdcpmanager hddmanager zram soc-configuration-basic soc-configuration-early
 soc-configuration-late strongswan ipseccontroller nfs-export-hdd nfs-export-ramdisks wicome wicome-gpio
 wicome-genivi usbpowermonitor mgu-updater mgu-uplink mgu-deploy-verify mgu-app-fallback udev-replay-add-usb-eth
 firewalldz sshd-always-on-fw var-opt-ro
 vizualyse-cast virtual-hud1 virtual-hud2 virtual-ic1 virtual-ic2 idrive7-renderd idrive7-renderd-hmi
 mgu-render mgu-render-hmi cluster-render"
for s in $MASK; do ln -sfn /dev/null etc/systemd/system/$s.service; done
for s in mgu-render cluster-render; do ln -sfn /dev/null etc/systemd/system/$s.socket; done
mkdir -p etc/systemd/system/early.target.wants etc/systemd/system/multi-user.target.wants
ln -sfn /etc/systemd/system/tap2touch.service etc/systemd/system/early.target.wants/tap2touch.service
ln -sfn /etc/systemd/system/carsim.service etc/systemd/system/early.target.wants/carsim.service
ln -sfn /lib/systemd/system/mgu-serial-getty.service etc/systemd/system/multi-user.target.wants/mgu-serial-getty.service

# 5. the disk
echo "making the file system..."
rm -f /tmp/mgu.raw
mkfs.ext4 -q -F -L mgu-root -E root_owner=0:0 -d $S /tmp/mgu.raw 8G
qemu-img convert -O qcow2 /tmp/mgu.raw /out/mgu.qcow2.part
# a running VM holds mgu.qcow2 open (Windows): leave the new disk beside it,
# run.ps1 swaps it in at the next boot
mv /out/mgu.qcow2.part /out/mgu.qcow2 2>/dev/null || { mv /out/mgu.qcow2.part /out/mgu.qcow2.new; echo "VM running: new disk is mgu.qcow2.new (swapped in by run.ps1)"; }
rm -rf $S /tmp/mgu.raw
'
ls -la "$OUT"/mgu.qcow2*
