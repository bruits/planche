use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use mcp::{Bridge, Call, Relay, Reply};
use serde_json::{Value, json};
use tokio::sync::mpsc;

/// Longer than any test takes, so that only a test of the wait sees it end.
const PATIENT: Duration = Duration::from_secs(60);

fn bridge(waiting: Duration) -> Arc<Bridge> {
    Arc::new(Bridge::new(waiting))
}

fn attached(bridge: &Bridge) -> mpsc::UnboundedReceiver<Call> {
    let (sender, receiver) = mpsc::unbounded_channel();
    bridge.attach(move |call| sender.send(call).map_err(|error| error.to_string()));
    receiver
}

fn asking(
    bridge: &Arc<Bridge>,
    tool: &'static str,
) -> tokio::task::JoinHandle<Result<Value, String>> {
    let bridge = bridge.clone();
    tokio::spawn(async move { bridge.ask(tool, json!({})).await })
}

#[tokio::test]
async fn a_call_fails_at_once_before_a_page_attaches() {
    let error = bridge(PATIENT).ask("board", json!({})).await.unwrap_err();
    assert_eq!(error, "Planche is not ready");
}

#[tokio::test]
async fn a_call_gets_the_reply_of_its_id() {
    let bridge = bridge(PATIENT);
    let mut calls = attached(&bridge);
    let asked = asking(&bridge, "elements");
    let call = calls.recv().await.unwrap();
    assert_eq!(call.tool, "elements");
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap();
    assert!(call.deadline > now.as_millis() as u64, "{call:?}");
    assert!(bridge.reply(Reply {
        id: call.id,
        result: Some(json!([1])),
        error: None,
    }));
    assert_eq!(asked.await.unwrap().unwrap(), json!([1]));
}

#[tokio::test]
async fn the_page_tells_why_it_cannot_answer() {
    let bridge = bridge(PATIENT);
    let mut calls = attached(&bridge);
    let asked = asking(&bridge, "elements");
    let id = calls.recv().await.unwrap().id;
    bridge.reply(Reply {
        id,
        result: None,
        error: Some("No such elements".to_owned()),
    });
    assert_eq!(asked.await.unwrap().unwrap_err(), "No such elements");
}

#[tokio::test]
async fn calls_waiting_on_a_page_that_goes_fail() {
    let bridge = bridge(PATIENT);
    let mut calls = attached(&bridge);
    let asked = asking(&bridge, "selection");
    calls.recv().await.unwrap();
    bridge.detach();
    assert_eq!(
        asked.await.unwrap().unwrap_err(),
        "Planche reloaded before it answered"
    );
    assert_eq!(
        bridge.ask("selection", json!({})).await.unwrap_err(),
        "Planche is not ready"
    );
}

#[tokio::test]
async fn a_page_that_never_answers_is_given_up_on() {
    let bridge = bridge(Duration::from_millis(1));
    let mut calls = attached(&bridge);
    let error = bridge.ask("board", json!({})).await.unwrap_err();
    assert_eq!(error, "Planche did not answer in time");
    let id = calls.recv().await.unwrap().id;
    assert!(!bridge.reply(Reply {
        id,
        result: Some(json!(1)),
        error: None,
    }));
}
