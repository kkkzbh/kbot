# Agent capability architecture

## Catalog surface

The Admin Agent page exposes four modules: MCP, Tools, Skills, and Plugin.

- MCP owns protocol server connections and MCP Tool configuration.
- Skills owns discovery, injection mode, content, permissions, and the Skill Loader state.
- Tools contains only standalone model-callable capabilities.
- Plugin groups capabilities that share one lifecycle and policy boundary. A Plugin can contain MCP servers, Skills, and Tools; it does not add an extra model protocol.

Runtime helper Tools such as `skill` and `agentcli` do not appear as standalone Tools. The Skill Loader is visible in Skills. High-risk internal management Tools remain unavailable to QQ conversations.

## Built-in Plugins

| Plugin | Ownership | Agent state |
| --- | --- | --- |
| Workspace | Files, Shell, attachment replay, realtime conversation context, computer backends | Configurable |
| Automation | Trigger and automation task operations | Configurable; runtime API will converge to one action-based Tool |
| Interaction | In-run question and confirmation | Locked off for the QQBot execution model |
| HBU Course Guidance | HBU course query operations | Locked off; command-owned |
| Codeforces | Temporary migration inventory | Locked off until removed by the command migration |
| Web | Unified `web_run` capability | Configurable |

Sub-agents are outside the current product surface and remain disabled.

## Effective Tool policy

Every resolver contributes a restriction. The effective set is the intersection of all resolver results:

```text
Plugin enabled
  -> Tool globally enabled
  -> Main Agent enabled
  -> route and conversation scope policy
  -> authority and selector checks
  -> runtime registration and provider availability
  -> model tool definitions
```

The Admin API updates a single native Tool through `PATCH /api/admin/v1/agent/tools/:name`. It reconstructs and persists the full ChatLuna Tool item so unrelated permission fields remain explicit and intact. MCP Tools continue through the MCP-owned endpoint.

## Memory boundary

`memory_search` remains one standalone Tool. The memory service already owns extraction, review, retention, provenance, and Admin workflows; these service capabilities are not additional model-callable components.

Promote Memory to a Plugin only when it gains at least two jointly managed Agent components, such as `memory_search` plus a memory Skill or MCP server, with a shared enablement and policy lifecycle. Until that condition exists, a Plugin would add UI hierarchy without creating a real runtime boundary.
