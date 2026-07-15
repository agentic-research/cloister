// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SkillLoadReceipt — the ADR-0043 load event the mediator emits on each
// content-addressed read. Wiring to cloister's real audit sink (the one the
// vault-proxy's ProxyCallReceipt uses) is the integration step; this is the
// shape + a recording sink for tests.
use crate::graph::ReceiptSink;
use parking_lot::Mutex;

#[derive(Debug, Clone)]
pub struct SkillLoadReceipt {
    pub id: String,
}

/// Test sink: records the ids read, so a test can assert the load events fired.
#[derive(Default)]
pub struct RecordingSink {
    ids: Mutex<Vec<String>>,
}
impl RecordingSink {
    pub fn ids(&self) -> Vec<String> {
        self.ids.lock().clone()
    }
}
impl ReceiptSink for RecordingSink {
    fn skill_load(&self, id: &str) {
        self.ids.lock().push(id.to_string());
    }
}
