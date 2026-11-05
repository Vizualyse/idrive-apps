# The cluster and the HUD (cluster-render)

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- cluster-render draws apps' layers on three targets: `map` (the centre of
  the cluster, 1088x480), `panel` (the whole cluster, 1920x720, over the
  gauges) and `hud` (800x480).
- **Video layers must be a multiple of 4 wide** (and even high), or the
  renderer refuses the layer and the frames go nowhere.
- Upload ceiling about **5500 KB/s** shared: a 1088x422 I420 frame is about
  690 KB, so near full size means about 8 fps; 15 fps needs about 2/3 size.
  The renderer scales a layer up, so a smaller frame shown larger is cheap.
- Layer classes matter: an **overlay** never takes a slot on its own; a
  **content** layer does. `prewarm` asks for the slot before the first frame
  (avoids handing the slot back while ffmpeg starts); `contend` takes it
  from the stock content ("take-over").
- The cluster decides who holds the centre. With its own map up it keeps
  re-mapping it: on this bench a take-over could take ~30 s of retries
  (flicker). With navigation running, or **Instrument cluster > Central
  display area > Off**, the slot is free and ours shows at once.
- The cluster draws some of its own things **over** third-party content:
  the direction list during navigation, a media widget (with sound on the
  CarPlay channel), parts over the whole-panel target. Nothing can be drawn
  above those.
- **Pressing BC while our layer held the centre left the cluster broken
  until a full car restart** (a head-unit reboot did not fix it). Not yet
  understood; suspected: the take-over colliding with the cluster changing
  its content. Treat take-over as risky.
- The cluster map's top and bottom are dimmed by the gauge surround (about
  y 72-440 of 480 is clean).
- The HUD: its top is clipped and its own speed sits at the bottom. The
  visible part is about 25-65 % of the height and 17-83 % of the width.

## cluster-render 0.4.0 *(ref: upstream `native/cluster-render/README.md`, `PROTOCOL.md`; our Cast requires 0.3.3)*

- One RAMSES participant running as `hmi_5000`. The link to the cluster carries ~11.5 MB/s for everything; scenes dropped above ~8 MB/s. The budget is still a 5500 KB/s ceiling (2000 floor, 500 steps); 8000 KB/s flashed black, a minute averaging 5774 KB/s had the map removed.
- Video sends only changed 64x64 tiles; when over budget, packed 4x4 blocks at a third of the bytes (`level_bits` 2, `dirty_threshold` 8); a `repeat` op sends an unchanged frame in a few bytes. Games will mostly go packed: about 21 fps at 1088x480 (inference). The atlas is drawn as **full-range BT.601**: a limited-range stream (Sunshine's default) needs its levels stretched while packing.
- **Text over video:** an `overlay` image layer above the video layer (stack: class, then `z`, then newest; `exclusive` hides those below), or an `effect()` layer (a GLSL fragment shader, no pixel upload; seen on iDrive 8) (`js/showcase.js:54-114`).
- HUD: slot 0x323; BMW's pop-ups show in 0x322 and asking for the HUD while one showed pushed it to the cluster; **black shows as transparent** (dark game scenes vanish); width at most 85 % (680x300), ~10 fps; cluster-render disables it after 2 strikes (a `disabled` event).
- Take-over: the cluster never pre-empts; take-over lost the race 10 of 33 times; door-open and a phone reconnect lock the centre slot. Scene ids 7702/7703 restarted the cluster. A mapping guard and a cluster watchdog (~10 s per client handle, 250 ms heartbeats).
- `guide_hold` hides BMW's turn box (opt out with `guide_hold: 0`).
- RHMI has `icPopUp` / `hudPopUp` component types: an official route for pop-ups on the cluster and HUD, untested by anyone ([idrive-app-ui.md](idrive-app-ui.md)).
