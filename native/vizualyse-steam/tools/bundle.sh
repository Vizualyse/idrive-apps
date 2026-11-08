#!/bin/sh
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Yousaf Khan
#
# Runs inside image/Dockerfile (build.sh starts it, the tool's folder at /m,
# the download cache at /dl): builds what the tool unpacks under
# /var/opt/vizualyse-steam on the head unit, at the paths it will have there:
#
#   build/runtime.tgz  runtime/: glibc 2.41 and its loader, every library Wine,
#                      Proton's own libraries, wl-sink and .NET load or dlopen;
#                      wl-sink; .NET and DepotDownloader (the game downloads);
#                      ALSA's configuration (Wine's sound into a FIFO, read by
#                      the tool), fontconfig's, the CA bundle.
#   build/proton.tgz   proton/: GE-Proton trimmed to what runs here (WineD3D on
#                      OpenGL, Wayland, 64-bit with new WoW64): no DXVK / VKD3D-
#                      Proton (no Vulkan on the unit's 4.14 kernel), no Mono or
#                      Gecko, no 32-bit Unix side, no text-to-speech. Every ELF
#                      program of it asks for the runtime's loader.
#   build/prefix.tgz   prefix/: the Windows prefix (Proton's "compatdata"),
#                      made here by Proton itself and wineboot: making one
#                      takes a minute on a PC, many on the Atom. Registry time
#                      stamps are zeroed so two builds give the same bytes.
#   build/launch.json  how Proton starts a game: its environment and command,
#                      captured from Proton's own launcher (the car runs no
#                      Python of ours: server.js starts Wine the same way).
#
# Why the runtime: the unit has glibc 2.27, its loader in /lib (no /lib64),
# Wayland 1.15 (Wine's Wayland driver needs >= 1.20), no fontconfig or CA
# bundle (knowledge/head-unit.md). Wine draws on the unit's OWN Mesa 19
# (libEGL, i965), linked in at run time: no GPU driver comes along (checked at
# the end), as for the browser (knowledge/browser.md).
#
# The libc patch: the unit's resolver (127.0.0.1) doesn't resolve internet
# names (knowledge/internet.md), and glibc reads only /etc/resolv.conf. The
# runtime's libc.so.6 reads /dev/shm/vzs.dns instead (same length), which the
# tool writes with the phone's DNS (mgu-uplink's lease), so DepotDownloader
# (and games) resolve through the hotspot.
#
#   sh /m/tools/bundle.sh       (in the image)
set -eu
ROOT=/var/opt/vizualyse-steam
R=$ROOT/runtime P=$ROOT/proton X=$ROOT/prefix
OUT=/m/build DL=/dl
LOADER=$R/lib/ld-linux-x86-64.so.2

GE=GE-Proton11-11
GE_SHA512=45721a7b625b2404d8896bb5e2a8b87fc9623a394873a6dd6b900c839681d5c01ec694ca00d003fc9c733c5f6c5648af8171985656f9fa47e20999fbebdbe235
DOTNET=10.0.14
DOTNET_SHA512=634326028645f38731c8c4e71a68356e4ca0d6b6607139a234ab760687f742063edaf33a1f20dda615742d2dc8300ca2ff857619d51fbb38090383b71334af89
DD=3.4.0
DD_SHA256=7419f65efb7eb16b6e56987ed1b76475f29c02475c0016166c84798388e796bc
# gbe_fork (Goldberg's Steam emulator, LGPL-3.0): its steam_api(64).dll for
# a game's "Run without Steam" (server.js), for games that quit without the
# Steam client (Slay the Spire 2: "run the game from Steam")
GBE=release-2026_09_27
GBE_SHA256=300186c34f49a9ea75b33ce2af299267cc1dad0225cf45e81a229578d4e11c85
GBE_LICENSE_SHA256=e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118

