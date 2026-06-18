# Eventbrite Analytics Plan (Temporary)

Temporary planning notes for making Moomie able to reproduce the kind of Eventbrite sales/traffic analysis we did manually.

## Goals

- Make Eventbrite analysis timeline-aware by default for live/upcoming events.
- Archive dashboard-grade Eventbrite traffic conversion data, including page views.
- Correctly handle Eventbrite series/multi-date events.
- Preserve the existing sandbox boundary: trusted TypeScript fetches Eventbrite data; model-authored Python only reads local JSON.
- Let Discord conversations continue naturally across thread/reply context.
- Encode RTO-specific analysis preferences into prompts/playbooks so Moomie starts from the right frame.

## Trust Boundary

The Eventbrite analysis system should replicate the successful parts of our manual investigation, but not the dangerous parts.

What worked well manually:

- A capable LLM selected hypotheses and next calculations.
- The LLM wrote small scripts to compute concrete numbers.
- The scripts produced auditable intermediate outputs.
- We iterated based on the results rather than trusting prose intuition.

What must **not** be replicated inside the sandbox:

- Brute-forcing Eventbrite API endpoints.
- Trying arbitrary Eventbrite request payloads.
- Accessing `EVENTBRITE_PRIVATE_TOKEN`.
- Making network requests to Eventbrite.

Required boundary:

- Trusted TypeScript tools own all Eventbrite API access.
- Trusted tools may fetch/snapshot live data and archive it as JSON.
- The analysis sandbox receives only local JSON files and selected non-secret environment variables.
- Model-authored Python can inspect, join, aggregate, and chart those files, but cannot call Eventbrite or read secrets.

In other words:

```text
Good: LLM writes pandas over archived Eventbrite JSON.
Bad: LLM tries Eventbrite API endpoints with the private token.
```

If new Eventbrite API endpoints are needed, they should be added as trusted TypeScript fetchers first, then exposed to analysis through archive/live snapshot files.

## Analysis Execution Model

The target model is not "trust the LLM to answer from vibes." It is:

1. Trusted code prepares the data pack.
2. The LLM chooses an analysis path.
3. The LLM writes and runs scripts over local files.
4. The script outputs tables/charts/JSON.
5. The LLM summarizes the computed results and cites the derived numbers.

Known recurring calculations should become deterministic helper functions or analysis kernels where possible. The Python sandbox remains useful for flexible follow-up analysis, but common metrics should not require the model to reinvent every formula.

Examples of calculations that should become reusable kernels:

- t-minus timeline cutoffs
- free/paid/reserved/donation ticket bucketing
- free vs paid registration ramp curves
- series parent vs child event reconciliation
- traffic conversion aggregation
- source and affiliate deltas
- show-rate / no-show-rate summaries
- capacity projections

## Data Model Requirements

Each archived Eventbrite event should include:

- `event.json`
- `attendees.json`
- `orders.json`
- `ticket_classes.json`
- `reports/sales.json`
- `reports/attendees.json`
- `reports/traffic_conversion.json`

For Eventbrite series:

- Child event IDs carry orders, attendee quantities, ticket classes, and performance-specific registrations.
- The series parent ID may carry page views/reach.
- The archive should store both child and series traffic reports when `event.json.series_id` exists.

Important rule:

- For reach/page-view denominator, prefer `series_report` when a series parent exists.
- For orders/tickets/attendees, use child event reports.

## Eventbrite Traffic Conversion Endpoint

The useful dashboard-style endpoint is:

```text
POST /organizations/{org}/reports/datasets/traffic_conversion/
```

The useful aggregate payload shape is:

