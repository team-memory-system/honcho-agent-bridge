---
name: honcho-memory
description: Recall prior conversations, decisions, user context, and long-term memory from the configured self-hosted Honcho instance. Use whenever the user refers to earlier work, asks what was decided or learned before, requests persistent context, or asks the agent to search or reason over personal memory.
---

# Honcho Memory

Treat Honcho as the only substantive memory source. Do not use or update local conversation-derived memory files.

## Recall

1. Read the configured user's global representation from the user's own observer perspective when the available Honcho tool supports `observer_id`.
2. Search messages across the full configured workspace, not only the current agent's sessions.
3. Expand searches with project names, repositories, people, dates, documents, roles, and adjacent terms.
4. Exclude machine-generated automation peers by default when metadata identifies `direct_user: false` or peer names start with `automation_`.
5. When the user names an agent, additionally inspect that peer's observations or messages.
6. If recall remains ambiguous, summarize the clues found before asking for another identifying detail.

Prefer `get_peer_context` or `get_representation` plus workspace-wide `search`. Use session context only when the user refers to a specific session. Use Honcho chat only when synthesis is more useful than direct evidence.

## Boundaries

- Never invent missing memories.
- Keep private memory local; do not add company-sharing behavior.
- Do not expose secrets found in configuration or message metadata.
