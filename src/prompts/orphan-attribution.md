A new event has just been created in our orchestra's project tracker.

**New event:**
- Name: {{EVENT_NAME}}
- Channel: #{{CHANNEL_NAME}}
- Date: {{EVENT_DATE}}

There are some existing action items that aren't linked to any event yet ("org-wide" items). Some of these may have been discussed before this event channel existed, and actually belong to this event.

**Unassigned items:**
{{ORPHAN_ITEMS}}

For each item, decide whether it likely belongs to this new event based on:
- Does the item's description relate to this event's name or topic?
- Was the item likely created during early planning for this event?
- Would it make sense for this item to be tracked under this event?

Only attribute items where you're reasonably confident. When in doubt, leave them unassigned — they can always be moved later.

Return JSON:
```json
{
  "attributions": [
    { "item_id": 42, "reason": "brief explanation" }
  ]
}
```

Return an empty `attributions` array if none of the items belong to this event.
