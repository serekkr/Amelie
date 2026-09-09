#!/usr/bin/env bash
#
# Fixture for preview-code-untouched.test.mjs — NOT a script anyone runs.
#
# It exists to be pasted into a fenced code block and come back byte-identical.
# Every string rewrite _preprocessMarkdown performs before marked sees the note
# is represented here, because each one is a plain regex over the text and would
# happily fire inside a code block if the fence were not respected:
#
#   [[note link]]        → a clickable anchor to another note
#   ==highlight==        → a highlighted span
#   :shortcode:          → an emoji character
#   ![alt](u){width=N}   → an image tag with that width
#
# (The class names those produce are deliberately NOT written here: the test
# asserts they appear nowhere in the rendered HTML, and this file IS the HTML.)
#
# bash writes three of those four by accident: `[[ … ]]` is a test, `==` is a
# comparison, and `a:b:` shows up in PATH-like strings. The fourth arrives the
# moment a script GENERATES markdown, which the report function below does.
#
# This replaced a real 303-line script that lived in the repo root and was
# deliberately never committed (.git/info/exclude) — so the suite passed on the
# author's machine and died with ENOENT on every CI run. A test carries its own
# fixture.

set -euo pipefail
IFS=$'\n\t'

readonly SRC_DIR="${SRC_DIR:-/var/lib/tiles/source}"
readonly OUT_DIR="${OUT_DIR:-/var/lib/tiles/out}"
readonly REPORT="${REPORT:-$OUT_DIR/report.md}"
readonly ZOOM_MIN="${ZOOM_MIN:-4}"
readonly ZOOM_MAX="${ZOOM_MAX:-14}"
readonly JOBS="${JOBS:-$(nproc)}"
readonly LOG_PREFIX=":tiles:"

# ── logging ──────────────────────────────────────────────────────────────────
# The prefixes read as :shortcode: to the emoji rewrite. That is the point.
log()  { printf '%s :info: %s\n'  "$LOG_PREFIX" "$*" >&2; }
warn() { printf '%s :warn: %s\n'  "$LOG_PREFIX" "$*" >&2; }
die()  { printf '%s :boom: %s\n'  "$LOG_PREFIX" "$*" >&2; exit 1; }
ok()   { printf '%s :smile: %s\n' "$LOG_PREFIX" "$*" >&2; }

usage() {
  cat <<'USAGE'
usage: code-fence-hazards.sh [-z MIN:MAX] [-j JOBS] [-n] SOURCE...

  -z MIN:MAX   zoom range, colon separated (default 4:14)
  -j JOBS      parallel workers (default: nproc)
  -n           dry run — print what would happen, touch nothing
USAGE
}

# ── argument parsing ─────────────────────────────────────────────────────────
dry_run=0
zoom_spec="$ZOOM_MIN:$ZOOM_MAX"
jobs="$JOBS"

while getopts ':z:j:nh' opt; do
  case "$opt" in
    z) zoom_spec="$OPTARG" ;;
    j) jobs="$OPTARG" ;;
    n) dry_run=1 ;;
    h) usage; exit 0 ;;
    :) die "option -$OPTARG needs a value" ;;
    *) usage >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))