```json
{
  "aggregations": [
    { "field": "traffic_pageviews", "method": "sum", "alias": "traffic_pageviews__sum" },
    { "field": "attendee_quantity", "method": "sum", "alias": "attendee_quantity__sum" },
    { "field": "orders_sold", "method": "sum", "alias": "orders_sold__sum" }
  ],
  "sort_by": [{ "field": "traffic_date_daily", "method": "asc" }],
  "group_by": [
    { "field": "traffic_date_daily" },
    { "field": "affiliate_category" }
  ],
  "filters": [
    { "field": "event_id", "operator": "in", "value": ["EVENT_OR_SERIES_ID"] }
  ],
  "having": [],
  "select": [],
  "page_size": 310,
  "report": "traffic_conversion",
  "timezone": "America/Los_Angeles"
}
```

For timeline-aware comparisons, add a date filter:

```json
{
  "field": "traffic_date",
  "operator": "between",
  "value": ["YYYY-MM-DD 00:00:00", "YYYY-MM-DD 23:59:59"]
}
```

Known Eventbrite quirk:

- The older public `reports/traffic` endpoint can return zero page views even when the dashboard has real page-view data.
- Use `reports/datasets/traffic_conversion/` instead.

## PR #42 Implementation Plan

PR #42 should focus on archiving the correct traffic/conversion data and removing any exploratory/broken endpoint work.

### Keep

- `EventbriteClient.post()` for trusted JSON POST requests.
- `reports/traffic_conversion.json` produced from the dashboard dataset endpoint.
- Aggregate payload using `aggregations`, `group_by`, `filters`, `report`, and `timezone`.
- Series-aware archive shape:
  - `event_report` for the child event ID.
  - `series_report` for `event.json.series_id`, when present.
- Analyzer schema documentation for `traffic_conversion.json`.

### Do Not Keep

- Calls to `/organizations/{org}/reports/traffic/?event_ids=...`.
- Calls to `traffic_summary`, `event_traffic`, `page_views`, or event-level `/traffic/` style endpoints.
- `traffic_sales_channel_lvl_*.json` files from the earlier broken approach.
- Any code that treats zero-valued `reports/traffic` responses as the page-view source of truth.
- Any sandbox-visible Eventbrite token, endpoint probing, or network access.

### Correct Archive Behavior

For every event snapshot:

1. Fetch the normal child event snapshot data.
2. Read `eventBlob.series_id` if present.
3. Fetch traffic conversion aggregate for the child event ID.
4. If `series_id` exists and differs from the child event ID, fetch traffic conversion aggregate for the series ID.
5. Write one file:

```text
reports/traffic_conversion.json
```

Expected shape:

```json
{
  "source": "/organizations/{org}/reports/datasets/traffic_conversion/",
  "retrieved_at": "...",
  "event_id": "child event id",
  "series_id": "series parent id or null",
  "event_report": {
    "report_event_id": "child event id",
    "totals": {
      "traffic_pageviews": 87,
      "attendee_quantity": 325,
      "orders_sold": 138
    },
    "items": []
  },
  "series_report": {
    "report_event_id": "series parent id",
    "totals": {
      "traffic_pageviews": 1988,
      "attendee_quantity": 0,
      "orders_sold": 0
    },
    "items": []
  }
}
```

Interpretation rule:

- For Eventbrite series, use `series_report.totals.traffic_pageviews` for reach.
- Use child `event_report` totals, attendees, orders, attendees.json, and orders.json for conversion/registrations.
- If no series report exists, use `event_report` for both reach and conversion.

### Live Data Sync Behavior

Live analysis should use the same snapshot path as archive analysis:

- Before running `analyze_eventbrite`, trusted code refreshes active event snapshots.
- Active event snapshots should include `traffic_conversion.json`.
- The Python sandbox sees only the snapshot files.
- The sandbox never sees `EVENTBRITE_PRIVATE_TOKEN` and never calls Eventbrite.

This means live/current analysis and archived/past analysis use the same file contract.

### Acceptance Checks

Before merging PR #42:

- Search source for broken endpoint leftovers:

```text
reports/traffic
traffic_sales_channel
traffic_summary
event_traffic
page_views
/traffic/
```

