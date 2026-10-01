//! How agents read and edit the board open in the desktop app, over MCP. An agent's client spawns the
//! app's binary as a [`gateway`], which passes bytes to the app over a port of this machine
//! only, once each side proved itself with a secret. Both find each other, and the secrets,
//! through a file that only the user can read. The app answers through a [`Relay`] to the web
//! app, which holds the board. It needs no Tauri, so its tests run on every platform.

mod bridge;
mod changes;
mod discovery;
mod gateway;
mod server;

use std::io;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};

use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub use bridge::{Bridge, Call, Reply};
pub use discovery::{Discovery, directory, token};
pub use gateway::{Error as GatewayError, gateway};
pub use server::{Relay, listen};

#[derive(Debug, thiserror::Error)]
pub enum StartError {
    #[error("another Planche has it on already (process {0})")]
    InUse(u32),
    #[error("there is no randomness for a token: {0}")]
    Token(#[from] getrandom::Error),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// While agent access is on. Dropping it ends every connection, and the file goes.
pub struct Running {
    task: JoinHandle<()>,
    directory: PathBuf,
    discovery: Discovery,
}

/// Needs a Tokio runtime.
pub async fn start<R: Relay + Clone>(directory: &Path, relay: R) -> Result<Running, StartError> {
    if let Ok(other) = Discovery::read(directory)
        && other.pid != std::process::id()
        && other.is_live().await
    {
        return Err(StartError::InUse(other.pid));
    }
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let discovery = Discovery {
        port: listener.local_addr()?.port(),
        token: token()?,
        answer: token()?,
        pid: std::process::id(),
    };
    discovery.write(directory)?;
    let secrets = (discovery.token.clone(), discovery.answer.clone());
    let task = tokio::spawn(listen(listener, secrets, relay));
    Ok(Running {
        task,
        directory: directory.to_owned(),
        discovery,
    })
}

impl Drop for Running {
    fn drop(&mut self) {
        self.task.abort();
        self.discovery.remove(&self.directory);
    }
}
