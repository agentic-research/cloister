// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SkillLoadReceipt — the ADR-0043 load event the mediator emits on each
// content-addressed read. Wiring to cloister's real audit sink (the one the
// vault-proxy's ProxyCallReceipt uses) is the integration step; this is the
// shape + a recording sink for tests.
use crate::mediator::graph::ReceiptSink;
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

/// Live sink for the mount bin: emits each load event to stderr in a greppable
/// form so an operator (and the cloister-e87760 fidelity harness) can see EVERY
/// content-addressed read reach the mediator. The real integration wires this to
/// cloister's audit/disclosure chain (cloister-3fc1b6); this is the observable
/// interim.
pub struct StderrReceiptSink;
impl ReceiptSink for StderrReceiptSink {
    fn skill_load(&self, id: &str) {
        eprintln!("SkillLoadReceipt id={id}");
    }
}
