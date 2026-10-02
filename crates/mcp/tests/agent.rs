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
    let reads = [
        "board",
        "elements",
        "image",
        "render",
        "screenshot",
        "selection",
    ];
    let writes = [
        "add",
        "add_images",
        "group",
        "remove",
        "restack",
        "select",
        "transform",
        "ungroup",
        "update",
    ];
    let mut all = [&reads[..], &writes[..]].concat();
    all.sort_unstable();
    assert_eq!(names, all);
    for tool in &tools {
        let schema = serde_json::to_string(&tool.input_schema).unwrap();
        // Some clients read no references in a tool's input.
        assert!(
            !schema.contains("$ref") && !schema.contains("$defs"),
            "{}",
            tool.name
        );
        let read_only = tool
            .annotations
            .as_ref()
            .and_then(|hints| hints.read_only_hint);
        assert_eq!(
            read_only,
            Some(reads.contains(&tool.name.as_ref())),
            "{}",
            tool.name
        );
    }

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
async fn a_render_asks_for_an_area_or_for_elements() {
    let (address, secrets, task) = serving(Pictured(picture("image/png", "AAAA"))).await;
    let area = json!({ "x": 0.5, "y": 0.5, "width": 10.5, "height": 5.5 });
    for arguments in [
        json!({}),
        json!({ "area": area, "ids": ["a"] }),
        json!({ "ids": [] }),
        json!({ "ids": (0..101).map(|id| id.to_string()).collect::<Vec<_>>() }),
        json!({ "ids": ["a"], "size": 8 }),
        json!({ "ids": ["a"], "size": 1569 }),
        json!({ "ids": ["a"], "zoom": 2 }),
    ] {
        let (failed, _) = call(address, &secrets, "render", arguments).await;
        assert!(failed);
    }
    let client = ().serve(connected(address, &secrets).await).await.unwrap();
    for arguments in [
        json!({ "area": area, "size": 800 }),
        json!({ "ids": ["a"] }),
    ] {
        let arguments = arguments.as_object().unwrap().clone();
        let result = client
            .call_tool(CallToolRequestParams::new("render").with_arguments(arguments.clone()))
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(false));
        let [text, picture] = &result.content[..] else {
            panic!("{:?}", result.content);
        };
        let facts: Value = serde_json::from_str(&text.as_text().unwrap().text).unwrap();
        assert_eq!(facts["tool"], "render");
        for (name, value) in &arguments {
            assert_eq!(facts["args"][name], *value);
        }
        assert_eq!(picture.as_image().unwrap().mime_type, "image/png");
    }
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
    assert_eq!(client.list_all_tools().await.unwrap().len(), 15);

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

async fn relayed(tool: &str, arguments: Value) -> Result<Value, String> {
    let (address, secrets, task) = serving(Echo(None)).await;
    let (failed, text) = call(address, &secrets, tool, arguments).await;
    task.abort();
    if failed {
        Err(text)
    } else {
        Ok(serde_json::from_str::<Value>(&text).unwrap()["args"].clone())
    }
}

#[tokio::test]
async fn an_image_file_reaches_the_web_app_as_its_bytes_and_its_name_alone() {
    let directory = scratch("image-file");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("harbour.png");
    std::fs::write(&path, b"not even a PNG").unwrap();
    let image = json!({ "path": path, "x": 10.0, "caption": "The harbour" });
    let args = relayed("add_images", json!({ "images": [image] }))
        .await
        .unwrap();
    assert_eq!(
        args,
        json!({ "images": [{
            "data": "bm90IGV2ZW4gYSBQTkc=",
            "filename": "harbour.png",
            "x": 10.0,
            "caption": "The harbour",
        }] })
    );
    std::fs::remove_dir_all(&directory).unwrap();
}

#[cfg(windows)]
#[tokio::test]
async fn a_file_on_another_machine_is_never_asked_for() {
    // Hosts that resolve nowhere, so that a failing check fails fast.
    for path in [
        r"\\host.invalid\share\harbour.png",
        "//host.invalid/share/harbour.png",
        r"\/host.invalid/share/harbour.png",
        "//./UNC/host.invalid/share/harbour.png",
        "//./pipe/harbour",
    ] {
        let image = json!({ "path": path });
        let refused = relayed("add_images", json!({ "images": [image] }))
            .await
            .unwrap_err();
        assert!(
            refused.ends_with("a path must be absolute, on this machine"),
            "{refused}"
        );
    }
}