say() { echo "bundle: $*"; }
# fetch URL FILE ALGO SUM: into /dl once, checked every time
fetch() {
    if [ ! -f "$DL/$2" ]; then
        curl -fsSL --retry 3 -o "$DL/$2.part" "$1"
        mv "$DL/$2.part" "$DL/$2"
    fi
    echo "$4  $DL/$2" | ${3}sum -c --quiet - || { rm -f "$DL/$2"; echo "bundle: $2: $3 mismatch" >&2; exit 1; }
}
mkdir -p "$DL"
fetch "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/$GE/$GE-x86_64.tar.gz" "$GE-x86_64.tar.gz" sha512 $GE_SHA512
fetch "https://builds.dotnet.microsoft.com/dotnet/Runtime/$DOTNET/dotnet-runtime-$DOTNET-linux-x64.tar.gz" "dotnet-runtime-$DOTNET-linux-x64.tar.gz" sha512 $DOTNET_SHA512
fetch "https://github.com/SteamRE/DepotDownloader/releases/download/DepotDownloader_$DD/DepotDownloader-framework.zip" "DepotDownloader-$DD-framework.zip" sha256 $DD_SHA256
fetch "https://github.com/Detanup01/gbe_fork/releases/download/$GBE/emu-win-release-vs22.7z" "gbe-$GBE-win.7z" sha256 $GBE_SHA256
fetch "https://raw.githubusercontent.com/Detanup01/gbe_fork/$GBE/LICENSE" "gbe-$GBE-LICENSE" sha256 $GBE_LICENSE_SHA256

rm -rf "$ROOT" /tmp/ge
mkdir -p "$R/lib" "$R/licenses" "$P" "$X" /tmp/ge

# ---- Proton, trimmed ---------------------------------------------------------
say "unpacking $GE"
tar xzf "$DL/$GE-x86_64.tar.gz" -C /tmp/ge
G=/tmp/ge/$(ls /tmp/ge)
# the launcher only runs here, at build time (not shipped: see the tar below)
cp -a "$G/proton" "$G/filelock.py" "$G/utilities.py" "$G/vulkan.py" "$G/version" "$G/toolmanifest.vdf" \
      "$G/compatibilitytool.vdf" "$G/user_settings.sample.py" "$G/proton_3.7_tracked_files" "$P/"
