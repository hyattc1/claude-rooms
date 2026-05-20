---
description: Join an existing claude-rooms room by code.
argument-hint: <room-code>
---

Run this with the room code the user supplied and show the user the script's stdout verbatim, then stop. Do not add commentary, do not run any other tools.

```sh
node "$CLAUDE_PLUGIN_ROOT/dist/commands/rooms-join.js" "$ARGUMENTS"
```
