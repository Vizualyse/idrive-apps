# 08 · Control socket hardening

## Why

`/dev/shm/vizualyse-cast/ctl.sock` is mode 0660, group `tm_oap_app`: every
Store app on the head unit is in that group, so any of them can read the
phone link **with its token** and send stop / mirror / disable.

## Work

- Check the peer with `SO_PEERCRED` (Node 8 has no API: read
  `/proc/net/unix` and the peer's `/proc/<pid>/status`, or a tiny native
  helper) and accept only the Cast app's uid (the app manager gives it a fixed
  uid at install: find where it is recorded, e.g. `custom_apps.json`).
- Or: no token in the status; the app asks for the QR PNG, which the tool
  writes in a folder only the app's uid can read.
- Rotate the token on demand (a button on the iDrive page).

## Done when

- A process in `tm_oap_app` that is not the Cast app gets nothing from the
  socket.
