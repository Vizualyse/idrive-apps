#!/bin/sh
# Builds the emulator's kernel (bzImage) in a container: Linux 6.6 LTS,
# x86_64 + KVM-guest defconfig with everything the VM needs built in (no
# initramfs, no modules). Run from anywhere:
#
#   sh tools/mgu-emu/kernel/build.sh        # -> tools/mgu-emu/build/bzImage
#
# The source tree and objects stay in the docker volume mgu-emu-kbuild, so a
# rebuild after a config change only recompiles what changed.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
OUT="$HERE/../build"
mkdir -p "$OUT"
KVER=${KVER:-6.6.58}

w() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

docker volume create mgu-emu-kbuild >/dev/null
MSYS_NO_PATHCONV=1 docker run --rm \
    -v mgu-emu-kbuild:/k \
    -v "$(w "$HERE"):/cfg:ro" \
    -v "$(w "$OUT"):/out" \
    -e KVER="$KVER" \
    debian:bookworm sh -eu -c '
apt-get -qq update >/dev/null
apt-get -qq install -y --no-install-recommends build-essential bc bison flex libelf-dev libssl-dev \
    curl ca-certificates xz-utils cpio kmod >/dev/null
cd /k
if [ ! -d linux-$KVER ]; then
    curl -fsSL https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$KVER.tar.xz | tar -xJ
fi
cd linux-$KVER
make -s x86_64_defconfig
make -s kvm_guest.config
scripts/kconfig/merge_config.sh -m .config /cfg/emu.config >/dev/null
make -s olddefconfig
# every option in emu.config must have stuck (a missing dependency drops it silently)
grep -E "^CONFIG_" /cfg/emu.config | while IFS= read -r l; do
    grep -qx "$l" .config || { echo "config did not stick: $l"; }
done
make -s -j"$(nproc)" bzImage
cp arch/x86/boot/bzImage /out/bzImage
cp .config /out/kernel.config
echo "built $(make -s kernelrelease)"
'
ls -la "$OUT/bzImage"
