#!/bin/sh
# Removes the link of the old program name (deb-postinst.sh) with the package; a file or a link
# to another program under that name is not ours and stays. Not on an upgrade (the new
# version's postinst keeps the link).
set -e
link="$DPKG_ROOT/usr/bin/annalo"
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if [ -L "$link" ] && [ "$(readlink "$link")" = arcalo ]; then
    rm -f "$link"
  fi
fi
exit 0
