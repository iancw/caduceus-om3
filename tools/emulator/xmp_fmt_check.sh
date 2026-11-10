#!/bin/bash
# Run the formatter check (tools/emulator/xmp_check.mjs, XMP_FMT_DIR mode) on a build made by cbuild.sh.
# usage: tools/emulator/xmp_fmt_check.sh NAME     (uses ~/om3-work/out-NAME, $OM3_CARD, $OM3_EMU from ~/om3-work/env.sh)
set -e
. "$HOME/om3-work/env.sh"
O="$HOME/om3-work/out-${1:?name}"
python3 "$OM3_REPO/tools/emulator/card_add_file.py" "$OM3_CARD" "$O/card.omsd" "$O/GUIDES.BIN" OM3MOD GUIDES.BIN >/dev/null
XMP_FMT_DIR="$O" OM_EMU_MODEL=E147 OM_WORKER_ENTRY=60a8f623 node "$OM3_REPO/tools/emulator/xmp_check.mjs" "$OM3_EMU" "$O/main.bin" "$O/card.omsd" "$O/xmp.json" 's1'
