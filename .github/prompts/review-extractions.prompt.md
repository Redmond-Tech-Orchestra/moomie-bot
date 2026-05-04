---
description: "Review Moomie's extracted action items and conversation classifications for accuracy and completeness"
agent: "agent"
tools: [search]
argument-hint: "Paste Moomie's extraction output or describe what to review"
---
You are reviewing automated extraction output from Moomie (a Discord bot) that watches conversations in the Microsoft Open Orchestra Discord server.

The extraction rules are defined in `src/prompts/burst-extraction.md` — read that file to understand what Moomie considers a valid commitment vs. noise.

## Your Task

Review the extracted items for:
1. **False positives** — things flagged as commitments that are actually just discussion/brainstorming
2. **Missed items** — real commitments or decisions that weren't captured
3. **Wrong event mapping** — items assigned to the wrong event
4. **Wrong owner** — items attributed to the wrong person
5. **Missing deadlines** — commitments with implicit deadlines that weren't extracted

## Output

Provide:
1. Items to **keep** (confirmed valid)
2. Items to **remove** (false positives, with reason)
3. Items to **add** (missed commitments)
4. Items to **fix** (wrong event, owner, or deadline)

Format as a simple list with ✅ keep / ❌ remove / ➕ add / ✏️ fix prefixes.
