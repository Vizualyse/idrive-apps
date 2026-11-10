# Sound

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- Every source writes to a named SmartXbar input (`smartx:<name>`); the
  audio manager decides which reaches the speakers. `CarPlayMain_CF_48_STEREO`
  plays while CarPlay is (or nothing else is) the source.
- No `aplay` on the unit: Python (mgu-python 3.12) with ctypes and
  libasound works with nothing to compile.
- The first open of an input after boot can take a long time to connect
  (2 s of audio took 52 s once); after that it is real time.
- So a live stream must drop, not queue: Moonlight 0.1.1 wrote every sample
  and the game's sound stayed seconds behind the picture after such a stall
  (2026-11-05). `pcm_play.py --live` reads its input empty, keeps the device
  60 ms full and drops what waits beyond 60 ms. `snd_pcm_set_params` starts
  playback only once the whole buffer is full, so a device kept part full
  needs a lower start threshold (sw params).
- *(ref: IterioDev, an iDrive 8 SDK config in a bundle)* oap-sdk has an
  OAP **media player** (`mediaPlayer` settings; instances `OapGenericMedia`
  entertainment, `OapGenericOverlay`, `OapGenericInterrupt`). It may be how
  an app becomes a real entertainment source with the iDrive volume on it:
  look for `OapGenericMedia` / `mediaPlayer` in the unit's oap-sdk 24.x and
  `/etc/oap/someip/someip-interfaces.json`. The SDK's `registerAudioFocus()`
  only sets a status. A root tool can reach SOME/IP services through
  `/usr/lib/someip.node` ([vehicle-data.md](vehicle-data.md)).
- *(ref: upstream)* Wireless CarPlay on 2.4 GHz plus a cluster stream made
  the sound cut out; everything runs at nice 0 so nothing starves CarPlay's
  audio threads.

## The audio manager (tests on our unit, 2026-11-05)