#[tokio::test]
async fn only_a_file_of_this_machine_is_read() {
    let directory = scratch("not-files");
    std::fs::create_dir_all(&directory).unwrap();
    let large = directory.join("large.png");
    // Sparse, so that it costs nothing.
    std::fs::File::create(&large)
        .unwrap()
        .set_len(26 << 20)
        .unwrap();
    for (image, refusal) in [
        (json!({ "path": "harbour.png" }), "a path must be absolute"),
        (json!({ "path": directory }), "not a file"),
        (json!({ "path": large }), "over 25 MB"),
        (
            json!({ "path": large, "data": "AAAA" }),
            "a path or data, not both",
        ),
        (json!({}), "a path or data, not both"),
    ] {
        let refused = relayed("add_images", json!({ "images": [image] }))
            .await
            .unwrap_err();
        assert!(refused.contains(refusal), "{refused}");
    }
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn more_than_50_mb_of_files_at_a_time_are_refused() {
    let directory = scratch("too-many-files");
    std::fs::create_dir_all(&directory).unwrap();
    let path = directory.join("large.png");
    // Sparse, so that it costs nothing.
    std::fs::File::create(&path)
        .unwrap()
        .set_len(20 << 20)
        .unwrap();
    let image = json!({ "path": path });
    let refused = relayed("add_images", json!({ "images": vec![image; 3] }))
        .await
        .unwrap_err();
    assert_eq!(refused, "50 MB of files at most at a time");
    std::fs::remove_dir_all(&directory).unwrap();
}

#[tokio::test]
async fn too_many_images_are_refused_before_any_is_read() {
    // Never made, so that reading it would give another refusal.
    let image = json!({ "path": scratch("never-read").join("harbour.png") });
    let refused = relayed("add_images", json!({ "images": vec![image; 13] }))
        .await
        .unwrap_err();
    assert_eq!(refused, "At most 12 at a time");
}

#[tokio::test]
async fn data_too_large_is_refused() {
    let image = json!({ "data": "A".repeat(5_000_001) });
    let refused = relayed("add_images", json!({ "images": [image] }))
        .await
        .unwrap_err();
    assert_eq!(
        refused,
        "data holds 5000000 characters at most: give a path for a larger file"
    );
}

#[tokio::test]
async fn a_name_given_with_the_bytes_keeps_its_last_part() {
    let image = json!({ "data": "AAAA", "filename": "/Users/me/Desktop/harbour.png" });
    let args = relayed("add_images", json!({ "images": [image] }))
        .await
        .unwrap();
    assert_eq!(args["images"][0]["filename"], "harbour.png");
}

#[tokio::test]
async fn what_the_agent_leaves_out_stays_absent() {
    let note = json!({ "type": "note", "x": 0.0, "y": 0.0, "text": "Warm light" });
    let args = relayed("add", json!({ "elements": [note] })).await.unwrap();
    assert_eq!(args, json!({ "elements": [note] }));
}

#[tokio::test]
async fn calls_too_large_are_refused() {
    let note = json!({ "type": "note", "x": 0.0, "y": 0.0, "text": "Warm light" });
    let refused = relayed("add", json!({ "elements": vec![note; 51] }))
        .await
        .unwrap_err();
    assert_eq!(refused, "At most 50 at a time");
    let long = json!({ "id": "a", "caption": "a".repeat(2_001) });
    let refused = relayed("update", json!({ "updates": [long] }))
        .await
        .unwrap_err();
    assert_eq!(refused, "A caption holds 2000 characters at most");
}

#[tokio::test]
async fn an_unknown_field_is_refused_before_the_web_app_hears_of_it() {
    let refused = relayed("transform", json!({ "ids": ["a"], "rotation": 90 }))
        .await
        .unwrap_err();
    assert!(refused.contains("unknown field `rotation`"), "{refused}");
}

#[tokio::test]
async fn a_style_reaches_the_web_app_as_the_agent_gave_it() {
    let elements = json!([
        { "type": "note", "x": 0.0, "y": 0.0, "text": "Warm light", "colour": "#EC8353", "bold": true, "italic": false, "align": "centre" },
        { "type": "sticky", "x": 0.0, "y": 0.0, "paper": "lilac", "strike": true },
        { "type": "shape", "x": 0.0, "y": 0.0, "text": "Key light", "colour": "blue", "weight": "thick", "dash": "dashed", "fill": "tint", "bold": true, "align": "left" },
        { "type": "arrow", "from": { "x": 0.0, "y": 0.0 }, "to": { "x": 1.0, "y": 0.0 }, "dash": "dashed", "heads": "both" },
        { "type": "line", "from": { "x": 0.0, "y": 0.0 }, "to": { "x": 1.0, "y": 0.0 }, "weight": "thin" },
    ]);
    let args = relayed("add", json!({ "elements": elements }))
        .await
        .unwrap();
    assert_eq!(args, json!({ "elements": elements }));

    let update = json!({
        "id": "a",
        "colour": "red",
        "paper": "pink",
        "weight": "medium",
        "dash": "solid",
        "heads": "end",
        "fill": "solid",
        "bold": false,
        "italic": true,
        "strike": false,
        "align": "right",
    });
    let args = relayed("update", json!({ "updates": [update] }))
        .await
        .unwrap();
    assert_eq!(args, json!({ "updates": [update] }));
}

#[tokio::test]
async fn a_crop_shape_reaches_the_web_app_as_the_agent_gave_it() {
    let update = json!({ "id": "a", "crop_shape": "ellipse" });
    let args = relayed("update", json!({ "updates": [update] }))
        .await
        .unwrap();
    assert_eq!(args, json!({ "updates": [update] }));

    let star = json!({ "id": "a", "crop_shape": "star" });
    let refused = relayed("update", json!({ "updates": [star] }))
        .await
        .unwrap_err();
    assert!(refused.contains("unknown variant `star`"), "{refused}");
}

#[tokio::test]
async fn a_style_that_an_element_cannot_take_is_refused_before_the_web_app_hears_of_it() {
    let point = json!({ "x": 0.0, "y": 0.0 });
    let refusals = [
        (
            json!({ "type": "comment", "at": point, "text": "Why?", "colour": "red" }),
            "unknown field `colour`",
        ),
        (
            json!({ "type": "sticky", "x": 0.0, "y": 0.0, "colour": "red" }),
            "unknown field `colour`",
        ),
        (
            json!({ "type": "note", "x": 0.0, "y": 0.0, "text": "Hi", "weight": "thin" }),
            "unknown field `weight`",
        ),
        (
            json!({ "type": "line", "from": point, "to": point, "heads": "both" }),
            "unknown field `heads`",
        ),
        (
            json!({ "type": "arrow", "from": point, "to": point, "fill": "solid" }),
            "unknown field `fill`",
        ),
        (
            json!({ "type": "arrow", "from": point, "to": point, "heads": "neither" }),
            "unknown variant `neither`",
        ),
        (
            json!({ "type": "shape", "x": 0.0, "y": 0.0, "weight": "heavy" }),
            "unknown variant `heavy`",
        ),
        (
            json!({ "type": "sticky", "x": 0.0, "y": 0.0, "paper": "red" }),
            "unknown variant `red`",
        ),
        (
            json!({ "type": "arrow", "from": point, "to": point, "bold": true }),
            "unknown field `bold`",
        ),
        (
            json!({ "type": "note", "x": 0.0, "y": 0.0, "text": "Hi", "colour": "purple" }),
            "`purple` is not a colour",
        ),
    ];
    for (element, expected) in refusals {
        let refused = relayed("add", json!({ "elements": [element] }))
            .await
            .unwrap_err();
        assert!(refused.contains(expected), "{refused}");
    }
    let refused = relayed(
        "update",
        json!({ "updates": [{ "id": "a", "align": "middle" }] }),
    )
    .await
    .unwrap_err();
    assert!(refused.contains("unknown variant `middle`"), "{refused}");
}
