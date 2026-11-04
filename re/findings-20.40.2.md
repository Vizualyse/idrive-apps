# libNmeCarPlay.so on this unit (carplay 20.40.2): first Ghidra pass

Unit: `BMW MGU I_21w12.2-1-4` (`/etc/os-release`). Library:
`/usr/lib/cinemo/libNmeCarPlay.so`, 924 200 bytes, sha256
`8838c272f5e46715740e36e985e761b1d85a0b399376d0de2348c38309051fa5`, build-id
`8e502fa40b7fbfb79c36acdd9905da6a1d000254`, x86-64, stripped (35 exports).
Addresses are Ghidra's (image base `0x100000`). Reproduce with
`re/run.sh ghidra` and `re/run.sh decompile` (re/README.md).

Tags: **static** = read from the binary.

## What it is

- Cinemo's wrapper (`src/NmeCarPlay/r14/...`, C++, `NmeString`, `NmeLogEx`)
  around **Apple's AirPlay receiver code, version `AirPlay/320.17.6`**. This is
  the same code base as Harman's `libairplay` in the Audi MHI2-altScreen work. [static]
- Apple's functions are not exported, but they log their own names. 345 such
  strings map to functions (`ExportLogNames`). [static]
- Cinemo stores dictionary keys as constant string objects: an 8-byte header
  `56 07 01 00 ff ff ff 7f`, then the text. Code references the header. [static]

## Named functions (from their log strings)

| Function | Ghidra | Notes |
|---|---|---|
| `AirPlayReceiverSessionSetup` (contains `_ScreenSetup`, `_MainAltAudioSetup`, `_GeneralAudioSetup`, `_ControlSetup`) | `0x180670` | the SETUP handler, one branch per stream `type` |
| `_SetUpStreams` | `0x173a30` | |
| `_TearDownStreams` | `0x173610` | |
| `_ScreenStart` | `0x17a480` | starts the screen thread |
| `_ScreenThread` / `AirPlayScreenReceiver` | `0x17a530` | |
| `_ScreenTearDown` | `0x179c40` | |
| `AirPlayReceiverSessionScreen_ProcessFrames` (+ `_ProcessFrame`, `_ProcessCommand`) | `0x1855d0` | frame pump |
| `ScreenStreamSetWidthHeight` / `SetAVCC` / `Start` / `Stop` | `0x1728e0` / `0x172960` / `0x172a50` / `0x172ab0` | |
| stream key: `AirPlayStreamKey` / `AirPlayStreamIV` | `0x187690` | used when there is no pair-verify key |
| stream key: `DataStream-Salt` / `-Output-` / `-Input-Encryption-Key` | `0x17df90` | used when there is one |
| server `CopyProperty` (`/info`): `displays`, `hidDevices`, `audioFormats`, … | `0x10d270` | |
| list builder (one entry per matching config item) | `0x10c050` | |
| display record builder | `0x10cdf0` | |
| `MainScreen` | `0x10bc80` | |

## SETUP: only screen type 110 [static]

In `0x180670` the stream `type` picks the branch: `0x60`–`0x66` audio
(`0x65` alt, `0x66` main), **`0x6e` (110) screen**. **Every other type logs
`### Unsupported stream type: %d`.** So a phone that asks for 111 is refused.