Only documentation of the broken endpoint as a warning is acceptable; no fetch calls should remain.

- Build passes:

```text
npm run build
```

- Snapshot verification for current Thursday child event:

```text
snapshotEvent("1989325458999")
```

Expected verification values at time of investigation:

- `event_report.totals.traffic_pageviews`: 87
- `event_report.totals.attendee_quantity`: 325
- `event_report.totals.orders_sold`: 138
- `series_report.totals.traffic_pageviews`: 1,988

- Confirm analyzer docs say series page views may live on `series_report` while child orders/tickets live on `event_report`.

### PR #42 Implementation Status

Implemented in PR #42:

1. Correct dashboard traffic conversion archiving.
2. Series parent / child event traffic reconciliation in archived JSON.
3. Trusted Python analysis kernels injected into the sandbox as `eventbrite_kernels`.
4. Prompt rules for timeline-aware, series-aware, free/paid-aware analysis.
5. Optional `playbook` argument for `analyze_eventbrite`.

Still not implemented in PR #42:

1. Discord conversation memory / persistent analysis context.
2. Automatic thread/reply-chain context harvesting beyond existing chat tools.
3. A deterministic TypeScript context-pack generator that precomputes every table before the LLM runs.
4. Fully scripted playbook outputs that bypass LLM-authored Python for common requests.

Those remaining items should be scoped separately unless they become necessary during PR #42 review.

## Timeline-Aware Comparison

Default behavior for live/upcoming events:

1. Compute `days_before_event = event_start - now`.
2. For each baseline event, compute `baseline_cutoff = baseline_event_start - days_before_event`.
3. Compare current data only to historical data up to `baseline_cutoff`.
4. Show final historical totals only as context, not as the primary comparison.

Default output should include:

- Current event page views, orders, tickets/attendees, conversion rates.
- Baseline average at the same t-minus point.
- Current-vs-baseline ratios.
- Baseline final totals for context.
- A clear warning if the user asks for current vs final historical totals.

## RTO Baseline Defaults

For modern masterworks / 1,000-person target analysis, default baseline should be:

- Broadway Lights, Hollywood Nights
- Tchaik Night
- Symphonic Fantasia

Older events such as Rhythm & Blues and RACH FEST are useful for weekday/venue context, but they were smaller-era concerts and should not be the default modern-scale baseline.

## Required Analysis Frames

### Reach vs Conversion

Decompose ticket performance into:

```text
ticket volume = page views * ticket conversion rate
order volume = page views * order conversion rate
```

This helps separate:

- not enough people saw the page
- people saw the page but did not register

Example from the Shakespeare investigation:

- Timeline-adjusted page views were about 52% of modern baseline.
- Orders were about 45% of baseline.
- Tickets were about 42% of baseline.
- Ticket conversion was 21.88% vs baseline 26.85%.

Conclusion: reach was the primary issue, with mild conversion drag.

### Free vs Paid Split

Always separate:

- free tickets
- paid tickets
- reserved tickets
- donation tickets
- ADA free/paid where relevant

Do not average paid and free funnels together.

RTO historical defaults from recent masterworks:

- Free tickets are roughly 90% of the funnel.
- Paid tickets are roughly 10% of the funnel.
- Free show rate is roughly 43%.
- Paid/reserved show rate is roughly 75%.

### Free vs Paid Ramp Timing

Free and paid tickets do not ramp on the same timeline. Moomie should avoid treating a paid-ticket shortfall at 4 weeks out the same way it treats a free-ticket shortfall.

For recent modern masterworks:

- Free-ticket baseline should use Broadway, Tchaik, and Symphonic.
- Paid-ticket baseline should use Tchaik and Symphonic; Broadway had effectively no paid-ticket funnel.

Observed average curve:

