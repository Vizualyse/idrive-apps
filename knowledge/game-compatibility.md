# Game compatibility (vizualyse-steam)

Which Steam games run on the head unit through vizualyse-steam (Proton,
WineD3D on Mesa 19 i965, [games.md](games.md)). Only **Supported** has run
on the car; everything else is judged from the game's engine, renderer,
minimum specs and input against the unit's limits below. Move a game when
it has been tried, with the date and version. Index: [index.md](index.md).

The rows cover the owner's Steam library (about 280 games, 2026-11-07)
and a few others worth buying. Engines, renderers, specs and pad support
were placed **from memory, not yet checked** against store pages or
PCGamingWiki: check a game's before trying it, and correct the row.

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
1280x720 with FTL, 2026-11-07). Steam 0.1.10 draws at 960x540 by default
(848x480 and 640x360 for heavy games), capped at the tool's frame rate.

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

Hard limits (Unsupported): D3D12 only (no VKD3D on ANV 19); Vulkan 1.2+
only (ANV 19.1.8 is Vulkan 1.1); .NET Framework / XNA (no Wine Mono, yet); SteamStub, anti-cheat,
online-only; Games for Windows Live; needs more than the RAM cap.

Learned on the car (2026-11-08): **older engines need a screen of at least
640x480** (Unity 4 found "no video modes" at 896x320): use Picture 960x540
for them until the tool does it. **ANGLE games** (a `libEGL.dll` /
`libGLESv2.dll` beside the exe: Don't Starve) translate twice on WineD3D:
DXVK (32-bit from 0.1.14) is their way.

## Supported

| Game | Engine / renderer | Notes |
|---|---|---|
| Slay the Spire 2 | Godot 4 (MegaDot 4.5.1), .NET 9; Vulkan (Forward+) from Steam 0.1.9, `opengl3` with Vulkan off | 64-bit; needs **Run without Steam** (gbe_fork). Hover tooltips need a pad. On Vulkan on the car (2026-11-08, 0.1.11-0.1.12): about 18 fps at 896x320 (13-15 at 960x540), GPU about 100 %; animations slow, the rest smooth; **hangs at the enemy's turn every time on 0.1.12** (two Godot worker threads spin; its log ends at the monster's move). **2026-11-09, 0.1.14:** the hang the same on ANV 19.1.8, at the same move (`Monster LEAF_SLIME_S performing move TACKLE_MOVE`); **On patched ANV 22.3.7 (Vulkan 1.3.230, swapped in by hand, same day): past that move and on through the next turn**, so Mesa 19 (very likely its shader compiler) was the hang; about 19-24 fps at 896x320 with FSR once settled (GPU 95-100 % at 450 MHz), the first two minutes stalling on memory (the game 3.1 GB, 260 MB available, 1.8 GB swapped); felt far more fluid, faster from splash to menu. The pad was seen only two minutes in (`pads: player 1` at 14:04:35, the game at 14:02:41) and didn't work in the game: probably connected late (not proven). It loads slowly (about 30 s to its menu, longer on the screen); FSR runs (about 21/s at 8 ms GPU, wl-sink 0.6 ms a picture, 0.1.13's trim working). **Vulkan off (`opengl3`) doesn't work:** ANGLE is missing so it takes native GL (Mesa 19.0.6 i965, 4.5 core), and its scene shader fails (`packHalf2x16` / `unpackHalf2x16` in a `#version 330` shader), so the menu never draws. Its full screen window is 898x320 at -1,0 (FSR and the direct path need 0.1.13's trim). Taps scrolled its map until 0.1.12's 32 px dead zone. `--rendering-method mobile` makes it pick D3D12. |
| Vampire Survivors | Unity, DXVK (64-bit D3D11) | Runs (2026-11-08, 0.1.11): about 18-19 fps on its loading screen, 13-14 in play with FSR at 896x320; FSR and its live switching work (about 10 ms GPU a picture); Detail Lite and Potato start. Once stuck on its loading screen (waiting, not loading): Run without Steam if it happens again. |
| Don't Starve | Klei, **ANGLE** (GLES 2 on D3D9/11), 32-bit | Starts (2026-11-08, 0.1.12, WineD3D, 960x540) but about **2.5 fps**: GLES through ANGLE to D3D, then WineD3D back to GL; taps shorter than a frame missed; its window 964x518 at -2,11. Vulkan on 0.1.12 (ANV 19.0.6) fails ("Error initializing OpenGl ... OpenGL ES 2.0": no 32-bit DXVK there). **On 0.1.14's ANV 19.1.8 (2026-11-09): runs on Vulkan**, about 20 pictures/s on its menu, smooth in play with a pad; taps reach it (they drop the pad's focus) but still don't click (0.1.15's tap hold). Wants 1280x720 or 800x600 modes (warns, carries on at 960x540). |
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
| The Binding of Isaac: Rebirth | Custom 2D | Pad support, light. |
| Castle Crashers / BattleBlock Theater | Behemoth 2D | Pad-first. |
| Mark of the Ninja (original) | Klei 2D | Pad support. |
| Don't Starve | Klei 2D | Pad support. |
| BlazBlue: Calamity Trigger / Continuum Shift Extend | 2D, D3D9 | Fighting game, pad-first, very light. |
| Guilty Gear XX Accent Core Plus R | 2D, D3D9 | Fighting game, pad-first, very light. |
| Skullgirls 2nd Encore | Z-Engine, 2D | Fighting game, pad-first, low specs. |
| Star Wars: Battlefront 2 (2005) | D3D9, 32-bit | ~2005 specs, pad support; offline Instant Action. |
| GTA: San Andreas | RenderWare, D3D9, 32-bit | Tiny specs, pad support. Check the owned build needs no Rockstar launcher. |
| GTA III / Vice City | RenderWare, D3D8/9, 32-bit | Tiny specs; weaker pad support. Same launcher check. |
| Star Wars: KOTOR II | Odyssey, OpenGL | Aspyr's update added pad support. |
| Half-Life / Blue Shift / Opposing Force | GoldSrc, OpenGL, 32-bit | Tiny specs; pad support since the 25th-anniversary update. Run without Steam. |
| Counter-Strike: Condition Zero | GoldSrc, OpenGL, 32-bit | Offline bots. Run without Steam. |
| RetroArch | Native, OpenGL | Pad support; 8/16-bit cores (NES, SNES, Mega Drive, GBA) are light. |
| Dreaming Sarah / Vagante / Chime Sharp / Master Spy / Chronology / The Fall | Small 2D | Pad support. |
| Gunpoint (32-bit OpenGL, Cg) / Long Live the Queen / The Inner World / Train Valley / FreeCell Quest / Chainsaw Warrior / Deep Dungeons of Doom | Small 2D | Left click only: touch is enough. |
| Leaf Blower Revolution / Idle Skilling | Idle | Click only; suit a parked car. |

## Untested (Might work)

| Game | Engine / renderer | Why only "might" |
|---|---|---|
| Teslagrad | Unity 4.6, 32-bit, D3D9 | Tried 2026-11-08 (0.1.12): needs a screen at least 640x480 (at 896x320 Unity finds "no video modes"; 960x540 works, D3D9 on WineD3D starts); needs Steam (`SteamInitializeFailed` without it), and gbe_fork lacks its 2013 SDK's `STEAMUNIFIEDMESSAGES_INTERFACE_VERSION001` (asked through `GetISteamController`): "Missing interface". Waits on the tool's gbe fix. |
| Hollow Knight | Unity, `-force-glcore` | Minimum GPU (9800 GTX+) above the unit's; 2D, so 960x540 should hold. Pad needed. |
| Dead Cells | HashLink, D3D11 or OpenGL | Use its OpenGL mode; pad needed. |
| Loop Hero | GameMaker Studio 2, D3D11 | D3D11 through WineD3D, but light 2D. |
| Monster Train | Unity, `-force-glcore` | Busy effects; click-driven. |
| Halls of Torment | Godot 4, compatibility renderer | Many sprites late in a run. |
| Half-Life 2 / Portal | Source, D3D9 | Specs fit (2004-07). Needs gbe_fork, the Source pad config; Valve's DRM untested here. |
| Portal 2 / Left 4 Dead 2 | Source, D3D9 | Pad support built in; min GPU (GeForce 7600 / Radeon X800) fits, CPU tight: 960x540 lowest, ~30 fps at best. |
| 2007-2011 3D console ports | UE3 / Gamebryo / IW, D3D9 | See below. |
| Portal Reloaded / Left 4 Dead | Source, D3D9 | As Portal 2 / L4D2; L4D solo with bots. |
| Half-Life: Source / Garry's Mod / Sven Co-op | Source / GoldSrc-based | Specs fit; Garry's Mod CPU-heavy; Sven Co-op meant for multiplayer. |
| The Talos Principle | Serious Engine 4, OpenGL option | Native GL path; heavy 3D, lowest settings. |
| GRID (2008) | EGO, D3D9 | Pad-first racing. |
| GRID 2 | EGO, D3D11 | Officially supports Intel HD 3000; D3D11 through WineD3D. |
| DiRT 3 Complete Edition / DiRT Showdown | EGO, D3D9 / D3D11 | DiRT 3 has a D3D9 mode; Showdown heavier. |
| Assetto Corsa | D3D11 | DX10-class minimum GPU; pad support. |
| Civilization V | D3D9 mode | Turn-based, so a low frame rate is fine; actions by left click. |
| Crusader Kings II | Clausewitz, D3D9 | Mouse; slow late in a game. |
| Stellaris | Clausewitz, D3D9 | 4 GB RAM minimum (raise the cap); very slow late in a game. |
| RimWorld | Unity, `-force-glcore` | Right click is essential: needs an on-screen right click or a pad layer. |
| Factorio | Native, `--force-opengl` | Pad support since 2.0; early game only (CPU). |
| Prison Architect / Poly Bridge / This War of Mine / Dungeon of the Endless / Cosmonautica / Distrust / Dead In Bermuda | Mostly Unity | Mouse-driven; some need right click. |
| Children of Morta / Hand of Fate / Jotun / Headlander / Mark of the Ninja: Remastered / Shotgun King / Mewgenics | Various | Specs near the limit. |
| Disco Elysium | Unity | 4 GB RAM minimum: raise the cap. |
| The Witcher: Enhanced Edition | Aurora, D3D9, 32-bit | No pad support. |
| Mafia / Red Faction / Red Faction II / KOTOR / Killing Floor (solo) | D3D8/9, 32-bit | Old, so speed is fine; little or no pad support. |
| System Shock 2 | 1999, D3D | Keyboard and mouse only. |
| SEGA Mega Drive & Genesis Classics | Unity | The emulation is light, the 3D bedroom menu isn't. |
| ROUNDS / Golf With Your Friends | Unity | Local play with pads. |
| The Jackbox Party Pack 7 | | Players join from their phones over the hotspot's internet. |
| Tales from the Borderlands / Don't Starve Together (offline) | Telltale / Klei | Specs near the limit. |

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
| Call of Duty: World at War | IW engine, D3D9, 32-bit | As Black Ops 1; pad support unchecked. |
| Call of Duty: Black Ops II (Zombies offline) | IW engine, D3D11 | Heavier than BO1: likely under 20 fps. |
| Borderlands 2 / The Pre-Sequel | UE3, D3D9 | Pad support, low minimum GPU: the best UE3 bet. |
| Borderlands GOTY (original) | UE3, D3D9 | No proper pad support on PC. |
| Darksiders (original) / DmC Devil May Cry | D3D9 / UE3 | Pad support. |
| Dead Space 2 | D3D9 | Pad support, low minimum GPU. |
| BioShock / BioShock 2 (originals) | UE2.5, D3D9 | BioShock 2 has pad support, BioShock not. |
| BioShock Infinite | UE3, D3D10/11 | Heavy. |
| Batman: Arkham City GOTY | UE3, D3D9/11 | Pad support; heavy. |
| Psychonauts | D3D9 | Pad support, old. |
| NARUTO Storm 3 Full Burst / Revolution | D3D9 | Pad-first. |
| Saints Row: The Third / Red Faction: Guerrilla (Steam Edition) / Red Faction: Armageddon | D3D9 modes | Pad support; heavy. |
| Tomb Raider (2013) | D3D9 mode | Low minimum GPU for its age; pad support. |
| Dishonored / Outlast / Q.U.B.E. / Q.U.B.E. Director's Cut / Sanctum 2 / Styx: Master of Shadows | UE3, D3D9 | Near the limit. |
| Portal 2 / Left 4 Dead 2 | Source, D3D9 | Pad support; the best bet of this era. |
| Fallout: New Vegas / Fallout 3 | Gamebryo, D3D9, 32-bit | Pad support; CPU-heavy in towns. Fallout 3 only in a release without Games for Windows Live. |
| Mirror's Edge (2009) | UE3, D3D9 | Pad support; turn PhysX off. |
| Dead Space (2008) | D3D9 | Pad support; low minimum GPU (GeForce 6800). |
| Batman: Arkham Asylum GOTY | UE3, D3D9 | Pad support. Unsupported while its Steam build still needs Games for Windows Live. |
| Skyrim (2011 original) | Creation, D3D9, 32-bit | Delisted; only if owned. Pad support, heavy. Special Edition is D3D11, 64-bit: heavier still. |

## Unsupported

| Game | Why |
|---|---|
| Terraria | XNA, .NET Framework (no Wine Mono): "Wine Mono is not installed", exit 255 on the car (2026-11-08). Wine Mono 11.3.0 with FNA is in GE-Proton (planned back in) |
| Castle Crashers | SteamStub DRM (`.bind` section in castle.exe): exits 53 at once, with or without gbe_fork (2026-11-08) |
| Defy Gravity | XNA, .NET Framework (no Wine Mono) |
| Celeste | FNA on .NET Framework (Windows build) |
| Rogue Legacy | XNA, .NET Framework |
| Hades | D3D11 / Vulkan only, GPU-heavy; no OpenGL path |
| Cuphead | Heavy D3D11 and sprite memory; minimum GPU above the unit's |
| Any D3D12 / Vulkan-only game | No Vulkan on the 4.14 kernel ([browser.md](browser.md)) |
| Games with anti-cheat, online-only, SteamStub | No Steam client; gbe_fork doesn't cover DRM wrappers |
| Games for Windows Live titles | GFWL doesn't run here |
| 3D games with a GTX 4xx / HD 5xxx or newer minimum | Far past the HD 505 before Wine's overhead |
| Apex Legends, PUBG, SMITE / SMITE 2, Counter-Strike 2, Team Fortress 2, Counter-Strike: Source, Day of Defeat / Source, Team Fortress Classic, Deathmatch Classic, Ricochet, HL2: Deathmatch, HL Deathmatch: Source, Rainbow Six Siege, For Honor, Rust, Dead by Daylight, Warframe, Warface: Clutch, Brawlhalla, Divine Knockout, Realm Royale, Ring of Elysium, Quake Champions, Chivalry, Mirage, PAYDAY 2, Vermintide 2, Evolve Stage 2, WildStar, ELYON, Echo of Soul, Rocket League, Super Auto Pets, Hand of the Gods, Moirai, Guns of Icarus, Blockstorm, Offensive Combat: Redux, Team Racing League | Online-only or anti-cheat |
| Beat Saber, Blade & Sorcery, Pistol Whip, SUPERHOT VR, Half-Life: Alyx, Skyrim VR, The Lab, FNAF: Help Wanted, VRChat | VR |
| Assassin's Creed IV, Far Cry 3, GTA IV | Ubisoft / Rockstar launcher |
| Portal with RTX, Quake II RTX, Wolfenstein II | Ray tracing or Vulkan only |
| 7 Days to Die, ARK, Arkham Knight, Detroit, Elden Ring, FFXV, DOOM (2016), Wolfenstein: TNO / Old Blood, Shadow of Mordor / War, Witcher 2 / 3, XCOM 2, Hades II, Valheim, Risk of Rain 2, Divinity: OS2, Crusader Kings III, Skyrim SE, BioShock / BioShock 2 Remastered, Darksiders II Deathinitive / III / Warmastered, Borderlands GOTY Enhanced, RF Guerrilla Re-Mars-tered, Just Cause 2, Sniper Elite 4, Little Nightmares (both), NARUTO Storm 4, Shadow Tactics, Aragami, Automation, Palworld, PEAK, Schedule I, TABS, UEBS | Far too heavy (D3D11/12, UE4/5 or a modern minimum GPU) |

Not games: Wallpaper Engine, EVGA Precision X1, SKSE, OVR Advanced
Settings, Natural Locomotion, iVRy. Not placed yet (small indies, most
probably light; pad support decides): Ancient Planet, Angeldust, Banana,
Barro GT, Battle Riders, Bomb Defense, Bezier, ClusterPuck 99, Gurgamoth,
Spectrum, Tiltagon, Zero Reflex and the like.
