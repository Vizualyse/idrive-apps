# iDrive app pages (RHMI, oap-sdk)

How a Store app builds its iDrive page. From our apps (Cast, Moonlight) and
the reference repos ([reference-repos.md](reference-repos.md)); *(ref: …)*
marks what we have not yet done ourselves. Index: [index.md](index.md).

## What we use

- One `LT_State_Wide` page per app (Cast, Moonlight): labels, buttons, a
  PNG through `LT_Label_1Graphic_Scalable` ([central-screen.md](central-screen.md)).
- RHMI event values arrive as booleans or as 1/0; a press can arrive twice
  (`action` and the raw `userEvent`): dedupe within ~400 ms.

## The templates on the unit

- *(ref: idrive7-apps `kit/renderd/js/hmi_template.js:8-16`)* HmiMain3D
  reads the widget templates from `/mnt/dataro/data/hmi/bmw/widget/*.pbw`;
  their names are compiled into `/usr/bin/HmiMain3D` as
  `eGfxIdWidgetType_LT_*`. Read-only on the unit, the full catalogue is
  `ls /mnt/dataro/data/hmi/bmw/widget/` plus
  `strings /usr/bin/HmiMain3D | grep -E '^eGfxIdWidgetType_LT_|^eParam_'`.
- Component types in BMW's SDK *(ref: idrive7-apps `docs/rhmi-widgets.md:50-77`)*:
  state, overlay, popUp, **icPopUp / hudPopUp / hudMidPopUp** (cluster and
  HUD pop-ups, untested by anyone), label, button, checkBox, radioButton,
  image, valueList, slider, progressBar, dropDownMenu, toolBar,
  selectionBar, startWidget …
- Property ids *(same, `:85-106`)*: 1 Enabled, 2 Visible, 3 Focusable (0
  static, 1 focusable, 3 focusable + clickable; focus events only with 3),
  **6 Speedlockable** (blocked while driving: untested), 9 ParentState,
  18 DefaultFocusComponent, 20 icPriority.
- Templates proven on cars *(ref: idrive7-apps `kit/tools/build.py:78-95`)*:
  `LT_Label_1Row`, `LT_Label_Header_1Row`, `LT_Label_3Row_1TextDyn`,
  `LT_Button_1Row`, `LT_Button_1Row_1IconLeft`,
  `LT_Button_1Row_2Col7030_2Text` (`Text1stCol`/`Text2ndCol`),
  `LT_Button_2Row_2Text` (`Text1stRow`/`Text2ndRow`, a value row as in BMW's
  parking settings), `LT_CheckBox_1Row`, `LT_ScrollLabel_UnlimitedRow_TextDyn`,
  `LT_Slider_LeftJustified_Fill_Steps` (upstream). Home tile:
  `LT_Table_OnlineApps_DriveRecorderWidget` (image cell `BackgroundImage1`
  384x256).

## Choosing one of several (e.g. Moonlight's output)

