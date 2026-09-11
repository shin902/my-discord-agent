#!/usr/bin/env python3
"""Thin subcommand frontend for Google Calendar capabilities."""
import argparse
import json
import subprocess
import sys


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


def add_calendar_id(parser):
    parser.add_argument("--calendar-id", "--calendarId", dest="calendar_id")


def add_event_fields(parser, include_core=False, recurrence=False):
    if include_core:
        parser.add_argument("--summary")
        parser.add_argument("--start")
        parser.add_argument("--end")
    parser.add_argument("--description")
    parser.add_argument("--location")
    parser.add_argument("--attendee", "--attendees", dest="attendees", action="append")
    parser.add_argument("--time-zone", "--timeZone", dest="time_zone")
    if recurrence:
        parser.add_argument("--recurrence", action="append")
    add_calendar_id(parser)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="calendar.py",
        description="Use Google Calendar through the shared Tool Proxy",
    )
    commands = parser.add_subparsers(dest="operation", required=True)

    commands.add_parser("calendars", help="list calendars")

    events = commands.add_parser("events", help="list events")
    add_calendar_id(events)
    events.add_argument("--time-min", "--timeMin", "--from", dest="time_min")
    events.add_argument("--time-max", "--timeMax", "--to", dest="time_max")
    events.add_argument("--max-results", "--maxResults", dest="max_results", type=int)

    event = commands.add_parser("event", help="read one event")
    event.add_argument("event_id")
    add_calendar_id(event)

    create = commands.add_parser("create", help="create an event")
    # Keep positional forms accepted by the first Skill draft while exposing
    # the clearer option form documented by this public CLI.
    create.add_argument("summary_pos", nargs="?")
    create.add_argument("start_pos", nargs="?")
    create.add_argument("end_pos", nargs="?")
    create.add_argument("--summary")
    create.add_argument("--start")
    create.add_argument("--end")
    add_event_fields(create, recurrence=True)

    update = commands.add_parser("update", help="update an event")
    update.add_argument("event_id")
    add_event_fields(update, include_core=True)

    delete = commands.add_parser("delete", help="delete an event")
    delete.add_argument("event_id")
    add_calendar_id(delete)

    return parser


def optional_fields(args, fields):
    payload = {}
    for source, target in fields:
        value = getattr(args, source)
        if value is not None:
            payload[target] = value
    attendees = getattr(args, "attendees", None)
    if attendees is not None:
        payload["attendees"] = attendees
    return payload


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    if args.operation == "calendars":
        return invoke("list-calendars", {})

    if args.operation == "events":
        payload = optional_fields(
            args,
            (
                ("calendar_id", "calendarId"),
                ("time_min", "timeMin"),
                ("time_max", "timeMax"),
                ("max_results", "maxResults"),
            ),
        )
        return invoke("list-events", payload)

    if args.operation == "event":
        payload = {"eventId": args.event_id}
        payload.update(optional_fields(args, (("calendar_id", "calendarId"),)))
        return invoke("read-event", payload)

    if args.operation == "delete":
        payload = {"eventId": args.event_id}
        payload.update(optional_fields(args, (("calendar_id", "calendarId"),)))
        return invoke("delete-event", payload)

    if args.operation == "create":
        summary = args.summary if args.summary is not None else args.summary_pos
        start = args.start if args.start is not None else args.start_pos
        end = args.end if args.end is not None else args.end_pos
        if summary is None or start is None or end is None:
            parser.error("create requires --summary, --start, and --end")
        payload = {"summary": summary, "start": start, "end": end}
        payload.update(
            optional_fields(
                args,
                (
                    ("description", "description"),
                    ("location", "location"),
                    ("time_zone", "timeZone"),
                    ("calendar_id", "calendarId"),
                ),
            )
        )
        if args.recurrence is not None:
            payload["recurrence"] = args.recurrence
        return invoke("create-event", payload)

    payload = {"eventId": args.event_id}
    payload.update(
        optional_fields(
            args,
            (
                ("summary", "summary"),
                ("start", "start"),
                ("end", "end"),
                ("description", "description"),
                ("location", "location"),
                ("time_zone", "timeZone"),
                ("calendar_id", "calendarId"),
            ),
        )
    )
    return invoke("update-event", payload)


if __name__ == "__main__":
    raise SystemExit(main())
