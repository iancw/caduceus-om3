#!/bin/bash
# Build this checkout in the om3-linux container (a macOS build does not reproduce) and copy the outputs to ~/om3-work/out-NAME.
# usage: tools/emulator/cbuild.sh NAME   (needs the container from research/setup.sh; prints the build log tail)
set -e
NAME=${1:?name}
docker exec om3-linux bash -lc ". /root/om3-work/env.sh && rm -rf \$OM3_WORK/out-$NAME && cd /repo && python3 firmware/build.py --stock \$OM3_STOCK --toolchain \$OM3_TOOLCHAIN --out \$OM3_WORK/out-$NAME" 2>&1 | tail -${TAIL:-6}
rm -rf "$HOME/om3-work/out-$NAME" && mkdir -p "$HOME/om3-work/out-$NAME"
docker cp "om3-linux:/root/om3-work/out-$NAME/." "$HOME/om3-work/out-$NAME/"
ls -l "$HOME/om3-work/out-$NAME/main.bin" "$HOME/om3-work/out-$NAME/GUIDES.BIN" | awk '{print $5, $9}'
