#!/usr/bin/env python3
"""Check the shell guard contract against Markdown examples, without running them."""
import os
import re
import subprocess
import sys
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
DOC_SUFFIXES = {".md", ".mdx", ".rst", ".org", ".adoc", ".markdown"}
GUARD = r"(?:hb_require_host|workbox_require_host)"
ARG = r'"?\$\{1:-\}"?'
FENCE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
WORDS = re.compile(r"""(?:[^ \t"';&|]+|"[^"]*"|'[^']*')+|&&|\|\||[;&|]""")
ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z_0-9]*=")
SEPARATORS = {"&&", "||", ";", "&", "|"}
SOURCE = re.compile(r"# Pin source: .*deployment record.*see \[Host identity\]\(#host-identity\)")
WARNING = "Reading the ID from whichever machine you are logged into defeats the check."


def contract(path, source):
    """Return pin names, and a predicate saying which first args require them."""
    lines = [re.sub(r"\s+#.*$", "", line).strip() for line in source.splitlines()]
    lines = [line for line in lines if line and not line.startswith("#")]
    calls = [i for i, line in enumerate(lines) if re.search(rf"(?:^|[|;&\s]){GUARD}(?:$|[;\s])", line)]
    if not calls:
        return None
    pins = ("WORKBOX_EXPECT_MACHINE_ID", *re.findall(
        r"^\s+\[\[ \$\{([A-Z_]+):-\} =~ \^\[a-f0-9\]\{32\}\$ \]\] \|\|", source, re.M,
    ))
    first = calls[0]
    if len(calls) > 1:
        # A person should not rely on the special --apply fleet enrollment.
        # The entry point's unqualified manual branch still calls the guard.
        if re.search(rf"^if \[ {ARG} = --apply \]; then$", source, re.M) and lines[calls[-1] - 1] == "else":
            return pins, lambda _: True
        raise ValueError(f"{path}: unrecognized multi-branch host guard")
    unless = re.fullmatch(rf"\[{{1,2}} {ARG} ={{1,2}} ([\w-]+) \]{{1,2}} \|\| {GUARD}", lines[first])
    if unless:
        return pins, lambda arg: arg != unless[1]
    if first >= 5 and lines[first - 5] == "case ${1:-} in":
        only = re.fullmatch(r"([\w|-]+)\)", lines[first - 4])
        if only:
            return pins, lambda arg: arg in only[1].split("|")
    if first >= 4 and lines[first - 4] == 'if [ "$#" -eq 0 ]; then':
        return pins, lambda arg: arg == ""
    if re.fullmatch(GUARD, lines[first]):
        return pins, lambda _: True
    raise ValueError(f"{path}: unrecognized host guard: {lines[first]}")


def blocks(source):
    """Enumerate CommonMark fences with original line numbers, including list indentation."""
    fence, lines, start = "", [], 0
    for number, line in enumerate(source.splitlines(), 1):
        marker = FENCE.match(line)
        if not fence:
            if marker:
                fence, lines, start = marker[1], [], number + 1
        elif marker and marker[1].startswith(fence) and not marker[2].strip():
            yield start, lines
            fence = ""
        else:
            lines.append(line)
    if fence:
        yield start, lines


def examples(lines, start, commands):
    """Find guarded and pin-free example invocations, keeping notes and quoted assignments."""
    command, note = "", ""
    for number, raw in enumerate(lines, start):
        line = raw.strip()
        if not line or line.startswith("#"):
            note = line
            continue
        if not command:
            first = number
        if line.endswith("\\"):
            command += line[:-1] + " "
            continue
        tokens, begin = WORDS.findall(command + line), 0
        for at, token in enumerate(tokens):
            if token.startswith("#"):
                break
            if token in SEPARATORS:
                begin = at + 1
                continue
            name = PurePosixPath(token.strip('"\'')).name
            if name in commands:
                arg = tokens[at + 1].strip('"\'') if at + 1 < len(tokens) else ""
                yield first, name, tokens[begin:at], "" if arg in SEPARATORS else arg, note
        command, note = "", ""


