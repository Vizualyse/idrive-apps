#!/bin/sh
# emu-test.sh: our sound as an entertainment source, end to end, in the
# emulator (after emu-audio.sh): mark CarLife's media source (287) available,
# connect it to MediaSink_Front, play a 1 kHz tone into its SmartXbar input
# and find it in what SmartXbar sends the amplifier, then step the iDrive
# volume and see it reach the amplifier's input.
#
#   sh emu-test.sh DIR        (DIR as for emu-audio.sh; pcm_play.py in it)
set -eu
D=${1:?dir}
cd "$D"
PY=/var/opt/mgu-python/current/bin/python3
REC=/run/avbcap/MGU_GW_2_SINK_CF_48_STEREO.wav

node amsrc.js iface hook --src=287 >/dev/null
node amsrc.js iface connect --src=287 --sink=1024
sleep 5
node amsrc.js iface list | grep -A40 getListMainConnections | grep -A4 '"sourceID": 287' | grep connectionState

s0=$(stat -c %s "$REC")
$PY pcm_play.py --device smartx:CarLifeMedia_CF_48_STEREO --tone 1000 --seconds 3
sleep 1
s1=$(stat -c %s "$REC")
tail -c +$((s0 + 1)) "$REC" | head -c $((s1 - s0)) > /run/emu-test.raw
$PY - /run/emu-test.raw <<'EOF'
import array, math, sys
a = array.array('h'); b = open(sys.argv[1], 'rb').read(); a.frombytes(b[:len(b) // 4 * 4])
left = a[0::2]; w = 4800; tone = 0
for i in range(0, len(left) - w, w):
    s = left[i:i + w]
    zc = sum(1 for j in range(1, w) if (s[j - 1] < 0) != (s[j] < 0))
    if abs(zc / 2 / (w / 48000) - 1000) < 20 and max(abs(x) for x in s) > 1000:
        tone += 1
print('emu-test: %.1f s of 1 kHz reached the amplifier gateway (of %.1f s recorded)' % (tone * w / 48000, len(left) / 48000))
sys.exit(0 if tone * w / 48000 >= 2.5 else 1)
EOF

n=$(grep -c 'asyncSetSinkVolume.*"sinkID":129' /run/emu-ram.log || true)
node amsrc.js iface volume --step=2 >/dev/null
sleep 1
grep 'asyncSetSinkVolume.*"sinkID":129' /run/emu-ram.log | tail -n +$((n + 1)) | sed 's/.*"volume":\([0-9-]*\).*/emu-test: iDrive volume step -> amplifier input volume \1/'
