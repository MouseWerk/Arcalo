#!/bin/sh
# Arcalo 1.14 and earlier installed the program as /usr/bin/annalo; autostart entries, menus
# and scripts may still name it. The old name stays a link to the program. Only a missing name
# (or a link to nothing) is filled: a file or a link to another program stays as it is.
# $DPKG_ROOT: the root dpkg installs into (`dpkg --root`), empty for the system itself.
set -e
link="$DPKG_ROOT/usr/bin/annalo"
if [ ! -e "$link" ]; then
  ln -sfn arcalo "$link"
fi
exit 0
