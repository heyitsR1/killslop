# Security

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead:
the **Security** tab of this repository, then **Report a vulnerability**.
Expect a first answer within a week.

Helpful to include: what an attacker could do, the steps to reproduce it,
and which part is affected (extension, public API, maintainer console).

## Scope

In scope:

- the browser extension in `extension/`
- the community API and the maintainer console in `worker/`

Of particular interest:

- anything that lets one person hide content for everyone else: stuffing
  votes past the per-person keys, or getting an entry served without review
- anything that links someone's lookups or votes to their identity or their
  watch history
- reaching the console without the password, or making it act on a
  maintainer's behalf from another site
- script injection through titles, feedback text or any other data the
  console or the extension displays

Out of scope: volumetric denial of service, rate limits being counted per
network rather than per person (by design), and anything that needs a
malicious extension or an already compromised machine.

## What is stored

See the Privacy section of the README. Feedback emails are optional and are
readable only in the maintainer console.
