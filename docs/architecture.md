# Cursor Commit CLI Architecture

## Why Direct ConnectRPC over Protobuf

Cursor's "Generate Commit Message" button (`cursor.generateGitCommitMessage`) calls the internal Unary RPC `aiserver.v1.AiService/WriteGitCommitMessage` on `https://api2.cursor.sh`. Because this endpoint is available to free-tier accounts and does not have a public REST/JSON wrapper, `cursor-commit.js` speaks the exact binary Protobuf protocol and header signature expected by Cursor's backend:

- **Pure Bun Runtime**: Uses Bun's built-in `bun:sqlite`, `Bun.spawnSync`, and `fetch`, plus an inline Protobuf encoder/decoder for `WriteGitCommitMessageRequest` (fields `1: repeated string diffs`, `2: repeated string previous_commit_messages`) and `WriteGitCommitMessageResponse` (`1: string commit_message`).
- **Staged Changes Only by Default**: Reads exclusively from `git diff --cached --patch`, ignoring unstaged working-tree edits unless `--all` (`-a`) is explicitly passed.
- **Offline Token Longevity**: Reads `cursorAuth/accessToken` and `cursorAuth/refreshToken` from Cursor's local `state.vscdb`. When the access token expires while Cursor is closed, the script refreshes it via `https://api2.cursor.sh/oauth/token` and persists the new token back to `state.vscdb`.
- **Client Checksum**: Generates `x-cursor-checksum` from the current timestamp (obfuscated with rolling XOR seed `165`) and the local `telemetry.machineId` / `telemetry.macMachineId` from `storage.json`.

For CLI usage and Git alias setup, see [`README.md`](../README.md).