GENIVI AudioManager with BMW's control plugin (`AudioManager -c
libPluginControlInterfaceBMW.so`, user `ent_audiomanager`); its config is
protobuf in `/usr/share/audiomanager/*.bin`. Root reaches it over SOME/IP
through `/usr/lib/someip.node` (call from a fresh `setImmediate`, and register
`subscribeToAvailability` before calling methods, or every call fails with
"Service unavailable for call ..."). Interface JSONs for the binding are made
from `/etc/oap/someip/someip-interfaces.json` by `tools/someip_iface.py`
(matches BMW's generator on 125 of the main app's 131 methods).

- `CommandControl` (svc 45088, inst 1): `getListMainSources/Sinks/Connections`
  (read-only, safe), `connect(sourceID, sinkID)`.
- `RoutingControlObserver` (svc 45090, inst 1):
  `hookSourceAvailablityStatusChange(sourceID, {availability, reason})` is
  accepted from root and changes a source's availability.
- IDs: **entertainment sources connect to `MediaSink_Front` (1024)**, not to
  `MainSink` (1; `connect(x, 1)` gives `E_UNKNOWN`). Radio `FmDABCombined` 1,
  `CarPlayMedia` 266 (physical stream `CarPlayMain` 385), `OAPGenericMedia`
  1046, BT `ExternalDeviceBtA` 1033, USB 1035. Radio with no station tuned is
  silent while connected.
- **`OAPGenericMedia` (the Store apps' media source) plays, without CarPlay,
  with the iDrive volume** (2026-11-05, after a restart): `connect(1046,
  1024)` (E_OK, the radio drops), then `MediaPlayer.playFile` (instance
  `OapGenericMedia`) with a plain path: a 48 kHz WAV and an MP3 in `/run`
  both played in full, `PLAYER_STATE_PLAY` ~40 ms after the call,
  `currentItemTime` every 250 ms. The source lives in `DOMAIN_MGU_ENCODED`
  (CF_TS): the sound comes from `mediaapp`/`mediaengine` (`ent_meng`), not
  from a PCM stream we write. Without a connected source `playFile` does
  nothing. The HMI switches back to the radio by itself ~10 s after a connect
  with nothing playing. (Earlier tries that stopped after 0.2 s were broken
  by a test player of ours blocking the media output, below.)
- `smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL` takes 8
  channels only, and is not what plays for the OAP source.
- **`CarPlayMedia` without a phone:** marked available through the routing
  interface, `connect(266, 1024)` is accepted but stays `CS_CONNECTING`
  (nobody acknowledges the domain's connect); restored afterwards. A
  Miracast connection hung the same way once.
- A player writing into a SmartXbar stream that nothing consumes blocks in
  its write and keeps the device busy ("Device or resource busy" for the next
  opener): kill test players that outlive their run.
- DLT: `dlt-daemon` runs but serves no TCP (no 3490); `dlt-receive` on the
  unit can't connect. BMW ships `firewall-dlt-tracing-*-open.sh` for tracing.
- **Who must say yes:** each PCM stream's owner provides BMW's
  `de.bmw.infotainment.am.amsourceinterface.AmSourceControl` (svc 63363,
  an instance per owner, e.g. `CiaCarPlaySourceDefault` = the carplay
  process) with a `SourceAvailabilities` field and `ack*` events for the
  routing adapter's `asyncSetSourceState`. Without a phone the carplay process
  reports 266, 270, 385 and 397 `A_UNAVAILABLE` there: marking 266 available
  in the audio manager doesn't get the connection through.
- Owner instances nobody provides on our car (22 of 64) include
  `EntertainmentAudioCDFront` (`AudioCD_Front` 281) and `SdarsIPSource`
  (`SDARS_IP` 286), both entertainment PCM, but neither source is registered
  with the audio manager (coding, `CodingFlags.bin`, IDs 10000+).
- Moonlight runs `pcm_play.py` as root: a SmartX lock it creates is root's
  0640 and silences CarPlay until a restart. 0.2.1 meant to make the lock
  as the system does first, but looked up a user `ent_alsa`: the account is
  `ent_alsaroutingadapters` (uid 4032; `ls` shows 8 characters), so it never
  did. `tool/pcm_play` 1.0.1 takes `/run/smartx`'s own owner and group
  (`ent_alsaroutingadapters:mgu_alsa`, 2770 from tmpfiles.d), 0660
  (2026-11-10, emulator).
- `tool/speakers` ([platform](../platform/tool/speakers/CHANGELOG.md)) is
  the section below as a module: claim / release CarLife's source for a
  tool's sound.

## Our own entertainment source: CarLife's (emulator, 2026-11-10)

Not yet tried on the car. Tools: [tools/am-source](../tools/am-source/amsrc.js);
the emulator's side of it below.

- **`CarLifeMedia` (287) plays our PCM as the front entertainment source,
  with no phone**, in the emulator: as root, `hookSourceAvailablityStatusChange
  (287, A_AVAILABLE)` on RoutingControlObserver, then CommandControl
  `connect(287, 1024)` -> CS_CONNECTED. Its SmartXbar input
  `smartx:CarLifeMedia_CF_48_STEREO` then reaches the amplifier (a 1 kHz tone
  arrived intact on the AVB gateway), and every iDrive volume step reaches
  the amplifier's input as `asyncSetSinkVolume(129, v)`: the amplifier
  applies the volume, SmartXbar passes our samples unchanged.
- Why 287: it is entertainment class 1 like CarPlayMedia and the CD, in
  DOMAIN_MGU, 48 kHz stereo, allowed on 1024, and registered without a coding
  flag (field 16 of its DOMAIN_MGU.bin entry; the CD's 281 needs 10022, SDARS'
  286 needs 10124). CarLife is Baidu's, China only; `carlife` runs on our car
  anyway and owns the slot (`CarLifeSourceDefault`), reporting
  `SourceAvailabilities` [] without a phone, but **it acknowledges
  asyncSetSourceState SS_ON with E_OK** (CarPlay's owner, per 2026-11-05, left
  the connect hanging).
- How a connect runs (DLT): CommandControl.connect -> the control plugin's
  `MediaSinkFront` (refuses "is not started" until the Lifecycle power state
  is FULL_ON_USER_ON or ENTERTAINMENT_MODE_USER_ON, 99/100) -> route 287 ->
  394 (MGU_GW_2_SINK, SmartXbar, AlsaRoutingAdapters) -> 647 -> 643 (AVB) ->
  145 -> 129 (InputA_Main, the amplifier) -> CS_CONNECTED -> asyncSetSourceState
  287 SS_ON, which the routing adapter passes to the owner's AmSourceControl
  -> a volume control on MainSink 1 for the connection.
- The audio manager keeps the last heard front source
  (`LUM_LastHearedSourceMediaSinkFront`) and resumes it after a restart: a
  test must end on the radio (`connect(1, 1024)`).
- **Registering a source is refused**: `registerSource` for 281 (as
  ent_mapp, serving the CD's owner instance) gives E_UNKNOWN, and
  `peekSource` of an unknown name only reserves an ID (16384+).
- vsomeip policy: AmSourceControl owners are visible only to the routing
  adapter (4032) and ent_mapp (4100:4150); root sees none of them. ent_mapp
  may offer AmSourceControl and RoutingControl and call the routing
  observer; only ent_avbsourcesinkcontroller (4033:4030) may offer
  AVBSource / AVBSink.
- Owners offered in the emulator: ConnectivityHfpSourceInterface,
  ConnectivitySimpleHandsfreeSourceSink, ICAMProxy, AudioWaveplayer,
  CarLifeSourceDefault (`amsrc.js owners --uid=4100 --gid=4150`).
- Decompiling BMW's audio code: Ghidra took `CAmDltControlLogger::instance()`
  for non-returning and cut every function at its first log call;
  `re/ghidra/KeepReturns.java` (now in `re/run.sh decompile-all`) fixes it.

### The emulator's car audio

The emulator now runs the whole route ([emu-audio.sh](../tools/am-source/emu-audio.sh),
then [emu-test.sh](../tools/am-source/emu-test.sh)). What it lacked:

- **The amplifier** (DOMAIN_RAM, another ECU): the audio manager's lifecycle
  waits for it, and without it MediaSink_Front is never started.
  `domain-sim.js ram` registers it and acks everything.
- **mediaapp's DOMAIN_MGU_ENCODED** (where MediaSink_Front lives): the
  emulator's mediaapp never offers it (it drops to non-verbose logging after
  reading its config, so it doesn't say why). `domain-sim.js encoded`.
- **AVB** (masked): the head unit's AVBSourceSinkController and the
  amplifier's side. `avb-sim.js` registers both sides' gateway ends with the
  audio manager's AVB routing plugin and acks connect / startStream. BMW's
  own `AVBSourceSinkControllerRAMsim` ships on the unit but never reports its
  ends available.
- **The AVB ALSA devices** SmartXbar plays to the amplifier through
  (`plug:avb:MGU_GW_*`): snd-aloop cards in the emulator's kernel, one
  substream per device, each through ALSA's file plugin, so a recorded device
  is a WAV in `/run/avbcap` ([90-emu-avb.conf](../tools/mgu-emu/overlay/usr/share/alsa/alsa.conf.d/90-emu-avb.conf)).
- **Power state**: Lifecycle comes from the unit's NodeStateManager, not
  carsim's copy, derived from the vehicle condition: carsim's default PWF
  WOHNEN gives WELCOME_SCREEN (media sink stopped); FAHREN gives
  FULL_ON_USER_ON (carsim's new `set SERVICE FIELD JSON` command).
- DLT local print for the audio services (`DLT_LOCAL_PRINT_MODE=FORCE_ON`,
  level 4) needs journald's rate limit off, or the startup is lost.
- someip.node: a fixed-length array (catalog `arrayLengthWidth` 0, AVB's MAC
  addresses) is `{"t": "ArrayF", "l": 6}`; as ArrayD every such message
  fails "Buffer overflow" (`tools/someip_iface.py` emits it now).

