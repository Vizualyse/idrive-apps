<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# Third-party material in vizualyse-cluster

| What | Where | Licence |
|---|---|---|
| cluster-render's Node client, Robert Nisipeanu | `cluster_render_client.js` | MPL-2.0 (its SPDX header) |
| Barlow and Barlow Semi Condensed, The Barlow Project Authors | rendered into the themes' art and glyph atlases (`*.art.rgba.gz`, `*.font.gz`); the font files are in the source tree only (`themes/fonts/`, `themes/tri1/fonts/`, `themes/perf2/`) | SIL Open Font License 1.1 ([`themes/fonts/OFL.txt`](themes/fonts/OFL.txt)) |
| Archivo, The Archivo Project Authors (Omnibus-Type) | rendered the same way; source tree only, with static cuts made from it (`themes/lci1/fonts/`, `themes/perf1/fonts/`, `themes/tri2/fonts/`) | SIL Open Font License 1.1 (an `OFL.txt` beside each) |
| Saira, The Saira Project Authors (Omnibus-Type) | rendered the same way; source tree only, with a fixed-width cut (`themes/lci2/`) | SIL Open Font License 1.1 ([`themes/lci2/OFL.txt`](themes/lci2/OFL.txt)) |

The kit ships no font files: only pictures drawn with them. The themes echo
the look of BMW's G20 and LCI clusters, a three-dial cluster and a
performance cluster. They carry no BMW or Porsche marks, no BMW or Porsche
typeface and no artwork taken from either: every shape and glyph is drawn by
our own code with the fonts above.
