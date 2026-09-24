#!/bin/bash
# Acceptance harness for `mmbridge hub`: the result is frames on disk, not a claim.
#
# usage: hub-scenario.sh <out-dir> <shell command> [actions file]
#   Runs the command in a 120x40 tmux pane and captures the screen every 0.5s until "all finished"
#   (max 300s), then presses q and captures the exit output (JSON + EXIT=<code>) to after-quit.txt.
#   Actions file lines, fired once each when the clock passes them:
#     <seconds> keys <tmux key names...>     e.g. "2.5 keys 3"   "2.8 keys x"   "3 keys Escape"
#     <seconds> text <literal text>          e.g. "3.3 text focus on page 0"
#   The frame captured right after an action carries it in its file name; actions.log has the fire times.
# Off a real HOME (fake omp), put `dirname $(node -p process.execPath)` first on PATH: a node shim may read HOME.
set -u
out=$1; cmd=$2; actions=${3:-/dev/null}
rm -rf "$out"; mkdir -p "$out"
sess="hub-$$"
tmux new-session -d -s "$sess" -x 120 -y 40
tmux set-option -t "$sess" remain-on-exit on >/dev/null
tmux respawn-pane -k -t "$sess" "$cmd; echo EXIT=\$?"
start=$(python3 -c 'import time;print(time.time())')
elapsed() { python3 -c "import time;print(round(time.time()-$start,1))"; }
fired=0
for i in $(seq -w 1 600); do
  sleep 0.5
  t=$(elapsed); tag=""
  idx=0
  while IFS= read -r line; do
    idx=$((idx+1)); [ -z "$line" ] && continue
    [ "$idx" -le "$fired" ] && continue
    at=${line%% *}; rest=${line#* }; kind=${rest%% *}; arg=${rest#* }
    python3 -c "import sys;sys.exit(0 if $t >= $at else 1)" || break
    if [ "$kind" = text ]; then tmux send-keys -t "$sess" -l "$arg"; else tmux send-keys -t "$sess" $arg; fi
    fired=$idx; tag="$tag-$kind-$(echo "$arg" | tr -c 'A-Za-z0-9' '_' | cut -c1-20)"
    echo "$t $line" >> "$out/actions.log"
  done < "$actions"
  tmux capture-pane -t "$sess" -p > "$out/$i@${t}s$tag.txt"
  if rg -q "all finished" "$out/$i@${t}s$tag.txt"; then break; fi
done
echo "frames: $(command ls "$out" | rg -c '^[0-9]') ; until finished: $(elapsed)s" > "$out/summary.txt"
tmux send-keys -t "$sess" q
sleep 2
tmux capture-pane -t "$sess" -p -J -S -400 > "$out/after-quit.txt"
tmux kill-session -t "$sess"
cat "$out/summary.txt"
