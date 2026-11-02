mod flow;

use std::sync::Arc;
use std::time::Duration;

use russh::client::{Handle, Msg};
use russh::{ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Pty};
use serde::Serialize;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::connection::{ClientHandler, Session};
use flow::FlowControl;

const TERM: &str = "xterm-256color";
const TERMINAL_MODES: &[(Pty, u32)] = &[(Pty::VERASE, 127), (Pty::IUTF8, 1)];
const FLUSH_INTERVAL: Duration = Duration::from_millis(16);
const FLUSH_BYTES: usize = 64 * 1024;
/// How long to wait after a channel closes before deciding that the connection itself is still up.
const DISCONNECT_GRACE: Duration = Duration::from_millis(100);
const STDERR: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEnd {
    Exited { status: Option<u32> },
    Disconnected,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TerminalEvent {
    /// Must eventually be acknowledged through [`Terminal::ack`], or output stops.
    Output(Vec<u8>),
    End(TerminalEnd),
}

enum Input {
    Data(Vec<u8>),
    Resize(TerminalSize),
    Close,
}

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("服务器拒绝打开终端")]
    Refused,
    #[error("SSH 协议错误：{0}")]
    Protocol(#[from] russh::Error),
}

/// Closes the remote shell when dropped.
pub struct Terminal {
    input: mpsc::UnboundedSender<Input>,
    flow: Arc<FlowControl>,
}

impl Terminal {
    pub fn write(&self, data: Vec<u8>) {
        let _ = self.input.send(Input::Data(data));
    }

    pub fn resize(&self, size: TerminalSize) {
        let _ = self.input.send(Input::Resize(size));
    }

    pub fn ack(&self, bytes: usize) {
        self.flow.ack(bytes);
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.input.send(Input::Close);
        self.flow.release();
    }
}

impl Session {
    pub async fn open_terminal(
        &self,
        size: TerminalSize,
        on_event: impl FnMut(TerminalEvent) + Send + 'static,
    ) -> Result<Terminal, TerminalError> {
        let channel = self.handle.channel_open_session().await?;
        let (mut read, write) = channel.split();
        write
            .request_pty(false, TERM, size.cols, size.rows, 0, 0, TERMINAL_MODES)
            .await?;
        write.request_shell(true).await?;
        let initial_output = wait_for_shell(&mut read).await?;

        let (input, input_queue) = mpsc::unbounded_channel();
        let flow = Arc::new(FlowControl::default());
        tokio::spawn(write_input(write, input_queue));
        tokio::spawn(read_output(
            read,
            self.handle.clone(),
            flow.clone(),
            initial_output,
            on_event,
        ));
        Ok(Terminal { input, flow })
    }
}

async fn wait_for_shell(read: &mut ChannelReadHalf) -> Result<Vec<u8>, TerminalError> {
    let mut output = Vec::new();
    loop {
        match read.wait().await {
            Some(ChannelMsg::Success) => return Ok(output),
            Some(ChannelMsg::Data { data }) => output.extend_from_slice(&data),
            Some(ChannelMsg::Failure | ChannelMsg::Close) | None => {
                return Err(TerminalError::Refused);
            }
            Some(_) => {}
        }
    }
}

async fn write_input(write: ChannelWriteHalf<Msg>, mut queue: mpsc::UnboundedReceiver<Input>) {
    while let Some(input) = queue.recv().await {
        let result = match input {
            Input::Data(data) => write.data_bytes(data).await,
            Input::Resize(size) => write.window_change(size.cols, size.rows, 0, 0).await,
            Input::Close => {
                let _ = write.close().await;
                return;
            }
        };
        if result.is_err() {
            return;
        }
    }
}

async fn read_output(
    mut read: ChannelReadHalf,
    handle: Arc<Handle<ClientHandler>>,
    flow: Arc<FlowControl>,
    mut pending: Vec<u8>,
    mut on_event: impl FnMut(TerminalEvent),
) {
    let mut flush = |pending: &mut Vec<u8>| {
        if !pending.is_empty() {
            flow.sent(pending.len());
            on_event(TerminalEvent::Output(std::mem::take(pending)));
        }
    };
    let mut status = None;
    let mut deadline = Instant::now() + FLUSH_INTERVAL;
    loop {
        if flow.should_pause() {
            // russh delivers to channels from its session loop, so a pause that lasts long enough
            // to fill the channel buffer also stalls every other channel on this connection.
            flush(&mut pending);
            flow.wait_until_drained().await;
        }
        tokio::select! {
            message = read.wait() => {
                let was_empty = pending.is_empty();
                match message {
                    Some(ChannelMsg::Data { data }) => pending.extend_from_slice(&data),
                    Some(ChannelMsg::ExtendedData { data, ext: STDERR }) => {
                        pending.extend_from_slice(&data)
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => status = Some(exit_status),
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
                if was_empty && !pending.is_empty() {
                    deadline = Instant::now() + FLUSH_INTERVAL;
                }
                if pending.len() >= FLUSH_BYTES {
                    flush(&mut pending);
                }
            }
            _ = tokio::time::sleep_until(deadline), if !pending.is_empty() => flush(&mut pending),
        }
    }
    flush(&mut pending);
    drop(flush);

    let end = if status.is_none() && connection_lost(&handle).await {
        TerminalEnd::Disconnected
    } else {
        TerminalEnd::Exited { status }
    };
    on_event(TerminalEvent::End(end));
}

async fn connection_lost(handle: &Handle<ClientHandler>) -> bool {
    let wait = Instant::now() + DISCONNECT_GRACE;
    while Instant::now() < wait {
        if handle.is_closed() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    handle.is_closed()
}
