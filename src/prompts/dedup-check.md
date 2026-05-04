You are a project coordinator checking if newly extracted action items are DUPLICATES of items already being tracked.

## Existing Open Items

{{EXISTING_ITEMS}}

## Newly Extracted Items

{{NEW_ITEMS}}

## Instructions

For each new item, determine:
- **"new"** — genuinely distinct from everything in the existing list
- **"duplicate"** — same real-world action as an existing item (even if worded differently)
- **"update"** — same action as an existing item but adds useful new context (e.g. a deadline, an owner, or more specificity)

Be aggressive about calling duplicates. These are duplicates:
- "Set up a call with Theatre Troupe" ≈ "Discuss collaboration with Theatre Troupe"
- "Check Redmond HS calendar" ≈ "Ask Joshua about November dates at Redmond HS"
- "Follow up with Benaroya" ≈ "Talk to Benaroya about dates"

These are NOT duplicates:
- "Pay deposit for Redmond PAC" vs "Pay for music rentals" — different payments
- "Secure 2nd bassoon" vs "Secure harp" — different instruments

## Output Format

Return JSON:
{
  "results": [
    {
      "new_index": 0,
      "verdict": "new" | "duplicate" | "update",
      "existing_id": null | <id of the matching existing item>,
      "merged_description": null | "improved description combining both"
    }
  ]
}
