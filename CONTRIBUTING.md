# Contributing to Core

Core owns the framework-agnostic contracts for models, graph execution, streaming and tool lifecycles. A change is acceptable only when it preserves typed public behavior without depending on a provider, an adapter, or a network service.

| Change | Regression that must be preserved |
| --- | --- |
| Structured output or model protocol | Provider fallback remains transparent to application code. |
| Agent loop or tool messages | Tool results retain `toolCallId`; every `tool_start` has one `tool_end`. |
| Tool error handling | Recoverable failure is returned to the model as structured tool output and the stream remains well formed. |
| Step-event contract | Event type and public payload fields remain backward compatible. |

Run `npm test && npm run build && npm pack --dry-run` before requesting review. Tests must be deterministic and must not use credentials, live model APIs, or MCP servers. Add the regression that would have failed before the implementation change, then keep the assertion focused on public behavior rather than private helpers.

Do not publish from a local machine. Pull requests and `main` run the verification job; tags run the repository release workflow after review.
