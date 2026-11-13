# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

Every surface is HTML/JS: phone pages, the iDrive app pages (RHMI), and what
the tools draw for the head unit's screens. They are not browser websites,
though: they run on a BMW iDrive 7 head unit (MGU, `I_21w12.2-1-4`) and are
shown on the car's screens through cluster-render (instrument cluster and HUD)
and mgu-render (central screen).

## Users

- **Cluster themes:** enthusiast owners of iDrive 7 cars (G-series, Live
  Cockpit Professional 12.3" cluster) who want a performance display for
  spirited or track driving and to show the car off. Drama is welcome; the
  display is still read at a glance while driving.
- **The rest of the suite** *(inferred from the README, not confirmed in the
  interview)*: owners who install from the mgu Store. They cast video to the
  cluster, HUD or central screen (Cast). They stream PC games with Moonlight or
  run Steam games. They browse on the central screen. They control most of
  this from their phone.

## Product Purpose

Vizualyse adds what BMW's stock software does not offer: phone video and
CarPlay's map on the cluster and HUD, games and a browser on the central
screen, and custom fullscreen cluster themes. Users switch between themes by
hand or by drive mode (Sport, Comfort). Success means each feature works on a
real car without harming the car's own displays or warnings.

## Positioning

These apps run on the car's own head unit and draw on the car's own screens.
They need no added hardware, and the car's own cluster comes back when an app
is switched off. The cluster themes draw over BMW's scene through
cluster-render's whole-cluster target. They leave the car's warning lights and
bottom strip visible.

## Operating Context

- Installed and updated from the mgu Store (Releases channel). Each tool needs
  its prerequisites: mgu-deploy, mgu-python, mgu-uplink, cluster-render,
  mgu-render.
- Used in the car, often while driving. Controlled from the iDrive controller,
  the touch screen, the steering wheel, or a phone page.
- Development is off-car first: emulators and harnesses, a bench head unit,
  then the car. Releases are built by CI.

## Capabilities and Constraints

- **Cluster:** the whole-cluster target is 1920×720 and is drawn over BMW's
  gauges and under the warning lights. The car's own strip (y ≥ 646) stays
  clear. Areas hidden by the cluster glass and the driver-camera cowl are to be
  avoided.
- **Cluster upload budget:** about 5,500 KB/s, shared. Shader layers are
  favoured over video for themes.
- **Hazards:** heavy shaders have restarted the cluster on other people's cars.
  Taking over BMW's content is risky.
- **HUD:** about 800×480, with a limited visible area. Black shows as
  transparent.
- **Units:** UK. Speed in mph, distances and range in miles, temperatures in
  °C.
- **Licensing:** GPL-3.0-or-later. Some files are MPL-2.0 or MIT, as their
  headers say.
- **Undecided:** which vehicle signals each theme can actually read, and how
  themes are packaged and switched in the Store app.

## Brand Commitments

- The name is Vizualyse. Apps are named Cast, Moonlight, Steam and Browser.
- The cluster themes may echo car-maker styling (BMW G20 and LCI clusters, a
  Porsche-style cluster). They must **never use BMW or Porsche marks**: no
  roundels, M stripes, wordmarks or proprietary typefaces. A gear readout
  such as "M4" (manual mode, 4th gear) is not a mark and is fine.
- The cluster themes should **feel factory-fitted**, as if they came with the
  car, not like an aftermarket skin.

## Evidence on Hand

- Facts measured on our unit: `knowledge/` (start at `knowledge/index.md`),
  including `knowledge/cluster-and-hud.md`.
- What other projects learned: `knowledge/reference-repos.md` and
  `re/references.md`.
- Cluster theme mockups (eight boards: four styles, each in Sport and Comfort):
  https://claude.ai/artifact/Vf25Jm1QRZ87dGBo8ZTy6A
- **Absent:** none of the cluster themes has been tested on a car. Tyre
  pressure and temperature, oil temperature, boost, engine and electric power,
  and battery charge are not yet confirmed as signals we can read. User
  numbers, testimonials and press do not exist and must not be invented.

## Product Principles

1. **Real data only.** A shipped theme shows only readings the car actually
   provides. Mockup values are placeholders, never claims.
2. **The car's own safety display wins.** Warning lights, the bottom strip and
   BMW's pop-ups are never covered or imitated.
3. **Off means stock.** Switching an app off returns the car's own display
   unharmed.
4. **Factory feel, own marks.** Look like it belongs in the car, without
   borrowing anyone's trademarks.
5. **Proven on the car, not just on the bench.** A result counts only once it
   has run on a real unit, and hazards found there are written down.
