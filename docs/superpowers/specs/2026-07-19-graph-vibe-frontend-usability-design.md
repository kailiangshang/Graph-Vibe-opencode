# Graph Vibe Frontend Usability Design

## Goal

Make the Graph Vibe Web product visibly identifiable and usable from first launch through an empty Graph workflow without requiring a model provider. OpenCode behavior must remain unchanged.

## Current Problems

1. The migration page uses Tailwind classes for primary button tokens that are not exported by the generated color theme. Primary actions therefore render as plain text even though they are buttons.
2. The Web client has no authoritative product identity. After Graph Vibe unlocks, the browser title, wordmark, and home surface still present OpenCode.
3. Graph is available only after a session exists and through a session-header icon. A new Graph Vibe user has no clear home-page path into the Graph workflow.
4. The empty Graph screen explains that no plan exists but does not provide an action back to the session composer where the user can describe a goal.

## Product Identity

Extend `GET /global/health` with a public product projection:

```ts
{
  id: "opencode" | "graph-vibe"
  name: string
  capability: string
}
```

The server derives this value from `Product.current()`. The generated Client and SDK carry the contract to the Web app. The existing per-server health state stores the projection, and the selected server determines the active product shell.

Older servers that omit `product` are treated as OpenCode. Graph Vibe presentation is enabled only by an explicit `product.id === "graph-vibe"`; the client must not infer identity from ports, URLs, migration availability, or browser location.

## Product Shell

For an explicitly identified Graph Vibe server:

- Set the document title to `Graph Vibe`.
- Replace the OpenCode home wordmark with a Graph Vibe lockup and the capability `Graph-guided development`.
- Use Graph Vibe wording in product-owned loading, empty, error, and onboarding surfaces.
- Keep references to OpenCode only when they describe the migration source or an external OpenCode-specific service.

For OpenCode and older servers, preserve the existing UI exactly.

The product presentation should be a small app-level context derived from server health, not a second Web entrypoint or duplicated home/layout implementation.

## Migration Checkpoint

Replace hand-built primary action styling with the established `@opencode-ai/ui/button` component and supported variants. This removes reliance on missing Tailwind mappings such as `bg-button-primary-base` and `text-text-on-color`.

The initial checkpoint has a clear hierarchy:

- `Discover OpenCode data` is the primary action.
- `Start Graph Vibe fresh` is a secondary action and retains its explicit irreversible confirmation.
- Actions are disabled while a request is pending.
- A visible pending label explains which checkpoint action is running.
- Desktop and mobile controls remain at least 44 pixels high.

All later primary migration actions use the same button component and hierarchy so discovery, transfer, validation, and finalization do not regress independently.

## Home Graph Entry

Graph Vibe home adds a prominent `Start Graph Workflow` action while retaining ordinary session creation as a secondary path.

The action flow is:

1. Use the current project when one is selected.
2. If no project is selected, open the existing directory picker.
3. Create an empty session through the generated SDK without sending a prompt or invoking a model.
4. Navigate directly to that session's Graph route.
5. If session creation fails, remain on Home and display the existing notification/error treatment.

OpenCode home does not render this action.

## Empty Graph Guidance

An empty Graph remains a valid state. It must show:

- `No plan admitted`.
- A concise explanation that a goal entered in the session creates the first plan.
- A `Describe a goal` action that navigates back to the same session composer.

This makes the no-model acceptance path useful without pretending a plan can be generated without a provider.

## Error Handling

- Missing product data falls back to OpenCode.
- Health request failures preserve the last known identity for that server and use existing disconnected states.
- Home Graph session creation reports the public SDK error without creating a partial navigation state.
- Migration actions use the existing redacted conflict/error channel and never render raw source errors or secrets.
- Empty Graph loading and API failures retain the existing retry behavior.

## Verification

Automated coverage must include:

1. Server health returns the correct OpenCode and Graph Vibe product projections.
2. Generated Client and SDK expose the product field deterministically.
3. Migration primary actions have button semantics, visible primary styling, pending disablement, and 44-pixel minimum height on desktop and mobile.
4. OpenCode retains its current title, wordmark, and Home behavior.
5. Graph Vibe displays its own title, lockup, capability, and Home Graph action.
6. The Home action selects or uses a project, creates an empty session, and navigates to Graph without a model request.
7. Empty Graph offers `Describe a goal` and returns to the correct session.
8. A live isolated launch completes fresh start, traverses Home to empty Graph, captures desktop and mobile screenshots, and records no browser console errors.

## Non-Goals

- Redesigning the session timeline, settings, provider dialogs, or Graph cockpit.
- Running a paid or external model during acceptance.
- Creating a separate Graph Vibe Web application or duplicating OpenCode layouts.
- Inferring product identity from network configuration.
- Changing the loopback default. The WSL fallback may bind `0.0.0.0` only with a temporary password on a trusted host-private, firewall-restricted network; Basic auth does not provide transport confidentiality, and remote access requires TLS termination or a secure tunnel.
