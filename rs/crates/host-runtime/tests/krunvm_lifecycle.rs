use std::collections::BTreeSet;

use cloister_host_runtime::krunvm::{
    plan_gc, required_reserve, ImageRecord, RuntimeInventory, StorageUsage, VmRecord,
};

fn set(values: &[&str]) -> BTreeSet<String> {
    values.iter().map(|value| (*value).to_string()).collect()
}

#[test]
fn planner_reclaims_only_known_unreachable_state() {
    let inventory = RuntimeInventory {
        vms: vec![
            VmRecord::known("exact", "mache", "r-exact", "p-current", 50),
            VmRecord::known("active", "mache", "r-active", "p-old", 40),
            VmRecord::known("pinned", "llo", "r-pinned", "p-pinned", 30),
            VmRecord::known("superseded-newer", "mache", "r-old-2", "p-old-2", 20),
            VmRecord::known("superseded-older", "mache", "r-old-1", "p-old-1", 10),
            VmRecord::unknown("operator-vm"),
        ],
        images: vec![
            ImageRecord::known("p-current", 50),
            ImageRecord::known("p-pinned", 30),
            ImageRecord::known("p-unreferenced", 5),
            ImageRecord::unknown("operator-image"),
        ],
        running_vms: set(&["exact"]),
    };

    let plan = plan_gc(
        &inventory,
        &set(&["r-exact", "r-active"]),
        &set(&["p-current", "p-pinned"]),
    );

    assert_eq!(
        plan.delete_vms,
        vec!["superseded-older", "superseded-newer"]
    );
    assert_eq!(plan.prune_images, vec!["p-unreferenced"]);
    assert_eq!(
        plan.protected_unknown,
        vec!["operator-image", "operator-vm"]
    );
}

#[test]
fn reserve_is_twenty_percent_with_a_512_mib_floor() {
    const GIB: u64 = 1024 * 1024 * 1024;
    assert_eq!(required_reserve(2 * GIB), 512 * 1024 * 1024);
    assert_eq!(required_reserve(10 * GIB), 2 * GIB);
}

#[test]
fn acquisition_requires_the_reserve_to_remain_available() {
    let blocked = StorageUsage::new(3_000, 2_600, 500);
    assert!(!blocked.can_acquire());

    let ready = StorageUsage::new(3_000, 2_400, 500);
    assert!(ready.can_acquire());
}
