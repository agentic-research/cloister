#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "../cli/lib/cluster/cluster-to-toml.mjs";
import { main } from "../cli/lib/cluster/cluster-to-toml.mjs";
import { runIfDirect } from "./lib/run-cli-wrapper.mjs";
await runIfDirect(import.meta.url, main, "cluster-to-toml");
