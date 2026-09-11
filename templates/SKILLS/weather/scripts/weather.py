#!/usr/bin/env python3
"""Thin subcommand frontend for weather capabilities."""
import argparse
import json
import os
import sys


def build_parser():
    parser = argparse.ArgumentParser(
        prog="weather.py", description="Get weather through Tool Proxy"
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    current = commands.add_parser("current", help="get current weather")
    current.set_defaults(capability="get-current-weather")
    current.add_argument("location")

    forecast = commands.add_parser("forecast", help="get a forecast")
    forecast.set_defaults(capability="get-weather-forecast")
    forecast.add_argument("location")
    forecast.add_argument("--days", type=int)
    return parser


def main(argv=None):
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    payload = {"location": args.location}
    if args.operation == "forecast" and args.days is not None:
        payload["days"] = args.days

    os.execvp(
        "tool-proxy",
        ["tool-proxy", args.capability, json.dumps(payload, ensure_ascii=False)],
    )


if __name__ == "__main__":
    raise SystemExit(main())
