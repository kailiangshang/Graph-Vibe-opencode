# Graph Vibe Storage Isolation and OpenCode Migration Design

## Context

Graph Vibe currently changes the product identity and enables Graph mode without changing OpenCode's global storage namespace. `Global.Path` remains rooted under `opencode`, and the local launcher additionally disables channel-specific databases. As a result, Graph Vibe and an independently installed OpenCode can read and mutate the same database, sessions, migrations, credentials, configuration, daemon state, caches, logs, plugins, and tool artifacts.

This has already happened on the development machine. The production OpenCode database contains Graph tables and Graph migration journal entries. Product isolation is therefore a release blocker, but isolation alone is not a complete product experience. Existing OpenCode users must be able to bring their configuration, credentials, selected sessions, and useful history into Graph Vibe without creating a permanent synchronization relationship.

## Goals

- Give OpenCode and Graph Vibe disjoint namespaces for every mutable global resource.
- Make guided OpenCode migration a first-class Graph Vibe onboarding flow.
- Migrate configuration and credentials by default while requiring explicit selection for large session history.
- Preserve selected sessions as resumable Graph Vibe sessions when their projects remain available.
- Reconstruct imported history from a Graph perspective without replaying provider or tool work.
- Preserve existing Graph data already written into a mixed OpenCode database.
- Make the one-time import resumable and auditable without supporting ongoing synchronization.
- Guarantee that Graph Vibe never writes to the OpenCode source during discovery, migration, or validation.
- Give Graph Vibe independent install, upgrade, uninstall, daemon, network, and desktop lifecycle identities.

## Non-Goals

- Synchronizing OpenCode and Graph Vibe after first migration.
- Merging transcripts that diverge after migration.
- Deleting Graph tables or migration entries from an existing OpenCode database.
- Replaying historical model requests, shell commands, tool calls, or pending permissions.
- Copying disposable caches, installed language servers, package directories, or logs.
- Replacing organization-managed OpenCode policy with a weaker Graph Vibe policy.
- Writing Graph Vibe settings into a project's `.opencode` directory.

## Product Principles

Isolation governs future ownership. Migration preserves user continuity. Both are required.

The migration is one-way and one-time. It may be paused, resumed, retried, and expanded until the user explicitly finalizes it. Once finalized, Graph Vibe permanently stops reading the OpenCode source. Choosing a fresh start finalizes an empty migration plan.

In this document, the OpenCode migration source means the selected installation's global data, config, cache, and state roots. A version-controlled project `.opencode` directory is not part of that migration source; it remains an explicitly read-only compatibility input as described below.

Imported transcripts are historical facts. Graph reconstruction may derive or infer a new view, but it does not rewrite messages, claim unsupported verification, or replay historical effects.

## Product Profile

Process bootstrap selects an immutable product profile before any module resolves a global path, database, configuration, daemon, or cache.

The profile contains:

- Product ID and display name
- Storage namespace
- Database basename and channel behavior
- Global configuration filenames
- Daemon registration namespace
- Default backend and UI ports
- Package and release identities
- Desktop application ID, protocol, and updater identity
- Upgrade and uninstall implementation

OpenCode retains its current `opencode` profile. Graph Vibe uses `graph-vibe`.

The Graph Vibe profile uses `graph-vibe.db`, `graph-vibe.json` / `graph-vibe.jsonc`, backend port `4097`, UI port `4444`, npm package `graph-vibe`, desktop application ID `ai.graph-vibe.desktop`, and URL protocol `graph-vibe`. Platform artifact names begin with `graph-vibe-`.

On Linux, Graph Vibe defaults to:

```text
~/.local/share/graph-vibe
~/.config/graph-vibe
~/.cache/graph-vibe
~/.local/state/graph-vibe
/tmp/graph-vibe
```

Equivalent platform-native roots apply on macOS and Windows. XDG environment variables continue to select the platform base, but the product namespace remains distinct beneath that base.

The profile must be resolved before `xdg-basedir` values or module-level path constants are evaluated. Tests and embedding APIs may inject a complete profile explicitly. Product identity cannot change after bootstrap.

## Isolation Boundary

The following Graph Vibe resources must not overlap OpenCode defaults:

- Primary SQLite database, WAL, SHM, and migration journal
- Legacy storage files and data migrations
- Provider credentials and OAuth refresh state
- MCP client credentials and OAuth state
- Session transcripts, inputs, messages, parts, todos, and permissions
- Graph nodes, edges, versions, workflow state, drafts, and audit evidence
- Snapshots, worktrees, plans, tool output, repositories, and attachments
- Global configuration, TUI configuration, agents, commands, skills, themes, references, and plugins
- Plugin metadata, package dependencies, and package locks
- Model selection, prompt history, frecency, KV state, and locks
- Model catalog, downloaded binaries, LSPs, skill cache, and package cache
- Logs, heap snapshots, crash reports, and temporary files
- Daemon registration, password, process identity, and service discovery

