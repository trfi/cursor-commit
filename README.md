# cursor-commit

Generate Git commit messages from the terminal using Cursor's native **Generate Commit Message** AI (`aiserver.v1.AiService/WriteGitCommitMessage`) — **without opening the Cursor IDE**.

Works with **Cursor Free** and **Cursor Pro** accounts, runs on **Bun** with zero external `npm` dependencies, and automatically refreshes expired tokens in the background.

## Features

- **Zero External Dependencies**: Uses Bun's built-in `bun:sqlite`, `Bun.spawnSync`, and `fetch` with a lightweight inline Protobuf encoder/decoder.
- **Works on Free Tier**: Calls the exact internal Unary RPC used by Cursor's Source Control sparkle button (`✨ Generate Commit Message`).
- **Staged Changes Only by Default**: Reads exclusively from `git diff --cached` and ignores unstaged edits (unless `--all` is explicitly passed) plus the last 10 commit messages to match your repository's commit style.
- **No-History Mode (`--no-history` / `-n`)**: Skip sending `previous_commit_messages` and rely strictly on `explicit_context` + staged `diffs`.
- **Automatic Token Refresh**: Reads `cursorAuth/accessToken` and `cursorAuth/refreshToken` from Cursor's local `state.vscdb` and refreshes expired tokens automatically even if you haven't opened Cursor in months.
- **Cross-Platform**: Supports Windows, macOS, and Linux.

## Prerequisites

1. [Bun](https://bun.sh/) (`v1.1+`) installed.
2. [Cursor](https://cursor.com/) installed and signed in at least once on your machine (no need to keep Cursor running).

## Installation

```bash
git clone https://github.com/trfi/cursor-commit.git
cd cursor-commit

# Register `cursor-commit` as a global CLI command on your system
bun link

# Automatically configure all global Git aliases (cc, ccc, ccy, ccn, cccn, ccyn)
bun cursor-commit.js --setup-aliases
```

## Usage

Stage your changes (`git add <files>`) and run:

| Git Alias | Description |
| :--- | :--- |
| `git cc` | Generate and print commit message to stdout |
| `git ccc` | Generate commit message and run `git commit -m "<msg>"` |
| `git ccy` | Generate commit message and copy to clipboard |
| `git ccn` | Generate and print commit message without `previous_commit_messages` |
| `git cccn` | Generate commit message (no history) and run `git commit -m "<msg>"` |
| `git ccyn` | Generate commit message (no history) and copy to clipboard |

### CLI Options

| Flag | Description |
| :--- | :--- |
| *(none)* | Generate and print commit message for staged changes (`git diff --cached`) |
| `-c`, `--commit` | Generate commit message and run `git commit -m "<message>"` |
| `-y`, `--copy` | Generate commit message and copy it to the system clipboard |
| `-n`, `--no-history` | Do not send `previous_commit_messages` (send only `explicit_context` + `diffs`) |
| `-a`, `--all` | Fallback to unstaged changes (`git diff HEAD`) if nothing is staged |
| `--setup-aliases` | Configure all global Git aliases (`cc`, `ccc`, `ccy`, `ccn`, `cccn`, `ccyn`) |
| `--hook <file>` | Prepend generated message into a commit message file (for `.git/hooks/prepare-commit-msg`) |
| `-h`, `--help` | Show CLI usage |

## Documentation

See [`docs/architecture.md`](./docs/architecture.md) for details on the ConnectRPC Protobuf wire format, `x-cursor-checksum` calculation, and token refresh lifecycle.

## License

[MIT](./LICENSE)
