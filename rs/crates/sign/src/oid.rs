// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 cloister contributors
// Origin: agentic-research/ley-line (Apache-2.0); see ../../../NOTICE.

use const_oid::ObjectIdentifier;

/// id-data (1.2.840.113549.1.7.1) — CMS Data content type
pub const ID_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.1");

/// id-signedData (1.2.840.113549.1.7.2) — CMS SignedData content type
pub const ID_SIGNED_DATA: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.7.2");

/// id-sha512 (2.16.840.1.101.3.4.2.3) — SHA-512 digest algorithm
pub const ID_SHA512: ObjectIdentifier = ObjectIdentifier::new_unwrap("2.16.840.1.101.3.4.2.3");

/// id-Ed25519 (1.3.101.112) — Ed25519 signature algorithm
pub const ID_ED25519: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.3.101.112");

/// id-contentType (1.2.840.113549.1.9.3) — CMS content-type attribute
pub const ID_CONTENT_TYPE: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.3");

/// id-messageDigest (1.2.840.113549.1.9.4) — CMS message-digest attribute
pub const ID_MESSAGE_DIGEST: ObjectIdentifier =
    ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.4");

/// id-signingTime (1.2.840.113549.1.9.5) — CMS signing-time attribute
pub const ID_SIGNING_TIME: ObjectIdentifier = ObjectIdentifier::new_unwrap("1.2.840.113549.1.9.5");
