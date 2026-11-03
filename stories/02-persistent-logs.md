# 02 · Logs that survive a restart

## Why

The head unit's journal is in RAM (`/var/log` -> `volatile/log`). The BC hang
needed a full car restart, which erased every log of it. Next time we need
the tool's log and cluster-render's slot events from before the restart.

## Work

- The service writes its own log lines to `/var/opt/vizualyse-cast/log/cast.log`
  as well as the journal, rotated at about 1 MB, keeping 3 files.
- A follower (`journalctl -f -u cluster-render -o short-iso`, filtered to
  `dcsm`, `target`, `take-over`, `refused`, warnings and errors) appended to
  `/var/opt/vizualyse-cast/log/render.log`, same rotation.
- Each start writes a header: boot id, versions (tool, cluster-render,
  mgu-render), settings.
- A "Logs" link on the phone page (token-protected) to download them; the
  iDrive page shows the last few lines.
- `/var/opt/vizualyse-cast` is removed on uninstall: say so in the README.

## Done when

- After a head-unit reboot, the previous boot's tool and renderer lines are
  in `/var/opt/vizualyse-cast/log`.
- Disk use stays under about 8 MB.
