"""Compare the tracked scan and every control's exit/stdout/stderr with origin/main."""
import difflib
import io
import os
import subprocess
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import ModuleType
from unittest.mock import patch


RELATIVE = Path("linux/hetzner-workbox/test-guarded-docs.py")
ROOT = Path(__file__).resolve().parents[2]
ENCODING = sys.stdout.encoding


def load(name, file):
    module = ModuleType(name)
    module.__file__ = str(file)
    sys.modules[name] = module
    exec(compile(file.read_bytes(), str(file), "exec"), vars(module))
    return module


def invoke(module, args, root, cwd):
    out, err = io.BytesIO(), io.BytesIO()
    stdout = io.TextIOWrapper(out, encoding=ENCODING, write_through=True)
    stderr = io.TextIOWrapper(err, encoding=ENCODING, write_through=True)
    old_cwd = Path.cwd()
    try:
        os.chdir(cwd)
        with patch.object(module, "ROOT", root), patch.object(sys, "argv", [module.__file__, *args]):
            with redirect_stdout(stdout), redirect_stderr(stderr):
                code = module.main()
        return code, out.getvalue(), err.getvalue()
    finally:
        os.chdir(old_cwd)


def equal(label, before, after):
    if before[0] != after[0]:
        raise AssertionError(f"{label}: exit {before[0]} on main, {after[0]} in this checkout")
    for channel, old, new in zip(("stdout", "stderr"), before[1:], after[1:]):
        if old != new:
            diff = b"".join(difflib.diff_bytes(difflib.unified_diff, old.splitlines(True), new.splitlines(True)))
            raise AssertionError(f"{label}: {channel} differs byte for byte:\n{diff.decode(ENCODING)}")


def compare_in(temp, old, new):
    scans = 0
    original_scan = new.Scanner.scan
    original_run = subprocess.run

    def scan(scanner, args, cwd):
        nonlocal scans
        actual = original_scan(scanner, args, cwd)
        root = scanner.grammar.root
        equal(f"{temp}: {args[0] if args else 'tracked scan'}",
              invoke(old, args, root.resolve(), cwd),
              (actual.returncode, actual.stdout.encode(ENCODING), actual.stderr.encode(ENCODING)))
        scans += 1
        return actual

    def run(args, *rest, **kwargs):
        # The scratch census still uses the real CLI. Compare the bytes it
        # actually wrote, not merely the exception/diagnostic seen by controls.
        nonlocal scans
        if args[0] != sys.executable:
            return original_run(args, *rest, **kwargs)
        result = original_run(args, *rest, **{**kwargs, "text": False})
        cwd = kwargs["cwd"]
        equal(f"{temp}: scratch checkout census",
              invoke(old, args[2:], cwd.resolve(), cwd), (result.returncode, result.stdout, result.stderr))
        scans += 1
        return subprocess.CompletedProcess(args, result.returncode,
                                           result.stdout.decode(ENCODING), result.stderr.decode(ENCODING))

    with patch.dict(os.environ, {"TMPDIR": str(temp)}), patch.object(tempfile, "tempdir", None):
        if Path(tempfile.gettempdir()) != temp:
            raise AssertionError(f"TMPDIR spelling was not retained: {temp}")
        # Compare the complete tracked CLI, then the exact fixture invocations
        # with their files still on disk. Each side sees the same inputs and cwd.
        equal(f"{temp}: tracked CLI", invoke(old, [], ROOT, ROOT), invoke(new, [], ROOT, ROOT))
        with patch.object(new.Scanner, "scan", scan), patch.object(subprocess, "run", run):
            equal(f"{temp}: controls CLI", (0, b"guarded docs controls OK\n", b""),
                  invoke(new, ["--controls"], ROOT, ROOT))
        if scans != 15:
            raise AssertionError(f"{temp}: compared {scans} control invocations, expected 15")


def main():
    with tempfile.TemporaryDirectory(prefix="guarded-docs-parity-") as scratch:
        scratch = Path(scratch).resolve()
        main_scanner = scratch / RELATIVE
        main_scanner.parent.mkdir(parents=True)
        main_scanner.write_bytes(subprocess.check_output(["git", "show", f"origin/main:{RELATIVE}"], cwd=ROOT))
        old = load("main_guarded_docs", main_scanner)
        new = load("current_guarded_docs", ROOT / RELATIVE)
        canonical = scratch / "fixtures"
        canonical.mkdir()
        if canonical.is_relative_to("/private/var"):
            alias = Path("/") / canonical.relative_to("/private")
        else:
            alias = scratch / "alias"
            alias.symlink_to(canonical, target_is_directory=True)
        if alias == canonical or alias.resolve() != canonical:
            raise AssertionError(f"expected different spellings for the same scratch path: {alias}, {canonical}")
        for temp in (canonical, alias):
            compare_in(temp, old, new)
        print("guarded docs byte parity OK (tracked scan and 15 control invocations across both TMPDIR spellings)")


if __name__ == "__main__":
    main()
