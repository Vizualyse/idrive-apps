# What others found about the CarPlay alternate screen

Starting points for reverse-engineering the second (cluster) screen into this
unit's CarPlay. Each item says how it was established. Re-check anything
against our own binaries before relying on it.

## The protocol (phone side)

From [MHI2-altScreen](https://github.com/joeyQuery/MHI2-altScreen) (Audi
MU0678, Harman stack, GPL-3.0; seen on a car, in logs, and in the iPhone's
own logs):

- Screen streams have a type. **110** is the main screen; **111** is the
  alternate (cluster) screen. One session carries both, on separate data
  connections.
- The phone proposes many features (`uiContext, viewAreas, cornerMasks,
  focusTransfer, h.264Level5.1, mainBuffered, altScreen, enhancedSiri, hevc,
  …`). It **negotiates `altScreen` and `viewAreas` only when the head unit
  advertises them**.
- The second display record in `/info` carries type 111, width/height in
  pixels and mm, `maxFPS`, `uuid`, `initialURL`,
  `altScreenSuggestUIURLs`, `viewAreas`, `features`, and a primary input
  device. With `features=0` the phone held the stream at ~16 fps; with
  `features=2` plus an input device it sent ~30 fps.
- Cluster contexts are URLs inside one stream: `maps:/car/instrumentcluster`,
  `…/map`, `…/instructioncard`.
- `suggestUI` is a suggestion. The accessory answers with `showUI` for its
  UUID. Session commands: `updateViewArea` (applied only together with
  `adjacentViewAreas`), `changeMapZoomLevel` (`zoomDirection` 0 in, 1 out).
- Stream 111's encryption key comes from the same session master key as 110:
  they captured it at `SetSecurityInfo` and ran the library's own key-derivation
  helper with stream 111's inputs.

### How the Audi work transfers, and how it doesn't

Their `libairplay.so` is built from Apple's receiver code and **exports its
functions by name** (`AirPlayReceiverSessionSetup`, `…SetSecurityInfo`,
`…Screen_StartSession`, `ProcessFrames`, …). Their hook drives those
functions for a second screen, following a reference implementation (MHI2Q)
that already did it. Their order of steps for stream 111
(`docs/static-phase/q-to-mhi2.md`):

```
SETUP 111 -> create screen B -> UpdateState -> Setup(B,111) -> time sync
 -> derive AES -> SetSecurityInfo -> listener -> answer 111 + dataPort
worker: accept -> wrap socket -> StartSession(B) -> ProcessFrames(B)
```

**Cinemo's `libNmeCarPlay` contains the same Apple receiver code** (survey of
20.40.2, 2026-11-03): it identifies as `AirPlay/320.17.6`, and its log strings
name `AirPlayReceiverSessionScreen_ProcessFrames`, `ScreenStreamStart`,
`DataStream-Salt`, `AirPlayStreamKey`, `streamConnectionID`, `displays` /
`widthPixels` / `maxFPS` / `primaryInputDevice`. Unlike Harman's build, these
functions are **not exported** (35 exports in all), so they have to be found
through their log strings in Ghidra. It has none of `altScreen`, `viewAreas`,
`safeArea`, `suggestUI` or `showUI`. That fits an AirPlay version from before
the alternate screen.

## Cinemo and BMW (carplay 22.28.3, our waze-on-cluster)

From this repository's history (`git show 19d12ff^:native/waze-on-cluster/patch/PATCH.md`),
read from carplay 22.28.3's code:

- BMW's `carplay` talks to Cinemo through a C++ object (`mCarPlay` /
  `mCinemoCarPlay`): `SetInitialInfoResponse(…)` at start (the info that
  includes the alternate display), `GetDisplaySource(…)` with a sink URL per
  display, `ShowUI(url, uuid)`, `ForceKeyframe`.
- The second stream's sink: `avb://media_transport.avb_streaming.15?mime_type=video/H264`.
  The H.264 stays undecoded and is sent as RTP (payload type 96). Cinemo maps
  `udp://` and `tcp://` to `NmeVfsSocket`.
- Cinemo listens on TCP 6031 for the alternate screen.
- BMW's side gates it by `KI_KOMBI_VARIANT` (`ICSafeAreaProvider`,
  `AlternateDisplays::onSuggestUi`, `requestStream`).

**Answered for 20.40.2** ([findings-20.40.2.md](findings-20.40.2.md)): the
code is missing. SETUP accepts screen type 110 only, and none of the
alternate-screen keys are present. The original question was: does its
`libNmeCarPlay` have the same API
(a display index in `GetDisplaySource`, alternate-display fields in the info
response) with BMW's side never calling it? Or is the code missing?
`survey.py`'s vocabulary and Ghidra's `scalar` lines (functions testing both
110 and 111) answer that first.

## The AirPlay layer underneath

- [UxPlay](https://github.com/antimof/Uxplay): an open AirPlay mirroring
  receiver. Covers `/info`, the display record, pairing and the per-stream key
  derivation (stream 110).
- Apple's head-unit specifications are MFi-only (Apple engineer on the
  [developer forums](https://developer.apple.com/forums/thread/765300)).
  Nothing here uses them.

## Limits on testing off the car

Everything up to the phone can run off the car. A live session cannot: the
phone authenticates the head unit through the MFi chip on the car's hardware.