cp -a "$G/protonfixes" "$P/"
for f in LICENSE LICENSE.OFL PATENTS.AV1; do cp "$G/$f" "$P/"; done
F=$P/files
mkdir -p "$F/lib/wine" "$F/share/wine"
cp -a "$G/files/bin" "$F/"
# (bin/xrandr, an X11 tool Proton's launcher calls at build time, is not shipped)
# DXVK, VKD3D-Proton, NVAPI and the like never run here (no Vulkan), but
# Proton's prefix setup copies and links their DLLs whatever the renderer:
# kept (~70 MB) so the prefix has no dangling links
for d in "$G"/files/lib/wine/*; do [ "$(basename "$d")" = i386-unix ] || cp -a "$d" "$F/lib/wine/"; done
# new WoW64 (PROTON_USE_WOW64=1) runs 32-bit programs from the 64-bit side:
# of i386-unix only Proton's 64-bit ELF files are kept (the car has no 32-bit
# glibc), as the bench does
mkdir -p "$F/lib/wine/i386-unix"
for f in "$G"/files/lib/wine/i386-unix/*; do
    [ "$(od -A n -t x1 -j 4 -N 1 "$f" | tr -d ' ')" = 02 ] && cp -a "$f" "$F/lib/wine/i386-unix/"
done
cp -a "$G/files/lib/vkd3d" "$F/lib/"              # libvkd3d-shader: WineD3D imports it
cp -a "$G/files/lib/x86_64-linux-gnu" "$F/lib/"
# not here: text-to-speech (onnxruntime, piper, espeak), Vulkan layers, OpenXR,
# NVIDIA's API bridges
( cd "$F/lib/x86_64-linux-gnu" && rm -rf libonnxruntime* libpiper* libespeak* libVkLayer_* libdxvk_* \
      libopenxr* liblsteamclient_overlay_bridge* cmake pkgconfig )
# share/ whole (the prefix setup copies from many corners of it), less Wine's
# Mono (.NET Framework games need it: not in this version) and Gecko (HTML
# views), and the text-to-speech data: ~500 MB
rm -rf "$F/share"
cp -a "$G/files/share" "$F/"
rm -rf "$F/share/wine/mono" "$F/share/wine/gecko" "$F/share/espeak-ng-data" "$F/share/libtashkeel_model.ort"
# Every ELF program asks for the runtime's loader (the unit has no /lib64).
# wine-preloader is static: it maps the interpreter `wine` names.
n=0
for f in $(find "$F" -type f); do
    if readelf -l "$f" 2>/dev/null | grep -q 'Requesting program interpreter'; then
        patchelf --set-interpreter "$LOADER" "$f"; n=$((n + 1))
    fi
done
say "proton: $n programs on $LOADER: $(du -sh "$P" | cut -f1)"
# 32-bit programs on the unit: its kernel has no IA32 emulation, and Wine's
# new WoW64 set the 32-bit %fs up through i386 system calls (int $0x80) that
# fault there. build.sh rebuilds ntdll.so from this Proton's own Wine tree
# with patches/wine-no-ia32.patch (tools/build_ntdll.sh): the 64-bit
# modify_ldt and an LDT selector per 32-bit thread. Only over the ntdll.so of
# the GE-Proton it was built for.
NT=$F/lib/wine/x86_64-unix/ntdll.so
echo "37242d504908ed213f24e508ed0c731dc9de64bd980fdd3f0b4fa5fd32cca090  $NT" | sha256sum -c --quiet \
    || { echo "bundle: Proton's ntdll.so is not $GE's: tools/build_ntdll.sh and the patch need this Proton" >&2; exit 1; }
[ -f /m/build/ntdll-noia32.so ] || { echo "bundle: build/ntdll-noia32.so missing (build.sh makes it)" >&2; exit 1; }
cp /m/build/ntdll-noia32.so "$NT"
strip --strip-unneeded "$NT"
chmod 0555 "$NT"
objdump -d "$NT" | grep -q 'int  *\$0x80' && { echo "bundle: ntdll.so still has int \$0x80" >&2; exit 1; }
say "ntdll.so: rebuilt with patches/wine-no-ia32.patch"

# ---- the runtime: .NET, DepotDownloader, wl-sink -------------------------------
mkdir -p "$R/dotnet" "$R/depotdownloader"
tar xzf "$DL/dotnet-runtime-$DOTNET-linux-x64.tar.gz" -C "$R/dotnet"
patchelf --set-interpreter "$LOADER" "$R/dotnet/dotnet"
cp "$R/dotnet/LICENSE.txt" "$R/licenses/dotnet-LICENSE.txt"
cp "$R/dotnet/ThirdPartyNotices.txt" "$R/licenses/dotnet-ThirdPartyNotices.txt"
unzip -q -o "$DL/DepotDownloader-$DD-framework.zip" -d "$R/depotdownloader"
rm -f "$R/depotdownloader/DepotDownloader.exe" "$R/depotdownloader/DepotDownloader.pdb"
cp "$R/depotdownloader/LICENSE" "$R/licenses/DepotDownloader-LICENSE.txt"
# gbe_fork's regular (not experimental) Steam API DLLs: goldberg/x64, x86
mkdir -p /tmp/gbe "$R/goldberg/x64" "$R/goldberg/x86"
7z x -y -o/tmp/gbe "$DL/gbe-$GBE-win.7z" release/regular/x64/steam_api64.dll release/regular/x86/steam_api.dll > /dev/null
cp /tmp/gbe/release/regular/x64/steam_api64.dll "$R/goldberg/x64/"
cp /tmp/gbe/release/regular/x86/steam_api.dll "$R/goldberg/x86/"
chmod 0644 "$R/goldberg/x64/steam_api64.dll" "$R/goldberg/x86/steam_api.dll"
cp "$DL/gbe-$GBE-LICENSE" "$R/licenses/gbe_fork-LICENSE.txt"
echo "$GBE" > "$R/goldberg/VERSION"

G2=/tmp/wl-gen
mkdir -p $G2
XDG=/usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml
VP=/usr/share/wayland-protocols/stable/viewporter/viewporter.xml
wayland-scanner server-header $XDG $G2/xdg-shell-server-protocol.h
wayland-scanner private-code $XDG $G2/xdg-shell-protocol.c
wayland-scanner server-header /m/src/protocol/wayland-drm.xml $G2/wayland-drm-server-protocol.h
wayland-scanner private-code /m/src/protocol/wayland-drm.xml $G2/wayland-drm-protocol.c
wayland-scanner server-header $VP $G2/viewporter-server-protocol.h
wayland-scanner private-code $VP $G2/viewporter-protocol.c
# wl-sink is also a client of Winston (src/winston_out.c, platform native/winston_out)
for x in ivi-application ivi-controller linux-dmabuf-unstable-v1; do
    wayland-scanner client-header /m/src/protocol/$x.xml $G2/$x-client-protocol.h
    wayland-scanner private-code /m/src/protocol/$x.xml $G2/$x-protocol.c
done
wayland-scanner server-header /m/src/protocol/linux-dmabuf-unstable-v1.xml $G2/linux-dmabuf-unstable-v1-server-protocol.h   # wl-sink --dmabuf
gcc -O2 -Wall -Wextra -Werror -o /tmp/rgb_test /m/src/rgb_test.c /m/src/rgb.c && /tmp/rgb_test
gcc -O2 -g0 -std=gnu11 -Wall -Wextra -Werror -I/m/src -I$G2 \
    -Wl,--dynamic-linker=$LOADER -Wl,-rpath,$R/lib -Wl,--build-id=sha1 -o "$R/wl-sink" \
    /m/src/wl_sink.c /m/src/rgb.c /m/src/frame_out.c /m/src/winston_out.c $G2/xdg-shell-protocol.c \
    $G2/wayland-drm-protocol.c $G2/viewporter-protocol.c $G2/ivi-application-protocol.c $G2/ivi-controller-protocol.c \
    $G2/linux-dmabuf-unstable-v1-protocol.c \
    $(pkg-config --cflags --libs wayland-server wayland-client) -ldl
strip --strip-unneeded "$R/wl-sink"
# the display's touches while a game is shown, read passively (src/touch_main.c,
# vizualyse-chromium's helper): server.js turns them into wl-sink's pointer
gcc -O2 -g0 -std=gnu11 -Wall -Wextra -Werror \
    -Wl,--dynamic-linker=$LOADER -Wl,-rpath,$R/lib -Wl,--build-id=sha1 -o "$R/steam-touch" \
    /m/src/touch_main.c /m/src/touch.c -lpthread
strip --strip-unneeded "$R/steam-touch"
# the game's controllers: XInput USB pads through usbfs (the platform's pads.c
# / usb_pads.c, vizualyse-moonlight's code) into the pads file our
# xinput1_4.dll reads (src/pads_main.c, src/vzs_pads.h); pads.c's tests first
gcc -O2 -std=gnu11 -Wall -Wextra -Wno-unused-parameter -Werror -I/m/src -o /tmp/pads_test /m/test/pads_test.c /m/src/pads.c && /tmp/pads_test
gcc -O2 -g0 -std=gnu11 -Wall -Wextra -Wno-unused-parameter -Werror -I/m/src \
    -Wl,--dynamic-linker=$LOADER -Wl,-rpath,$R/lib -Wl,--build-id=sha1 -o "$R/steam-pads" \
    /m/src/pads_main.c /m/src/usb_pads.c /m/src/pads.c
strip --strip-unneeded "$R/steam-pads"
# our XInput (src/xinput.c): Windows DLLs, 64- and 32-bit, reading the pads
# file; server.js puts them in the prefix as xinput1_4 / 1_3 / 9_1_0 / ...
for a in x86_64:x64 i686:x86; do
    mkdir -p "$R/xinput/${a#*:}"
    ${a%:*}-w64-mingw32-gcc -O2 -std=gnu11 -Wall -Wextra -Werror -shared -I/m/src \
        -o "$R/xinput/${a#*:}/xinput1_4.dll" /m/src/xinput.c /m/src/xinput.def \
        -Wl,--kill-at -Wl,--enable-stdcall-fixup -static-libgcc -Wl,--no-insert-timestamp -s
done

# ---- the runtime's libraries ---------------------------------------------------
M=/usr/lib/x86_64-linux-gnu
# what is only dlopen()ed (ldd can't see it): Wine's Wayland, keyboard, fonts,
# TLS, sound, D-Bus, udev; .NET's OpenSSL; glibc's stubs (libdl, libpthread,
# librt: the unit's Mesa asks for them, and without ours the unit's 2.27 ones
# would load into a 2.41 process)
for l in libwayland-client.so.0 libwayland-egl.so.1 libwayland-server.so.0 libxkbcommon.so.0 \
         libasound.so.2 libfreetype.so.6 libfontconfig.so.1 libgnutls.so.30 libdbus-1.so.3 libudev.so.1 \
         libssl.so.3 libcrypto.so.3 libdrm.so.2 libexpat.so.1 libffi.so.8 libz.so.1 libstdc++.so.6 libgcc_s.so.1 \
         libdl.so.2 libpthread.so.0 librt.so.1 libm.so.6 libresolv.so.2 libutil.so.1; do
    cp -L "$M/$l" "$R/lib/"
done
cp -L "$M/libc.so.6" "$R/lib/"
cp -L /lib64/ld-linux-x86-64.so.2 "$R/lib/"
# Every library the ELF files need, resolved in this image; Proton's own
# (files/lib/x86_64-linux-gnu) stay where they are.
PL=$F/lib/x86_64-linux-gnu
ELFS="$R/wl-sink $R/steam-touch $R/steam-pads $R/dotnet/dotnet $(find "$R/dotnet" -name '*.so') $(ls "$R"/lib/*.so*) \
      $(find "$F/bin" "$F/lib/wine/x86_64-unix" "$PL" -type f ! -name xrandr \( -name '*.so*' -o -perm -u+x \))"
closure() {
    for e in "$@"; do LD_LIBRARY_PATH=$PL ldd "$e" 2>/dev/null; done | awk '/=> \// {print $1" "$3}' | sort -u
}
pass=0
while :; do
    added=0
    closure $ELFS > /tmp/needed
    while read -r name p; do
        case $p in "$PL"/*|"$R"/*) continue ;; esac
        case $name in */*) continue ;; esac     # the loader, by its path: ours is there already
        [ -e "$R/lib/$name" ] && continue
        cp -L "$p" "$R/lib/$name"
        ELFS="$ELFS $R/lib/$name"
        added=$((added + 1))
    done < /tmp/needed
    pass=$((pass + 1))
    [ $added -eq 0 ] && break
    [ $pass -gt 6 ] && { echo "bundle: the library closure does not settle" >&2; exit 1; }