Explicit low-level overrides such as `OPENCODE_DB` remain available for tests and advanced embedding. In Graph Vibe mode, an override that resolves under the OpenCode namespace emits a blocking warning unless `GRAPH_VIBE_ALLOW_OPENCODE_PATHS=1` is also present. Normal launchers never set that unsafe override.

## Install and Runtime Lifecycle

Graph Vibe must have a package and release identity that cannot install over or uninstall OpenCode.

- The Graph Vibe package does not publish as or upgrade `opencode-ai`.
- `graph-vibe upgrade` uses Graph Vibe release metadata and artifacts only.
- `graph-vibe uninstall` lists and removes Graph Vibe paths and packages only.
- Until independent release endpoints exist, Graph Vibe upgrade and uninstall fail closed with actionable guidance.
- Graph Vibe daemon registration and password files live under Graph Vibe state.
- Graph Vibe uses an independent default backend port. Explicit ports may still collide and receive a normal bind error.
- A Graph Vibe desktop build uses a distinct application ID, executable, protocol, user-data path, crash path, and updater channel.
- Shipping the current OpenCode desktop identity as Graph Vibe is prohibited.

## Project Configuration

Project `.opencode` configuration is a versioned project contract rather than global application state. Graph Vibe reads it as a compatibility baseline but treats the entire source as read-only.

Every loaded configuration source carries provenance and a mutability capability. For `.opencode` sources in Graph Vibe mode, the loader must not:

- Insert or update `$schema`
- Create `.gitignore`
- Install or update packages
- Write package manifests or lockfiles
- Add, remove, or rewrite plugins
- Create agents, commands, skills, or themes

Graph Vibe project-specific changes are written to `.graph-vibe/graph-vibe.json` or `.graph-vibe/graph-vibe.jsonc`, which overlays `.opencode`. Organization-managed OpenCode policy remains a shared security baseline and is applied before Graph Vibe overrides. Graph Vibe isolation must not bypass managed restrictions.

## Migration Architecture

Migration is divided into six components with narrow responsibilities.

### OpenCode Migration Source

The source adapter discovers supported OpenCode installations and exposes typed, read-only snapshots.

- SQLite data is read from a consistent online snapshot, not by copying live DB, WAL, and SHM files.
- File sources are opened read-only.
- Discovery records source path, installation channel, schema capabilities, estimated sizes, and source fingerprints.
- The source adapter has no method that can write, migrate, checkpoint, or prune OpenCode.

### Migration Planner

The planner scans source categories and produces an immutable migration plan containing:

- Selected configuration categories
- Selected projects and sessions
- Entity counts and estimated byte sizes
- Referenced attachments and tool-output files
- Destination conflicts and decisions
- Unsupported or corrupt source items
- Required free space
- Graph reconstruction options

Plan changes create a new plan revision. Execution always references an exact revision.

### Migration Journal

The journal is stored only in the Graph Vibe database. It records migration state and idempotency keys without storing secrets or full prompt/tool content.

The lifecycle is:

```text
discovered -> draft -> copying -> validating -> ready_to_finalize -> completed
                         |             |
                       paused        failed
```

The journal tracks each category and session independently. A committed item is not repeated after restart. Failed items may be retried or explicitly skipped before finalization.

### Migration Executor

The executor applies one immutable plan revision.

- Configuration directories are assembled in staging and atomically promoted.
- Credential files retain private file modes.
- Each session relationship closure is committed in its own database transaction.
- Referenced files are copied through bounded, hashed staging.
- Cancellation stops unstarted work and preserves committed items.
- Process interruption leaves a resumable journal state.

### Session Importer

The session importer maps source entities into Graph Vibe entities using a durable mapping:

```text
source_installation + entity_type + source_id + source_fingerprint
  -> graph_vibe_entity_id + migration_item_status
```

This avoids relying on source IDs being collision-free in a target that may contain migration metadata. The original source ID remains provenance.

### Session Graph Rebuilder

The rebuilder creates a Graph view from imported history in two phases.

The deterministic phase extracts goals, tasks, todos, tool activity, changed files, test commands, diagnostics, and explicit dependencies. The model phase may enrich goals, modules, descriptions, and inferred dependencies. It cannot alter the source transcript or deterministic evidence.

## First-Run Experience

