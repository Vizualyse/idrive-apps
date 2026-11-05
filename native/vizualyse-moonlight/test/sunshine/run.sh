#!/bin/sh
# Xvfb on :0, PulseAudio, a clock that changes every second (something to encode), then
# Sunshine with fixed web credentials (admin / admin) for the PIN.
set -e
mkdir -p "$HOME/.config/sunshine"
cp /seed/sunshine.conf /seed/apps.json "$HOME/.config/sunshine/"
Xvfb :0 -screen 0 1280x720x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
export DISPLAY=:0
for i in 1 2 3 4 5 6 7 8 9 10; do [ -e /tmp/.X11-unix/X0 ] && break; sleep 0.3; done
# sound: PulseAudio with a null sink (Sunshine captures its monitor) and a
# tone playing into it, so the stream carries audio
pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr >/tmp/pulse.log 2>&1 || true
for i in 1 2 3 4 5 6 7 8 9 10; do pactl info >/dev/null 2>&1 && break; sleep 0.3; done
pactl load-module module-null-sink sink_name=test >/dev/null 2>&1 || true
pactl set-default-sink test >/dev/null 2>&1 || true
(while true; do pacat --format=s16le --rate=48000 --channels=2 < /dev/urandom; sleep 1; done) >/dev/null 2>&1 &
xclock -digital -update 1 -geometry 1280x720+0+0 -face 'monospace-96' >/dev/null 2>&1 &
sunshine "$HOME/.config/sunshine/sunshine.conf" --creds admin admin >/dev/null 2>&1 || true
exec sunshine "$HOME/.config/sunshine/sunshine.conf"
