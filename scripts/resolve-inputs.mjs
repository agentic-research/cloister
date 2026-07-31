#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

export * from "../cli/lib/cluster/resolve-inputs.mjs";
import { main } from "../cli/lib/cluster/resolve-inputs.mjs";
import { runIfDirect } from "./lib/run-cli-wrapper.mjs";
await runIfDirect(import.meta.url, main, "resolve-inputs");
