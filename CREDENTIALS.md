# Stopped-service credential rotation

This is a privileged operator action for an existing explicitly identified account. Verify the requester's identity and authorization out of band using the operator's established procedure; record the account UUID and decision privately. This command does not establish identity, send email, enable an account, or provide public password recovery.

Stop the service and every worker using this database before running the command. Keep the service stopped until a successful result or reconciliation of an uncertain result. The exclusive maintenance gate rejects admitted work, but does not prove an idle service has been stopped; `LITRADOCK_SERVICE_STOPPED=yes` is the operator's explicit attestation. Use the dedicated service OS identity and its protected database/object configuration. Run from the installed package directory, outside the private object and backup roots. Verify the new package hashes; the earlier frozen demo package does not contain this command.

Pass configuration only through the operator process environment: `LITRADOCK_POSTGRES`, `LITRADOCK_OBJECTS`, `LITRADOCK_ACCOUNT_ID` (nonempty hyphenated UUID), `LITRADOCK_SERVICE_STOPPED=yes`, and `LITRADOCK_NEW_PASSWORD`. The new password must be 12–256 characters, not all whitespace, and contain no control characters. It is not trimmed or normalized. Use a unique strong password. Do not place any secret on a command line, in shell history, a transcript, Git, CI configuration, a public artifact, or a service-wide persistent environment file. Same-identity/root process inspection can access environment memory; use the protected operator context and clear the parent environment immediately afterward. The process clears its inherited password variable before opening the database, but managed strings cannot promise secure memory erasure.

Example for a private Linux operator shell after loading the dedicated configuration from its protected location (do not use `set -x` or terminal recording):

```bash
set +x
IFS= read -r -p 'Verified account UUID: ' LITRADOCK_ACCOUNT_ID
IFS= read -r -s -p 'New password: ' LITRADOCK_NEW_PASSWORD
printf '\n'
export LITRADOCK_ACCOUNT_ID LITRADOCK_NEW_PASSWORD
export LITRADOCK_SERVICE_STOPPED=yes
dotnet LitraDock.Hosted.dll --rotate-credential
rotation_status=$?
unset LITRADOCK_NEW_PASSWORD LITRADOCK_SERVICE_STOPPED LITRADOCK_ACCOUNT_ID
# Review rotation_status and the redacted JSON result before restarting.
```

Do not append configuration arguments: this command rejects all additional arguments and ignores application configuration providers for its secret. The JSON success result identifies the account, preserved enabled state, and number of revoked sessions. Only after commit does it report success. Restart the service using its normal protected configuration. Old sessions remain invalid; the new password signs in only if the account was enabled. Preserve account disablement until separately authorized. Libraries, original files, research decisions, job IDs and paused work remain unchanged; rotation never resumes work.

Failure exits nonzero with a fixed reason: `invalid_input`, `unknown_account`, `busy`, `contention`, `interrupted_or_commit_unconfirmed`, or `database_failure_or_commit_unconfirmed`. Lock contention is bounded by the existing three-second account lock timeout, with existing connection/command timeouts. Cancellation or process termination before commit causes PostgreSQL transaction rollback. Loss of confirmation during commit can leave the outcome uncertain; do not claim rollback from an exit code alone. Keep service stopped, privately verify the account state and session count, then retry a deliberate rotation if necessary. Repeating rotation is supported and revokes every session again, even when the requested password is unchanged. Never print password hashes or database exception details to investigate.

Retain a protected audit containing UTC time, operator identity verification reference, UUID, approved reason, package/assembly hashes, exit status, redacted result, and restart validation. Send the new credential through the established protected channel outside this application. Review the separate deployment procedure for backup, restore, TLS, origin, account isolation, retention and rollback: rotation does not qualify a host or complete identity recovery.
