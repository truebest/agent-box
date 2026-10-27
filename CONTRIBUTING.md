# Contributing

Use a topic branch and open a GitHub pull request against `main`. Describe the
change and include the checks you ran. Keep documentation, UI text and commit
messages in English. Preserve dependency lockfiles, licenses and copyright notices.

Reuse Herdr's native agent and terminal behavior. Preserve sandbox UIDs,
conversations, running processes, templates and completed snapshots. Test changes
that modify sandbox state in disposable environments.

## Checks

Run the Python tests:

```sh
python3 -m unittest discover -s tests -v
```

For frontend changes, run these commands in `panel/web`:

```sh
npm ci
npm test
npm run lint
npm run build
```

For image, Go, runtime or console changes, run `sh ci/check.sh` from the repository
root. Its Docker stages build and test the runtime, Go module and console overlay.
Record browser, snapshot restore and host recovery checks when relevant.

## Sensitive data

Keep credentials, browser sessions, agent journals and snapshots out of commits,
issues and logs. Read [SECURITY.md](SECURITY.md) before sharing a reproduction.

Gitleaks uses its default rules plus the project's credential patterns. Exceptions
cover exact public upstream fixture values in specific files. Inspect new findings
and fix their cause rather than excluding an entire directory or rule.
