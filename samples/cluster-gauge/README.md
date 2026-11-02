# cluster-gauge sample

A minimal app drawing on the iDrive 7 instrument cluster or HUD through
[`cluster-render`](https://github.com/robertnisipeanu/idrive-apps/tree/main/native/cluster-render): a needle gauge with the head
unit's CPU load and a digital readout `HH:MM  CPU  NN` under it.

It uses three layer kinds: two **image** layers (the dial and the needle,
which the renderer rotates about its pivot), one **R8 asset** (a seven-segment
glyph atlas) and one **effect** layer (a shader drawing the text from the
atlas). The data is `/proc/stat`, so no vehicle API is needed: replace
`readValue()` with your own source.

## Run it on the head unit

Requires the Cluster renderer tool installed from the Store. With the car
parked, ignition on:

```sh
scp gauge.js ../../native/vizualyse-cast/src/cluster_render_client.js root@<mgu-ip>:/tmp/
ssh root@<mgu-ip> 'cd /tmp && node gauge.js --target map --seconds 60'
```

`--target map` is the central map area of the cluster (1088x480), `hud` the
head-up display (800x480), `panel` the whole cluster (1920x720). It ends after
`--seconds` (default 60) or on Ctrl-C, and its layers are removed with it.

On the HUD the visible area is smaller than its 800x480 target (the top is
clipped) and the car's own speed sits at the bottom, so `--target hud` keeps
the dial and readout side by side in the band from 25 % to 65 % of the height.
`--band TOP-BOTTOM` (e.g. `--band 0.3-0.6`) picks another band on any target,
`--no-band` uses the full area.

Keep content off the speedometer, warnings and check-control areas, and keep
anything animated off the HUD while driving.
