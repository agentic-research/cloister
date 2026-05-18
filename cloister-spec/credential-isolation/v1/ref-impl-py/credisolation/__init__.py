"""Reference implementation of cloister/credential-isolation/v1.

Submodules:
  envelope  — POST /vault/proxy/<service>/<upstream-path> request shape
              + canonical request bytes for Interlace-Sig.
  injection — five injection strategies (authorizationBearer, authorizationBasic,
              headerNamed, queryParam, bodyField) and how each builds the
              upstream request given (skill-request, credential).
  receipt   — receipt canonical input + sha256 commitment digest. Pinned
              MUST-NOT-COMMIT field list enforced at the typed boundary.
  validate  — structural validators for the JSON test-vector files.
"""

from credisolation import envelope, injection, receipt, validate  # noqa: F401
