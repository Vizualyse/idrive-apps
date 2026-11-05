# Internet (mgu-uplink)

Measured on one unit (head unit software `I_21w12.2-1-4`) unless a line says otherwise. Index: [index.md](index.md).

- mgu-uplink puts the head unit on the phone's hotspot, but routes **only
  listed uids** (`/var/opt/mgu-uplink/uids.d/`, a policy-routing table).
  It deliberately ignores uid 0: root never gets the internet.
  Root has no route to the hotspot's own subnet either ("Network is
  unreachable" to a PC next to the phone): a tool that talks to a device on
  the hotspot does it as its listed uid too.
- The unit's own resolver (127.0.0.1) does not resolve internet names. Use
  the uplink's DNS (the phone, from `/run/mgu-uplink/lease.json`).
- The firmware has no public CA bundle (only BMW's). Node carries its own;
  curl needs one supplied.
- What works: a small proxy running as an allowed uid (12999), resolving
  through the phone's DNS, with ffmpeg pointed at it (`http_proxy`). A Store
  tool declares `"internet": true` and its uids; the Store writes the
  uplink entry.
- iPhone hotspots disappear when idle: keep Settings > Personal Hotspot open
  (and Maximize Compatibility on) while the head unit joins.
