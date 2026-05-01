# Launch Security Review Playbook

This playbook turns security review into evidence-backed findings rather than generic OWASP recital.

## Contract

- Cite concrete code, configuration, logs, or deployment evidence.
- Describe exploit path, impact, likelihood, and remediation.
- Do not re-flag known resolved issues unless the evidence shows regression.
- Separate production risk from development-only risk.
- Mark credential rotation, public disclosure, and production security changes as approval-required.

## Topic Statuses

| Status | Meaning |
| --- | --- |
| GREEN | Evidence shows the control exists and is active |
| YELLOW | Control exists but needs hardening, verification, or monitoring |
| RED | Missing or broken control with plausible exploit path |
| GRAY | Not relevant to this system or task |

## Review Topics

### SEC-AUTH

Authentication must be active on protected routes, with no production bypass flags.

### SEC-AUTHZ-RLS

Authorization and row-level access controls must protect user-owned data.

### SEC-SECRETS

Secrets must not be committed, logged, exposed to clients, or available to untrusted workers.

### SEC-RATE-LIMITING

Public API routes should have rate limits appropriate to abuse cost and business risk.

### SEC-DATA-EXPOSURE

PII, sensitive study data, donor data, PHI, and partner artifacts must not leak through logs, errors, exports, or public pages.

### SEC-SUPPLY-CHAIN

Dependencies, CI, build scripts, and deployment configuration should not allow obvious supply-chain compromise.

## Required Output

1. Summary verdict.
2. Findings table: Topic, Status, Evidence, Exploit Path, Risk, Fix.
3. Production blockers.
4. Verification commands or checks.
5. Approval required for any production mutation.