done

# glibc reads the resolver configuration the tool writes (see the top)
python3 - "$R/lib/libc.so.6" <<'EOF'
import sys
p = sys.argv[1]
b = open(p, 'rb').read()
old, new = b'/etc/resolv.conf\0', b'/dev/shm/vzs.dns\0'
assert len(old) == len(new)
n = b.count(old)
if n < 1:
    sys.exit('bundle: no /etc/resolv.conf in libc.so.6')
open(p, 'wb').write(b.replace(old, new))
print('bundle: libc.so.6 reads /dev/shm/vzs.dns (%d place%s)' % (n, '' if n == 1 else 's'))
EOF

# ALSA: our configuration only, never the unit's /etc/asound.conf (SmartXbar's,
# for its libasound 1.1). Wine's default device is a plug into the file
# plugin: S16LE 48 kHz stereo into $ROOT's FIFO, read by the tool (server.js),
# which plays it into SmartXbar as Moonlight does.
mkdir -p "$R/share" "$R/etc/fonts" "$R/etc/ssl/certs"
cp -a /usr/share/alsa "$R/share/"
# alsa.conf's first @hooks block loads the system's and the user's files
# (/etc/alsa/conf.d, /etc/asound.conf, ~/.asoundrc, ...): it loads ours alone
python3 - "$R/share/alsa/alsa.conf" "$R/etc/asound.conf" <<'EOF'
import sys
p, ours = sys.argv[1], sys.argv[2]
s = open(p).read()
a = s.index('\n@hooks [\n')
b = s.index('\n]\n', a) + 3
s = s[:a] + '\n@hooks [\n\t{\n\t\tfunc load\n\t\tfiles [\n\t\t\t"%s"\n\t\t]\n\t\terrors false\n\t}\n]\n' % ours + s[b:]
for bad in ('"/etc/asound.conf', '~/.asoundrc', '/etc/alsa/conf.d', 'XDG_CONFIG_HOME'):
    if bad in s:
        sys.exit('bundle: alsa.conf still loads ' + bad)
