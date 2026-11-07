#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

if [[ "${1:-}" == "--help" ]]; then
  cat <<'HELP'
Usage: scripts/build-image.sh [IMAGE_TAG] [OUTPUT_TAR_GZ]

Build and load the application image, then export it for offline deployment.
Defaults: pr-review-agent:<git-sha>, work/docker/pr-review-agent-<git-sha>.tar.gz
Set PLATFORM=linux/arm64 for ARM servers (default: linux/amd64).
The image contains neither .env nor private keys; mount them when deploying.
HELP
  exit 0
fi

revision="$(git rev-parse --short HEAD)"
image_tag="${1:-pr-review-agent:$revision}"
output_file="${2:-work/docker/pr-review-agent-$revision.tar.gz}"
platform="${PLATFORM:-linux/amd64}"

mkdir -p "$(dirname -- "$output_file")"
docker buildx build --platform "$platform" --load --tag "$image_tag" .
docker image save "$image_tag" | gzip > "$output_file"
printf 'Image: %s\nPlatform: %s\nArchive: %s\n' "$image_tag" "$platform" "$output_file"
