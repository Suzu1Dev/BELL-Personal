#!/usr/bin/env python3
"""BELL Personal data snapshots (offline or online), pruning, restore and content inventory (Python stdlib).

Trimmed copy of bell-explain's deployment/migrate-data.py: the lesson and
repository checks and the relocate command do not apply here."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat

AUTO_SNAPSHOT = re.compile(r"auto-(\d{8})-(\d{6})")
# Scratch directories of model runs (<data>/ai/run-*): created and removed by every AI call, no
# backup value, and one vanishing mid-copy would fail the whole snapshot.
SKIPPED_DIRECTORIES = {"ai"}
PRE_DEPLOY_SNAPSHOT = re.compile(r"pre-deploy-(\d{8})-(\d{6})")
PREFIX = re.compile(r"[a-z0-9][a-z0-9-]{0,31}")


def connect(path):
    return sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)


def inventory(directory):
    databases = {}
    for path in sorted(directory.glob("*.sqlite")):
        db = connect(path)
        try:
            check = db.execute("PRAGMA integrity_check").fetchall()
            if check != [("ok",)]:
                raise RuntimeError(f"Integrity check failed: {path.name}")
            tables = {}
            for (name, schema) in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"):
                quoted = '"' + name.replace('"', '""') + '"'
                cursor = db.execute(f"SELECT * FROM {quoted}")
                columns = [item[0] for item in cursor.description]
                rows = []
                for values in cursor:
                    row = dict(zip(columns, values))
                    rows.append(json.dumps(row, sort_keys=True, ensure_ascii=False,
                        default=lambda value: {"bytes": value.hex()}, separators=(",", ":")))
                digest = hashlib.sha256((schema + "\n" + "\n".join(sorted(rows))).encode()).hexdigest()
                tables[name] = {"rows": len(rows), "sha256": digest}
            databases[path.name] = tables
        finally:
            db.close()
    files = []
    for path in sorted(directory.rglob("*")):
        relative = path.relative_to(directory).as_posix()
        if path.parent == directory and any(path.name.endswith(suffix) for suffix in (".sqlite", ".sqlite-wal", ".sqlite-shm")):
            continue
        if relative.split("/")[0] in SKIPPED_DIRECTORIES or (path.parent == directory and path.name == "manifest.json"):
            continue
        if path.is_symlink():
            files.append([relative, "link", os.readlink(path)])
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    digest.update(chunk)
            files.append([relative, path.stat().st_size, digest.hexdigest()])
    return {"databases": databases, "files": {"count": len(files),
        "sha256": hashlib.sha256(json.dumps(files, separators=(",", ":")).encode()).hexdigest()}}


def copy_file(source, target, *, follow_symlinks=True):
    """shutil.copy2 that skips a file removed while the folder is copied (an undone delete leaving trash/)."""
    try:
        return shutil.copy2(source, target, follow_symlinks=follow_symlinks)
    except FileNotFoundError:
        return target


def copy_entry(path, target):
    """One non-database entry of the data directory."""
    if path.is_dir() and not path.is_symlink():
        shutil.copytree(path, target, symlinks=True, copy_function=copy_file)
    else:
        copy_file(path, target, follow_symlinks=False)


def snapshot(source, destination):
    """Offline snapshot (BELL Personal stopped): the same layout and manifest.json as an online one, so restore accepts it."""
    if destination.exists() or destination.is_relative_to(source):
        raise RuntimeError("Snapshot destination must be new and outside source data")
    destination.mkdir(parents=True, mode=0o700)
    for path in source.iterdir():
        if path.name.endswith((".sqlite-wal", ".sqlite-shm")) or (path.name in SKIPPED_DIRECTORIES and path.is_dir()):
            continue
        target = destination / path.name
        if path.name.endswith(".sqlite") and path.is_file():
            copy_database(path, target)
        else:
            copy_entry(path, target)
    expected, actual = inventory(source), inventory(destination)
    if expected != actual:
        raise RuntimeError("Snapshot differs from source; stop all writers and retry to a new directory")
    result = {"snapshot": str(destination), "inventory": actual}
    (destination / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def copy_database(path, target):
    """Consistent copy through the SQLite backup API while BELL keeps writing."""
    db = connect(path)
    output = sqlite3.connect(target)
    try:
        db.backup(output)
        # Rollback-journal mode: opening the copy read-only later leaves no -wal/-shm files.
        output.execute("PRAGMA journal_mode=DELETE")
        if output.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise RuntimeError(f"Integrity check failed for the copy of {path.name}")
    finally:
        output.close()
        db.close()
    target.chmod(0o600)


def make_writable(directory):
    for path in [directory, *directory.rglob("*")]:
        if not path.is_symlink():
            path.chmod(path.stat().st_mode | stat.S_IWUSR | (stat.S_IXUSR if path.is_dir() else 0))


def make_read_only(directory):
    for path in sorted(directory.rglob("*"), reverse=True):
        if path.is_symlink():
            continue
        path.chmod(0o500 if path.is_dir() else 0o400)
    directory.chmod(0o500)


def online_snapshot(source, into, prefix="auto"):
    """Snapshot without stopping BELL Personal. Databases are copied consistently
    one by one; other files (the trash folder) are copied as they are. Work
    happens in a .partial- folder that is renamed only once complete."""
    if not PREFIX.fullmatch(prefix):
        raise RuntimeError("Prefix must be 1-32 lowercase letters, digits or hyphens")
    into.mkdir(parents=True, exist_ok=True, mode=0o700)
    if into.resolve().is_relative_to(source):
        raise RuntimeError("Snapshot directory must be outside the data directory")
    name = datetime.now(timezone.utc).strftime(f"{prefix}-%Y%m%d-%H%M%S")
    destination, partial = into / name, into / f".partial-{name}"
    if destination.exists() or partial.exists():
        raise RuntimeError("A snapshot with this name already exists; retry in a second")
    partial.mkdir(mode=0o700)
    try:
        for path in sorted(source.iterdir()):
            if path.name.endswith((".sqlite-wal", ".sqlite-shm")) or (path.name in SKIPPED_DIRECTORIES and path.is_dir()):
                continue
            target = partial / path.name
            if path.name.endswith(".sqlite") and path.is_file():
                copy_database(path, target)
            else:
                copy_entry(path, target)
        result = {"snapshot": str(destination), "inventory": inventory(partial)}
        (partial / "manifest.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
        os.rename(partial, destination)
    except BaseException:
        make_writable(partial)
        shutil.rmtree(partial, ignore_errors=True)
        raise
    make_read_only(destination)
    return result


def restore(snapshot, target):
    """Copy a complete snapshot into a new data directory with writable modes."""
    if not (snapshot / "manifest.json").is_file():
        raise RuntimeError("Not a complete snapshot: manifest.json is missing")
    if target.exists():
        raise RuntimeError("Target data directory exists; stop BELL Personal and move it aside first")
    shutil.copytree(snapshot, target, symlinks=True, ignore=shutil.ignore_patterns("manifest.json"))
    for path in [target, *target.rglob("*")]:
        if not path.is_symlink():
            path.chmod(0o700 if path.is_dir() else 0o600)
    return {"restored": str(target), "inventory": inventory(target)}


def prune(into, keep_daily, keep_weekly, keep_pre_deploy_days=30):
    """Keep the newest complete automatic snapshot of each recent day and ISO week.
    pre-deploy- snapshots are kept for keep_pre_deploy_days (they hold cached
    mail, which /privacy promises to expire); other prefixes (manual) are never
    touched; incomplete automatic folders and day-old .partial- leftovers are
    removed."""
    removed = []
    now = datetime.now(timezone.utc).timestamp()
    for path in sorted(into.iterdir()):
        match = PRE_DEPLOY_SNAPSHOT.fullmatch(path.name)
        if not (match and path.is_dir()):
            continue
        taken = datetime.strptime(match.group(1) + match.group(2), "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc).timestamp()
        if now - taken > keep_pre_deploy_days * 86_400:
            make_writable(path)
            shutil.rmtree(path)
            removed.append(path.name)
    for path in into.iterdir():
        stale = path.name.startswith(".partial-") and now - path.stat().st_mtime > 86_400
        incomplete = AUTO_SNAPSHOT.fullmatch(path.name) and not (path / "manifest.json").is_file()
        if path.is_dir() and (stale or incomplete):
            make_writable(path)
            shutil.rmtree(path)
            removed.append(path.name)
    snapshots = sorted((path for path in into.iterdir() if path.is_dir() and AUTO_SNAPSHOT.fullmatch(path.name)), key=lambda path: path.name)
    keep = set(snapshots[-1:])
    for size, period in ((keep_daily, lambda day: day.strftime("%Y%m%d")), (keep_weekly, lambda day: "%d-%02d" % day.isocalendar()[:2])):
        latest = {}
        for path in snapshots:
            latest[period(datetime.strptime(AUTO_SNAPSHOT.fullmatch(path.name).group(1), "%Y%m%d"))] = path
        keep.update(latest[key] for key in sorted(latest, reverse=True)[:size])
    for path in snapshots:
        if path in keep:
            continue
        make_writable(path)
        shutil.rmtree(path)
        removed.append(path.name)
    return {"kept": sorted(path.name for path in keep), "removed": removed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("snapshot", "prune", "restore", "inventory"))
    parser.add_argument("directory", type=Path, help="data directory; the backups directory for prune; the snapshot for restore")
    parser.add_argument("destination", nargs="?", type=Path)
    parser.add_argument("--online", action="store_true", help="snapshot while BELL Personal runs into --into/auto-<UTC time>")
    parser.add_argument("--into", type=Path, help="parent directory for online snapshots")
    parser.add_argument("--prefix", default="auto", help="online snapshot name prefix; only auto- snapshots are pruned")
    parser.add_argument("--keep-daily", type=int, default=7)
    parser.add_argument("--keep-weekly", type=int, default=4)
    parser.add_argument("--keep-pre-deploy-days", type=int, default=30, help="pre-deploy- snapshots older than this are pruned")
    args = parser.parse_args()
    directory = args.directory.resolve()
    if not directory.is_dir():
        parser.error("Directory does not exist")
    if args.command == "snapshot" and args.online:
        if not args.into:
            parser.error("snapshot --online requires --into")
        result = online_snapshot(directory, args.into.resolve(), args.prefix)
    elif args.command == "restore":
        if not args.destination:
            parser.error("restore requires the new data directory")
        result = restore(directory, args.destination.resolve())
    elif args.command == "prune":
        result = prune(directory, args.keep_daily, args.keep_weekly, args.keep_pre_deploy_days)
    elif args.command == "snapshot":
        if not args.destination:
            parser.error("snapshot requires a destination; stop the application first, or use --online --into")
        result = snapshot(directory, args.destination.resolve())
    else:
        result = inventory(directory)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    os.umask(0o077)
    main()
