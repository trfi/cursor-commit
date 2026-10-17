#!/usr/bin/env bun
/**
 * cursor-commit.js
 * Standalone Bun CLI utility that calls Cursor's internal WriteGitCommitMessage API
 * (aiserver.v1.AiService/WriteGitCommitMessage) without opening the Cursor IDE.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Database } from "bun:sqlite";

const CURSOR_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const CURSOR_API_BASE = "https://api2.cursor.sh";

const DEFAULT_COMMIT_INSTRUCTIONS = `Write a production-grade Git commit message following Conventional Commits (<type>(<scope>): <subject>) and the 7 rules of a great Git commit message:
1. Subject line: Use imperative mood (e.g., "fix", "add", "prevent", NOT "fixed" or "added"), lowercase after colon, no trailing period, max 72 chars. Choose the accurate semantic type: use "fix" when resolving bugs, flashes, race conditions, or broken focus/shortcuts; use "feat" only for net-new user-facing features.
2. Body format: Leave one blank line after the subject, then provide concise bullet points ("- ") starting with a specific imperative verb (e.g., "- Prevent...", "- Route...", "- Sync...", "- Propagate...", NEVER past-tense like "- Updated..." and avoid vague verbs like "Enhance" or "Improve").
3. Focus on WHY and technical mechanism: Explain the root cause, constraint, or mechanism (e.g., why a flag/hook is needed), not a file-by-file changelog.
4. Strictly omit documentation filler: NEVER include bullets about updating documentation, comments, or lesson files unless the commit only changes docs.`;

function getPaths() {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    return {
      dbPath: path.join(appData, "Cursor", "User", "globalStorage", "state.vscdb"),
      storagePath: path.join(appData, "Cursor", "User", "globalStorage", "storage.json"),
      productPath: path.join(localAppData, "Programs", "cursor", "resources", "app", "product.json"),
    };
  }
  if (process.platform === "darwin") {
    const appSupport = path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage");
    return {
      dbPath: path.join(appSupport, "state.vscdb"),
      storagePath: path.join(appSupport, "storage.json"),
      productPath: "/Applications/Cursor.app/Contents/Resources/app/product.json",
    };
  }
  const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Cursor", "User", "globalStorage");
  return {
    dbPath: path.join(configDir, "state.vscdb"),
    storagePath: path.join(configDir, "storage.json"),
    productPath: "/usr/share/cursor/resources/app/product.json",
  };
}

function getCursorChecksum(machineId, macMachineId) {
  const x = Math.floor(Date.now() / 1e6);
  const bytes = new Uint8Array([
    (x >> 40) & 255,
    (x >> 32) & 255,
    (x >> 24) & 255,
    (x >> 16) & 255,
    (x >> 8) & 255,
    x & 255,
  ]);
  let t = 165;
  for (let n = 0; n < bytes.length; n++) {
    bytes[n] = ((bytes[n] ^ t) + (n % 256)) & 255;
    t = bytes[n];
  }
  const encoded = Buffer.from(bytes).toString("base64url");
  return macMachineId ? `${encoded}${machineId}/${macMachineId}` : `${encoded}${machineId}`;
}

function decodeJwtExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

async function getValidAccessToken(dbPath) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cursor database not found at: ${dbPath}`);
  }

  const db = new Database(dbPath, { readonly: true });
  const getVal = (key) => {
    const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get(key);
    return row ? row.value : undefined;
  };
  let accessToken = getVal("cursorAuth/accessToken");
  const refreshToken = getVal("cursorAuth/refreshToken");
  db.close();

  if (!accessToken && !refreshToken) {
    throw new Error("No Cursor login session found in state.vscdb. Please sign in to Cursor once.");
  }

  const exp = decodeJwtExp(accessToken);
  if (!accessToken || Date.now() + 5 * 60 * 1000 > exp) {
    const res = await fetch(`${CURSOR_API_BASE}/oauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-cursor-client-type": "ide",
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: CURSOR_CLIENT_ID,
        refresh_token: refreshToken,
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to refresh Access Token (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    if (!data.access_token) {
      throw new Error("Invalid token refresh response from Cursor API.");
    }
    accessToken = data.access_token;

    try {
      const writeDb = new Database(dbPath);
      writeDb
        .query("UPDATE ItemTable SET value = ? WHERE key = 'cursorAuth/accessToken'")
        .run(accessToken);
      writeDb.close();
    } catch {
      // Ignore if Cursor IDE currently holds a write lock on state.vscdb
    }
  }

  return accessToken;
}

function encodeVarint(val) {
  const bytes = [];
  while (val > 0x7f) {
    bytes.push((val & 0x7f) | 0x80);
    val >>>= 7;
  }
  bytes.push(val & 0x7f);
  return Buffer.from(bytes);
}

function encodeBytesField(fieldNo, buf) {
  const tag = encodeVarint((fieldNo << 3) | 2);
  const len = encodeVarint(buf.length);
  return Buffer.concat([tag, len, buf]);
}

function encodeStringField(fieldNo, str) {
  return encodeBytesField(fieldNo, Buffer.from(str, "utf8"));
}

function encodeExplicitContext(instructions) {
  // aiserver.v1.ExplicitContext:
  // field 1: string context
  // field 2: string repo_context
  return Buffer.concat([
    encodeStringField(1, instructions),
    encodeStringField(2, instructions),
  ]);
}

function encodeWriteGitCommitMessageRequest(diffs, previousCommitMessages, instructions) {
  const chunks = [];
  for (const d of diffs) {
    chunks.push(encodeStringField(1, d));
  }
  for (const m of previousCommitMessages) {
    chunks.push(encodeStringField(2, m));
  }
  if (instructions) {
    chunks.push(encodeBytesField(3, encodeExplicitContext(instructions)));
  }
  return Buffer.concat(chunks);
}

function decodeWriteGitCommitMessageResponse(buf) {
  let offset = 0;
  while (offset < buf.length) {
    let tag = 0;
    let shift = 0;
    while (offset < buf.length) {
      const b = buf[offset++];
      tag |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }
    const fieldNo = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 2) {
      let len = 0;
      shift = 0;
      while (offset < buf.length) {
        const b = buf[offset++];
        len |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      const val = buf.subarray(offset, offset + len);
      offset += len;
      if (fieldNo === 1) {
        return val.toString("utf8");
      }
    } else {
      break;
    }
  }
  return "";
}

function runGit(args) {
  const proc = Bun.spawnSync(["git", ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (proc.exitCode !== 0) return "";
  return proc.stdout.toString("utf8").trim();
}

function splitDiffByFile(rawDiff) {
  const parts = rawDiff.split(/^(?=diff --git )/m).map((s) => s.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [rawDiff];
}

function cleanCommitExample(msg) {
  return msg
    .split(/\r?\n/)
    .filter((line) => !/^-\s*(updated|improved|added|enhanced)\s+documentation\b/i.test(line.trim()))
    .map((line) =>
      line
        .replace(/^(\s*-\s*)Updated\b/, "$1Update")
        .replace(/^(\s*-\s*)Introduced\b/, "$1Introduce")
        .replace(/^(\s*-\s*)Enhanced\b/, "$1Update")
        .replace(/^(\s*-\s*)Improved\b/, "$1Refine")
        .replace(/^(\s*-\s*)Added\b/, "$1Add")
        .replace(/^(\s*-\s*)Removed\b/, "$1Remove")
        .replace(/^(\s*-\s*)Modified\b/, "$1Modify")
        .replace(/^(\s*-\s*)Adjusted\b/, "$1Adjust")
    )
    .join("\n")
    .trim();
}

function getGitContext(includeUnstagedFallback = false) {
  let rawDiff = runGit(["diff", "--cached", "--patch"]);

  if (!rawDiff && includeUnstagedFallback) {
    rawDiff = runGit(["diff", "HEAD", "--patch"]) || runGit(["diff", "--patch"]);
  }

  if (!rawDiff) {
    throw new Error(
      "No staged changes found (run `git add` first, or pass `--all` to include unstaged changes)."
    );
  }

  const MAX_DIFF_CHARS = 120000;
  if (rawDiff.length > MAX_DIFF_CHARS) {
    rawDiff = rawDiff.slice(0, MAX_DIFF_CHARS) + "\n... [diff truncated]";
  }

  const diffs = splitDiffByFile(rawDiff);
  const logOutput = runGit(["log", "-n", "10", "--pretty=format:%B%x00"]);
  const previousCommitMessages = logOutput
    ? logOutput
        .split("\0")
        .map((s) => cleanCommitExample(s))
        .filter(Boolean)
    : [];

  return { diffs, previousCommitMessages };
}

function postProcessCommitMessage(msg) {
  const lines = msg.split(/\r?\n/);
  const bulletLines = lines.filter((l) => /^\s*-\s+/.test(l));
  const isDocFiller = (line) =>
    /^\s*-\s*(?:update|updated|enhance|enhanced|improve|improved|add|added|refine|refined)\s+(?:the\s+)?documentation\s+to\s+(?:reflect|clarify|document)\b/i.test(
      line
    );

  // Only prune generic "Updated documentation to reflect..." filler if there are other substantive bullets
  if (bulletLines.length > 1) {
    return lines
      .filter((l) => !isDocFiller(l))
      .join("\n")
      .trim();
  }
  return msg.trim();
}

async function generateCommitMessage(includeUnstagedFallback = false) {
  const { dbPath, storagePath, productPath } = getPaths();
  const { diffs, previousCommitMessages } = getGitContext(includeUnstagedFallback);

  let machineId = crypto.randomUUID();
  let macMachineId = undefined;
  if (fs.existsSync(storagePath)) {
    const storage = JSON.parse(fs.readFileSync(storagePath, "utf8"));
    machineId = storage["telemetry.machineId"] || machineId;
    macMachineId = storage["telemetry.macMachineId"];
  }

  let clientVersion = "3.22.7";
  if (fs.existsSync(productPath)) {
    const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
    clientVersion = product.version || clientVersion;
  }

  const accessToken = await getValidAccessToken(dbPath);
  const checksum = getCursorChecksum(machineId, macMachineId);
  const body = encodeWriteGitCommitMessageRequest(
    diffs,
    previousCommitMessages,
    DEFAULT_COMMIT_INSTRUCTIONS
  );

  const res = await fetch(`${CURSOR_API_BASE}/aiserver.v1.AiService/WriteGitCommitMessage`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/proto",
      "Connect-Protocol-Version": "1",
      "x-cursor-checksum": checksum,
      "x-cursor-client-version": clientVersion,
      "x-cursor-client-type": "ide",
      "x-cursor-client-os": process.platform,
      "x-cursor-client-arch": process.arch,
      "x-cursor-client-device-type": "desktop",
      "x-cursor-timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
      "x-ghost-mode": "true",
      "x-request-id": crypto.randomUUID(),
    },
    body,
  });

  const resBuf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    throw new Error(`Cursor API error (${res.status}): ${resBuf.toString("utf8")}`);
  }

  const commitMessage = postProcessCommitMessage(decodeWriteGitCommitMessageResponse(resBuf));
  if (!commitMessage) {
    throw new Error("Cursor API returned an empty commit message.");
  }
  return commitMessage;
}

function copyToClipboard(text) {
  const input = Buffer.from(text, "utf8");
  if (process.platform === "win32") {
    return Bun.spawnSync(["clip"], { stdin: input }).exitCode === 0;
  }
  if (process.platform === "darwin") {
    return Bun.spawnSync(["pbcopy"], { stdin: input }).exitCode === 0;
  }
  for (const cmd of [
    ["wl-copy"],
    ["xclip", "-selection", "clipboard"],
    ["xsel", "--clipboard", "--input"],
  ]) {
    try {
      if (Bun.spawnSync(cmd, { stdin: input }).exitCode === 0) return true;
    } catch {}
  }
  return false;
}

function printHelp() {
  console.log(`cursor-commit - Generate Git commit messages using Cursor's native AI without opening Cursor

Usage:
  bun cursor-commit.js [options]

Options:
  -c, --commit       Generate message from staged changes and run \`git commit -m "<msg>"\`
  -y, --copy         Generate message and copy it to the system clipboard
  -a, --all          Fallback to unstaged changes if no changes are staged
  --hook <file>      Prepend generated message to a commit message file (for prepare-commit-msg hook)
  -h, --help         Show this help message`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const includeUnstaged = args.includes("--all") || args.includes("-a");
  const commitMsg = await generateCommitMessage(includeUnstaged);

  const hookIdx = args.indexOf("--hook");
  if (hookIdx !== -1 && args[hookIdx + 1]) {
    const msgFile = args[hookIdx + 1];
    const existing = fs.existsSync(msgFile) ? fs.readFileSync(msgFile, "utf8") : "";
    fs.writeFileSync(msgFile, `${commitMsg}\n${existing}`, "utf8");
    return;
  }

  if (args.includes("--copy") || args.includes("-y")) {
    const copied = copyToClipboard(commitMsg);
    console.log(commitMsg);
    if (copied) {
      console.error("\n[Copied commit message to clipboard]");
    }
    return;
  }

  if (args.includes("--commit") || args.includes("-c")) {
    console.log(`Commit message:\n${commitMsg}\n`);
    const proc = Bun.spawnSync(["git", "commit", "-m", commitMsg], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exit(proc.exitCode ?? 0);
  }

  console.log(commitMsg);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
