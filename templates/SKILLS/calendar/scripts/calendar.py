#!/usr/bin/env python3
"""Thin subcommand frontend for Google Calendar capabilities."""
import argparse
import json
import os
import sys


def add_event_options(parser, required=False, recurrence=False):
    for name in ("summary", "start", "end"):
        parser.add_argument(f"--{name}", required=required)
    parser.add_argument("--description")
    parser.add_argument("--location")
    parser.add_argument("--attendee", dest="attendees", action="append")
    parser.add_argument("--time-zone", dest="time_zone")
    parser.add_argument("--calendar-id", dest="calendar_id")
    if recurrence:
        parser.add_argument("--recurrence", action="append")


def build_parser():
    parser = argparse.ArgumentParser(
        prog="calendar.py", description="Use Google Calendar through Tool Proxy"
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    calendars = commands.add_parser("calendars", help="list calendars")
    calendars.set_defaults(capability="list-calendars")

    events = commands.add_parser("events", help="list events")
    events.set_defaults(capability="list-events")
    events.add_argument("--calendar-id", dest="calendar_id")
    events.add_argument("--time-min", dest="time_min")
    events.add_argument("--time-max", dest="time_max")
    events.add_argument("--max-results", dest="max_results", type=int)

    event = commands.add_parser("event", help="read an event")
    event.set_defaults(capability="read-event")
    event.add_argument("event_id")
    event.add_argument("--calendar-id", dest="calendar_id")

    create = commands.add_parser("create", help="create an event")
    create.set_defaults(capability="create-event")
    add_event_options(create, required=True, recurrence=True)

    update = commands.add_parser("update", help="update an event")
    update.set_defaults(capability="update-event")
    update.add_argument("event_id")
    add_event_options(update)

    delete = commands.add_parser("delete", help="delete an event")
    delete.set_defaults(capability="delete-event")
    delete.add_argument("event_id")
    delete.add_argument("--calendar-id", dest="calendar_id")
    return parser


def main(argv=None):
    args = build_parser().parse_args(sys.argv[1:] if argv is None else argv)
    payload = {}
    if args.operation in ("event", "update", "delete"):
        payload["eventId"] = args.event_id

    if args.operation == "events":
        fields = (
            ("calendar_id", "calendarId"),
            ("time_min", "timeMin"),
            ("time_max", "timeMax"),
            ("max_results", "maxResults"),
        )
    elif args.operation in ("event", "delete"):
        fields = (("calendar_id", "calendarId"),)
    elif args.operation in ("create", "update"):
        fields = (
            ("summary", "summary"),
            ("start", "start"),
            ("end", "end"),
            ("description", "description"),
            ("location", "location"),
            ("time_zone", "timeZone"),
            ("calendar_id", "calendarId"),
        )
    else:
        fields = ()

    for source, target in fields:
        value = getattr(args, source, None)
        if value is not None:
            payload[target] = value
    for source in ("attendees", "recurrence"):
        value = getattr(args, source, None)
        if value is not None:
            payload[source] = value

    os.execvp(
        "tool-proxy",
        ["tool-proxy", args.capability, json.dumps(payload, ensure_ascii=False)],
    )


if __name__ == "__main__":
    raise SystemExit(main())
