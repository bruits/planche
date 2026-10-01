use std::io::{BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use mcp::{Discovery, GatewayError, Relay, StartError, gateway, listen, start, token};
use rmcp::ServiceExt;
use rmcp::model::CallToolRequestParams;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

#[derive(Clone)]
struct Echo(Option<&'static str>);

impl Relay for Echo {
    async fn ask(&self, tool: &str, args: Value) -> Result<Value, String> {
        match self.0 {
            Some(failure) => Err(failure.to_owned()),
            None => Ok(json!({ "tool": tool, "args": args })),
        }
    }
}

struct Secrets {
    token: String,
    answer: String,
}

async fn serving(relay: impl Relay + Clone) -> (SocketAddr, Secrets, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let secrets = Secrets {
        token: token().unwrap(),
        answer: token().unwrap(),
    };
    let given = (secrets.token.clone(), secrets.answer.clone());
    let task = tokio::spawn(listen(listener, given, relay));
    (address, secrets, task)
}

/// Past the token and the app's answer, where MCP starts.
async fn connected(address: SocketAddr, secrets: &Secrets) -> TcpStream {
    let mut stream = TcpStream::connect(address).await.unwrap();
    let token = format!("{}\n", secrets.token);
    stream.write_all(token.as_bytes()).await.unwrap();
    let mut answer = Vec::new();
    loop {
        let byte = stream.read_u8().await.unwrap();
        if byte == b'\n' {
            break;
        }
        answer.push(byte);
    }
    assert_eq!(answer, secrets.answer.as_bytes());
    stream
}

fn scratch(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("planche-mcp-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    directory
}

fn discovery(address: SocketAddr, secrets: Secrets, pid: u32) -> Discovery {
    Discovery {
        port: address.port(),
        token: secrets.token,
        answer: secrets.answer,
        pid,
    }
}

async fn call(
    address: SocketAddr,
    secrets: &Secrets,
    tool: &str,
    arguments: Value,
) -> (bool, String) {
    let client = ().serve(connected(address, secrets).await).await.unwrap();
    let request = CallToolRequestParams::new(tool.to_owned());
    let request = match arguments {
        Value::Object(arguments) => request.with_arguments(arguments),
        _ => request,
    };
    let result = client.call_tool(request).await.unwrap();
    let text = result.content[0].as_text().unwrap().text.clone();
    (result.is_error == Some(true), text)
}

fn spawn_gateway(
    directory: &Path,
) -> (
    std::io::PipeWriter,
    BufReader<std::io::PipeReader>,
    std::thread::JoinHandle<Result<(), GatewayError>>,
) {
    let (client_reads, gateway_writes) = std::io::pipe().unwrap();
    let (gateway_reads, client_writes) = std::io::pipe().unwrap();
    let directory = directory.to_owned();
    let passing = std::thread::spawn(move || gateway(&directory, gateway_reads, gateway_writes));
    (client_writes, BufReader::new(client_reads), passing)
}

fn initialize() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "test", "version": "0" },
        },
    })
}

#[tokio::test]
async fn an_agent_with_the_token_reads_through_the_tools() {
    let (address, secrets, task) = serving(Echo(None)).await;
    let client = ().serve(connected(address, &secrets).await).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    let mut names: Vec<_> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        ["board", "elements", "image", "screenshot", "selection"]
    );

    let (failed, text) = call(address, &secrets, "elements", json!({ "ids": ["a"] })).await;
    assert!(!failed);
    let answer: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        answer,
        json!({ "tool": "elements", "args": { "ids": ["a"] } })
    );
    task.abort();
}

#[tokio::test]
async fn pages_and_lists_of_ids_are_bounded() {
    let (address, secrets, task) = serving(Echo(None)).await;
    let limit = |text: &str| serde_json::from_str::<Value>(text).unwrap()["args"]["limit"].clone();
    let (_, text) = call(address, &secrets, "board", json!({})).await;
    assert_eq!(limit(&text), 100);
    let (_, text) = call(address, &secrets, "board", json!({ "limit": 10_000 })).await;
    assert_eq!(limit(&text), 500);

    let ids: Vec<String> = (0..101).map(|id| id.to_string()).collect();
    let (failed, text) = call(address, &secrets, "elements", json!({ "ids": ids })).await;
    assert!(failed);
    assert_eq!(text, "At most 100 ids at a time");
    task.abort();
}

#[derive(Clone)]
struct Pictured(Value);

impl Relay for Pictured {
    async fn ask(&self, tool: &str, args: Value) -> Result<Value, String> {
        Ok(json!({ "tool": tool, "args": args, "image": self.0 }))
    }
}

fn picture(mime: &str, data: &str) -> Value {
    json!({ "mime": mime, "data": data, "width": 3, "height": 2 })
}

