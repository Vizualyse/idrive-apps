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
  0640 and silences CarPlay until a restart. 0.2.1 makes the lock as the
  system does (`ent_alsa:mgu_alsa` 0660) first.