def handoff(prefix, pins):
    if "sudo" in prefix:
        prefix = prefix[prefix.index("sudo") + 1:]
        if prefix[:1] == ["-n"]:
            prefix = prefix[1:]
        if prefix[:1] != ["env"]:
            yield "pass the pin through sudo env"
        else:
            prefix = prefix[1:]
    end = next((i for i, word in enumerate(prefix) if not ASSIGNMENT.match(word)), len(prefix))
    launcher = prefix[end:]
    if launcher and (len(launcher) != 1 or PurePosixPath(launcher[0]).name not in {"sh", "bash"}):
        yield "use a direct invocation or sh/bash after the inline assignments"
    variables = set()
    for pin in pins:
        match = next((m for word in prefix[:end] if (m := re.fullmatch(rf'{pin}="\$([A-Z_][A-Z0-9_]*)"', word))), None)
        if not match:
            yield f"missing inline {pin} from the deployment record"
        elif match[1] in variables:
            yield "source and destination must have separate deployment record pins"
        else:
            variables.add(match[1])


def violations(path, content, commands):
    for start, lines in blocks(content):
        for number, name, prefix, arg, note in examples(lines, start, commands):
            where = f"{path}:{number}: {name}"
            pins, requires = commands[name]
            if not requires(arg):
                if not note.startswith("# No pin needed: "):
                    yield f"{where}: mark the read-only example as no pin needed"
                continue
            yield from (f"{where}: {problem}" for problem in handoff(prefix, pins))
            if not SOURCE.search(note) or content.count(WARNING) != 1:
                yield f"{where}: name the deployment record beside the command and link the document's single Host identity warning"


def entries(paths):
    for path in paths:
        if path.suffix != ".sh" and not (
            str(path).startswith(("workbox/bin/", "linux/hetzner-workbox/")) and not path.suffix
        ):
            continue
        source = (ROOT / path).read_text()
        if source.startswith("#!") and (entry := contract(path, source)):
            yield path.name, entry


def controls(commands):
    doc = f"## Host identity\n{WARNING}\n\n~~~sh\n# Pin source: deployment record; see [Host identity](#host-identity).\n"

    def check(line, note=doc):
        return "\n".join(violations("skills/new/SKILL.md", f"{note}{line}\n~~~\n", commands))

    assert "skills/new/SKILL.md:6: backup.sh: missing inline WORKBOX_EXPECT_MACHINE_ID" in check(
        'sudo -n env "$d/backup.sh" list',
    )
    assert "pass the pin through sudo env" in check('WORKBOX_EXPECT_MACHINE_ID="$PIN" sudo "$d/backup.sh" list')
    assert "missing inline HB_TARGET_MACHINE_ID" in check(
        'sudo env WORKBOX_EXPECT_MACHINE_ID="$SOURCE_ID" "$d/sync.sh" --dry-run pass 1',
    )
    assert not check('sudo -n env WORKBOX_EXPECT_MACHINE_ID="$RECORDED_ID" \\\n  bash "$d/backup.sh" list')
    assert "separate deployment record pins" in check(
        'sudo env WORKBOX_EXPECT_MACHINE_ID="$PIN" HB_TARGET_MACHINE_ID="$PIN" "$d/sync.sh" rest',
    )
    assert "after the inline assignments" in check('sudo env WORKBOX_EXPECT_MACHINE_ID="$PIN" env -i "$d/backup.sh" list')
    no_pin = "~~~sh\n# No pin needed: read-only.\n"
    for command in ["./layout.sh --dry-run", "./storage.sh check", "./bootstrap.sh --check",
                    "workbox-rift-storage --check", "install-node --check"]:
        assert not check(command, no_pin), command
    for command in ["workbox-rift-storage --fstab", "install-node", "./sync.sh --dry-run pass 2"]:
        assert "missing inline WORKBOX_EXPECT_MACHINE_ID" in check(command, no_pin), command


def main():
    raw = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    paths = sorted({Path(os.fsdecode(part)) for part in raw.split(b"\0") if part})
    commands = dict(entries(paths))
    if not commands:
        raise ValueError("no guarded scripts found")
    if sys.argv[1:] == ["--controls"]:
        controls(commands)
        print("guarded docs controls OK")
        return 0
    docs = [path for path in paths if path.suffix in DOC_SUFFIXES]
    # Optional file arguments run freshly extracted historical examples against the same guards.
    if sys.argv[1:]:
        docs = [Path(path).resolve() for path in sys.argv[1:]]
    failures = [problem for path in docs for problem in violations(path, (ROOT / path).read_text(), commands)]
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("guarded docs OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