The 110 branch, in order (matching the Audi project's documented steps):

1. refuse if a screen is already set up (`[session+0x1cc8]`);
2. `0x185570(screen=[session+0x1cd0], streamDesc, …)`: screen setup;
3. read `streamConnectionID`;
4. stream key: with a pair-verify key (`[session+0x498]`), HKDF
   `0x17df90(…, connID)` then `0x1854c0(screen, key, 0x20)`; otherwise
   `0x187690(session+0x288, 0x10, connID, key, iv)` then `0x185510(screen, key, iv)`;
5. TCP listener: `0x1579c0(family, 1, 6, 0xffffe872, &port, 0xfff73334)`
   (the Audi MU0678 listener has the same `0xFFFFE872`);
6. response `{type: 110, dataPort: port}`;
7. `[session+0x1cc8] = 1`, log `screen receiver set up on port %d`, then
   `_ScreenStart` (`0x17a480`).

Screen state is a **single slot** in the session (`+0x1cc8` flag, `+0x1cd0`
screen object, `+0x1cd8` socket). A second screen needs its own.

## /info `displays`: several records possible, fixed keys [static]

`0x10c050(config, "displays", 0x10cdf0)` walks the config's items and builds
**one display record per item named `displays`**. Each item is a URL whose
parameters become the record. The keys it knows: `uuid`, `edid`, `features`,
`maxFPS`, `widthPixels`, `heightPixels`, `widthPhysical`, `heightPhysical`,
`primaryInputDevice`.

So a second display record (with `features`, which the Audi work needed set
to 2) can probably come from configuration alone. Not tested.

**Absent from the whole library:** `altScreen`, `viewAreas`, `safeArea`,
`initialURL`, `altScreenSuggestUIURLs`, `suggestUI`, `showUI`. [static]

## What adding the second screen would take

1. **Advertise:** a second `displays` record (configuration, if BMW's
   `carplay` passes it through), **plus** the `altScreen` / `viewAreas`
   negotiation and the `viewAreas` content, which this code base lacks. Inject
   these at the `/info` builder (`0x10d270`) or where the reply is serialised.
2. **Accept type 111:** hook the SETUP handler so 111 runs the 110 steps
   above against a **second** screen slot: setup, key from that stream's
   `streamConnectionID`, own listener, answer `{111, dataPort}`, start a
   second screen thread.
3. **Output:** send the second thread's frames to our own sink (cluster-render),
   not the main display path.
4. **Commands:** answer `suggestUI` with `showUI`; send `updateViewArea`
   with `adjacentViewAreas`.

## Can a second screen object run? Yes, structurally [static]

From the whole-program decompile (`re/run.sh decompile-all`):

- **Create** `0x185440(&obj)`: `calloc(1, 0x358)`, its own mutex, `[+0x348] = -1`.
  Called once, from session creation (`0x17e0f0`). No shared state: the only
  globals in the screen-object functions (`0x185360`–`0x186160`) are log
  categories, constants, and ScreenStream's one-time class registration.
- **Methods:** setup `0x185570(obj, streamDesc)` (reads one key into
  `[obj]`, default `0x46`); key `0x1854c0(obj, key, 0x20)` or
  `0x185510(obj, key, iv)`; callbacks `0x185490(obj, {session, 0x17a7a0, 0x17a790})`;
  start `0x185ef0(obj, ctx)`; frame pump `0x1855d0(obj, netSocket, timeout)`;
  finalize `0x185360(obj)`; command `0x185f90(obj, 0x71, …)` at teardown.
- **The session keeps one slot:** `+0x1cc8` set-up flag, `+0x1cd0` object,
  `+0x1cd8` listening fd, `+0x1ce0` NetSocket, `+0x1ce8`/`+0x1cf0` thread.
  A second screen keeps the same fields in the hook's own memory and calls the
  same functions.
- **Screen thread** `0x17a530` (`AirPlayScreenReceiver`), started by
  `_ScreenStart` `0x17a480`: accept on the listener (`0x156a80`, 10 s) → wrap
  (`0x156a20`, NetSocket) → `0x185490` callbacks → `0x185ef0(obj, [session+0x28])`
  → `0x1855d0(obj, netSocket, [[session+0x10]+0xac])` until the stream ends →
  `0x185360`. The same order as the Audi project's step list.

Still to read: callbacks `0x17a7a0` / `0x17a790` (do they touch screen-A state?),
and teardown `0x179c40` / `0x17dde0`.

## Where the frames go [static]

`0x185ef0` creates a ScreenStream (`0x172870`) at `[obj+0x350]` and sets its
context to `[session+0x28]`. ScreenStream is a thin shim into Cinemo:

| ScreenStream | Cinemo call | sink method (`sink = ctx + 0x20`, `0x18f040`) |
|---|---|---|
| `SetAVCC` `0x172960` | `0x19b8b0(avcc, len, ctx)` | `0x19a6c0` |
| `Start` `0x172a50` | `0x19b870(ctx)` | `0x199e00` |
| `Stop` `0x172ab0` | `0x19b890(ctx)` | `0x19aa40` |
| frame `0x172b20(ss, data, len, pts, …)` | `0x19b8e0(data, len, pts', ctx)` | `0x19b730` → `0x19ac00` |

The sink is embedded in Cinemo's session object, so there is one per
session. **To redirect stream 111:** give screen B's ScreenStream its own
context value, and intercept those four ScreenStream functions. Calls with
B's context go to our sink (AVCC header + H.264 frames → cluster-render).
Everything else falls through to the stock code, so screen A is untouched.

## Which port [live ruleset, 2026-11-03]

`nft list ruleset` on the unit (saved as `../idrive-rootfs/20.40.2/nft-ruleset.txt`):

- IPv4, `wlan_bridge` (wireless CarPlay): TCP **5000, 5001, 6030, 6031,
  7000** accepted. Anything else → `logblocked` → drop.
- IPv6: no CarPlay ports open. CarPlay here runs on IPv4.
- The 110 listener asks for `0xffffe872` = −6030 (Apple's "this port if
  free"). **A 111 listener asking for −6031 (`0xffffe871`) gets an open port.**
  The Audi unit's filter problem does not apply.
- Unrelated: the debug image's `keep-port22-open.sh` greps for
  `tcp dport 22 accept`, but nft prints `tcp dport ssh accept`, so it adds a
  duplicate rule every 15 s (1242 on 2026-11-03).

## The hook, as the evidence now stands

An `LD_PRELOAD` library in `carplay`, pinned to this build-id, patching
internal functions in place (Linux allows `mprotect` on text):

1. **SETUP:** where type `0x6e` is checked in `0x180670`, send 111 to our
   handler. It creates screen B (`0x185440`), sets it up (`0x185570`), derives
   B's key from its `streamConnectionID` with the same helpers (`0x17df90` /
   `0x187690`), sets the key, opens a listener on −6031 (`0x1579c0`), answers
   `{type: 111, dataPort}`, and starts our copy of the screen thread.
2. **Frames:** the four ScreenStream functions above, keyed on B's context.
3. **/info:** a second `displays` record, `altScreen`, `viewAreas`.
4. **Commands:** `suggestUI` → `showUI`; `updateViewArea` with `adjacentViewAreas`.

## Proven off-car: a second screen in the real library [harness, 2026-11-03]

`re/run.sh harness 20.40.2 aes|chacha|chacha-tamper` (`re/harness/screen_b.c`).
It is built for glibc 2.27 (Ubuntu 18.04, as the unit), runs under the unit's
own loader and libraries from the pulled root file system, and checks the
build-id before using any address. It creates a screen object, sets it up,
sets a key, gives it its own context, redirects the four ScreenStream
functions to a sink, and runs the library's own frame pump on a local socket.
A thread plays the phone. All three pass:

| mode | result |
|---|---|
| `aes` | AVCC + 12/12 frames decrypted byte-exact into our sink; start/stop seen; no call with another context |
| `chacha` | the same, through ChaCha20-Poly1305 (the pair-verify path wireless CarPlay uses) |
| `chacha-tamper` | frame 2 corrupted: rejected (`-6754`), **and every later frame too**; frames 0–1 intact |

What this pins down:

- **Wire format:** 128-byte header (u32 body size, u8 opcode 0 frame / 1
  config, u8 flags at +6 (bit 1 = use the timing callback), u64 timestamp at
  +8, float width/height at +0x10/+0x14 on config), then the body. Config
  (AVCC) is not encrypted.
- **ChaCha20-Poly1305:** RFC 7539. Nonce = 4 zero bytes + an 8-byte
  little-endian frame counter from 0. AAD = the 128-byte header as sent, its
  size field counting the 16-byte tag. Same 32-byte key as `0x1854c0`.
- **AES-CTR:** AES-128-CTR, 128-bit big-endian counter from the IV.
- **One bad frame ends the stream:** the nonce advances only on a frame that
  authenticates. On stream 111, a decryption error means tearing the stream
  down and setting it up again.
- **The redirect works:** with screen B's own context, the four ScreenStream
  replacements receive everything and Cinemo's sink is never called. (The
  harness replaces those functions outright. The in-car hook needs
  trampolines so screen A's calls reach the stock code.)
- Teardown (`0x179c40`) sends `'q'` to the screen's command pipe
  (`0x185f90(obj, 0x71)`). The pump answers "User quit event received".
- The callback at `+0x18` converts the sender's timestamp (stock: the
  session's clock, `0x188e80`). It is used only when a config's flags bit 1 is
  set. The one at `+0x10` (`0x188d20`) is not called by the pump. Where else
  it is called is still open.

Not covered by this harness: SETUP, `/info`, and the session commands. The
next section covers the first two.

## Proven off-car: hook111 through SETUP and /info [harness, 2026-11-03]

`re/run.sh harness-setup 20.40.2` (`re/harness/setup_b.c` + `native/hook111/src/hook111.c`).
Everything listed in STATUS.md §3 passes. What it took to run the stock SETUP
on a fake session:

- **The constructor's state** (`0x17e0f0`): fds `-1` at `+0x488`, `+0x1b68`,
  `+0x1b70`, `+0x1adc`, `+0x1b20`, `+0x1b50`, `+0x1cd8` (32-bit) and
  `+0x4c0`, `+0xdd8` (64-bit); `+0x490 = 1`. With `0` at `+0x1b68`,
  `_ControlIdleStateTransition` (`0x17c0e0`, called after the stream loop)
  takes keep-alive as running and walks `[[session+0x18]+8]+0x78` (Cinemo's
  object, null in the harness): the old exit 139 at `0x17c65f`.
- **Cinemo's platform object at `session+0x20`:** SETUP ends with
  `AirPlayReceiverSessionPlatformControl` (`0x173a30`, command
  `setUpStreams`), which records audio streams into it and calls
  `_UpdateStreams` (`0x172ba0`). With no audio stream in the request, a zeroed
  object (at least 0xa0 bytes) is enough. It logs its own
  `### Unsupported stream type 111` and goes on.
- **First SETUP:** with `+0x464 = 0` the stock code also does control setup
  (timing socket `0x17bf00`, keep-alive and events only if asked), as a real
  first SETUP does.
- **Config items** (`0x10c050`'s provider `+0x30`): a 0x48-byte record:
  `name[40]`, `int type @0x28` (1 = URL string), `u32 id @0x30` (passed to
  the read method `+0x40`), `u32 arg @0x38` (passed to the record builder),
  `u64 len @0x40`. The stack canary follows it directly.

## Screen B's life [static + harness, 2026-11-04]

- **The `+0x10` delegate callback is dead in this build.** `0x185490` writes
  it; no screen-object function (`0x185360`–`0x186160`) reads it, and the
  object only goes out as sub-fields (cipher state `+200`, ScreenStream
  `+0x350`). Both clock callbacks (`0x17a7a0` / `0x17a790`) read only
  `session+0x1b18` (the clock), never screen A's state.
- **TEARDOWN** (`AirPlayReceiverSessionTearDown`, `0x17e840`):
  - with streams, type 111 is logged as unsupported and nothing else happens;
  - without streams, the whole session goes, and the clock `+0x1b18` is freed
    (`0x188930`).

  The connection's close (`0x174680`) and a failed SETUP both run a full
  TEARDOWN first. Finalize (`0x17dde0`) has no direct callers (the last
  release). So wrapping TEARDOWN covers every way screen B ends; hook111 tears
  it down first. Prologue: 18 position-independent bytes.
- **Stock screen teardown** (`0x179c40`), mirrored for B: `'q'` on the
  object's command socket (`0x185f90(obj, 0x71)`, a no-op before start,
  `obj+0x348` < 0), cancel the NetSocket (`0x155ac0`), join, free it
  (`0x1559e0`), close the listener. Then finalize the object (`0x185360`,
  which stops its ScreenStream) and free it (`0x1853f0`).
- **The accept helper `0x156a80` can't be woken.** It makes the listener
  non-blocking and treats a failed accept as transient. After `shutdown()`,
  select keeps reporting it readable and accept keeps failing, and below one
  second left it retries at timeout 0, forever. The stock teardown never hits
  this, because it waits out the accept. Screen B uses its own: select on the
  listener plus a wake pipe, then `0x1568e0(fd, 1)` and TCP_NODELAY, as the
  helper does.

## Session commands [static + harness, 2026-11-04]

- **Phone → accessory:** POST `/command`, a plist `{type, params}`
  (`_requestProcessCommand` `0x1775a0`) →
  `AirPlayReceiverSessionControl(session, 1, type, NULL, params, &resp)`
  (`0x183bf0`). Known types: `modesChanged`, `requestUI`, `updateFeedback`,
  `hidSetInputMode`, `iAPSendMessage`. Anything else goes on to Cinemo
  (`0x173a30`, delegate `+0x48`), which has no `suggestUI`. Prologue:
  28 position-independent bytes.
- **Accessory → phone:** `0x17a0c0` on the event queue (`0x1460e0` =
  dispatch_sync, queue `session+0x468`), with `{session, dict, completion,
  ctx, int rc}`. It sends the dict as a binary plist, `POST /command
  RTSP/1.0`, on the events HTTP client `session+0x470`. Every sender uses it:
  `RequestUI` `0x184590` (`{type:requestUI, params:{url}}`),
  `ForceKeyFrame` `0x1843a0` (`{type:forceKeyFrame}`, no params) and 7 more.
  It needs `+0x466` set and `+0x480` (a timer) present.
- **The events connection:** `_ControlStart` `0x17ec00`, at RECORD. It
  accepts on `+0x488` (opened at control setup if `+0x465`), then
  `0x14a040(&session+0x470, fd)`, `0x14a1b0(client, queue)`,
  `0x14a230(client)`; with pair-verify, keys `Events-Salt` /
  `Events-Read-` / `-Write-Encryption-Key`. Then `+0x466 = 1`.
- **Pair-verify stream key:** `0x17df90(session+0x498, connID, 0, 0, key)`,
  the same call as the 110 branch → `0x15b260`. It requires `+0x48` ∈ {3, 4}
  and state `+0x60 == 5`, and its input is the 32-byte secret at `+0x1ba`.
  The derivation is HKDF-SHA512 (`0x166910`: extract `0x166890`, expand in
  64-byte blocks), salt `"DataStream-Salt%llu"`, info
  `"DataStream-Output-Encryption-Key"`. Proven by the harness's phone
  deriving it with OpenSSL.

## The session's idle state [car + static + harness, 2026-11-04]

Why a session with 111 as its only stream ended every ~40 s on the car.

- **The car:** in hook111's plist log, TEARDOWN of 110 at 15:38:59 (the
  iDrive took its screen back). The phone's next session started at 15:39:39,
  with no TEARDOWN in between; screen B streamed throughout.