Graph Vibe starts in its isolated namespace before source discovery. Until migration is finalized, the main product is write-gated. The user can migrate, pause, resume, or choose a fresh start, but cannot create Graph Vibe sessions that would conflict with import planning.

The guided flow is:

1. Detect and select an OpenCode installation.
2. Review configuration categories, selected by default.
3. Review credentials and MCP OAuth material, selected by default without displaying secret values.
4. Optionally enable session migration.
5. Select projects, then sessions by title, time, status, and estimated size. The current project's recent sessions are selected initially.
6. Review deterministic reconstruction and optional model enhancement. Model enhancement is selected by default.
7. Run a dry-run preflight for disk, schema, paths, conflicts, and permissions.
8. Execute with category and per-session progress.
9. Validate imported data and review skipped or failed items.
10. Explicitly finalize migration or return to the draft to add items.

Finalization writes a durable `source_import_completed` marker and removes global installation source-access capability from normal runtime composition. Graph Vibe exposes no later OpenCode import or synchronization command. Background model enhancement uses only the copied Graph Vibe transcript and may continue after finalization. The project-local, read-only `.opencode` compatibility input remains available.

## Configuration Migration

Configuration migration is selected by default and includes:

- Global OpenCode and TUI settings
- Provider configuration and model preferences
- Provider API keys and OAuth credentials
- MCP definitions, client registrations, and OAuth credentials
- Agents, commands, skills, themes, and references
- Plugin declarations and enabled state

It does not copy:

- `node_modules`
- Package locks
- Downloaded language servers or binaries
- Model and package caches
- Logs, heap dumps, or crash reports
- Global temporary files

Dependencies are resolved again inside Graph Vibe's config namespace. Absolute paths and environment references are preserved, but invalid or unavailable paths are shown during preflight.

Existing target settings are structurally merged. Conflicts require an explicit source, target, or field-level decision and are persisted in the plan. No conflict silently overwrites a target value.

Credential values are copied on the same machine under the same OS user, written with private permissions, excluded from logs and reports, and thereafter maintained independently. Authentication refresh or removal in either product does not affect the other.

## Session Selection and Copy

Session migration is disabled until the user opts in because it can be large and triggers Graph reconstruction.

Selection is hierarchical:

- Projects show path, availability, session count, time range, and estimated bytes.
- Sessions show title, status, updated time, transcript size, referenced artifact size, and whether Graph data already exists.
- The current project's recent sessions are selected initially.
- Users may select all, none, or individual sessions.

For a selected session, the importer copies the relational closure required to preserve history and resume safely:

- Project and project-directory identity
- Session metadata
- Messages and parts
- Durable session input records
- Todos and required projection metadata
- Referenced attachments and external tool-output files
- Persistent permission configuration needed by the session
- Existing Graph records when present

Unreferenced snapshots, worktree caches, global logs, and unrelated tool-output files are not copied.

## Imported Session State

Imported sessions are resumable by default.

- `copied`: the relationship closure is durable.
- `indexed`: deterministic history indexing is complete.
- `rebuilding`: Graph reconstruction is running.
- `ready`: the project path exists and the session may continue.
- `detached`: history is available, but the project must be rebound before execution.
- `needs_attention`: the source was active, pending permission, or had pending provider work. It imports as a paused checkpoint and requires explicit continuation.
- `failed`: this session failed import and may be retried or skipped.

No source execution state is resumed automatically. Pending permissions, in-flight provider work, and tool calls are never replayed. One-time permissions are discarded. Continuing a migrated session performs current Graph Vibe permission checks and starts from imported durable history.

## Graph Reconstruction

Deterministic reconstruction completes before a session becomes `ready`.

Inputs include:

- User requests and corrections
- Assistant task summaries
- Todo state transitions
- Tool calls and results
- Artifact writes and file paths
- Test, lint, typecheck, and diagnostics commands
- Explicit success, failure, and interruption records

Deterministic output includes node provenance to source message and part IDs. A task is reconstructed as verified only when durable source evidence proves that relevant checks passed. Generic completion prose is not verification evidence.

Model enhancement is asynchronous and optional. It may infer goals, module boundaries, task descriptions, and dependency edges. Every inferred value records model identity, source IDs, and confidence. Inferred facts cannot override deterministic status, artifacts, or evidence. Users may discard and rerun model enhancement without changing the imported transcript.

## Mixed Legacy Database

The current faulty product has already written Graph records into OpenCode's database. The source adapter detects this mixed schema.

