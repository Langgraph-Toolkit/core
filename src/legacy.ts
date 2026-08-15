/**
 * Compatibility entrypoint for the pre-0.2 graph-definition DSL.
 *
 * New applications should import `createWorkflow`, `createGraph`, and the
 * `create*` helpers from `@langgraph-toolkit/core`. Advanced new projects can
 * use the explicit `/low-level` subpath; this compatibility alias remains for
 * incremental migrations.
 */
export * from "./low-level.js";