| Days before | Free avg count | Free % final | Paid avg count | Paid % final |
|---:|---:|---:|---:|---:|
| 30 | 891 | 48.4% | 73 | 22.6% |
| 28 | 949 | 51.6% | 83 | 25.7% |
| 21 | 1,111 | 60.6% | 124 | 37.9% |
| 14 | 1,314 | 71.9% | 174 | 52.8% |
| 10 | 1,417 | 77.4% | 220 | 66.7% |
| 7 | 1,518 | 83.1% | 252 | 76.8% |
| 5 | 1,565 | 85.6% | 270 | 82.3% |
| 3 | 1,633 | 89.3% | 285 | 86.9% |
| 1 | 1,710 | 93.6% | 304 | 93.3% |
| Final | 1,830 | 100% | 323 | 100% |

Key interpretation:

- Around 28-30 days out, free tickets are already about half of final volume.
- Around 28-30 days out, paid tickets are only about one quarter of final volume.
- Free median registration timing is about 27 days before the event.
- Paid median registration timing is about 14 days before the event.
- Paid sales are naturally more backloaded and often accelerate inside the final two weeks.

Symphonic Fantasia paid-ticket curve is a useful reference because it effectively sold out paid tickets near the final week:

| Days before | Symphonic paid count | % final |
|---:|---:|---:|
| 30 | 84 | 22.7% |
| 21 | 153 | 41.4% |
| 14 | 224 | 60.5% |
| 10 | 285 | 77.0% |
| 7 | 314 | 84.9% |
| 5 | 336 | 90.8% |
| 3 | 355 | 95.9% |
| 1 | 369 | 99.7% |
| Final | 370 | 100% |

Default conclusion logic:

- If free tickets are far behind at ~4 weeks out, treat it as urgent because free should already be near half of final volume.
- If paid tickets are behind at ~4 weeks out, treat it as a softer warning because paid historically ramps later.
- If paid + reserved is healthy, do not overstate paid-ticket risk from paid-only numbers.
- Project paid final volume using paid-ramp percentages, not free-ramp percentages.

### Eventbrite Series Reconciliation

For multi-date Eventbrite events:

- Identify series parent and child events.
- Use series parent for page views/reach.
- Use child events for orders/tickets/attendees.
- Explain the mismatch if child page views appear impossibly low.

Example:

- Series parent page views: 1,988.
- Thursday child: 325 attendees / 138 orders.
- Saturday child: 110 attendees / 44 orders.
- Hybrid conversion: 1,988 page views to 182 orders / 435 tickets.

### Source / Affiliate Gap Analysis

Compare by:

- `affiliate_category`
- `affiliate_code`
- Direct Traffic
- Creator Tools
- Eventbrite Marketplace
- Creator Event Links
- known RTO codes such as `rtoweb`, `akams`, `musiciansandfriends`, `sm`, `ebpredboostfbandigads`, `efbevent`

Report:

- biggest absolute gaps
- biggest proportional gaps
- unusually strong sources
- unusually weak sources

Known interpretation caveats:

- Direct Traffic likely includes external links, website links, shortlinks, social posts, Meta ads, email links, musician shares, and unclassified referrals.
- Creator Tools likely includes organizer-generated Eventbrite tools and possibly some Eventbrite campaign/share tooling.
- Eventbrite Marketplace is the cleanest proxy for Eventbrite-native discovery.

### Capacity / No-Show Planning

Inputs:

- venue capacity
- target fill percentage
- historical show rates by ticket bucket

For the current RPAC / Redmond High context:

- Capacity: 522.
- Planning target: 90%, about 470 seats.
- 1,000 free tickets at 43.4% show rate predicts about 434 attendees.
- 600 paid/reserved tickets at 75% show rate predicts about 450 attendees.

### Venue / Weekday Hypothesis

Use older Thursday concerts for context, not as the main modern-scale baseline.

Reasoning from the Shakespeare investigation:

- Older Thursday concerts performed reasonably for smaller venues.
- The current Saturday paid event did not absorb missing Thursday demand.
- Therefore, the data did not strongly support a pure Thursday-vs-Saturday problem.

## Discord Conversation Continuity

Moomie should be able to continue analysis naturally.

Context priority:

1. If in a Discord thread, use recent thread history.
2. If replying to a message, include the reply chain and nearby context.
3. Otherwise, read recent channel messages and filter for relevant Eventbrite/sales/concert discussion.
4. Store lightweight analysis memory per thread/channel for recent Eventbrite investigations.

Suggested memory fields:

- selected baseline events
- active/current Eventbrite event IDs
- series parent and child IDs
- assumptions such as capacity, target fill, free/paid split
- last key metrics
- unresolved hypotheses

Example saved assumptions from this investigation:

- Modern masterworks baseline: Broadway, Tchaik, Symphonic.
- Compare current events at the same t-minus point.
- Split free and paid funnels.
- Use series parent page views and child event orders/tickets.
- Diagnose reach vs conversion before claiming content disinterest.

## Suggested Playbooks

Expose these as named internal analysis flows, or let the chat model choose them.

### `sales_health_check`

- Uses recent masterworks baseline.
- Timeline-adjusts current vs past.
- Splits free/paid/reserved.
- Decomposes reach vs conversion.
- Summarizes source gaps.

### `traffic_conversion_analysis`

- Pulls page views, orders, attendee quantity.
- Handles Eventbrite series parent/child reports.
- Computes order conversion and ticket conversion.
- Compares source categories at same t-minus point.

### `source_gap_analysis`

- Compares affiliate categories and affiliate codes.
- Reports absolute and proportional deltas.
- Calls out direct traffic, creator tools, marketplace, and known RTO tracking codes.

### `capacity_projection`

- Uses venue capacity and target fill.
- Applies historical show rates by ticket type.
- Recommends ticket caps or quantity changes.

### `weekday_venue_hypothesis_analysis`

- Compares weekday and venue context.
- Separates smaller-era concerts from modern-scale concerts.
- Checks whether demand shifted across dates.

## Suggested User-Facing Behavior

If a user asks, "How are ticket sales going?", Moomie should say something like:

```text
I'll compare against Broadway, Tchaik, and Symphonic at the same t-minus point, split free vs paid, and separate reach from conversion.
```

Then produce a compact answer:

```text
At 27.8 days out, Shakespeare has 1,988 page views vs a baseline average of 3,823 (52%). Orders are 182 vs 404 (45%). Ticket conversion is 21.9% vs 26.9%, slightly weaker but not broken. Main issue is reach, especially Marketplace and Direct traffic.
```

Then offer follow-ups:

```text
I can also break this down by source/affiliate gaps, free vs paid funnel, capacity/no-show projection, or venue/date hypothesis.
```

## Implementation Notes

Current PR #42 approach:

- Trusted TypeScript fetches and archives Eventbrite data.
- The sandbox gets only local JSON plus the injected `eventbrite_kernels` helper module.
- The LLM can still write flexible Python, but common calculations are available as reusable kernels to reduce token usage and arithmetic mistakes.
- Playbooks currently steer the analyzer prompt; they do not yet force fully deterministic output tables.

Future hardening path:

- Add a deterministic TypeScript context pack generator:
  - current live event snapshots
  - baseline event selection
  - same-point cutoff dates
  - traffic conversion summaries
  - ticket bucket summaries
  - no-show historical rates
- Add scripted playbook outputs for common requests.
- Add Discord thread/reply context and optional persisted analysis assumptions as a separate feature.

Final documentation pass:

- Keep this file as a working design doc during implementation.
- Before considering the feature complete, rewrite it as a high-level implementation doc.
- Include a Mermaid chart showing the trusted fetch -> archive -> sandbox analysis flow.
- Avoid documenting low-level details that are obvious in source code and likely to drift.