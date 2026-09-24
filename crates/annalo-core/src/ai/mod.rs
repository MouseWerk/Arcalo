//! The integrated AI execution engine.
//!
//! All model traffic goes through a LiteLLM proxy (OpenAI-compatible API), so
//! local runtimes (Ollama, vLLM) and cloud providers are addressed the same
//! way and only differ in the model name the [`router`] picks.

pub mod availability;
pub mod client;
pub mod metrics;
pub mod rag;
pub mod router;
pub mod tools;
pub mod transform;
pub mod zeitguess;

pub use client::{ChatMessage, ChatRequest, Completion, LiteLlmClient, StreamEvent};
pub use metrics::{PriceTable, SessionMeter, UsageRecord};
pub use router::{ModelRouter, RouteDecision, RouterConfig, Tier};
