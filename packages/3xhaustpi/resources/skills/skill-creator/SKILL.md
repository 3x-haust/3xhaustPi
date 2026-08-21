---
name: Skill Creator
description: Use when the user asks 3xhaustPi to add, capture, or improve a reusable skill.
---

# Skill Creator

Turn a repeated workflow into one focused 3xhaustPi skill.

1. Choose a lowercase skill id using letters, numbers, dots, underscores, or hyphens.
2. Create the project template with `3xhaustpi skill create <id>`.
3. Edit `.3xhaust/skills/<id>/SKILL.md`.
4. Keep frontmatter limited to:
   - `name`: a short display name
   - `description`: specific trigger conditions
5. Write instructions as concrete decisions and observable steps.
6. Name exact commands only when they are stable and safe for this workflow.
7. Do not embed credentials, tokens, private URLs, machine-specific home paths, or copied chat history.
8. Verify discovery with `3xhaustpi resource list`.

Prefer one narrow skill over a large skill that mixes unrelated workflows.
