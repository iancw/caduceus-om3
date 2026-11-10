# Writing the look into the photo (XMP) — design

Status: **draft for the owner's approval (2026-11-10). Nothing is built.** Evidence labels: *analysis* = read from the
stock firmware or our source, not run; *camera-tested* = seen on a real OM-3. Everything about the firmware below is
*analysis* until a camera test. Findings and addresses: `research/NOTES.md`, "Writing the look into the picture's
metadata" and the three sections after it.

## Why

A JPG should carry the look it was shot with, in a form a person can read (exiftool, Lightroom's metadata panel) and
the Control Panel can load back as a look ("Read from photo", then "Add to my looks"). The camera's maker note already
holds many of the numbers, but not all (split toning, Glow / Clarity strength, WB shift as profile values, the film
name) and its numbering is OM's, not ours.

## Goals

- Every photo shot through COLOR 1–4 carries the settings that were applied, as named values, in XMP.
- The Control Panel can rebuild the look from a photo with the same field map it uses for `LOOKS.BIN`.
- Nothing the camera does today changes: same file layout, same packet length, rating edits keep working.

## Non-goals

- Not the OM maker note (OM owns its tag numbers). Not UserComment (125 bytes, too small).
- Not the `op1_` link: it is compressed JSON and the camera cannot build it. The Control Panel makes `op1_` from a photo.
- Not the COLOR slot number (an implementation detail; the maker note has it).
- Not grain, Glow / Clarity pictures or anything the user adds in an editor afterwards.

## Anti-goals (a failure even if it "works")

- A photo the camera or an editor can no longer open, or a changed Exif / XMP length that shifts other data.
- Fields that disagree with what the camera really applied.
- Two field maps (firmware, Control Panel, docs) that drift apart.

## The data

In the photo's existing XMP packet (`rdf:Description`), **after the `xmp:Rating` digit** (the stock rating edit compares at
+230 and otherwise searches from the start, so it still finds the Rating before our text), the camera adds one namespace declaration and these attributes. Values are the same
numbers as one `LOOKS.BIN` record (`docs/FORMATS.md`), the settings **as applied at the shot**, so a film the owner edited
shows the edited values.

| Field | Record | Value |
|---|---|---|
| `Version` | | `1` |
| `Look` | name | the look or film name from the card's `LOOKS.BIN` (up to 15 characters); `& < > " '` replaced by `_` |
| `Film` | | film number 1–20 = 5 × (COLOR − 1) + look; `0` when the slot used its own settings |
| `Hue`, `Light`, `Saturation` | +0, +12, +24 | 12 comma-separated numbers (−5..5), order below |
| `WbOn`, `WbAB`, `WbGM` | +36..38 | 0/1, −7..7, −7..7 |
| `Blacks`, `Whites` | +39, +40 | −5..5 |
| `Contrast`, `Shading` | +41, +43 | −2..2, −5..5 |
| `Shadows`, `Midtones`, `Highlights` | +44..46 | −7..7 (the camera's tone settings) |
| `GlowClarity` | +47 | −5..−1 Glow, 1..5 Clarity, 0 off |
| `Art`, `NR`, `VigFix`, `Grain`, `Sharp` | +48..52 | as in FORMATS.md (Art 0..5, NR 0..3, VigFix 0..1, Grain 0..3, Sharp −5..2) |
| `ShadowColor`, `ShadowStrength`, `HighlightColor`, `HighlightStrength` | +53..56 | colour 0..11, strength −5..5 |

Colour order for the three lists (the record's order, clockwise from Yellow): Yellow, Orange, Orange-red, Red, Magenta,
Violet, Blue, Blue-cyan, Cyan, Green-cyan, Green, Yellow-green. The UI sector order of the Control Panel differs; the
reader maps it. Record `+42` (legacy Sharpness) is not written.

Namespace: `xmlns:cad="https://androidfanman.github.io/caduceus-om3/ns/1/"` (**my call**; a short page there describes
the fields). Example tail of the description:

```
 xmp:Rating="0" xmlns:cad="…/ns/1/" cad:Version="1" cad:Look="Portra 400" cad:Film="1"
 cad:Hue="0,0,0,1,0,0,0,0,0,0,0,0" cad:Light="…" cad:Saturation="…" cad:WbOn="1" …/>
```

Size: about 700 bytes of text against about 1950 free in the 2301-byte packet (*analysis*). The packet length stays
2301: the added text is taken out of the blank padding and `<?xpacket end="w"?>` stays last.

## The camera side (analysis)

- The packet is built once at power-on into a RAM buffer (0x62a982e6, 2301 bytes). The JPEG writer 0x60455cfa runs once
  per JPEG and copies exactly 2301 bytes after fixed length constants (APP1 length 0x091C, return 2334). So the work is a
  **hook at the writer's entry**: write the fields into the buffer (move the three tail lines forward, use padding),
  then run the original copy.
- The look at that moment: our capture code already reads it (`xb_slot`, xblock.s). The patch also has a routine that
  turns the effective settings into a 64-byte record (`pf_capto`; it also reads the camera's own saturation, contrast,
  tone settings). **To verify first:** that it can be called from the writer's hook (frame, side effects, the capture
  job being busy), and from which context the writer runs.
- Output: a small table {name text, record offset, kind: number / 12-list / name / film} and one formatter. Estimate
  600–800 bytes with names; the GUIDES.BIN code block has about 3.2 KB free (13248 of 16448) *(check against the current
  build)*. If it does not fit, the names can move to a card file.
- Written only when COLOR 1–4 is the effective profile (**my call**); otherwise the stock packet is untouched.
- The playback rating edit overwrites one digit, so our fields survive it.

## The Control Panel and tools

- "Read from photo": open a JPG, find the XMP packet, read the `cad:` fields, build a `Look` with the same mapping as
  `readProfiles`, show it, offer "Add to my looks". No image data leaves the browser.
- A small exiftool config (`docs/`) names the fields.
- **One source of truth:** `docs/FORMATS.md` gets an "XMP" section with the table above. The firmware table is checked
  against it by `build.py`, the Control Panel map by a test; a change in one fails the other.

## Not decided or unknown

- Does the RAW (ORF) file carry the same packet (the notes say it uses tag 700; its size source is not examined)?
- Do Lightroom, Photoshop, Apple Photos and Google Photos keep unknown XMP fields? Test after a camera photo exists.
- The film name for a film that was edited: the card's name (as above) is used; whether to mark "edited" is open
  (the Control Panel can tell by comparing with the library film).
- Whether the namespace page goes on the GitHub Pages site under that address.

## Delivery order

1. Verify the hook (emulator): can the writer's hook call `pf_capto` safely; fix the format table against the build.
2. Build the writer into a test build; emulator shows the packet if a JPEG can be produced there, else decode a
   dumped buffer.
3. Control Panel reader and the exiftool config (testable without a camera, using a hand-made packet).
4. Camera test by the owner (shoot with a film and with a COLOR's own settings; read with exiftool; open in one editor).
5. Release only after the camera test and the owner's go-ahead.