open(p, 'w').write(s)
print('bundle: alsa.conf loads ' + ours + ' only')
EOF
cat > "$R/etc/asound.conf" <<EOF
# vizualyse-steam: Wine's sound as raw S16LE 48 kHz stereo into a FIFO the
# tool reads and plays into SmartXbar (server.js, pcm_play.py).
pcm.!default {
    type plug
    slave { pcm "vzs_out"; format S16_LE; rate 48000; channels 2 }
}
pcm.vzs_out {
    type file
    slave.pcm "null"
    file "/dev/shm/vizualyse-steam/pcm"
    format "raw"
}
EOF
cat > "$R/etc/fonts/fonts.conf" <<EOF
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>$F/share/fonts</dir>
  <cachedir>$ROOT/home/.cache/fontconfig</cachedir>
</fontconfig>
EOF
cp -L /etc/ssl/certs/ca-certificates.crt "$R/etc/ssl/certs/"

# ---- the prefix, and how Proton starts a game ----------------------------------
# A compositor for wineboot (wl-sink without a frame file or GPU), Proton's own
# launcher once, with a stand-in for Steam's launcher wrapper that keeps the
# environment and command instead of running them, then wineboot.
export XDG_RUNTIME_DIR=/tmp/xdg HOME=/tmp/home
mkdir -p -m 700 "$XDG_RUNTIME_DIR" "$HOME" "$ROOT/steam"
"$R/wl-sink" --socket wayland-9 --no-drm --create 1280x720 >/tmp/wl-sink.log 2>&1 &
SINK=$!
i=0; while [ ! -S "$XDG_RUNTIME_DIR/wayland-9" ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
mkdir -p /tmp/adverb
cat > /tmp/adverb/steam-runtime-launcher-interface-0 <<'EOF'
#!/bin/sh
# Proton runs "<this> proton ARGV...": keep its environment and command, run nothing
shift
exec python3 -c 'import json, os, sys
json.dump({"env": dict(os.environ), "argv": sys.argv[1:]}, open("/tmp/launch-raw.json", "w"), indent=1, sort_keys=True)' "$@"
EOF
chmod +x /tmp/adverb/steam-runtime-launcher-interface-0
# the game stands in as GAME (server.js puts the real one there)
( cd /tmp && env PATH=/tmp/adverb:/usr/bin:/bin WAYLAND_DISPLAY=wayland-9 \
    STEAM_COMPAT_DATA_PATH=$X STEAM_COMPAT_CLIENT_INSTALL_PATH=$ROOT/steam \
    PROTON_USE_WINED3D=1 PROTON_ENABLE_WAYLAND=1 PROTON_USE_WOW64=1 PROTONFIXES_DISABLE=1 \
    SteamGameId=0 SteamAppId=0 python3 "$P/proton" run GAME > /tmp/proton-setup.log 2>&1 ) \
    || { tail -20 /tmp/proton-setup.log >&2; echo "bundle: Proton's setup failed" >&2; exit 1; }
[ -f /tmp/launch-raw.json ] || { tail -20 /tmp/proton-setup.log >&2; echo "bundle: Proton never reached its launch" >&2; exit 1; }
# wineboot through the captured environment, then the adapter (WineD3D knows no
# HD 505, the unit's GPU: it would say HD 4000 or GeForce 8800 and games pick
# settings by it; HD 510, 0x1902, is the closest Gen9 it knows)
python3 - "$X" <<'EOF'
import json, os, subprocess, sys
raw = json.load(open('/tmp/launch-raw.json'))
env = dict(raw['env'])
env.update({'WAYLAND_DISPLAY': 'wayland-9', 'WINEDEBUG': '-all'})
# no Mono or Gecko here: without this wineboot waits on their installers' dialogs
env['WINEDLLOVERRIDES'] = env.get('WINEDLLOVERRIDES', '') + ';mscoree=;mshtml='
wine = raw['argv'][1]          # [preloader, wine, steam.exe, GAME]
pre = raw['argv'][0]
def run(*args):
    r = subprocess.run([pre, wine] + list(args), env=env, cwd='/tmp', timeout=900)
    if r.returncode:
        sys.exit('bundle: wine %s: exit %d' % (' '.join(args), r.returncode))
server = os.path.join(os.path.dirname(wine), 'wineserver')
if not os.path.exists(server):
    server = os.path.join(os.path.dirname(wine), '..', '..', '..', 'bin', 'wineserver')
run('wineboot', '-u')
# wineboot's server shuts down after it: a reg add that met it on the way
# out failed with "recvmsg: Connection reset by peer" (one build in three)
subprocess.run([server, '-w'], env=env, timeout=300)
# one regedit for all three values: separate reg adds each started and
# stopped a server, and the next met it on the way out the same way (CI)
open('/tmp/d3d.reg', 'w').write('REGEDIT4\r\n\r\n[HKEY_CURRENT_USER\\Software\\Wine\\Direct3D]\r\n'
    '"VideoPciVendorID"=dword:00008086\r\n"VideoPciDeviceID"=dword:00001902\r\n'
    '"VideoMemorySize"="1024"\r\n')   # read as a string ("is 0" as a DWORD)
run('regedit', '/S', 'Z:\\tmp\\d3d.reg')
subprocess.run([server, '-w'], env=env, timeout=300)
print('bundle: prefix made')
EOF
kill $SINK 2>/dev/null || true
# Two builds, the same bytes: registry time stamps zeroed, and the prefix's
# random identities fixed (the same on every car; nothing here is personal)
python3 - "$X/pfx" <<'EOF'
import re, sys, os
pfx = sys.argv[1]
for name in ('system.reg', 'user.reg', 'userdef.reg'):
    p = os.path.join(pfx, name)
    s = open(p, encoding='utf-8', errors='surrogateescape').read()
    s = re.sub(r'^(\[[^\n]*\]) \d+$', r'\1 0', s, flags=re.M)
    s = re.sub(r'^#time=[0-9a-f]+$', '#time=0', s, flags=re.M)
    s = re.sub(r'("MachineGuid"=")[^"]*"', r'\g<1>00000000-0000-0000-0000-000000000000"', s)
    s = re.sub(r'("MachineId"="\{)[^}]*\}"', r'\g<1>00000000-0000-0000-0000-000000000000}"', s)
    # device container ids: their last 8 bytes are a time stamp
    s = re.sub(r'(\{[0-9a-fA-F]{8}-0000-[fF]{4}-)[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}', r'\g<1>0000-000000000000}', s)
    s = re.sub(r'("InstallDate"=dword:)[0-9a-f]+', r'\g<1>00000000', s)
    s = re.sub(r'("InstallTime"=hex\(b\):)[0-9a-f,]+', r'\g<1>00,00,00,00,00,00,00,00', s)
    open(p, 'w', encoding='utf-8', errors='surrogateescape').write(s)
print('bundle: registry normalised')
# No prefix update on the unit: Wine compares .update-timestamp with
# wine.inf's time, which the archives zero, so the first start ran
# wineboot --update, and with mscoree on (games need it) that offered Wine
# Mono's installer in a window nobody can press (2026-11-07). The prefix is
# made by the same Wine that runs it: "disable" skips the check.
open(os.path.join(pfx, '.update-timestamp'), 'w').write('disable\n')
print('bundle: prefix updates disabled')
EOF
rm -f "$X/pfx.lock"
# launch.json: Proton's environment for a game, the container's own noise left out
python3 - <<EOF
import json
raw = json.load(open('/tmp/launch-raw.json'))
drop = {'HOME', 'HOSTNAME', 'PWD', 'OLDPWD', 'SHLVL', '_', 'TERM', 'XDG_RUNTIME_DIR', 'WAYLAND_DISPLAY',
        'PROTON_USE_WINED3D', 'PROTON_ENABLE_WAYLAND', 'PROTON_USE_WOW64', 'PROTONFIXES_DISABLE', 'SteamGameId', 'SteamAppId',
        'STEAM_COMPAT_DATA_PATH', 'STEAM_COMPAT_CLIENT_INSTALL_PATH'}
env = {k: v for k, v in raw['env'].items() if k not in drop and not k.startswith('LC_')}
argv = raw['argv']
assert argv[-1] == 'GAME', argv
json.dump({'proton': '$GE', 'argv': argv[:-1], 'env': env}, open('$OUT/launch.json.tmp', 'w'), indent=1, sort_keys=True)
print('bundle: launch: ' + ' '.join(argv[:-1]))
EOF
mv "$OUT/launch.json.tmp" "$OUT/launch.json"

# ---- checks -------------------------------------------------------------------
# Every NEEDED of ours resolves in the runtime, in Proton's libraries or next
# to it (Wine's modules find ntdll.so and win32u.so beside them). Wine's
# modules for what doesn't exist here are never loaded and keep their wants:
# X11 (winex11), PulseAudio (winepulse: ALSA here), OpenXR, AMD's AGS, smart
# cards, USB passthrough, Proton's text-to-speech.
UNUSED=" winex11.so winepulse.so wineopenxr.so amd_ags_x64.so winscard.so wineusb.so protontts.so "
missing=0
for e in "$R/wl-sink" "$R/dotnet/dotnet" $(find "$F/lib/wine/x86_64-unix" -name '*.so'); do
    case "$UNUSED" in *" $(basename "$e") "*) continue ;; esac
    for n in $(objdump -p "$e" | awk '/NEEDED/ {print $2}'); do
        [ -e "$R/lib/$n" ] || [ -e "$PL/$n" ] || [ -e "$(dirname "$e")/$n" ] \
            || { echo "bundle: $(basename "$e") needs $n, not in the bundle" >&2; missing=1; }
    done
