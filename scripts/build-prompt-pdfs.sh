#!/usr/bin/env bash
#
# Render the prompt pack to PDF.
#
# Produces one PDF per prompt plus a combined all-projects.pdf, so a single file
# can be sent to someone who wants the whole pack and individual files can be
# handed to whoever is building that one project.
#
#   ./scripts/build-prompt-pdfs.sh
#
# Requires pandoc and a LaTeX engine. xelatex is preferred over pdflatex because
# the prompts contain typographic characters (→ · — ≥) that pdflatex cannot set
# without a package dance.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${ROOT}/prompts"
OUT="${SRC}/pdf"

# Ordered deliberately: shared requirements first, since every project prompt
# assumes it.
FILES=(
  "README.md"
  "00-shared-requirements.md"
  "01-tensorrt-llm-voice-agent.md"
  "02-sglang-document-image-analysis.md"
  "03-llamacpp-offline-mobile-assistant.md"
  "04-executorch-face-recognition.md"
  "05-onnxruntime-object-tracking.md"
  "06-litert-drone-image-analysis.md"
)

command -v pandoc >/dev/null 2>&1 || {
  echo "error: pandoc not found. Install it: brew install pandoc" >&2
  exit 1
}

ENGINE=""
for candidate in xelatex lualatex pdflatex; do
  if command -v "$candidate" >/dev/null 2>&1; then
    ENGINE="$candidate"
    break
  fi
done

if [[ -z "$ENGINE" ]]; then
  echo "error: no LaTeX engine found (xelatex, lualatex or pdflatex)." >&2
  echo "       macOS: brew install --cask basictex   (then restart your shell)" >&2
  exit 1
fi

mkdir -p "$OUT"

# Shared typography. Kept here rather than in each file's front matter so a
# change applies to the whole pack at once.
PANDOC_ARGS=(
  --from=markdown+yaml_metadata_block+pipe_tables+task_lists+fenced_code_blocks
  --pdf-engine="$ENGINE"
  --highlight-style=tango
  -V geometry:"a4paper,margin=2.2cm"
  -V fontsize=10pt
  -V linkcolor=[HTML]{0F6E7E}
  -V urlcolor=[HTML]{0F6E7E}
  -V colorlinks=true
  -V documentclass=article
)

# xelatex can select real fonts by name; pdflatex cannot, and passing these to
# it produces an unhelpful failure rather than a fallback.
if [[ "$ENGINE" != "pdflatex" ]]; then
  # Fonts, plus a header include that disables ligatures. See pandoc-header.tex
  # for why the ligature setting cannot simply be passed as -V mainfontoptions.
  PANDOC_ARGS+=(
    -V mainfont="Helvetica Neue"
    -V monofont="Menlo"
    --include-in-header="${SRC}/pandoc-header.tex"
  )
fi

echo "engine: $ENGINE"
echo "output: $OUT"
echo

for file in "${FILES[@]}"; do
  src="${SRC}/${file}"
  [[ -f "$src" ]] || { echo "  SKIP  ${file} (not found)"; continue; }

  dest="${OUT}/${file%.md}.pdf"
  # --toc only on the substantial documents; a two-page index with a table of
  # contents reads as padding.
  # macOS ships bash 3.2, where expanding an empty array under `set -u` is an
  # error — hence the ${a[@]+"${a[@]}"} guard rather than a bare "${a[@]}".
  extra=()
  [[ "$file" != "README.md" ]] && extra=(--toc --toc-depth=2)

  if pandoc "$src" "${PANDOC_ARGS[@]}" ${extra[@]+"${extra[@]}"} -o "$dest" 2>/dev/null; then
    echo "  OK    $(basename "$dest")  ($(du -h "$dest" | cut -f1))"
  else
    echo "  FAIL  ${file} — rerunning to show the error:" >&2
    pandoc "$src" "${PANDOC_ARGS[@]}" ${extra[@]+"${extra[@]}"} -o "$dest" || true
    exit 1
  fi
done

# Combined pack. Page breaks between documents so each project starts cleanly.
echo
combined="${OUT}/all-projects.pdf"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

merged="${tmp}/merged.md"
{
  echo "---"
  echo "title: \"AI Serving Framework — Project Prompt Pack\""
  echo "subtitle: \"Seven production-shaped projects across GPU server, mobile and IoT\""
  echo "---"
  echo
  for file in "${FILES[@]}"; do
    src="${SRC}/${file}"
    [[ -f "$src" ]] || continue
    # Strip each file's own YAML front matter — the combined document has one
    # title block of its own, and repeated blocks render as stray text.
    awk 'BEGIN{fm=0} /^---$/{fm++; next} fm>=2 || fm==0 {print}' "$src"
    echo
    echo '\newpage'
    echo
  done
} > "$merged"

if pandoc "$merged" "${PANDOC_ARGS[@]}" --toc --toc-depth=2 -o "$combined" 2>/dev/null; then
  echo "  OK    all-projects.pdf  ($(du -h "$combined" | cut -f1))"
else
  echo "  FAIL  all-projects.pdf" >&2
  exit 1
fi

echo
echo "done — $(ls -1 "$OUT"/*.pdf | wc -l | tr -d ' ') PDFs in ${OUT}"
