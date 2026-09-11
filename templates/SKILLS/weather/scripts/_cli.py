#!/usr/bin/env python3
"""Thin CLI argument adapter for trusted weather capabilities."""
import argparse
import json
import subprocess
import sys


OPERATIONS = {"current": "get-current-weather", "forecast": "get-weather-forecast"}


def invoke(capability, payload):
    try:
        result = subprocess.run(
            ["tool-proxy", capability, json.dumps(payload, ensure_ascii=False)],
            check=False,
        )
    except FileNotFoundError:
        print("tool-proxy is unavailable; update the Runner image", file=sys.stderr)
        return 1
    return result.returncode


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print("Usage: current.sh LOCATION | forecast.sh LOCATION [--days N]")
        print("Operations: current, forecast")
        return 0
    operation = argv[0]
    if operation not in OPERATIONS:
        print(f"unknown operation: {operation}", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(prog=f"{operation}.sh", description=f"Get {operation} weather via Tool Proxy")
    parser.add_argument("location")
    if operation == "forecast":
        parser.add_argument("--days", type=int)
    args = parser.parse_args(argv[1:])
    payload = {"location": args.location}
    if operation == "forecast" and args.days is not None:
        payload["days"] = args.days
    return invoke(OPERATIONS[operation], payload)


if __name__ == "__main__":
    raise SystemExit(main())
