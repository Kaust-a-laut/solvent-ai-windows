# Architectural Changes & Improvements

This document outlines the architectural upgrades being implemented to improve the resilience, performance, and observability of Solvent AI.

## 1. Provider Failover & Circuit Breaker Integration
**Why:** The system previously relied heavily on a static `DEFAULT_PROVIDER`. If that provider experienced an outage (e.g., consistent 5xx errors or timeouts), the application would fail to respond.
**What:** We are integrating the existing `CircuitBreakerService` deeply into the `AIService`. When a provider fails, the circuit breaker will open, and the system will automatically consult the `ProviderSelector` to dynamically choose the next best available provider based on the user's configured criteria (cost, performance, etc.). This ensures high availability and cost-efficiency during provider degradation.

## 2. Memory Fragmentation & SQLite Migration
**Why:** The local vector memory was previously stored in a single, large JSON file (`.solvent_memory.json`). As this file grew, the cost of parsing, updating, and saving the entire file on every memory event became a performance bottleneck.
**What:** We are migrating the memory storage to a local SQLite database using `better-sqlite3` and the `sqlite-vss` extension. This provides:
- **Atomic transactions:** Safe, concurrent reads and writes without file corruption risks.
- **Blazing fast performance:** Synchronous database access avoids blocking the Node.js event loop during heavy I/O.
- **Efficient vector search:** `sqlite-vss` allows us to perform fast, scalable vector similarity searches directly within the database, rather than loading everything into memory.
A migration script will be included to seamlessly port existing JSON memory into the new SQLite database.

## 3. Observability & Trace Dashboard
**Why:** The backend already logs detailed `RetrievalTrace` events (showing context budget, active/suppressed memories, and prompt token counts), but these were only visible in the raw `.solvent_retrieval_traces.jsonl` file. It was difficult for users or developers to understand *why* the AI made certain decisions or included specific context.
**What:** We are exposing these traces via a new backend endpoint (`/api/debug/traces`) and building an integrated "Debug" tab in the frontend React application. This dashboard will allow users to visually inspect the RAG pipeline, view token budgets, and analyze the exact context that was injected into any given prompt.
