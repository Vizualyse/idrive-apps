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
-n 1`). The script was written and is in this conversation's history; it
writes to `/tmp/samp/`.

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
