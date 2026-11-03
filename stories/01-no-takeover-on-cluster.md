# 01 · No take-over on the cluster (BC crash)

## Why

With a mirror on the cluster map, pressing **BC** (the board computer
button) left the cluster broken until a full car restart; rebooting the head
unit did not fix it. The cluster's own computer kept a bad state. The riskiest
thing the tool does there is cluster-render's **take-over**: our layers have
`contend: true`, so cluster-render unmaps the cluster's own content from the
centre slot to get it. BC makes the cluster swap that content at the same
time. Not proven (the logs were in RAM and lost), but take-over is the prime
suspect.

## What we know

- Without take-over our content waits until the cluster leaves the slot free.
- The slot is free with **navigation running**, or with **Instrument cluster >
  Central display area > Off**; in those, our mirror showed at once with no
  take-over in the recent tests.
- The QR code and the video layers set `contend: true`; videos also
  `prewarm: true` (asks for the slot before the first frame; keep it).

## Work

- `contend: false` for every layer (QR, video, mirror), or an option that
  defaults to off, named for what it risks ("take the centre from the
  cluster").
- The phone page and the iDrive page say why nothing shows when the cluster
  holds the centre: the renderer reports `parked (holder stock)`; show
  "The cluster is using its centre: start navigation or set Central display
  area to Off".
- Then try to reproduce the BC hang **with logs on** (story 02): mirror on,
  press BC a few times, with take-over off, then (if you accept the risk)
  on. Record the cluster-render dcsm lines.

## Done when

- No layer takes over by default; a parked target is explained on both pages.
- BC pressed 10 times with a mirror up and take-over off: the cluster keeps
  working, no car restart needed.

## Risks

- Without take-over the cluster map output shows only when the slot is free;
  that is the point.
