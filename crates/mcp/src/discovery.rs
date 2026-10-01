use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

const FILE: &str = "agent.json";
/// Well above a secret and its line break.
pub(crate) const MOST_LINE: usize = 256;

/// Where a running app with agent access on listens, the token it asks for first, and the
/// answer it gives, which proves it is the app that wrote the file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Discovery {
    pub port: u16,
    pub token: String,
    pub answer: String,
    pub pid: u32,
}

/// The folder of Tauri's `app_local_data_dir`, which the gateway has no app to ask for.
pub fn directory(identifier: &str) -> Option<PathBuf> {
    dirs::data_local_dir().map(|directory| directory.join(identifier))
}

pub fn token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl Discovery {
    /// Through a temporary file, so that a reader never finds half of it. On Windows it takes the
    /// folder's permissions, which are the user's.
    pub fn write(&self, directory: &Path) -> io::Result<()> {
        fs::create_dir_all(directory)?;
        let temporary = directory.join(format!("{FILE}.{}.tmp", self.pid));
        // Left by a process of the same id that died.
        let _ = fs::remove_file(&temporary);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(self)?)?;
        drop(file);
        fs::rename(&temporary, directory.join(FILE))
    }

    pub fn read(directory: &Path) -> io::Result<Self> {
        Ok(serde_json::from_slice(&fs::read(directory.join(FILE))?)?)
    }

    /// Unless another app wrote its own since.
    pub fn remove(&self, directory: &Path) {
        if Self::read(directory).is_ok_and(|found| found == *self) {
            // Gone already, at worst.
            let _ = fs::remove_file(directory.join(FILE));
        }
    }

    /// Whether the app that wrote it still answers at its port, which another process may have
    /// taken since the app died.
    pub async fn is_live(&self) -> bool {
        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, self.port));
        let asking = async {
            let mut stream = TcpStream::connect(address).await?;
            stream
                .write_all(format!("{}\n", self.token).as_bytes())
                .await?;
            let mut line = String::new();
            let mut first = BufReader::new(stream).take(MOST_LINE as u64);
            first.read_line(&mut line).await?;
            io::Result::Ok(line.trim_end_matches(['\r', '\n']) == self.answer)
        };
        let answered = tokio::time::timeout(Duration::from_millis(500), asking).await;
        answered.is_ok_and(|answered| answered.is_ok_and(|right| right))
    }
}
