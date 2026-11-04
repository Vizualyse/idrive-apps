# Changelog

## 0.3.1

- CarPlay second screen: on / off. Sets hook111's mode (alt or off) for this
  start and saves it for later starts; says when a change applies only from
  the phone's next connection or the next start. Off stops a second screen
  that is playing.
- Requires vizualyse-cast 0.3.1.

## 0.3.0

- CarPlay map on the cluster / on the HUD: CarPlay's own second screen (its
  cluster map), through hook111, in place of mirroring the central screen.
  Available only while hook111 is armed and ready.
- The central-screen mirror and its Google Maps layouts are gone.
- Requires vizualyse-cast 0.3.0.

## 0.2.0

- Cast to cluster on/off on the page: off stops what plays, hides the QR
  code and closes the phone page.
- Mirror Google Maps on the cluster (banner, map and readouts stacked) and on
  the HUD (banner and readouts beside the map), from the central screen.
- The QR code on the cluster is off by default: with navigation up the
  cluster draws its direction list over it. This page always shows it.
- Requires vizualyse-cast 0.2.0.

## 0.1.0

- The page: status, the phone link as a QR code and as text, Stop, Play last
  on the cluster map / the HUD / this screen, the cluster QR code on or off.
