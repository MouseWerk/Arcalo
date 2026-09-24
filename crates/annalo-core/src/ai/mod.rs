//! The integrated AI execution engine.
//!
//! Requests go to configured providers ([`provider`]): a LiteLLM proxy, any OpenAI-compatible
//! API, Azure OpenAI or a local Ollama. All speak the OpenAI chat protocol, so the [`router`]
//! only picks a tier (local / standard / reasoning) and each tier names a provider and a model.

pub mod availability;
pub mod client;
pub mod metrics;
pub mod privacy;
pub mod provider;
pub mod rag;
pub mod router;
pub mod tools;
pub mod transform;
pub mod zeitguess;

pub use client::{AiClient, ChatMessage, ChatRequest, Completion, StreamEvent};
pub use metrics::{PriceRule, PriceTable, SessionMeter, UsageRecord};
pub use provider::{AiProvider, ProviderKind};
pub use router::{ModelRef, ModelRouter, RouteDecision, RouterConfig, Tier};
