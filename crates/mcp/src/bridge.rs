use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

use crate::Relay;

#[derive(Debug, Clone, Serialize)]
pub struct Call {
    pub id: u64,
    pub tool: String,
    pub args: Value,
    /// When the call is given up on, in milliseconds since 1970, which the web app's clock
    /// shares, so that it changes nothing once the agent has heard that nothing answered.
    pub deadline: u64,
}

/// The web app's answer to the call of the same id.
#[derive(Debug, Deserialize)]
pub struct Reply {
    pub id: u64,
    pub result: Option<Value>,
    pub error: Option<String>,
}

type Push = Box<dyn Fn(Call) -> Result<(), String> + Send + Sync>;
type Answer = Result<Value, String>;

#[derive(Default)]
struct Waiting {
    push: Option<Push>,
    answers: HashMap<u64, oneshot::Sender<Answer>>,
}

/// The calls on their way to the web app, whose page may reload or never answer.
pub struct Bridge {
    next: AtomicU64,
    timeout: Duration,
    waiting: Mutex<Waiting>,
}

impl Bridge {
    pub fn new(timeout: Duration) -> Self {
        Self {
            next: AtomicU64::new(0),
            timeout,
            waiting: Mutex::default(),
        }
    }

    /// From now on, calls go through `push`, and those waiting on an earlier one fail.
    pub fn attach(&self, push: impl Fn(Call) -> Result<(), String> + Send + Sync + 'static) {
        let mut waiting = self.waiting.lock().expect("never poisoned");
        waiting.answers.clear();
        waiting.push = Some(Box::new(push));
    }

    pub fn detach(&self) {
        let mut waiting = self.waiting.lock().expect("never poisoned");
        waiting.answers.clear();
        waiting.push = None;
    }

    /// Whether the call was still waiting.
    pub fn reply(&self, Reply { id, result, error }: Reply) -> bool {
        let answer = match (result, error) {
            (_, Some(error)) => Err(error),
            (Some(result), None) => Ok(result),
            (None, None) => Err("the web app gave no answer".to_owned()),
        };
        let sender = self
            .waiting
            .lock()
            .expect("never poisoned")
            .answers
            .remove(&id);
        sender.is_some_and(|sender| sender.send(answer).is_ok())
    }
}

impl Relay for Bridge {
    async fn ask(&self, tool: &str, args: Value) -> Answer {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut waiting = self.waiting.lock().expect("never poisoned");
            let Some(push) = &waiting.push else {
                return Err("Planche is not ready".to_owned());
            };
            let deadline = SystemTime::now() + self.timeout;
            let since = deadline.duration_since(UNIX_EPOCH).unwrap_or_default();
            let call = Call {
                id,
                tool: tool.to_owned(),
                args,
                deadline: since.as_millis() as u64,
            };
            push(call).map_err(|error| format!("Planche is not ready: {error}"))?;
            waiting.answers.insert(id, sender);
        }
        match tokio::time::timeout(self.timeout, receiver).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("Planche reloaded before it answered".to_owned()),
            Err(_) => {
                self.waiting
                    .lock()
                    .expect("never poisoned")
                    .answers
                    .remove(&id);
                Err("Planche did not answer in time".to_owned())
            }
        }
    }
}
