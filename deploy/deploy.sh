#!/usr/bin/env bash
set -euo pipefail

# Build the SPA and swap it live atomically. Run on the server, from the repo
# root of the instance's checkout:
#
#   deploy/deploy.sh production|staging|testing
#
# Each instance deploys from its own branch (production ← main, staging ←
# staging, testing ← testing); the script refuses to build from any other
# branch. It writes the build into a fresh directory under
# /opt/lets-encode/<instance>/releases/ and repoints the `current` symlink the
# Apache vhost serves, so no request ever sees a half-copied build. The broker
# is untouched — restart it separately when broker/ changed.

instance=${1:?usage: deploy/deploy.sh production|staging|testing}

case "$instance" in
	production) branch=main ;;
	staging)    branch=staging ;;
	testing)    branch=testing ;;
	*) echo "unknown instance: $instance" >&2; exit 1 ;;
esac

deploy_root=/opt/lets-encode/$instance

checked_out=$(git rev-parse --abbrev-ref HEAD)
if [ "$checked_out" != "$branch" ]; then
	echo "refusing: $instance deploys from '$branch', this checkout is on '$checked_out'" >&2
	exit 1
fi

npm ci
# Vite's default build mode is production; staging/testing select their
# .env.<mode> overlays.
if [ "$instance" = production ]; then
	npm run build
else
	npm run build -- --mode "$instance"
fi

release=$deploy_root/releases/$(date +%Y%m%d-%H%M%S)-$(git rev-parse --short HEAD)
mkdir -p "$release"
cp -R build/. "$release"/

# ln + mv -T so the symlink is replaced in one rename, never a dangling gap.
ln -sfn "$release" "$deploy_root/current.new"
mv -T "$deploy_root/current.new" "$deploy_root/current"

# Keep the five newest releases for rollback (repoint `current` by hand).
ls -dt "$deploy_root"/releases/*/ | tail -n +6 | xargs -r rm -rf

echo "deployed $instance: $release"
