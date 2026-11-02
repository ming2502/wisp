use std::sync::atomic::{AtomicUsize, Ordering};

use tokio::sync::Notify;

/// Stop reading from the server when this many bytes are unconfirmed by the renderer.
pub(super) const HIGH_WATERMARK: usize = 512 * 1024;
const LOW_WATERMARK: usize = 128 * 1024;

/// Tracks bytes sent to the renderer and not yet drawn, so that output such as `cat` on a huge file
/// pushes back on the server instead of growing without bound in the WebView.
#[derive(Default)]
pub(super) struct FlowControl {
    unacked: AtomicUsize,
    resume: Notify,
}

impl FlowControl {
    pub(super) fn sent(&self, bytes: usize) {
        self.unacked.fetch_add(bytes, Ordering::AcqRel);
    }

    pub(super) fn ack(&self, bytes: usize) {
        let previous = self
            .unacked
            .try_update(Ordering::AcqRel, Ordering::Acquire, |unacked| {
                Some(unacked.saturating_sub(bytes))
            })
            .unwrap_or(0);
        if previous.saturating_sub(bytes) <= LOW_WATERMARK {
            self.resume.notify_one();
        }
    }

    /// Unblocks the reader for good when the renderer is gone and acknowledgements will never come.
    pub(super) fn release(&self) {
        self.unacked.store(0, Ordering::Release);
        self.resume.notify_one();
    }

    pub(super) fn should_pause(&self) -> bool {
        self.unacked.load(Ordering::Acquire) >= HIGH_WATERMARK
    }

    pub(super) async fn wait_until_drained(&self) {
        while self.unacked.load(Ordering::Acquire) > LOW_WATERMARK {
            self.resume.notified().await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn pauses_at_high_watermark() {
        let flow = FlowControl::default();
        flow.sent(HIGH_WATERMARK - 1);
        assert!(!flow.should_pause());
        flow.sent(1);
        assert!(flow.should_pause());
    }

    #[test]
    fn excess_ack_saturates() {
        let flow = FlowControl::default();
        flow.sent(10);
        flow.ack(100);
        flow.sent(HIGH_WATERMARK - 1);
        assert!(!flow.should_pause());
    }

    #[tokio::test]
    async fn waits_until_below_low_watermark() {
        let flow = FlowControl::default();
        flow.sent(HIGH_WATERMARK);
        let wait = flow.wait_until_drained();
        tokio::pin!(wait);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut wait)
                .await
                .is_err()
        );
        // Still above the low watermark, so the reader must stay paused.
        flow.ack(HIGH_WATERMARK - LOW_WATERMARK - 1);
        assert!(
            tokio::time::timeout(Duration::from_millis(20), &mut wait)
                .await
                .is_err()
        );
        flow.ack(1);
        tokio::time::timeout(Duration::from_secs(1), wait)
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn release_unblocks_reader() {
        let flow = FlowControl::default();
        flow.sent(HIGH_WATERMARK);
        flow.release();
        tokio::time::timeout(Duration::from_secs(1), flow.wait_until_drained())
            .await
            .unwrap();
    }
}
