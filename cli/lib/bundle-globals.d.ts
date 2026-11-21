// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Set to `true` by the bundler's `define` when cloister code is built into one
// file (gen/bundle.mjs), and absent otherwise. Read by
// cli/lib/started-as-script.mjs and cli/lib/cluster/cluster-schema.mjs.
declare var __CLOISTER_BUNDLE__: true | undefined;
