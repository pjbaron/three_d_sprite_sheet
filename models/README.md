# Models

The `.glb` files this tool loads are deliberately not committed. They come from
sources whose terms do not permit redistribution:

- Mixamo characters and animations (Adobe) - the walk/idle rigs and the
  `...@ClipName.glb` animation files. Adobe's terms allow use in your own
  projects but not redistribution of the source files.
- Meshy AI generated characters (`Meshy_AI_*.glb`) - governed by the Meshy
  terms in force for the account that generated them.

To run the tool, put your own `.glb` files in this directory and make sure the
entries in `js/catalog.js` point at them. `prepare_models.py` describes the
expected shape: a base mesh per character, plus one file per animation clip
named `<base>@<Clip>.glb` for retargeted Mixamo clips.
