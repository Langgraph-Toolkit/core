# Langgraph-Toolkit package publishing

Langgraph-Toolkit is the product name. The public npm organization is `langgraph-toolkit`, so publishable packages use the scoped identifiers below.

| Repository | npm package | Publish order |
|---|---|---:|
| `core` | `@langgraph-toolkit/core` | 1 |
| `mcp` | `@langgraph-toolkit/mcp` | 2 |
| `adapter-checkpointers` | `@langgraph-toolkit/adapter-checkpointers` | 3 |
| `adapter-express` | `@langgraph-toolkit/adapter-express` | 3 |
| `adapter-fastify` | `@langgraph-toolkit/adapter-fastify` | 3 |
| `adapter-nestjs` | `@langgraph-toolkit/adapter-nestjs` | 3 |
| `adapter-struxjs` | `@langgraph-toolkit/adapter-struxjs` | 3 |

The `examples` and `docs` repositories are not npm packages. They consume the scoped packages and document their use.

## CI workflow

Each publishable repository contains `.github/workflows/publish.yml`. Pull requests run dependency installation, TypeScript build, and tests. A tag matching `v*` runs the same verification job and then publishes with:

```bash
npm publish --access public --provenance
```

The workflow uses Node 22.14.0 or later, npm 11.5.1 or later, `contents: read`, and `id-token: write` only for the publish job. No long-lived npm token is committed to the repository.

## npm Trusted Publisher setup

Before the first tag publish, configure one Trusted Publisher entry for each package on npmjs.com. Select GitHub Actions and enter:

| Field | Value |
|---|---|
| Organization or user | `Langgraph-Toolkit` |
| Repository | The matching package repository, for example `core` |
| Workflow filename | `publish.yml` |
| Environment | Empty unless a protected GitHub environment is introduced |
| Allowed action | `npm publish` |

The workflow file must already exist in the repository. Configure `core` first, publish it, then configure and publish `mcp`, followed by the adapters. This order ensures that internal dependencies are resolvable on the public registry.

## Release procedure

1. Update the package version in the target repository and its dependent package ranges when required.
2. Run `npm install`, `npm run build`, `npm run test --if-present`, and `npm pack --dry-run` locally.
3. Commit the change and create a signed or protected `vX.Y.Z` tag in that package repository.
4. Confirm that the verification job passes before the publish job runs.
5. Verify the resulting package metadata, provenance statement, and dist-tag on npmjs.com.

The migration from the former `@langgraph/*` identifiers to `@langgraph-toolkit/*` is a breaking package rename. Existing consumers must update imports and dependency declarations.
