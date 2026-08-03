#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "../cli/lib/cluster/toml-to-cluster.mjs";
import { main } from "../cli/lib/cluster/toml-to-cluster.mjs";
import { runIfDirect } from "./lib/run-cli-wrapper.mjs";
await runIfDirect(import.meta.url, main, "toml-to-cluster");