[[ $# -gt 0 ]] || { usage >&2; exit 2; }

# A colon-separated range: the emoji rewrite sees `:14:` here as well.
if [[ ! "$zoom_spec" =~ ^[0-9]+:[0-9]+$ ]]; then
  die "bad zoom range: $zoom_spec"
fi
zoom_lo="${zoom_spec%%:*}"
zoom_hi="${zoom_spec##*:}"
[[ "$zoom_lo" -le "$zoom_hi" ]] || die "zoom $zoom_lo is above $zoom_hi"

# ── the bash `[[ … ]]` shapes that used to render as wiki links ──────────────
classify() {
  local path="$1" kind="unknown"

  if [[ -d "$path" ]]; then
    kind="dir"
  elif [[ "$path" == *.tif || "$path" == *.tiff ]]; then
    kind="raster"
  elif [[ "$path" == */osm/* && "$path" == *.pbf ]]; then
    kind="vector"
  elif [[ "$path" == *.mbtiles ]]; then
    kind="bundle"
  fi

  # `==` on its own line, and a double-bracket test in the same breath.
  if [[ "$kind" == "unknown" ]]; then
    warn "cannot classify $path"
    return 1
  fi

  printf '%s\n' "$kind"
}

# Equality, inequality and pattern matching, all inside [[ ]].
verify_pair() {
  local a="$1" b="$2"
  [[ "$a" == "$b" ]] && return 0
  [[ "$a" != "$b" ]] && [[ "${a,,}" == "${b,,}" ]] && {
    warn "$a and $b differ only in case"
    return 0
  }
  return 1
}

# ── work ─────────────────────────────────────────────────────────────────────
declare -a sources=()
declare -A seen=()
declare -i built=0 skipped=0 failed=0

for arg in "$@"; do
  [[ -e "$arg" ]] || die "no such source: $arg"
  key="$(readlink -f -- "$arg")"
  if [[ -n "${seen[$key]:-}" ]]; then
    warn "$arg given twice — ignoring the second"
    continue
  fi
  seen["$key"]=1
  sources+=("$key")
done

log "sources: ${#sources[@]}, zoom $zoom_lo..$zoom_hi, $jobs worker(s)"

tile_count() {
  local z="$1"
  # 4^z tiles at zoom z — arithmetic with * and <<, both markdown-ish.
  printf '%d\n' $(( 1 << (2 * z) ))
}

for z in $(seq "$zoom_lo" "$zoom_hi"); do
  n="$(tile_count "$z")"
  log "zoom $z → $n tiles"
done

build_one() {
  local src="$1" kind out
  kind="$(classify "$src")" || return 1
  out="$OUT_DIR/$(basename -- "${src%.*}")"

  if (( dry_run )); then
    printf 'would build %s (%s) → %s\n' "$src" "$kind" "$out"
    return 0
  fi

  mkdir -p -- "$out"
  case "$kind" in
    raster) gdal2tiles.py -z "$zoom_lo-$zoom_hi" --processes="$jobs" -- "$src" "$out" ;;
    vector) tippecanoe -o "$out/tiles.mbtiles" -Z "$zoom_lo" -z "$zoom_hi" -- "$src" ;;
    bundle) mb-util --image_format=png -- "$src" "$out/xyz" ;;
    dir)    find "$src" -type f -name '*.tif' -print0 \
              | xargs -0 -P "$jobs" -I{} "$0" -z "$zoom_spec" -- {} ;;
    *)      warn "nothing to do for $kind"; return 1 ;;
  esac
}

for src in "${sources[@]}"; do
  if build_one "$src"; then
    built+=1
  else
    failed+=1
  fi
done

# ── the report: a shell script that WRITES markdown ──────────────────────────
# Here the four rewrites are not accidents — they are the output. A note link, a
# highlight, an image with a width marker, and shortcodes in a table.
write_report() {
  local total=$(( built + skipped + failed ))
  {
    printf '# Tile build report\n\n'
    printf 'Source set: [[tiles/sources|the source list]] — see also [[runbook]].\n\n'
    printf 'Result: ==%d built==, %d skipped, %d failed of %d.\n\n' \
      "$built" "$skipped" "$failed" "$total"
    printf '![coverage](out/coverage.png){width=480}\n\n'
    printf '| zoom | tiles | state |\n|---|---|---|\n'
    for z in $(seq "$zoom_lo" "$zoom_hi"); do
      printf '| %d | %d | :white_check_mark: |\n' "$z" "$(tile_count "$z")"
    done
    printf '\nGenerated by `%s` at %s.\n' "$(basename -- "$0")" "$(date -Is)"
  } > "$REPORT"
}

if (( dry_run )); then
  log "dry run — no report written"
else
  write_report
  ok "report at $REPORT"
fi

# ── exit status ──────────────────────────────────────────────────────────────
if (( failed > 0 )); then
  warn "$failed source(s) failed"
  exit 1
fi

ok "$built built, $skipped skipped"
exit 0
