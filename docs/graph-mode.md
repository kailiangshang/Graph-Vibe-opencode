# Graph Workflow Mode

Graph mode is a structured development workflow where the AI agent operates from a
plan graph instead of free-form tool access. The graph tracks requirements (PRD),
composite features, and atomic tasks through implementation and verification stages.

## Enabling Graph Mode

### Environment Variable

```bash
# Dedicated flag (recommended)
OPENCODE_ENABLE_GRAPH_MODE=1 opencode serve --port 4096

# Legacy experimental flag (still works)
OPENCODE_EXPERIMENTAL=1 OPENCODE_EXPERIMENTAL_GRAPH_MODE=1 opencode serve --port 4096
```

### Flag Precedence

| Flag | Requires `OPENCODE_EXPERIMENTAL` | Since |
| --- | --- | --- |
| `OPENCODE_ENABLE_GRAPH_MODE=1` | No | current |
| `OPENCODE_EXPERIMENTAL_GRAPH_MODE=1` | No (self-enabling) | initial |
| `OPENCODE_EXPERIMENTAL=1` | — (master switch, enables all experimental features) | initial |

## How It Works

When graph mode is active:

1. **Tool restriction**: raw file-edit, shell, and process-scoped tools are replaced
   by graph-specific tools (`graph_plan_admit`, `graph_diagnostics_run`, and
   build-gate-aware artifact tools).
2. **Workflow prompt**: a system prompt instructs the agent to plan before acting,
   admit plans via `graph_plan_admit`, run project diagnostics via
   `graph_diagnostics_run`, and only advance node status through verified
   diagnostics output.
3. **Plan as source of truth**: the graph database (SQLite tables `graph_node`,
   `graph_edge`) stores the current plan. The agent cannot self-mark nodes as
   verified; only passing diagnostics can.

## Graph Tools

### `graph_plan_admit`

Admits a structured plan (nodes + edges) into the Current Plan for the active
session. Model-supplied `status` and `testStatus` fields are ignored — all nodes
start as `pending`/`none`.

### `graph_diagnostics_run`

Runs detected project diagnostics (test suite, type checker) for a target node.
Only diagnostics discovered by the server can verify a node; model-supplied
command strings are not executed.

## Web UI

### Graph Page

Navigate to `/<base64(directory)>/session/<id>/graph` or click the Graph button
(branch icon) in the session header.

Features:
- **Plan / Main toggle**: view the session's Current Plan or the project's Main Graph.
- **Graph / List view**: force-directed canvas or flat list.
- **L1 / L2 filter**: filter by node type (PRD/composite vs atomic).
- **Node detail panel**: shows readiness status, blockers, and validation issues.

### Realtime Updates

The graph page subscribes to `graph.plan.updated` and `graph.main.updated` events
and refreshes automatically.

## HTTP API

| Endpoint | Method | Description |
| --- | --- | --- |
| `/graph/main` | GET | Main graph for the project directory |
| `/graph/current-plan` | GET | Current Plan for a session |
| `/graph/node/:id` | GET | Node detail by ID |
| `/graph/node-readiness` | GET | Blockers and validation issues for a node |
| `/graph/plan/admit` | POST | Admit nodes/edges into Current Plan |
| `/graph/node/:id/status` | PATCH | Update node status |
| `/graph/plan/promote` | POST | Promote Current Plan to a versioned Main Graph snapshot |

All endpoints require a `directory` query parameter.

## Database Tables

| Table | Purpose |
| --- | --- |
| `graph_node` | Plan nodes (PRD, composite, atomic) with status and test status |
| `graph_edge` | Relationships (contains, blocks, addresses, uses, deprecated_by) |
| `graph_generation_run` | LLM generation tracking per node |
| `graph_tool_run` | Tool execution tracking per node |
| `graph_artifact_draft` | Staged file artifacts per node |

## Status Flow

```
pending → implemented → verified
                         ↗
pending ────────────────→
        (diagnostics pass)
```

- `pending`: admitted, not yet implemented.
- `implemented`: agent claims implementation; diagnostics not yet passed.
- `verified`: `graph_diagnostics_run` passed for this node.

## Debugging

```bash
# Check if graph mode is active
curl http://127.0.0.1:4096/session | jq '.[0].id' # pick a session

# View Current Plan
curl 'http://127.0.0.1:4096/graph/current-plan?session=<id>&directory=<dir>'

# View Main Graph
curl 'http://127.0.0.1:4096/graph/main?directory=<dir>'
```
