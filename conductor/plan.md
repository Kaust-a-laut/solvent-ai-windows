# Architectural Improvements Plan

## Background & Motivation
The system currently experiences three distinct limitations:
1. **Static Provider Dependency:** A strong reliance on `DEFAULT_PROVIDER` means persistent 5xx errors from the primary provider cause significant system degradation without automatic, dynamic failover.
2. **Memory Scalability:** `vectorService.ts` currently manages memory via a monolithic `.solvent_memory.json` file. This architecture introduces a bottleneck as memory size grows.
3. **Observability Gap:** The RAG pipeline relies on `traceLogger.ts`, but this information is only dumped into `.solvent_retrieval_traces.jsonl`. Without an integrated UI, inspecting token budgets, memory state, and decision provenance is extremely difficult.

## Scope & Impact
This plan outlines the steps to resolve these issues by modifying the `AIService` and `ProviderSelector`, replacing the existing local JSON vector database with a more robust SQLite solution, and building an internal observability dashboard in the frontend. 

The impact is primarily localized to backend AI processing files, the database handling mechanisms, and the settings interface in the frontend React application. 

## Proposed Solution
1. **Dynamic Failover Strategy:** We will modify `aiService.ts` to integrate the existing `circuitBreaker`. When an API call fails with a 5xx error, we trigger the circuit breaker. If the circuit opens, we will dynamically select the next best available provider via `providerSelector.select()` rather than iterating down a static chain.
2. **SQLite + sqlite-vss Migration:** We will replace the `.solvent_memory.json` implementation with `better-sqlite3` and `sqlite-vss`. This will require updating `package.json` with the new dependencies, writing an initialization service for the SQLite database, migrating the `vectorService.ts` to use SQL statements instead of file reads/writes, and building a one-off migration script for existing JSON data.
3. **Integrated Debug Dashboard:** We will create a new API endpoint in `backend/src/routes/debugRoutes.ts` (e.g. `/api/debug/traces`) to read from the `.solvent_retrieval_traces.jsonl` file. We will then add a "Debug" tab to the frontend Settings panel to fetch and display these traces.

## Alternatives Considered
- **WebAssembly SQLite:** We considered using a WASM version of SQLite, but native `better-sqlite3` with `sqlite-vss` offers significantly better synchronous performance for a desktop application.
- **Standalone Dashboard:** We considered a separate web application for the trace UI to avoid bloating the React app, but integrating it into the existing settings provides a much smoother developer and user experience.

## Implementation Plan

### Phase 1: Provider Failover Integration
1. Update `aiService.ts` to ensure it reports 5xx errors directly to `circuitBreaker.recordFailure(providerId)`.
2. Modify `executeProviderCompletion` to wrap its internal retry loop. When a provider fails, the system will now request a fallback via `providerSelector.select()` rather than the static `FALLBACK_CHAIN`.

### Phase 2: SQLite + VSS Migration
1. Add `better-sqlite3` and `sqlite-vss` to `backend/package.json`. Note that `electron-builder` will handle compiling native modules for the Electron environment during build.
2. Build a new SQLite abstraction layer (`backend/src/services/db/sqliteService.ts`).
3. Refactor `vectorService.ts` to perform all CRUD operations via `sqliteService.ts`. Ensure atomic transactions are used for inserts and updates. 
4. Write `scripts/migrate_memory_to_sqlite.ts` to seamlessly import the existing `.solvent_memory.json` data upon initial startup.

### Phase 3: Observability & Trace Dashboard
1. Implement the `GET /api/debug/traces` endpoint in `debugRoutes.ts`.
2. Update the frontend store/slices to handle trace data retrieval.
3. Build a React component (`frontend/src/components/Settings/DebugTab.tsx`) to display the data clearly, focusing on RAG provenance and token budgets.

## Verification
- **Failover:** We will run simulated 5xx errors against the active provider to ensure the circuit opens and `providerSelector` dynamically triggers the next optimal provider.
- **SQLite Migration:** We will run the migration script over test JSON files to confirm data integrity. We will test standard RAG flows (inserting, searching) with the new VSS backend to verify latency and correctness. 
- **Dashboard:** We will run interactions in the client and verify the new Debug tab populates correctly with the corresponding trace logs.

## Migration & Rollback
- The SQLite migration script will not delete `.solvent_memory.json`. It will be retained as a safe fallback point.
- If native module compilation issues arise with `sqlite-vss` in production environments, we will temporarily revert `vectorService.ts` to its current state via git history.
