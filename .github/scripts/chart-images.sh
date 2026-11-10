#!/usr/bin/env bash
# Helpers for sigp-release.yml that read the chart's image blocks.
#
#   chart-images.sh list  <values.yaml>
#       Print every chart image whose repository is a bare project image name.
#   chart-images.sh stamp <chart-dir> <image-prefix> <tag>
#       Rewrite a release copy of a chart so project images and repoCache.image
#       point at the release registry/tag. The standalone agent-sandbox values
#       file gets the parent chart's agentSandbox.image.tag.
#   chart-images.sh controller <stamped-chart-dir> <out-dir>
#       Copy the stamped agent-sandbox subchart to <out-dir> for release on its
#       own, with its CRDs moved from crds/ into templates/ (annotated
#       helm.sh/resource-policy: keep). Helm never upgrades files in crds/; the
#       parent chart upgrades them from a hook that only runs when it installs
#       the controller itself, so the standalone chart must own them.
#
# Needs yq v4 (preinstalled on GitHub's ubuntu runners).
set -euo pipefail

component_entries() {
  yq -r '
    to_entries[]
    | select((.value | tag) == "!!map")
    | select((.value.image.repository // "") | test("^[^/]+$"))
    | [.key, .value.image.repository] | @tsv
  ' "$1"
}

case "${1:-}" in
list)
  [[ $# -eq 2 ]] || { echo "usage: $0 list <values.yaml>" >&2; exit 2; }
  component_entries "$2" | cut -f2
  ;;
stamp)
  [[ $# -eq 4 ]] || { echo "usage: $0 stamp <chart-dir> <image-prefix> <tag>" >&2; exit 2; }
  chart=$2
  prefix=$3
  tag=$4
  values="$chart/values.yaml"
  while IFS=$'\t' read -r key name; do
    KEY="$key" PREFIX="$prefix" NAME="$name" TAG="$tag" yq -i \
      '.[env(KEY)].image.repository = env(PREFIX) + "/" + env(NAME) |
       .[env(KEY)].image.tag = strenv(TAG)' "$values"
  done < <(component_entries "$values")

  PREFIX="$prefix" TAG="$tag" yq -i \
    '.repoCache.image.repository = env(PREFIX) + "/centaur-agent" |
     .repoCache.image.tag = strenv(TAG)' "$values"

  parent_tag=$(yq -r '.agentSandbox.image.tag' "$values")
  [[ -n "$parent_tag" && "$parent_tag" != "null" ]] || {
    echo "agentSandbox.image.tag is empty" >&2
    exit 1
  }
  TAG="$parent_tag" yq -i '.image.tag = strenv(TAG)' \
    "$chart/charts/agent-sandbox/values.yaml"
  ;;
controller)
  [[ $# -eq 3 ]] || { echo "usage: $0 controller <stamped-chart-dir> <out-dir>" >&2; exit 2; }
  source_dir="$2/charts/agent-sandbox"
  out=$3
  rm -rf "$out"
  cp -a "$source_dir" "$out"
  if grep -l '{{' "$out"/crds/*.yaml >/dev/null 2>&1; then
    echo "a CRD contains '{{' and can't move into templates/ as-is" >&2
    exit 1
  fi
  mkdir -p "$out/templates/crds"
  for crd in "$out"/crds/*.yaml; do
    yq -i '.metadata.annotations."helm.sh/resource-policy" = "keep"' "$crd"
    mv "$crd" "$out/templates/crds/"
  done
  rmdir "$out/crds"
  ;;
*)
  echo "usage: $0 list <values.yaml> | stamp <chart-dir> <image-prefix> <tag> | controller <stamped-chart-dir> <out-dir>" >&2
  exit 2
  ;;
esac
