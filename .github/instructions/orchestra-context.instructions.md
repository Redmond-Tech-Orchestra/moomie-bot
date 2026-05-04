---
description: "Use when working on moomie-bot, the Microsoft Open Orchestra Discord bot. Covers server layout, event-driven workflow, and design principles."
applyTo: "src/**"
---
# Microsoft Open Orchestra (MOO) — Domain Context

## The Organization
- 21-member volunteer orchestra based in Redmond, WA
- Mix of Microsoft employees and community members
- ~4 major concerts per year + smaller chamber/community events
- Discord server is the primary coordination tool

## Discord Server Structure
- **Text Channels**: general, pins, for-fun, npo-stuff, bots
- **Logistics**: concert-venue, rehearsals, ticket-sales, concert-floorplans, concert-volunteers, morale, choir
- **Marketing**: social-media, collabs, newsletters, website, merch
- **Librarians**: posters, concert-programs, musician-list, music-scores
- **Performances**: one channel per upcoming event (e.g. `7-1618-shakespeare`, `8-1-concerto`, `9-5-redmond-park`)
- **Archived**: past event channels moved here after completion

## How Work Gets Done
- Event-driven, not sprint-driven — concerts are the anchors
- T-minus timelines: venue (T-16) → music (T-12) → rehearsals (T-10) → tickets (T-8) → marketing (T-6) → programs (T-4) → logistics (T-2)
- Decisions are made conversationally in Discord — no formal ticketing
- Commitments are verbal: "I'll handle that" / "I'll ask Joshua"
- 3-4 people drive most activity; volunteers contribute as available
- The conductor (Peter) is the de facto human tracking system

## Moomie Bot Design Principles
- Extract commitments from conversation — don't ask people to file tickets
- Surface what's falling through cracks — don't generate busywork
- Event-centric, not project-board-centric
- Respect volunteer time — no nagging, no daily rituals
- Say nothing unless there's something actionable
