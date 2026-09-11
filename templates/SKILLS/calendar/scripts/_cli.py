#!/usr/bin/env python3
"""Thin CLI argument adapter for trusted Google Calendar capabilities."""
import argparse
import json
import subprocess
import sys


OPERATIONS = {
    "calendars": "list-calendars",
    "events": "list-events",
    "event": "read-event",
    "create": "create-event",
    "update": "update-event",
    "delete": "delete-event",
}


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


def optional_calendar_id(parser):
    parser.add_argument("--calendar-id", "--calendarId", dest="calendar_id")


def add_event_fields(parser, *, include_recurrence=False, include_core=True):
    if include_core:
        parser.add_argument("--summary")
        parser.add_argument("--start")
        parser.add_argument("--end")
    parser.add_argument("--description")
    parser.add_argument("--location")
    parser.add_argument("--attendee", "--attendees", dest="attendees", action="append")
    parser.add_argument("--time-zone", "--timeZone", dest="time_zone")
    if include_recurrence:
        parser.add_argument("--recurrence", action="append")
    optional_calendar_id(parser)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help"):
        print("Usage: calendars.sh | events.sh | event.sh | create.sh | update.sh | delete.sh ...")
        print("Operations: calendars, events, event, create, update, delete")
        return 0
    operation = argv[0]
    if operation not in OPERATIONS:
        print(f"unknown operation: {operation}", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(prog=f"{operation}.sh", description=f"Google Calendar {operation} via Tool Proxy")
    if operation == "calendars":
        pass
    elif operation == "events":
        optional_calendar_id(parser)
        parser.add_argument("--time-min", "--timeMin", dest="time_min")
        parser.add_argument("--time-max", "--timeMax", dest="time_max")
        parser.add_argument("--max-results", "--maxResults", dest="max_results", type=int)
    elif operation == "event" or operation == "delete":
        parser.add_argument("event_id")
        optional_calendar_id(parser)
    elif operation == "create":
        parser.add_argument("summary")
        parser.add_argument("start")
        parser.add_argument("end")
        add_event_fields(parser, include_recurrence=True, include_core=False)
    else:
        parser.add_argument("event_id")
        add_event_fields(parser)
    args = parser.parse_args(argv[1:])

    if operation == "calendars":
        payload = {}
    elif operation == "events":
        payload = {}
        if args.calendar_id is not None:
            payload["calendarId"] = args.calendar_id
        if args.time_min is not None:
            payload["timeMin"] = args.time_min
        if args.time_max is not None:
            payload["timeMax"] = args.time_max
        if args.max_results is not None:
            payload["maxResults"] = args.max_results
    elif operation == "event" or operation == "delete":
        payload = {"eventId": args.event_id}
        if args.calendar_id is not None:
            payload["calendarId"] = args.calendar_id
    else:
        payload = {}
        if operation == "create":
            payload.update({"summary": args.summary, "start": args.start, "end": args.end})
        else:
            payload["eventId"] = args.event_id
        for source, target in (
            ("description", "description"),
            ("location", "location"),
            ("time_zone", "timeZone"),
            ("calendar_id", "calendarId"),
        ):
            value = getattr(args, source)
            if value is not None:
                payload[target] = value
        if operation == "update":
            for source in ("summary", "start", "end"):
                value = getattr(args, source)
                if value is not None:
                    payload[source] = value
        if args.attendees is not None:
            payload["attendees"] = args.attendees
        if operation == "create" and args.recurrence is not None:
            payload["recurrence"] = args.recurrence
    return invoke(OPERATIONS[operation], payload)


if __name__ == "__main__":
    raise SystemExit(main())