- Known Graph schema versions are decoded without migrating the source.
- Existing nodes, edges, versions, workflow state, drafts, and bounded audit evidence for selected sessions are imported first.
- Imported Graph IDs are remapped through the same entity mapping as sessions.
- Missing fields are upgraded only in the Graph Vibe destination.
- Deterministic reconstruction fills missing history-derived data but does not replace valid imported Graph evidence.
- OpenCode Graph tables and migration entries remain untouched after migration.

Unknown Graph schema versions fail only the affected Graph-data import. The transcript may still be imported and reconstructed when its base session schema is supported.

## Failure and Recovery

- Unsupported newer session schemas fail closed for session migration while still allowing independently supported configuration categories.
- Insufficient disk blocks before copying begins.
- Source mutation during planning creates a new snapshot requirement before execution.
- A corrupt session fails independently and can be skipped.
- Missing attachments produce explicit bounded warnings without corrupting the transcript.
- Target conflicts remain unresolved until the user decides.
- Validation failure returns to a resumable failed state rather than finalizing partial migration.
- Reports contain IDs, counts, hashes, paths, and bounded errors, never credentials or full conversation content.

Final validation proves:

- No source file was written by Graph Vibe.
- Target configuration parses and resolves.
- Credentials retain private permissions.
- Session foreign-key and projection invariants hold.
- Referenced copied files match expected hashes.
- Imported sessions render and project history.
- Resumable sessions cannot execute until project and checkpoint requirements are satisfied.

## API and UI Boundaries

Migration Core services own discovery, planning, execution, validation, and finalization. CLI, TUI, and App clients consume typed projections and issue revision-checked commands. Clients do not infer migration completion from files.

The projection exposes:

- Lifecycle state and plan revision
- Source installation summary
- Category counts and byte estimates
- Project and session selection summaries
- Current item and progress
- Bounded warnings and failures
- Validation result
- Whether finalization is allowed

The first-run gate is enforced by Core startup/session admission, not only by UI routing. A client that bypasses onboarding still cannot create or execute a Graph Vibe session before migration finalization.

## Security

- Source access is read-only by construction and absent after finalization.
- Migration never prints or serializes secret values into plans, events, logs, or reports.
- Credential destination files use private permissions and atomic replacement.
- Symlinks are resolved and checked before copying external referenced files.
- Project configuration retains managed policy precedence.
- Imported historical commands are data, never executable migration instructions.
- Model enhancement receives the minimum selected transcript data and follows current provider privacy configuration.

## Testing

Required automated coverage includes:

- Linux, macOS, and Windows path resolution for both products
- Concurrent OpenCode and Graph Vibe processes with no overlapping mutable path
- Independent databases and migration journals
- Active-WAL source snapshot consistency
- Source directory and database byte/metadata immutability
- Configuration and secret migration with private permissions
- Config merge conflicts and invalid path preflight
- No copied package caches or binary directories
- `.opencode` byte-for-byte immutability under Graph Vibe
- `.graph-vibe` overlay precedence and writes
- Session project selection, size estimates, and relationship closure
- Pause, process interruption, resume, retry, skip, and finalization
- Main-product write gate before finalization
- Permanent source-access removal after finalization
- Resumable, detached, and needs-attention imported sessions
- No provider, tool, or permission replay
- Deterministic Graph reconstruction and verification evidence rules
- Optional model enhancement provenance and replacement
- Mixed legacy database Graph preservation
- Unsupported schema and corrupt-session isolation
- Graph Vibe daemon, default port, package, upgrade, uninstall, and desktop identity isolation

## Rollout and Existing Development Data

Isolation ships before further Graph Vibe product release or dogfood that uses a real user profile.

The existing mixed OpenCode store is treated as a migration source. Before the first migration, Graph Vibe creates a validated online backup manifest and reports source size. It does not delete, rewrite, or attempt to roll back the mixed source after successful migration.

The current product UI work may continue only against isolated test roots until this boundary is complete. Live dogfood must verify that native OpenCode sessions, configuration, state, and processes remain unchanged.

## Acceptance Criteria

- Running Graph Vibe cannot create or modify a file under OpenCode's mutable global namespace under default configuration.
- Running or uninstalling Graph Vibe cannot stop, upgrade, uninstall, or delete OpenCode.
- Guided first migration preserves default configuration and credentials.
- Selected sessions import transactionally and become resumable, detached, or needs-attention as specified.
- Existing mixed-store Graph data survives migration without source mutation.
- Graph reconstruction is evidence-backed, provenance-aware, and does not replay historical effects.
- Migration survives interruption and remains editable until explicit finalization.
- After finalization, Graph Vibe performs no further reads or imports from OpenCode global installation roots.
- All Critical and Important spec and code-quality review findings are closed before release.