- **Idle** (`_ControlIdleStateTransition`, `0x17c0e0`, called at the end of
  SETUP and of TEARDOWN) means no main audio `+0x4a8`, no alt audio `+0xdc0`
  and no screen `+0x1cc8`. The stock 110 SETUP sets `+0x1cc8`, and the stock
  screen teardown `0x179c40` clears it. Screen B never touched it.
- **Going idle** stops timing (`0x17be20`) and, when the phone asked for
  keep-alive (`keepAliveLowPower`, socket `+0x1b68` on port 5020), starts
  `AirPlayKeepAliveReceiver` (`0x17a7b0`). That thread selects on the socket
  with a 30 s timeout. Any packet restarts the wait. On a timeout it logs
  "Keep alive thread timeout" and closes the session (`0x17ab90`).
- **The phone sends beacons only when it considers itself idle.** It's
  streaming 111, so it sends none. 30 s, then the reconnect: the ~40 s cycle.
- **Going active** stops the keep-alive receiver (`0x179d20`), recreates the
  timing socket if it's gone (adding `timingPort` to the response, as in the
  car's 110 SETUP responses), and runs `_TimingNegotiate` (more than 4 good
  replies, at most 64 tries 100 ms apart). It then starts the timing thread
  `0x17b460`. If negotiation fails the transition returns an error, and **a
  stock SETUP fails with it** (`local_194`).
