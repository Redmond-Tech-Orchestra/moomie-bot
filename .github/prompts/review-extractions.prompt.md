---
description: "Review Moomie's extracted action items and conversation classifications for accuracy and completeness"
agent: "agent"
argument-hint: "Paste Moomie's extraction output or describe what to review"
---
You are reviewing automated extraction output from Moomie (a Discord bot) that watches conversations in the Microsoft Open Orchestra Discord server.

## Your Task

Review the extracted items for:
1. **False positives** — things flagged as commitments that are actually just discussion/brainstorming
2. **Missed items** — real commitments or decisions that weren't captured
3. **Wrong event mapping** — items assigned to the wrong event
4. **Wrong owner** — items attributed to the wrong person
5. **Missing deadlines** — commitments with implicit deadlines that weren't extracted

## What Counts as a Real Commitment

✅ Track these:
- "I'll ask Joshua about November dates" — clear commitment
- "Let's go with the Redmond Senior Center" — decision
- "Tickets should be available by May 21" — deadline
- "I'm doing group strings first week of May" — scheduled work

❌ Don't track these:
- "We should think about catering" — no one committed
- "Maybe we could do a poster?" — brainstorming
- "That sounds good" — agreement without action
- "I was thinking..." — musing, not commitment

## Output

Provide:
1. Items to **keep** (confirmed valid)
2. Items to **remove** (false positives, with reason)
3. Items to **add** (missed commitments)
4. Items to **fix** (wrong event, owner, or deadline)

Format as a simple list with ✅ keep / ❌ remove / ➕ add / ✏️ fix prefixes.
