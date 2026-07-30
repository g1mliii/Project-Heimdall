//! Mutual exclusion for process-lifetime desktop operations.
//!
//! Capture, upload and updater installation all own resources that must survive
//! until their operation finishes. A single gate makes the check and
//! reservation atomic, so a hotkey cannot start capture between an updater's
//! last check and process restart.

use std::sync::{Arc, Mutex};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityKind {
    Capture,
    Upload,
    #[cfg(feature = "release-updates")]
    Update,
}

impl ActivityKind {
    fn label(self) -> &'static str {
        match self {
            Self::Capture => "capture",
            Self::Upload => "upload",
            #[cfg(feature = "release-updates")]
            Self::Update => "update installation",
        }
    }
}

#[derive(Debug, Default)]
struct ActivitySlot {
    next_id: u64,
    active: Option<(u64, ActivityKind)>,
}

#[derive(Clone, Debug, Default)]
pub struct ActivityState {
    inner: Arc<Mutex<ActivitySlot>>,
}

impl ActivityState {
    pub fn reserve(&self, kind: ActivityKind) -> AppResult<ActivityPermit> {
        let mut slot = self
            .inner
            .lock()
            .map_err(|_| AppError::Internal("activity state is poisoned".into()))?;
        if let Some((_, active)) = slot.active {
            return Err(AppError::OperationBusy(active.label()));
        }
        slot.next_id = slot.next_id.wrapping_add(1);
        let id = slot.next_id;
        slot.active = Some((id, kind));
        Ok(ActivityPermit {
            state: self.clone(),
            id,
        })
    }
}

#[derive(Debug)]
pub struct ActivityPermit {
    state: ActivityState,
    id: u64,
}

impl Drop for ActivityPermit {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.state.inner.lock() {
            if slot.active.is_some_and(|(id, _)| id == self.id) {
                slot.active = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_permit_atomically_blocks_every_other_activity() {
        let state = ActivityState::default();
        let capture = state.reserve(ActivityKind::Capture).unwrap();

        let error = state.reserve(ActivityKind::Upload).unwrap_err();
        assert_eq!(error.code(), "operation-busy");
        assert!(error.to_string().contains("capture"));

        drop(capture);
        let upload = state.reserve(ActivityKind::Upload).unwrap();
        assert_eq!(
            state.reserve(ActivityKind::Capture).unwrap_err().code(),
            "operation-busy"
        );
        drop(upload);
        state.reserve(ActivityKind::Capture).unwrap();
    }

    #[cfg(feature = "release-updates")]
    #[test]
    fn updater_permit_blocks_capture_and_upload_for_its_full_lifetime() {
        let state = ActivityState::default();
        let update = state.reserve(ActivityKind::Update).unwrap();

        assert_eq!(
            state.reserve(ActivityKind::Capture).unwrap_err().code(),
            "operation-busy"
        );
        assert_eq!(
            state.reserve(ActivityKind::Upload).unwrap_err().code(),
            "operation-busy"
        );

        drop(update);
        state.reserve(ActivityKind::Capture).unwrap();
    }
}