done
[ $missing -eq 0 ] || exit 1
# No GPU driver may come along: Wine uses the unit's own Mesa 19 (0.1.1 of the
# browser blacked out the HMI with a bundled one, knowledge/browser.md)
bad=$(cd "$ROOT" && find . \( -name 'libvulkan_*' -o -name '*_dri.so' -o -name '*_drv_video.so' -o -name '*_gbm.so' \
      -o -name 'libEGL*' -o -name 'libGL.so*' -o -name 'libGLX*' -o -name 'libGLES*' -o -name '*icd*.json' -o -name 'libgbm*' \) -print)
[ -z "$bad" ] || { echo "bundle: a GPU driver got in: $bad" >&2; exit 1; }

# ---- licences, version, archives -------------------------------------------------
for f in $(ls "$R/lib"); do dpkg -S "*/$f" 2>/dev/null | head -1 | cut -d: -f1; done | sort -u > /tmp/pkgs
for p in $(cat /tmp/pkgs) libasound2-data ca-certificates; do
    [ -f "/usr/share/doc/$p/copyright" ] && cp "/usr/share/doc/$p/copyright" "$R/licenses/$p.txt"
done
{
    echo "vizualyse-steam bundle"
    echo "proton $GE (trimmed: WineD3D, Wayland, new WoW64)"
    echo "dotnet $DOTNET, DepotDownloader $DD"
    echo "glibc $(dpkg-query -W -f '${Version}' libc6)"
    echo "packages: $(sort -u /tmp/pkgs | tr '\n' ' ')"
} > "$R/VERSION"
cp "$R/VERSION" "$OUT/bundle-VERSION.txt"
pack() {   # pack NAME DIR [tar options]: sorted, dated 0, root's, links kept
    n=$1; d=$2; shift 2
    ( cd / && tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --format=gnu --hard-dereference \
          "$@" -cf - "${d#/}" ) | gzip -n -6 > "$OUT/$n.tmp"
    mv "$OUT/$n.tmp" "$OUT/$n"
    say "$n: $(du -sh "$d" | cut -f1) unpacked, $(du -h "$OUT/$n" | cut -f1) packed"
}
pack runtime.tgz "$R"
# the launcher and protonfixes ran here only
pack proton.tgz "$P" --exclude="${P#/}/proton" --exclude="${P#/}/protonfixes" --exclude="${P#/}/*.py" \
    --exclude="${P#/}/proton_3.7_tracked_files" --exclude="${P#/}/files/bin/xrandr"
pack prefix.tgz "$X"
cat "$R/VERSION"
