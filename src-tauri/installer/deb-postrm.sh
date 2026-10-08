#!/bin/sh
# Removes the link of the old program name (deb-postinst.sh) with the package.
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if [ -L /usr/bin/annalo ]; then rm -f /usr/bin/annalo; fi
fi
exit 0
