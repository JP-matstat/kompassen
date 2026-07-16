"""One-command git sync for the kompassen repo.

Usage: python gits.py

Commits all local changes (with an auto-generated message), pulls from
origin/main with rebase, and pushes. Never leaves the repo half-merged:
on a rebase conflict it aborts, keeps your commit safe, and tells you
how to resolve manually.
"""

import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent
BRANCH = "main"
REMOTE = "origin"

# Local design experiments that must never be committed (per AGENTS.md).
EXCLUDED_FILES = {"index2.html", "styles2.css", "cv/index2.html"}

# Files that require bumping the ?v= cache-busting parameter in index.html.
CACHE_BUSTED_FILES = {"styles.css", "app.js", "i18n.js"}

NOISE_SNIPPETS = ("LF will be replaced by CRLF", "in the working copy of")


def run(*args, check=False):
    """Run a git command, return (exit_code, stdout, stderr)."""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        proc = subprocess.run(
            ["git", *args],
            cwd=REPO_DIR,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
    except FileNotFoundError:
        fail("git is not installed or not on PATH.")
    if check and proc.returncode != 0:
        fail(f"git {' '.join(args)} failed:\n{proc.stderr.strip()}")
    return proc.returncode, proc.stdout.strip(), proc.stderr.strip()


def fail(message):
    print(f"\nERROR: {message}")
    sys.exit(1)


def echo_git_output(stdout, stderr):
    """Print git's output, minus line-ending warning noise."""
    for stream in (stdout, stderr):
        for line in stream.splitlines():
            if not any(snippet in line for snippet in NOISE_SNIPPETS):
                print(f"  {line}")


def guard_checks():
    code, toplevel, _ = run("rev-parse", "--show-toplevel")
    if code != 0 or Path(toplevel).resolve() != REPO_DIR:
        fail(f"This script must run from inside the repo at {REPO_DIR}.")

    _, branch, _ = run("branch", "--show-current")
    if branch != BRANCH:
        fail(f"You are on branch '{branch or '(detached HEAD)'}', not '{BRANCH}'. "
             f"Switch back with: git checkout {BRANCH}")

    _, git_dir, _ = run("rev-parse", "--git-dir")
    git_dir = REPO_DIR / git_dir
    for marker, state in (("rebase-merge", "rebase"), ("rebase-apply", "rebase"),
                          ("MERGE_HEAD", "merge")):
        if (git_dir / marker).exists():
            fail(f"A {state} is already in progress. Finish it "
                 f"(git {state} --continue) or abort it (git {state} --abort), "
                 f"then rerun gits.py.")


def stage_changes():
    """Stage everything, minus exclusions. Return list of staged files."""
    run("add", "-A", check=True)

    # Unstage experiment files if they somehow got added.
    _, staged, _ = run("diff", "--cached", "--name-only")
    staged_files = staged.splitlines()
    for f in staged_files:
        if f in EXCLUDED_FILES:
            run("restore", "--staged", "--", f)
            print(f"  Skipped (local experiment, never committed): {f}")

    # predictions/ files must never be hand-edited: new files (from the
    # pipeline) are fine, but modifications to existing ones are suspect.
    _, status, _ = run("diff", "--cached", "--name-status")
    for line in status.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0].startswith("M") and parts[1].startswith("predictions/"):
            run("restore", "--staged", "--", parts[1])
            run("checkout", "--", parts[1])
            print(f"  WARNING: {parts[1]} was locally modified. predictions/ "
                  f"files must never be hand-edited; the change was discarded.")

    _, staged, _ = run("diff", "--cached", "--name-only")
    return staged.splitlines()


def commit(staged_files):
    names = [Path(f).name for f in staged_files[:3]]
    extra = len(staged_files) - len(names)
    summary = ", ".join(names) + (f" (+{extra} more)" if extra > 0 else "")
    message = f"Update {datetime.now():%Y-%m-%d %H:%M}: {summary}"
    run("commit", "-m", message, check=True)
    print(f"  Committed: {message}")

    touched = CACHE_BUSTED_FILES & set(staged_files)
    if touched:
        print(f"  REMINDER: you changed {', '.join(sorted(touched))} — make sure "
              f"the ?v= cache-busting parameter in index.html was bumped.")


def pull():
    code, out, err = run("pull", "--rebase", REMOTE, BRANCH)
    if code == 0:
        echo_git_output(out, err)
        return

    _, conflicts, _ = run("diff", "--name-only", "--diff-filter=U")
    run("rebase", "--abort")
    if conflicts:
        fail(
            "Merge conflict — the pull was aborted and your repo is back in a "
            "clean state (your commit is safe).\n"
            f"Conflicting files:\n  " + "\n  ".join(conflicts.splitlines()) + "\n"
            "To resolve:\n"
            f"  1. git pull --rebase {REMOTE} {BRANCH}\n"
            "  2. Edit the conflicting files (look for <<<<<<< markers)\n"
            "  3. git add <the fixed files>\n"
            "  4. git rebase --continue\n"
            "  5. python gits.py   (to push)"
        )
    fail(f"Pull failed (network/auth problem?):\n{err}\n"
         f"Your commit is safe locally. Rerun gits.py once the problem is fixed.")


def push(allow_retry=True):
    code, out, err = run("push", REMOTE, BRANCH)
    if code == 0:
        echo_git_output(out, err)
        return
    if allow_retry and ("rejected" in err or "fetch first" in err):
        print("  Push rejected (remote has new commits). Pulling again and retrying...")
        pull()
        push(allow_retry=False)
        return
    fail(f"Push failed:\n{err}\n"
         f"Your commit is safe locally. Rerun gits.py once the problem is fixed.")


def main():
    guard_checks()

    print("[1/4] Staging changes...")
    staged_files = stage_changes()

    print("[2/4] Committing...")
    if staged_files:
        commit(staged_files)
    else:
        print("  Nothing to commit.")

    print(f"[3/4] Pulling from {REMOTE}/{BRANCH}...")
    pull()

    print(f"[4/4] Pushing to {REMOTE}/{BRANCH}...")
    push()

    print("\nDone. Everything is synced.")


if __name__ == "__main__":
    main()