#[tokio::test]
async fn a_picture_comes_after_what_it_shows() {
    let (address, secrets, task) = serving(Pictured(picture("image/jpeg", "AAAA"))).await;
    let client = ().serve(connected(address, &secrets).await).await.unwrap();
    let arguments = json!({ "id": "a" }).as_object().unwrap().clone();
    let result = client
        .call_tool(CallToolRequestParams::new("image").with_arguments(arguments))
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(false));
    assert!(result.structured_content.is_none());
    let [text, picture] = &result.content[..] else {
        panic!("{:?}", result.content);
    };
    let facts: Value = serde_json::from_str(&text.as_text().unwrap().text).unwrap();
    let size = json!({ "width": 3, "height": 2 });
    assert_eq!(
        facts,
        json!({ "tool": "image", "args": { "id": "a" }, "image": size })
    );
    let picture = picture.as_image().unwrap();
    assert_eq!(
        (picture.data.as_str(), picture.mime_type.as_str()),
        ("AAAA", "image/jpeg")
    );
    task.abort();
}

#[tokio::test]
async fn a_picture_of_another_type_is_refused() {
    let (address, secrets, task) = serving(Pictured(picture("image/svg+xml", "AAAA"))).await;
    let (failed, text) = call(address, &secrets, "screenshot", Value::Null).await;
    assert!(failed);
    assert_eq!(text, "Planche gave no picture that agents can read");
    task.abort();
}

#[tokio::test]
async fn a_picture_past_the_most_is_refused() {
    for (length, refused) in [(5_000_000, false), (5_000_001, true)] {
        let image = picture("image/png", &"A".repeat(length));
        let (address, secrets, task) = serving(Pictured(image)).await;
        let (failed, _) = call(address, &secrets, "screenshot", Value::Null).await;
        assert_eq!(failed, refused, "{length}");
        task.abort();
    }
}

#[tokio::test]
async fn an_answer_without_a_picture_is_refused() {
    for image in [Value::Null, json!("AAAA"), json!({ "mime": "image/png" })] {
        let (address, secrets, task) = serving(Pictured(image)).await;
        let (failed, text) = call(address, &secrets, "screenshot", Value::Null).await;
        assert!(failed);
        assert_eq!(text, "Planche gave no picture that agents can read");
        task.abort();
    }
}

#[tokio::test]
async fn an_empty_picture_is_refused() {
    let (address, secrets, task) = serving(Pictured(picture("image/png", ""))).await;
    let (failed, text) = call(address, &secrets, "screenshot", Value::Null).await;
    assert!(failed);
    assert_eq!(text, "Planche gave no picture that agents can read");
    task.abort();
}

#[tokio::test]
async fn the_agent_reads_why_there_is_no_answer() {
    let (address, secrets, task) = serving(Echo(Some("Planche is not ready"))).await;
    for tool in ["selection", "screenshot"] {
        let (failed, text) = call(address, &secrets, tool, Value::Null).await;
        assert!(failed);
        assert_eq!(text, "Planche is not ready");
    }
    task.abort();
}

#[tokio::test]
async fn a_wrong_token_gets_nothing() {
    let (address, secrets, task) = serving(Echo(None)).await;
    let mut stream = TcpStream::connect(address).await.unwrap();
    // As long as the token, which a mere length check would let through.
    let wrong = format!("{}\n", "0".repeat(secrets.token.len()));
    stream.write_all(wrong.as_bytes()).await.unwrap();
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
    assert!(rest.is_empty());
    task.abort();
}

