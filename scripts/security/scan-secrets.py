"""Scan locally; never upload raw matches, credentials or source excerpts."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main():
    runner_temp = Path(os.environ["RUNNER_TEMP"])
    scanner = runner_temp / "lw-security-bin/gitleaks"
    with tempfile.TemporaryDirectory(prefix="lw-secret-scan-", dir=runner_temp) as temp:
        private = Path(temp)
        config = private / "scanner.toml"
        config.write_text("[extend]\nuseDefault = true\n", encoding="utf-8")
        ignore = private / ".gitleaksignore"
        ignore.write_text("", encoding="utf-8")
        base = [str(scanner), "--config", str(config), "--gitleaks-ignore-path", str(ignore),
                "--ignore-gitleaks-allow", "--redact=100", "--no-banner", "--no-color",
                "--exit-code", "2", "--max-decode-depth", "2", "--max-archive-depth", "2", "--timeout", "300"]
        commits = subprocess.check_output(["git", "rev-list", "--all", "--count"], text=True).strip()
        refs = subprocess.check_output(["git", "for-each-ref", "--format=%(refname)"], text=True).splitlines()
        print(json.dumps({"event": "security_scan_scope", "commits": int(commits), "refs": len(refs)}), flush=True)
        messages = private / "messages"
        messages.mkdir()
        (messages / "commit-messages.txt").write_bytes(subprocess.check_output(["git", "log", "--all", "--format=%B"]))
        modes = [("git-history", ["git", "--log-opts=--all --full-history -m", "."]),
                 ("current-tree", ["dir", "."]), ("commit-messages", ["dir", str(messages)])]
        if len(sys.argv) == 2:
            modes.append(("public-history", ["dir", sys.argv[1]]))
        total = 0
        errors = 0
        for name, command in modes:
            report = private / (name + ".json")
            result = subprocess.run(base + ["--report-format", "json", "--report-path", str(report)] + command,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=330)
            if result.returncode not in (0, 2) or not report.exists():
                errors += 1
                print(json.dumps({"event": "security_scan_error", "scope": name, "exit": result.returncode}), flush=True)
                continue
            findings = json.loads(report.read_text())
            if not isinstance(findings, list):
                raise ValueError("Unexpected scanner report")
            total += len(findings)
            print(json.dumps({"event": "security_scan_result", "scope": name, "findings": len(findings)}), flush=True)
            for item in findings[:100]:
                # No Secret, Match, author, message, email or source contents.
                print(json.dumps({"event": "security_finding_location", "scope": name,
                                  "rule": item.get("RuleID"), "file": item.get("File"),
                                  "line": item.get("StartLine"), "commit": item.get("Commit")}), flush=True)
        return 1 if errors or total else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, subprocess.SubprocessError, KeyError):
        print('{"event":"security_scan_failed_safely"}', flush=True)
        sys.exit(1)