- **Drop-down** (shipped by upstream's Waze app as "Show on", and by
  idrive7-apps' Doom):
  - `application.xml`: `<component id="N" type="dropDownMenu"/>` (upstream
    names the widget `LT_DropDownMenu_1Row_2Col3070`, Visible 1, Focusable 3).
  - `uiDescription.json`: `rows: [{ItemText: {value, type: 'Text'}}, …]`,
    `cells: {HeaderText: {value, type: 'Text'}, SelectedItem: {value: i, type: 'UInt'}}`.
  - JS: the choice is `c.on('action', ev => ev.row)`; show the selection
    with `c.setValue('SelectedItem', i, 'UInt')` (three arguments); the HMI
    draws the open list itself.
  - Upstream: `apps/robertn_waze_cluster/robertn_waze_cluster@0.6.0/rhmiData/uiDescriptions/ID7/application.xml:17-20`,
    `uiDescription.json:48-80`, `src/robertn_waze_cluster.js:228-232, 470-478`;
    screenshot `apps/robertn_waze_cluster/docs/main-show-on-open.png`.
- Alternatives: three `LT_CheckBox_1Row` set by hand
  (`setValue(row, 'eParam_RowSelected', bool, 'Bool')`: setValue creates the
  row, setRowSelected fails), or one `LT_Button_2Row_2Text` row that cycles
  its second line, or a sub-page (container with property 9 = the main
  state's id, opened with `openState`; BACK returns).
- Enable / hide: `setProperty('Enabled' | 'Visible', 0 | 1, 'UInt')`.
- The Store app's ways *(ref: mgu-store `apps/robertn_store/`)*: a cycle row
  `LT_Button_1Row_2Col7030_2Text` ("Phone access | On"), or a pick sub-state
  with one list: `setRowCount(n)` first, and only once it resolves
  `setValue(row, 'Text1stCol', v, 'Text')` (writing past the count grows the
  list), then `closeState` on the press. Its generator
  `tools/gen_rhmi.js` writes both `application.xml` and `uiDescription.json`;
  ids share one space. iDrive 8 refuses ParentState chains deeper than one.
- Also there: `restoreHmi` (re-push everything), `mapEntryState(entryUuid,
  state)` (what the tile opens), the speller use case
  `02076b22-d19b-4aef-9e8c-0d7305d8b88c` for text input.

## Gotchas *(ref: idrive7-apps `kit/runtime/`)*

- **Unicode:** "RHMI Text is not a reliable Unicode transport on this
  firmware" (`hmi-text.js:2-19`); they send strings through the string
  bundle (`SID_CN_DYNAMIC_nnnn`, `'StringId'`). Our Moonlight and Cast send
  `…`, `—`, `’`, `·` as Text: check on the car.
- **Images:** a new file name for every image, written to a temp file then
  renamed; release old handles two frames late or the screen blinks black
  for ~0.5 s (`mgu.js:232-290`).
- Call `updateResources()` before showing a state, or lists render empty;
  but on a graphic page before its first image it makes every later
  `createResourceHandles` fail (`mgu.js:712-720`).
- `openEntryState` can fail right after the tap that started the app: retry
  (6 × 0.8 s). Race every HMI call against ~4 s: MainApp shows "loading
  app" until `initialized()`.
- Call `registerActive()` when the AppStatus proxy is ready, or MainApp stops
  the app right after its start (`mgu.js:515-521`).
- **Never let an app crash or be killed:** CorruptAppsHandler wipes the
  app's data the first time and uninstalls it the second.
- A newer bundled SDK (27.x) needs `config/base.json`
  `{"rhmiLoadingEnabled":true,"entryPointLoadingEnabled":true}` or the app
  gets no screens; ours is `{}` (fine with the firmware's 24.x).
- SOME/IP proxies built inline next to the SDK's own traffic can deadlock the
  main thread: build them from a fresh `setImmediate`, one at a time
  (`signals.js:26-36`).
- Node 8 frees buffers lazily; a busy app can reach its memory limit and be
  killed (they call `global.gc()`). `oapAppSettings` (cpuLimit,
  memoryThresholdKB …) is in the app's manifest.
- The clock can be badly wrong (a car showed 2179): use monotonic time.

## Visibility, pop-ups and focus

- `applicationStackChanged`: `ROOT_APP` in the stack means the app is in
  front. On iDrive 7: `registerActive()` + `registerHmiVisible()` when shown,
  `unregisterHmiVisible()` + `registerInactive()` when hidden (ref:
  IterioDev `src/online-host.js:88, 139-154`).
- Each state emits `visible` and `focus`; **`focus: false` while still
  visible means an HMI pop-up, call or warning is on top** (IterioDev waits
  300 ms to tell it from leaving the state). Both repos hide their own
  full-screen layer then, so the pop-up is never covered. Moonlight's
  full-screen picture should do the same.
- A root tool can tell whether an app is in front itself:
  `de.bmw.infotainment.hmi.remote.RemoteHmiApplication`, instance by the
  app's RHMI uuid, `ROOT_APP` in `applicationStack` (ref: idrive7-apps
  `kit/renderd/js/foreground_gate.js:10-19`).