- `+0x1cc8` can't simply be left set for screen B: a 110 SETUP refuses with
  `-6719` while it's set.
- **The fix (hook111 0.1.1):** `0x17c0e0` is wrapped (16-byte prologue,
  position-independent). While screen B is up in that session, the flag is set
  for the duration of the call only. hook111 calls it once more after a 111
  SETUP, because the stock SETUP's own call ran before screen B existed.
- **Harness** (`setup_b.c`, "idle"): a fresh session as the phone sets it up
  (keep-alive asked for), a fake phone timing port, then the car's sequence:
  111 up, 110 up and down twice, 111 down. Checks: 111 makes the session
  active; 110 SETUP still works with B up; TEARDOWN {110} leaves it active;
  TEARDOWN {111} makes it idle again; without B, 110 up/down ends idle (the
  control). With the wrapper disabled, the three "stays active" checks fail.
  Not reproduced off-car: the 30 s timeout itself and the phone's beacons.

## View areas: where the phone puts the car [car + harness, 2026-11-04]

Google Maps (iOS 26.7.1) on the second display, frames taken from the stream
on the car:

- **Without view areas** it puts the car low and to the left, and the
  directions card top right. Measured across shapes: about 30 % across at
  936x480 and 1056x576, 24 % at 624x480. The size the phone is offered is
  followed exactly; the layout doesn't change with it.
