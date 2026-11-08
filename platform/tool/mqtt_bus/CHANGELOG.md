# tool/mqtt_bus

A version is frozen once a newer one exists. A component moves to a new
one with `node platform/platform.js use tool/mqtt_bus <version>`.

## 1.0.0

New: `mqtt_bus.js`, the tools' side of the shared bus (native/vizualyse-bus,
Mosquitto on `/run/vizualyse-bus/mqtt.sock`): a minimal MQTT 3.1.1 client for
Node 8 with no dependencies (QoS 0, retained messages, a last will,
keep-alive, reconnection every 5 s) and on it the asks: `ask(what, why)`,
`asked(name, value)`, `state()`, `close()`, an `asks` event. Its test
(`test/mqtt_bus_test.js`) runs against the real broker:
`native/vizualyse-bus/test/run_test.sh`. Used by vizualyse-steam (asks) and
vizualyse-cast (honours).
