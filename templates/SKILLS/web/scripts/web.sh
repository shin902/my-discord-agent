#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "Usage: web.sh <capability> '<JSON arguments>'" >&2
  exit 2
fi

exec tool-proxy "$1" "$2"
