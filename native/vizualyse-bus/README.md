# vizualyse-bus

The Vizualyse tools' shared bus: how one tool asks the others to switch
something off while it needs the car's resources, and gets it back on when
it is done. Steam asks for the cluster's and the HUD's video off while a game
runs; Cast pauses a stream or CarPlay's second screen there meanwhile and
starts it again afterwards.

- **The broker:** Eclipse Mosquitto 2.0.21 (MQTT 3.1.1 / 5), built for the
  unit (`build.sh`: Ubuntu 18.04, glibc 2.27, the unit's loader; no TLS,
  WebSockets, bridges or persistence; ~210 KB), as the systemd service
  `vizualyse-bus` (`systemd/vizualyse-bus.service`).
- **Who reaches it:** one listener, a Unix socket,
  `/run/vizualyse-bus/mqtt.sock`, in a folder systemd makes root's and 0700:
  only root's tools. Not a game (Wine runs as uid 12996), not the browser's
  pages, nothing on the network: there is no TCP listener, and the service
  has no network namespace of its own to listen in (`PrivateNetwork`). It
  runs as root with no capabilities at all (`CapabilityBoundingSet=`), 32 MB
  at most.
- **The client:** the platform module `tool/mqtt_bus` (`mqtt_bus.js`, Node 8,
  no dependencies), copied into each tool that uses it.

## Asks

Each tool has one retained topic, `vz/ask/<tool id>`, holding what it asks of
the others now:

```json
{"ask": {"cluster-video": "off", "hud-video": "off"}, "why": "Slay the Spire is running", "at": "2026-11-08T02:40:00.000Z"}
```

An empty message clears it: the tool's next ask, `ask(null)`, a clean stop,
or, when the tool dies or its connection goes, the broker itself (the
connection's last will). Every tool subscribes to `vz/ask/+`. So the state
is the set of live asks, not a stream of commands: a tool that starts late
sees every live ask at once (retained), and a tool that goes takes its asks
with it. Without the bus (not installed, stopped) nothing is asked and each
tool works as it would alone; a broker restart loses the retained asks, and
each tool sends its own again when it reconnects (5 s).

| Name | Meaning | Asked by | Honoured by |
|---|---|---|---|
| `cluster-video` | a tool's video on the instrument cluster: its decoding, cluster-render's upload | Steam and the Browser's game mode | Cast (a play on the cluster map pauses) |
| `hud-video` | the same on the HUD | Steam and the Browser's game mode | Cast (a play on the HUD pauses) |
| `browser` | the Browser tool's Chromium | Steam, while a game runs | the Browser (Chromium stops until nobody asks; in game mode only an ask made after game mode went on) |
| `steam` | a Steam game | the Browser, in game mode | Steam (a running game stops when the ask is made after it started) |

`steam` and `browser` follow "the newer start wins": each ask carries `at`
(when it was made, kept across reconnections; `asked()` returns it), and a
tool the user just started ignores asks made before that, so the tool that
asked earlier is the one that yields.

A new name goes in this table and in `platform/BUILDING-APPS.md` ("The bus").

## Off the car

```sh
sh native/vizualyse-bus/build.sh            # build/mosquitto, and Mosquitto's licences
sh native/vizualyse-bus/test/run_test.sh    # the client and Cast against it, Node 8, the unit's root filesystem
```

`test/run_test.sh` runs `platform/tool/mqtt_bus/<newest>/test/mqtt_bus_test.js`
(asks before the broker exists, retained for a late tool, cleared, a SIGKILLed
tool's will, the broker restarting, another user refused, no TCP listener)
and `native/vizualyse-cast/test/bus_test.js` (Cast's pause and start again)
as root in a container made from the unit's root filesystem; CI runs the
same in Ubuntu 18.04 with Node 8 (`BUS_TEST_IMAGE`).

## On the car

```sh
systemctl status vizualyse-bus
journalctl -u vizualyse-bus                      # Mosquitto: connections, by client id (the tool's)
journalctl -u vizualyse-steam -u vizualyse-cast | grep 'bus:'
```

Not yet run on the car (2026-11-08).
