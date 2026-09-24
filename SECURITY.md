# Security

Send suspected vulnerabilities privately to **zack@definitelynot.ai** with the affected version, a concise reproduction, and the expected and observed behavior. Do not send live passwords, cookies, tokens, full HARs, or private conversations. Start with synthetic data; agree on any additional diagnostic material privately.

The current development version is 1.7.0. Security fixes target the current version; no response-time or older-version maintenance commitment is implied.

Areas of concern include credentials leaving their provider origin, exported markup executing code, page scripts gaining access to extension reports or actions, recording without user action, and data crossing tabs or Firefox containers. The [source review](docs/security-review.md) records relevant changes and the limits of the executed tests. It is not a Mozilla approval or a claim that all vulnerabilities have been found.
