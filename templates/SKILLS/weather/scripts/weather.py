#!/usr/bin/env python3
"""Thin subcommand frontend for weather capabilities."""
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


def build_parser():
    parser = argparse.ArgumentParser(
        prog="weather.py",
        description="Get weather through the shared Tool Proxy",
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    current = commands.add_parser("current", help="get current weather")
    current.add_argument("location")

    forecast = commands.add_parser("forecast", help="get a weather forecast")
    forecast.add_argument("location")
    forecast.add_argument("--days", type=int)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)
    payload = {"location": args.location}
    if args.operation == "forecast" and args.days is not None:
        payload["days"] = args.days
    return invoke(OPERATIONS[args.operation], payload)


if __name__ == "__main__":
    raise SystemExit(main())
