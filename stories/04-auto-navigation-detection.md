# 04 · Auto mode: mirror only while Google Maps navigates

## Why

The mirror copies whatever is on the central screen. It should run only
while Google Maps is navigating in CarPlay, and stop when the screen shows
anything else.

## What we know

Average colour and spread of small patches (central-screen pixels), from
bench stills:

| Screen | x 1130-1170, y 20-110 (direction card's left edge) | x 1130-1170, y 590-700 (readouts card's left edge) | x 120-1300, y 0-70 (BMW title bar) |
|---|---|---|---|
| Google Maps navigating (2 stills) | teal (15,100,102) ±4 | navy (21,32,50) ±2 | map (47,81,108) ±25 |
| BMW Store | grey (29,29,30) ±46 | grey (34,35,39) ±43 | near-black (17,17,18) ±9 |
| BMW Media/Radio | grey (23,23,23) ±72 | near-black (15,14,16) ±12 | black (6,6,7) ±23 |

Rule: navigating when the first patch is **even** (spread < 15) and
**clearly green-blue** (G and B over R by 40+) and the second is **even**
(spread < 12). Judging on evenness and hue rather than exact colours should
hold for Google's light (day) theme (a green card, a white readouts card),
which has not been seen yet.

## Work

- A detector: `winston-grabber -s center -g 480x180 -f 1` to a local UDP
  port, ffmpeg cropping the two patches to a few raw RGB pixels at 1 fps, the
  server computing mean and spread.
- **Auto (navigation)** setting (iDrive page and phone page): on, with a
  layout and output (Google Maps cluster or HUD); navigation for 2 s starts
  the mirror, gone for 3 s stops it.
- Check on the bench whether two grabbers can run on `center` at once (the
  detector beside a mirror); if not, the mirror's ffmpeg also feeds the
  detector (a second, 1 fps output).
- Check the light theme (set Google Maps to day) and adjust the thresholds.

## Done when

- With Auto on: starting a route mirrors within ~2 s; switching the central
  screen to Radio stops it within ~3 s; Google Maps without a route does not
  mirror.
- The detector costs under 2 % CPU.
