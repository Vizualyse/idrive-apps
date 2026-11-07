# Game compatibility (vizualyse-steam)

Which Steam games run on the head unit through vizualyse-steam (Proton,
WineD3D on Mesa 19 i965, [games.md](games.md)). Only **Supported** has run
on the car; everything else is judged from the game's engine, renderer,
minimum specs and input against the unit's limits below. Move a game when
it has been tried, with the date and version. Index: [index.md](index.md).

| Status | Meaning |
|---|---|
| **Supported** | Ran on the car (date, version) |
| **Unsupported** | Can't run as things stand (the reason is a hard limit, not speed) |
| **Untested (Should work)** | Fits every limit with room to spare |
| **Untested (Might work)** | Fits on paper, but near the speed limit or with an open question |

## The unit as a desktop

Atom A3960 = the car version of the Pentium N4200 / J4205 (Apollo Lake,
2016): 4 Goldmont cores up to 2.4 GHz, HD 505 (Gen9, 18 EUs), shared
LPDDR4. Roughly:

- CPU: a Core 2 Duo at ~2 GHz per core, a Core 2 Quad Q6600 across four.
- GPU: Intel HD 4000 / GeForce 8600 GT-9500 GT, with less bandwidth (shared
  with the CPU and the HMI's own 3D).
- RAM: the game's cgroup cap, 2.5 GB by default, Wine and Proton included.
- Less than that desktop in practice: the HMI, the map and mgu-render keep
  running, and the unit is passively cooled in the dashboard.

**Picture size:** the app area is 1790x638, so a 16:9 game is shown at
1134x638. Count on **~1136x640 or 960x540 at 30 fps**; more pixels are
scaled away and still cost the frame path (wl-sink: 34 ms a picture at
1280x720 with FTL, 2026-11-07).

## Rule of thumb

Should work when all of these hold:

- minimum GPU no higher than **HD 4000 / GeForce 8600 / Radeon HD 4650**;
- minimum CPU no higher than a **2 GHz dual core**, RAM **2 GB or less**;
- **OpenGL natively** (Godot 3/4 `opengl3`, Unity `-force-glcore`, LÖVE,
  libGDX, SDL+GL) or **D3D9**; D3D10/11 only when the game is light; a
  native-GL game must not want a *compatibility* context above 3.0 (Mesa 19
  i965: 3.0 compat, 4.5 core);
- playable with a **wired XInput pad** or **left click / drag only** (no
  keyboard, right click or hover on touch);
- single-player, offline, no Steam DRM wrapper (SteamStub), no anti-cheat.

Hard limits (Unsupported): D3D12 or Vulkan only (no Vulkan on the 4.14
kernel); .NET Framework / XNA (no Wine Mono); SteamStub, anti-cheat,
online-only; Games for Windows Live; needs more than the RAM cap.

## Supported

| Game | Engine / renderer | Notes |
|---|---|---|
| Slay the Spire 2 | Godot 4, `--rendering-driver opengl3`, .NET 9 | 64-bit; needs **Run without Steam** (gbe_fork). Hover tooltips need a pad. |
| FTL: Faster Than Light | Custom, OpenGL, 32-bit | Runs with 0.1.3's rebuilt `ntdll.so` (2026-11-07): 15 pictures/s, 2.0 GB of the 2.5 GB cap. Only half playable: needs Space (pause) and right click, no pad support. |

## Untested (Should work)

| Game | Engine / renderer | Notes |
|---|---|---|
| Balatro | LÖVE, OpenGL 2.1 | Minimum specs far below the unit; pad and touch both natural. Best first try. |
| Slay the Spire | libGDX (bundled Java), OpenGL | Pad support. |
| Brotato | Godot 3, OpenGL | Pad support, light 2D. |
| Dome Keeper | Godot 3, OpenGL | Pad support. |
| Stardew Valley (1.6) | MonoGame, .NET 6 bundled | Trivial specs, full pad support. Check the Windows renderer (GL or D3D11). |
| Into the Breach | Custom | Low specs, click-only play. |
| Baba Is You | Custom | Very light, pad support. |
| Papers, Please | OpenFL / Haxe | Mouse-only, drag-heavy: fine on touch. |
| Mini Metro / Mini Motorways | Unity, `-force-glcore` | Touch-first games. |
| Peglin | Unity, `-force-glcore` | Click / pad, light. |
| Cobalt Core | MonoGame-style 2D | Pad support. Check its .NET runtime (bundled, not Framework). |
| Undertale / Deltarune | GameMaker, D3D9 | Very light; needs a pad (keyboard game otherwise). |
| Darkest Dungeon | Custom, OpenGL | Pad support. Check which GL context it asks for (above). |

## Untested (Might work)

| Game | Engine / renderer | Why only "might" |
|---|---|---|
| Hollow Knight | Unity, `-force-glcore` | Minimum GPU (9800 GTX+) above the unit's; 2D, so 960x540 should hold. Pad needed. |
| Vampire Survivors | Unity, `-force-glcore` | Late runs with thousands of sprites will drop frames on the Atom. |
| Dead Cells | HashLink, D3D11 or OpenGL | Use its OpenGL mode; pad needed. |
| Loop Hero | GameMaker Studio 2, D3D11 | D3D11 through WineD3D, but light 2D. |
| Monster Train | Unity, `-force-glcore` | Busy effects; click-driven. |
| Halls of Torment | Godot 4, compatibility renderer | Many sprites late in a run. |
| Half-Life 2 / Portal | Source, D3D9 | Specs fit (2004-07). Needs gbe_fork, the Source pad config; Valve's DRM untested here. |
| Portal 2 / Left 4 Dead 2 | Source, D3D9 | Pad support built in; min GPU (GeForce 7600 / Radeon X800) fits, CPU tight: 960x540 lowest, ~30 fps at best. |
| 2007-2011 3D console ports | UE3 / Gamebryo / IW, D3D9 | See below. |

## Untested (Might work): 3D games of the Black Ops 1 era (2008-2011)

**Call of Duty: Black Ops (2010)** asks for a Core 2 Duo E6600, 2 GB RAM, a
GeForce 8600 GT / Radeon X1950 Pro, D3D9c: right at the unit's level,
before Wine's cost. On paper it starts; in practice:

- **Speed:** WineD3D's D3D9 translation is CPU work per draw call, on the
  unit's weakest point (one Atom core). These games are draw-call heavy and
  32-bit, so each GL call also goes through new WoW64's 32-to-64-bit thunk.
  Expect **15-25 fps at 960x540 lowest** in the campaign, worse in big
  fights.
- **Input:** Black Ops 1 on PC **has pad support** in play, but its menus
  want the mouse (the user, 2026-11-07): here touch is the mouse, so a tap
  on the menus and the pad in play should do. There is **no aim assist**
  with a pad on PC, which makes the campaign harder, more so at a low frame
  rate. Modern Warfare 1/2 on PC: pad support unchecked.
- **DRM:** Activision's Steam builds use Steam's DRM; whether gbe_fork gets
  past it is unknown. Multiplayer (VAC) is out.

So Black Ops 1 is **Untested (Might work)**: the controls fit (touch for
menus, pad in play), the speed and the DRM are the questions. The same era
goes better where the game has **XInput pad support** and a light CPU
load:

| Game | Engine | Notes |
|---|---|---|
| Call of Duty: Black Ops | IW engine, D3D9, 32-bit | Pad in play (no aim assist), menus by touch; CPU-bound; Steam DRM. See above. |
| Call of Duty 4: MW / MW2 | IW engine, D3D9, 32-bit | Pad support on PC unchecked; Steam DRM. |
| Portal 2 / Left 4 Dead 2 | Source, D3D9 | Pad support; the best bet of this era. |
| Fallout: New Vegas / Fallout 3 | Gamebryo, D3D9, 32-bit | Pad support; CPU-heavy in towns. Fallout 3 only in a release without Games for Windows Live. |
| Mirror's Edge (2009) | UE3, D3D9 | Pad support; turn PhysX off. |
| Dead Space (2008) | D3D9 | Pad support; low minimum GPU (GeForce 6800). |
| Batman: Arkham Asylum GOTY | UE3, D3D9 | Pad support. Unsupported while its Steam build still needs Games for Windows Live. |
| Skyrim (2011 original) | Creation, D3D9, 32-bit | Delisted; only if owned. Pad support, heavy. Special Edition is D3D11, 64-bit: heavier still. |

## Unsupported

| Game | Why |
|---|---|
| Terraria | XNA, .NET Framework (no Wine Mono) |
| Celeste | FNA on .NET Framework (Windows build) |
| Rogue Legacy | XNA, .NET Framework |
| Hades | D3D11 / Vulkan only, GPU-heavy; no OpenGL path |
| Cuphead | Heavy D3D11 and sprite memory; minimum GPU above the unit's |
| Any D3D12 / Vulkan-only game | No Vulkan on the 4.14 kernel ([browser.md](browser.md)) |
| Games with anti-cheat, online-only, SteamStub | No Steam client; gbe_fork doesn't cover DRM wrappers |
| Games for Windows Live titles | GFWL doesn't run here |
| 3D games with a GTX 4xx / HD 5xxx or newer minimum | Far past the HD 505 before Wine's overhead |
