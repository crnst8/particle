# Security

## Threat model, stated plainly

particle is single-user software. Authentication is optional and off by default
for a frictionless localhost install. Two consequences:

1. **Without `PARTICLE_PASSWORD`, anyone who can reach the port can read, add
   and delete your library.** Set a long password whenever particle is exposed
   to the public internet. HTTPS is still required; set `PARTICLE_TRUST_PROXY=1`
   behind your TLS-terminating proxy.
2. **particle fetches URLs you give it, server-side.** Private, loopback,
   link-local and reserved destinations are blocked by default and every
   redirect is checked again. `ALLOW_PRIVATE_HOSTS=1` deliberately disables
   that boundary for people saving pages from a trusted LAN.

## What particle does defend against

- Extracted HTML is sanitised with DOMPurify against an explicit tag/attribute
  allowlist before it is ever stored or rendered.
- Article links are rewritten with `rel="noopener"`.
- The image proxy only forwards `image/*` responses over http(s).
- The image proxy stops reading after `IMAGE_MAX_BYTES` (8 MiB by default).
- Password sessions use an HttpOnly, SameSite cookie signed with HMAC.

## Reporting a vulnerability

Please don't open a public issue. Email the address on
<https://github.com/crnst8> with "particle" in the subject, or use GitHub's
[private vulnerability reporting](https://github.com/crnst8/particle/security/advisories/new).

Expect an acknowledgement within a week. This is a personal project maintained
in spare time — there is no SLA, but reports are taken seriously and credited
unless you'd rather not be.