#[test]
fn the_discovery_file_is_the_users_and_goes_with_its_app() {
    let directory = scratch("discovery");
    let written = Discovery {
        port: 1,
        token: token().unwrap(),
        answer: token().unwrap(),
        pid: std::process::id(),
    };
    written.write(&directory).unwrap();
    assert_eq!(Discovery::read(&directory).unwrap(), written);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(directory.join("agent.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    let other = Discovery {
        port: 2,
        ..written.clone()
    };
    other.write(&directory).unwrap();
    written.remove(&directory);
    assert_eq!(Discovery::read(&directory).unwrap(), other);
    other.remove(&directory);
    assert!(Discovery::read(&directory).is_err());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn the_file_lives_as_long_as_agent_access() {
    let directory = scratch("lifetime");
    let running = start(&directory, Echo(None)).await.unwrap();
    let written = Discovery::read(&directory).unwrap();
    assert_eq!(written.pid, std::process::id());
    assert!(written.is_live().await);

    drop(running);
    assert!(Discovery::read(&directory).is_err());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn another_live_app_keeps_it_and_a_dead_one_gives_it_up() {
    let directory = scratch("taken");
    let (address, secrets, other) = serving(Echo(None)).await;
    let theirs = discovery(address, secrets, std::process::id() + 1);
    theirs.write(&directory).unwrap();
    let error = start(&directory, Echo(None)).await.err().unwrap();
    assert!(matches!(error, StartError::InUse(pid) if pid == theirs.pid));
    assert_eq!(Discovery::read(&directory).unwrap(), theirs);

    // It died without removing its file.
    other.abort();
    let _ = other.await;
    let running = start(&directory, Echo(None)).await.unwrap();
    assert_eq!(Discovery::read(&directory).unwrap().pid, std::process::id());
    drop(running);
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn turning_it_off_ends_every_connection() {
    let directory = scratch("off");
    let running = start(&directory, Echo(None)).await.unwrap();
    let written = Discovery::read(&directory).unwrap();
    let address = SocketAddr::from(([127, 0, 0, 1], written.port));
    let secrets = Secrets {
        token: written.token,
        answer: written.answer,
    };
    let client = ().serve(connected(address, &secrets).await).await.unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 5);

    drop(running);
    let ended = tokio::time::timeout(Duration::from_secs(5), client.waiting()).await;
    assert!(ended.is_ok(), "the session outlived agent access");
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn the_gateway_passes_bytes_both_ways() {
    let directory = scratch("gateway");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (address, secrets, _task) = runtime.block_on(serving(Echo(None)));
    discovery(address, secrets, std::process::id())
        .write(&directory)
        .unwrap();

    let (mut client_writes, mut client_reads, passing) = spawn_gateway(&directory);
    writeln!(client_writes, "{}", initialize()).unwrap();
    let mut line = String::new();
    client_reads.read_line(&mut line).unwrap();
    let answer: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(answer["result"]["serverInfo"]["name"], "planche");
    assert_eq!(answer["result"]["protocolVersion"], "2025-06-18");

    drop(client_writes);
    assert!(passing.join().unwrap().is_ok());
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn the_gateway_says_when_the_app_ends_the_session() {
    let directory = scratch("ended");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (address, secrets, task) = runtime.block_on(serving(Echo(None)));
    discovery(address, secrets, std::process::id())
        .write(&directory)
        .unwrap();

    let (mut client_writes, mut client_reads, passing) = spawn_gateway(&directory);
    writeln!(client_writes, "{}", initialize()).unwrap();
    client_reads.read_line(&mut String::new()).unwrap();
    // Agent access turned off, while the client still talks.
    task.abort();
    assert!(matches!(passing.join().unwrap(), Err(GatewayError::Ended)));
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn the_gateway_says_when_the_app_is_not_running() {
    let directory = scratch("missing");
    let error = gateway(&directory, std::io::empty(), std::io::sink()).unwrap_err();
    assert!(matches!(error, GatewayError::NotRunning));
}

#[test]
fn too_many_agents_are_turned_away_with_a_reason() {
    let directory = scratch("crowded");
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let (address, secrets, _task) = runtime.block_on(serving(Echo(None)));
    // As many connections as the app takes, which never give a token.
    let _crowd: Vec<TcpStream> = runtime.block_on(async {
        let mut crowd = Vec::new();
        for _ in 0..8 {
            crowd.push(TcpStream::connect(address).await.unwrap());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        crowd
    });
    discovery(address, secrets, std::process::id())
        .write(&directory)
        .unwrap();

    let error = gateway(&directory, std::io::empty(), std::io::sink()).unwrap_err();
    assert!(matches!(error, GatewayError::Refused), "{error:?}");
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn a_process_on_the_port_of_an_app_that_died_and_says_nothing_is_not_planche() {
    let directory = scratch("silent-impostor");
    let impostor = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = impostor.local_addr().unwrap();
    let secrets = Secrets {
        token: token().unwrap(),
        answer: token().unwrap(),
    };
    discovery(address, secrets, std::process::id() + 1)
        .write(&directory)
        .unwrap();
    std::thread::spawn(move || {
        let held: Vec<_> = impostor.incoming().take(1).collect();
        std::thread::sleep(Duration::from_secs(10));
        drop(held);
    });

    let error = gateway(&directory, std::io::empty(), std::io::sink()).unwrap_err();
    assert!(matches!(error, GatewayError::Unreachable(port) if port == address.port()));
    std::fs::remove_dir_all(&directory).unwrap();
}

#[test]
fn a_process_on_the_port_of_an_app_that_died_is_not_planche() {
    let directory = scratch("impostor");
    let impostor = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let address = impostor.local_addr().unwrap();
    let stale = discovery(
        address,
        Secrets {
            token: token().unwrap(),
            answer: token().unwrap(),
        },
        std::process::id() + 1,
    );
    stale.write(&directory).unwrap();
    std::thread::spawn(move || {
        for stream in impostor.incoming() {
            let mut stream = stream.unwrap();
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            stream.write_all(b"{\"jsonrpc\":\"2.0\"}\n").unwrap();
        }
    });

    let runtime = tokio::runtime::Runtime::new().unwrap();
    assert!(!runtime.block_on(stale.is_live()));
    let mut output = Vec::new();
    let error = gateway(&directory, std::io::empty(), &mut output).unwrap_err();
    assert!(matches!(error, GatewayError::Unreachable(port) if port == address.port()));
    assert!(output.is_empty());
    std::fs::remove_dir_all(&directory).unwrap();
}