- **The view (`initialURL`) is followed.** `.../map` dropped the card; the car
  stayed where it was.
- **With view areas** (`enabledFeatures [altScreen, viewAreas]` at SETUP, and
  the records in `/info`) the phone accepted the session first time
  (`refusals=0`) and laid the view out in the safe area:

  | Safe area on 936x480 | Car | Card |
  |---|---|---|
  | 600x400 at 168,40 | x ~303, a quarter across the area | inside the area, top right |
  | **340x330 at 298,80** | **x ~466, centred** | **above the car, centred** |

  A narrow area stacks the card over the car, as the Audi work found for its
  big-dials layout.
- **The records** (from joeyQuery/MHI2-altScreen, `add_reference_viewarea`):
  in the second display's record, `viewAreas: [{widthPixels, heightPixels,
  originXPixels, originYPixels, drawUIOutsideSafeArea: false,
  viewAreaTransitionControl: false, safeArea: {widthPixels, heightPixels,
  originXPixels, originYPixels}}]` and `initialViewArea: 0`. Mode `full`'s
  refusals came from answering `viewAreas` without them.
- **Baked into hook111 0.1.4:** a `safearea` file (`x,y,w,h`) gives the records
  and the feature; the Cast tool writes 340x330 at y 40, centred across the
  map's width. A CF `false` for the two flags comes from the library's own
  plist reader (a 45-byte binary plist `[false]`).
- **The real stream size** is now read from each AVCC's SPS
  (`annexb_avcc_size`, `b_size=` in the status), which is how the shapes above
  were measured; the `display=` line is only what was offered.

## The cluster scene: showUI and its URL [car + harness, 2026-11-04]

Tried from the bench channel (`send.plist`) on the car, hook111 0.1.4, Google
Maps, iOS 26.7.1, 984x480 with view areas. Background from
luka-dev/mib2q-carplay-rgi (`docs/cluster-and-rgi/THIRD_PARTY_NAV_APPS.md`):
DashBoard parses the cluster URL's query into the scene settings
(`showETA`, `maneuverLayout`, `showSpeedLimit`, `showCompass`).

- **`showUI {uuid: <the second display>, url}` switches the cluster scene at
  once**, and did not cost the main screen (unlike answering `suggestUI`).
  The phone takes a new URL each time it changes; sent on a fresh stream it
  takes the same URL again.
- **The query applies through `showUI` only.** The same URL as `/info`'s
  `initialURL` changed nothing.
- **The cards** (centred safe area 340x330 / 340x435):

  | URL | Cluster |
  |---|---|
  | `maps:/car/instrumentcluster?showETA=yes` | directions card (top), time / distance card (bottom) |
  | `…?showETA=no` | directions card only |
  | `…?showETA=yes&maneuverLayout=topAligned` | time / distance card only (naming a layout hid the directions card on the narrow area) |
  | `…?showETA=yes&maneuverLayout=leftAligned` | the card at the safe area's left, the car pushed right |
  | `…/map` | no cards, road names on the map |
  | `…` (no query, from `showUI`) | no cards at all |

  On the wide 1056x384 with no safe area: `topAligned` showed both cards
  (with distance left), and `/map?showETA=yes` the time / distance card alone,
  bottom right.
- **Not seen:** `showCompass=yes` (Google Maps draws none); `showSpeedLimit=yes`
  showed nothing parked on a residential street (to try while driving).
- **Zoom:** `changeMapZoomLevel {uuid, zoomDirection}` 0 in, 1 out, at once.
- **View areas switch live:** with two in `/info` (`[0]` the safe area, `[1]`
  the whole display), `initialViewArea 0` and `adjacentViewAreas []`,
  `updateViewArea {uuid, viewAreaIndex 1, adjacentViewAreas [0],
  animationDurationMillis 300}` moved to Maps' own layout and back (`0`, `[]`),
  no reconnect.
- **The card layout** follows the safe area: the directions card its top edge,
  the time / distance card its bottom, the car between (lower without the time
  / distance card). The owner's pick on 984x480: 340x435 at y 20.
- **No effect:** the declared physical size (150 vs 180 mm wide) on the card
  size.
- **Built in (hook111 0.1.5):** files `url` (sent as `showUI` once per stream
  and on a change), `viewarea` (`initialViewArea`, and `updateViewArea` on a
  change), `zoom` (taken and sent); checked from the frame pump every 500 ms.
  `setup_b.c` checks each against a fake phone on the library's events
  connection.

## Loading into carplay [facts + static + harness, 2026-11-04]

- `carplay.service`:
  - runs as `cia_13002`, with `WatchdogSec=30`;
  - `Environment="LD_PRELOAD=/usr/lib/libschedconfig.so.1"` already, and it
    loads (`libschedconfig.so.1.0.0` is in the running `carplay`'s maps), so
    `carplay` isn't in secure-execution mode;
  - has no drop-ins, and `OnFailure=mediaddpserver_kill.service`;
  - recmgr's lists have no `carplay`.
- `libNmeCarPlay.so` isn't linked into `carplay`; only `libNmeSDK.so` is.
  It's a plugin, `dlopen`ed through `libNmeBaseClasses.so`
  (`dlopen@GLIBC_2.2.5`). So the preload installs the hook right after that
  `dlopen`. An unversioned `dlopen` in a preloaded library satisfies the
  versioned reference (harness-preload).
- `EnvironmentFile=` values override `Environment=`, so the env file carries
  the stock preload too: `LD_PRELOAD="/usr/lib/libschedconfig.so.1
  /var/opt/hook111/current/libhook111.so"`. The arm step reads the stock value
  from `systemctl show carplay.service -p Environment` and doesn't arm when it
  can't.
- The unit's `/bin/sh` is busybox ash (`busybox.nosuid`), with no `timeout`
  applet. It does have fractional `sleep`, `local`, `flock`, `sha256sum`.
