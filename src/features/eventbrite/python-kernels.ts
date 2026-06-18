export const EVENTBRITE_KERNELS_PY = String.raw`
from __future__ import annotations

import json
import os
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path


DATA_DIR = Path(os.environ["EVENTBRITE_DATA_DIR"])


def archive_root(data_dir=None):
    return Path(data_dir or DATA_DIR)


def event_dir(event_id, data_dir=None):
    return archive_root(data_dir) / "events" / str(event_id)


def load_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def event_ids(data_dir=None):
    root = archive_root(data_dir) / "events"
    if not root.exists():
        return []
    return sorted(p.name for p in root.iterdir() if (p / "_meta.json").exists())


def meta(event_id, data_dir=None):
    return load_json(event_dir(event_id, data_dir) / "_meta.json", {}) or {}


def event(event_id, data_dir=None):
    return load_json(event_dir(event_id, data_dir) / "event.json", {}) or {}


def attendees(event_id, data_dir=None):
    return (load_json(event_dir(event_id, data_dir) / "attendees.json", {}) or {}).get("items", [])


def orders(event_id, data_dir=None):
    return (load_json(event_dir(event_id, data_dir) / "orders.json", {}) or {}).get("items", [])


def report(event_id, name, data_dir=None):
    return load_json(event_dir(event_id, data_dir) / "reports" / name, {}) or {}


def parse_dt(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    text = str(value)
    for fmt in (None, "%m/%d/%y %I:%M %p", "%Y-%m-%d %H:%M:%S"):
        try:
            if fmt is None:
                return datetime.fromisoformat(text.replace("Z", "+00:00"))
            return datetime.strptime(text, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            pass
    return None


def money(obj):
    if not isinstance(obj, dict):
        return Decimal("0")
    try:
        return Decimal(str(obj.get("major_value") or "0"))
    except Exception:
        return Decimal("0")


def event_start(event_id, data_dir=None):
    blob = event(event_id, data_dir)
    return parse_dt((blob.get("start") or {}).get("utc"))


def ticket_bucket(attendee):
    name = (attendee.get("ticket_class_name") or "").lower()
    gross = money((attendee.get("costs") or {}).get("gross"))
    if "reserved" in name:
        return "reserved"
    if "donation" in name:
        return "donation"
    if "ada" in name:
        return "ada_paid" if gross > 0 else "ada_free"
    return "paid" if gross > 0 else "free"


def active_attendees(event_id, data_dir=None):
    return [
        row for row in attendees(event_id, data_dir)
        if row.get("status") in ("Attending", "Checked In")
        and not row.get("refunded")
        and not row.get("cancelled")
    ]


def rows_for_bucket(event_id, bucket, cutoff=None, data_dir=None):
    rows = []
    for row in active_attendees(event_id, data_dir):
        created = parse_dt(row.get("created"))
        if cutoff and created and created > cutoff:
            continue
        row_bucket = ticket_bucket(row)
        if bucket == "free" and row_bucket in ("free", "ada_free"):
            rows.append(row)
        elif bucket == "paid" and row_bucket in ("paid", "ada_paid"):
            rows.append(row)
        elif bucket == "paid_or_reserved" and row_bucket in ("paid", "ada_paid", "reserved"):
            rows.append(row)
        elif bucket == row_bucket:
            rows.append(row)
    return rows


def ticket_bucket_summary(event_id, cutoff=None, data_dir=None):
    counts = Counter()
    gross = defaultdict(Decimal)
    checked_in = Counter()
    for row in active_attendees(event_id, data_dir):
        created = parse_dt(row.get("created"))
        if cutoff and created and created > cutoff:
            continue
        bucket = ticket_bucket(row)
        counts[bucket] += 1
        gross[bucket] += money((row.get("costs") or {}).get("gross"))
        if row.get("checked_in"):
            checked_in[bucket] += 1
    return {
        bucket: {
            "registrations": count,
            "checked_in": checked_in[bucket],
            "gross": float(gross[bucket]),
        }
        for bucket, count in counts.items()
    }


def registration_curve(event_id, bucket="free", marks=(60,45,30,28,21,14,10,7,5,3,1,0), data_dir=None):
    start = event_start(event_id, data_dir)
    rows = rows_for_bucket(event_id, bucket, data_dir=data_dir)
    total = len(rows)
    created = [(parse_dt(row.get("created")), row) for row in rows]
    created = [(dt, row) for dt, row in created if dt]
    out = {"final": total}
    for mark in marks:
        cutoff = start - timedelta(days=mark) if start else None
        count = sum(1 for dt, _ in created if cutoff and dt <= cutoff)
        out[f"d{mark}"] = {"count": count, "pct_final": round(count / total * 100, 1) if total else None}
    if start and created:
        leads = sorted((start - dt).total_seconds() / 86400 for dt, _ in created)
        out["median_days_before"] = round(leads[len(leads)//2], 1)
    return out


def traffic_conversion(event_id, data_dir=None):
    return report(event_id, "traffic_conversion.json", data_dir)


def traffic_totals(event_id, prefer_series=True, data_dir=None):
    blob = traffic_conversion(event_id, data_dir)
    event_report = blob.get("event_report") or {}
    series_report = blob.get("series_report") or {}
    reach_report = series_report if prefer_series and series_report else event_report
    reach = (reach_report.get("totals") or {})
    conversion = (event_report.get("totals") or {})
    pageviews = int(reach.get("traffic_pageviews") or 0)
    orders_sold = int(conversion.get("orders_sold") or 0)
    attendee_quantity = int(conversion.get("attendee_quantity") or 0)
    return {
        "event_id": str(event_id),
        "series_id": blob.get("series_id"),
        "pageviews": pageviews,
        "orders_sold": orders_sold,
        "attendee_quantity": attendee_quantity,
        "order_conversion_pct": round(orders_sold / pageviews * 100, 2) if pageviews else None,
        "ticket_conversion_pct": round(attendee_quantity / pageviews * 100, 2) if pageviews else None,
        "reach_report_event_id": reach_report.get("report_event_id"),
        "conversion_report_event_id": event_report.get("report_event_id"),
    }


def series_id_for(event_id, data_dir=None):
    blob = event(event_id, data_dir)
    return blob.get("series_id") or str(event_id)


def series_children(event_id, data_dir=None):
    series_id = series_id_for(event_id, data_dir)
    children = []
    for candidate in event_ids(data_dir):
        blob = event(candidate, data_dir)
        if blob.get("series_id") == series_id or candidate == series_id:
            children.append(candidate)
    return sorted(set(children)) or [str(event_id)]


def series_traffic_totals(event_id, data_dir=None):
    children = series_children(event_id, data_dir)
    series_id = series_id_for(event_id, data_dir)
    pageviews = 0
    reach_report_event_id = None
    orders_sold = 0
    attendee_quantity = 0

    for child in children:
        blob = traffic_conversion(child, data_dir)
        event_report = blob.get("event_report") or {}
        series_report = blob.get("series_report") or {}
        if series_report and not pageviews:
            reach = series_report.get("totals") or {}
            pageviews = int(reach.get("traffic_pageviews") or 0)
            reach_report_event_id = series_report.get("report_event_id")
        if event_report:
            conversion = event_report.get("totals") or {}
            orders_sold += int(conversion.get("orders_sold") or 0)
            attendee_quantity += int(conversion.get("attendee_quantity") or 0)
        else:
            attendee_quantity += len(active_attendees(child, data_dir))
            orders_sold += sum(1 for order in orders(child, data_dir) if order.get("status") == "placed")

    if not pageviews:
        for child in children:
            totals = traffic_totals(child, prefer_series=False, data_dir=data_dir)
            pageviews += int(totals.get("pageviews") or 0)
            reach_report_event_id = reach_report_event_id or totals.get("reach_report_event_id")

    return {
        "series_id": series_id,
        "children": children,
        "pageviews": pageviews,
        "orders_sold": orders_sold,
        "attendee_quantity": attendee_quantity,
        "order_conversion_pct": round(orders_sold / pageviews * 100, 2) if pageviews else None,
        "ticket_conversion_pct": round(attendee_quantity / pageviews * 100, 2) if pageviews else None,
        "reach_report_event_id": reach_report_event_id,
    }


def tminus_days(event_id, as_of=None, data_dir=None):
    start = event_start(event_id, data_dir)
    if not start:
        return None
    as_of_dt = parse_dt(as_of) if as_of else datetime.now(timezone.utc)
    if as_of_dt.tzinfo is None:
        as_of_dt = as_of_dt.replace(tzinfo=timezone.utc)
    return (start - as_of_dt).total_seconds() / 86400


def cutoff_at_tminus(event_id, days_before, data_dir=None):
    start = event_start(event_id, data_dir)
    return start - timedelta(days=days_before) if start else None
`;

export function eventbriteKernelPrelude(): string {
  return [
    'import sys, types',
    `_eventbrite_kernel_source = ${JSON.stringify(EVENTBRITE_KERNELS_PY)}`,
    '_eventbrite_kernels = types.ModuleType("eventbrite_kernels")',
    'exec(_eventbrite_kernel_source, _eventbrite_kernels.__dict__)',
    'sys.modules["eventbrite_kernels"] = _eventbrite_kernels',
  ].join('\n');
}