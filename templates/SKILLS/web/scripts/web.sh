#!/bin/sh
set -eu

if [ "$#" -eq 1 ]; then
  exec tool-proxy describe "$1"
fi

if [ "$#" -ne 2 ]; then
  echo "Usage: web.sh <capability> ['<JSON arguments>']" >&2
  exit 2
fi

exec tool-proxy "$1" "$2"
