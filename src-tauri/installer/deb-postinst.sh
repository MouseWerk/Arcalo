#!/bin/sh
# Arcalo 1.14 and earlier installed the program as /usr/bin/annalo; autostart entries, menus
# and scripts may still name it. The old name stays a link to the program.
set -e
if [ ! -e /usr/bin/annalo ] || [ -L /usr/bin/annalo ]; then
  ln -sf arcalo /usr/bin/annalo
fi
exit 0
