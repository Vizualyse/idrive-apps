# 03 · Does CarPlay keep sending video in the background?

## Why

The goal is the Google Maps map on the cluster **while the central screen
shows something else** (radio, settings). The screen grab cannot do that: it
copies the central screen. A direct CarPlay feed (story 06) can, but only if
the phone keeps sending video while CarPlay is not in front. This test
decides whether 06 is worth doing.

## Test (read-only, about 3 minutes)

A recorder on the unit logs every second: rx bytes of every network
interface and `carplay`'s CPU ticks (`/proc/<pid>/stat` fields 14+15), and
every 5 s a quarter-size screenshot (`winston-grabber -s center -g 480x180
-n 1`), into `/tmp/samp/`:

```sh
#!/bin/sh
# 150 s: each second the per-interface rx bytes and carplay CPU ticks; every 5 s a quarter-size screenshot.
export XDG_RUNTIME_DIR=/run/wayland
mkdir -p /tmp/samp
P=$(pidof carplay)
i=0
while [ $i -lt 150 ]; do
  t=$(date +%s)
  cpu=$(awk '{print $14+$15}' /proc/$P/stat 2>/dev/null)
  nets=""; for n in /sys/class/net/*; do nets="$nets $(basename $n)=$(cat $n/statistics/rx_bytes)"; done
  echo "$t cpu=$cpu$nets" >> /tmp/samp/log.txt
  if [ $((i % 5)) -eq 0 ]; then winston-grabber -s center -g 480x180 -n 1 /tmp/samp/shot_$(printf %03d $i).jpg >/dev/null 2>&1 & fi
  i=$((i+1)); sleep 1
done
echo done >> /tmp/samp/log.txt
```

Run it detached (`nohup sh run.sh &`) so it outlives the SSH session.

1. CarPlay with Google Maps navigating on the central screen.
2. Start the recorder.
3. CarPlay in front ~30 s, then Radio/Media ~60 s, then CarPlay again.
4. Change the volume once (story 05 needs a picture of the pop-up).
5. Copy `/tmp/samp` to the PC, line the counters up with the screenshots.

## Reading it

- The interface carrying CarPlay (USB NCM or `wlan_bridge` for wireless)
  keeps several Mbit/s and `carplay` keeps its CPU while on Radio: the phone
  keeps sending, story 06 can show the map in the background.
- Traffic and CPU drop while on Radio: the phone stops; 06 cannot help in the
  background. Go with 04 + 05.

## Done when

- One of the two answers, with the numbers, written into `Learnings.md`.
