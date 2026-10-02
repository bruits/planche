use std::io::{self, ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use crate::Discovery;
use crate::discovery::MOST_LINE;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Planche is not running, or its agent access is off: turn it on in the Settings menu")]
    NotRunning,
    #[error(
        "Planche does not answer on port {0}: it may have stopped unexpectedly, so open it again"
    )]
    Unreachable(u16),
    #[error(
        "Planche closed the connection before it answered: too many agents may be connected, so close one and try again"
    )]
    Refused,
    #[error("Planche ended the session, as its agent access was turned off or it quit")]
    Ended,
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// What an agent's client spawns. It runs before Tauri, so it needs no runtime.
pub fn gateway(
    directory: &Path,
    input: impl Read + Send + 'static,
    mut output: impl Write,
) -> Result<(), Error> {
    let discovery = Discovery::read(directory).map_err(|_| Error::NotRunning)?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, discovery.port));
    let mut socket = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|_| Error::Unreachable(discovery.port))?;
    let sent = socket.write_all(format!("{}\n", discovery.token).as_bytes());
    // A process that took the port of an app that died does not know the answer.
    match sent.and_then(|()| answer(&mut socket)) {
        Ok(Some(answer)) if answer == discovery.answer => {}
        Ok(None) => return Err(Error::Refused),
        Err(error) if turned_away(&error) => return Err(Error::Refused),
        Ok(Some(_)) | Err(_) => return Err(Error::Unreachable(discovery.port)),
    }
    let mut sending = socket.try_clone()?;
    // Set before the app hears of it, so before the app can close in turn.
    let finished = Arc::new(AtomicBool::new(false));
    // Not joined, as it may wait on an input that never ends once the app has closed.
    thread::spawn({
        let finished = finished.clone();
        move || {
            let mut input = input;
            // Failing to send means the app closed first.
            if io::copy(&mut input, &mut sending).is_ok() {
                finished.store(true, Ordering::Release);
            }
            let _ = sending.shutdown(Shutdown::Write);
        }
    });
    let mut buffer = [0u8; 8192];
    loop {
        let read = match socket.read(&mut buffer) {
            Ok(read) => read,
            Err(error) if turned_away(&error) => 0,
            Err(error) => return Err(error.into()),
        };
        if read == 0 {
            return if finished.load(Ordering::Acquire) {
                Ok(())
            } else {
                Err(Error::Ended)
            };
        }
        output.write_all(&buffer[..read])?;
        // A client waits for each message whole.
        output.flush()?;
    }
}

/// The app's first line, a byte at a time so that nothing past it is read. `None` when the app
/// closes first.
fn answer(socket: &mut TcpStream) -> io::Result<Option<String>> {
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut line = Vec::new();
    let mut byte = [0u8];
    while line.len() < MOST_LINE {
        if socket.read(&mut byte)? == 0 {
            return Ok(None);
        }
        if byte[0] == b'\n' {
            break;
        }
        line.push(byte[0]);
    }
    socket.set_read_timeout(None)?;
    Ok(Some(String::from_utf8_lossy(&line).into_owned()))
}

/// How a connection the app closes unread ends.
fn turned_away(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::ConnectionReset | ErrorKind::ConnectionAborted | ErrorKind::BrokenPipe
    )
}
