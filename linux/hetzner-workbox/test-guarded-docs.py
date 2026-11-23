#!/usr/bin/env python3
"""Check the shell guard contract against Markdown examples, without running them."""
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from itertools import product
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
DOC_SUFFIXES = {".md", ".mdx", ".rst", ".org", ".adoc", ".markdown"}
GUARD = r"(?:hb_require_host|workbox_require_host)"
ARG = r'"?\$\{1:-\}"?'
FENCE = re.compile(r"^\s*(`{3,}|~{3,})(.*)$")
QUOTE_PREFIX = re.compile(r"^[ \t]{0,3}>[ \t]?")
ASSIGNMENT = re.compile(r"([A-Za-z_][A-Za-z_0-9]*)=(.*)", re.S)
LOCAL = "<machine-id-from-deployment-record>"
SOURCE_MACHINE = "<source-machine-id-from-deployment-record>"
DESTINATION = "<destination-machine-id-from-deployment-record>"
SOURCE = re.compile(r"# Pin source: .*deployment record.*see \[Host identity\]\(#host-identity\)")
WARNING = "Reading the ID from whichever machine you are logged into defeats the check."
REMEDY = "take the pin from the deployment record; see [Host identity](#host-identity)"
# An unquoted expansion can split into extra arguments to env, including
# another NAME=value. Even inside quotes, "$@" can expand to multiple words.
ATOM = r"[A-Za-z0-9_./:@%+,=~-]+"
VAR = r"\$(?:[A-Za-z_][A-Za-z_0-9]*|\{[A-Za-z_][A-Za-z_0-9]*\})"
SCALAR = re.compile("|".join((ATOM, r"'[^']*'", rf'"(?:[^"$`\\]|{VAR})*"')))
TARGET = re.compile("|".join((r"[A-Za-z0-9_.~/+-]+", r"'[A-Za-z0-9_.~/+-]+'", rf'"(?:{VAR}/)?[A-Za-z0-9_./+-]+"')))


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
    fence, lines, start, depth = "", [], 0, 0
    for number, line in enumerate(source.splitlines(), 1):
        nested = 0
        while (not fence or nested < depth) and (prefix := QUOTE_PREFIX.match(line)):
            nested += 1
            line = line[prefix.end():]
        if fence and nested < depth:
            yield start, lines
            fence = ""
        marker = FENCE.match(line)
        if not fence:
            if marker:
                fence, lines, start, depth = marker[1], [], number + 1, nested
        elif marker and marker[1].startswith(fence) and not marker[2].strip():
            yield start, lines
            fence = ""
        else:
            lines.append(line)
    if fence:
        yield start, lines


@dataclass(frozen=True)
class Word:
    raw: str
    value: str
    line: int


def shell_commands(lines, start):
    """Lex a shell simple-command subset, retaining raw quoting for assignments."""
    text = "\n".join(lines)
    words, comments = [], {}
    raw, value, quote, line, first = "", "", "", start, start
    i = 0
    while i < len(text):
        c = text[i]
        after = text[i + 1:i + 2]
        if not raw:
            first = line
        if c == "\\" and quote != "'":
            if not after:
                raise ValueError("unfinished shell escape")
            if after == "\n":
                line += 1
            else:
                raw += c + after
                value += c + after if quote == '"' and after not in '$`"\\' else after
            i += 2
            continue
        if quote != "'" and (c == "`" or (c == "$" and after in {"(", "{"} and (
            after == "(" or not re.match(r"\{[A-Za-z_][A-Za-z_0-9]*\}", text[i + 1:])
        ))):
            raise ValueError("command, arithmetic or indirect expansion is not part of a guarded example")
        if quote:
            raw += c
            if c == quote:
                quote = ""
            else:
                value += c
        elif c in "'\"":
            raw += c
            quote = c
        elif c == "#" and not raw:
            end = text.find("\n", i)
            if end < 0:
                end = len(text)
            if not words:
                comments[line] = text[i:end]
            i = end
            continue
        elif c in " \t\n;&|()<>":
            if raw:
                words.append(Word(raw, value, first))
                raw, value = "", ""
            if c == "\n":
                if words:
                    yield words, comments
                    words, comments = [], {}
            elif c in ";&|()<>":
                raise ValueError(f"shell operator {c!r} is not part of a guarded example")
        else:
            raw += c
            value += c
        if c == "\n":
            line += 1
        i += 1
    if quote:
        raise ValueError("unclosed shell quote")
    if raw:
        words.append(Word(raw, value, first))
    if words:
        yield words, comments


def handoff(prefix, pins, all_pins):
    """Allow exactly one direct assignment per required pin, with no variable flow."""
    if prefix and prefix[0].raw == "sudo":
        prefix = prefix[1:]
        if prefix and prefix[0].raw == "-n":
            prefix = prefix[1:]
        if not prefix or prefix[0].raw != "env":
            return ["pass the pin through sudo env"]
    if prefix and prefix[0].raw == "env":
        prefix = prefix[1:]
    prefix = list(prefix)
    if prefix and prefix[-1].raw in {"bash", "sh"}:
        prefix.pop()
    assigned = {}
    all_names = set()
    for word in prefix:
        assignment = ASSIGNMENT.fullmatch(word.raw)
        if not assignment:
            return ["use only inline assignments and a direct invocation or sh/bash"]
        name, value = assignment.groups()
        if name in all_names:
            return [f"duplicate assignment to {name}"]
        all_names.add(name)
        if name in pins:
            assigned[name] = value
        elif name in all_pins:
            return [f"{name} is not used by this command"]
        elif not name.startswith("HB_"):
            return [f"unsupported environment assignment {name}"]
        elif not SCALAR.fullmatch(value):
            return [f"{name} must be a single shell value, not an argument expansion"]
    roles = {0: (), 1: (LOCAL,), 2: (SOURCE_MACHINE, DESTINATION)}
    if len(pins) not in roles:
        return ["define a distinct deployment-record placeholder for each pin role"]
    return [
        f"assign {pin}='{placeholder}' directly once (no variable or substitution)"
        for pin, placeholder in zip(pins, roles[len(pins)])
        if assigned.get(pin) not in {f"'{placeholder}'", f'"{placeholder}"'}
    ]


def violations(path, content, commands):
    names = re.compile(r"(?<![\w.-])(" + "|".join(map(re.escape, commands)) + r")(?![\w.-])")
    all_pins = {pin for pins, _ in commands.values() for pin in pins}
    for start, lines in blocks(content):
        # A malformed candidate must not disappear because tokenization failed.
        text = "\n".join(line for line in lines if not line.lstrip().startswith("#"))
        normalized = re.sub(r"""\\(.)|['"]""", lambda m: m[1] or "", text.replace("\\\n", ""))
        candidate = names.search(text) or names.search(normalized)
        marked = any(SOURCE.search(line.strip()) for line in lines)
        try:
            shell = list(shell_commands(lines, start))
        except ValueError as error:
            if candidate or marked:
                yield f"{path}:{start}: {candidate[1] if candidate else 'guarded example'}: {error}; {REMEDY}"
            continue
        invocations = [
            (words, comments, at, PurePosixPath(word.value).name)
            for words, comments in shell for at, word in enumerate(words)
            if PurePosixPath(word.value).name in commands
        ]
        if not invocations:
            if candidate or marked:
                yield f"{path}:{start}: use one direct guarded command per fence; {REMEDY}"
            continue
        words, comments, at, name = invocations[0]
        where = f"{path}:{words[0].line}: {name}"
        if len(shell) != 1 or len(invocations) != 1 or not TARGET.fullmatch(words[at].raw):
            yield f"{where}: use one direct guarded command per fence; {REMEDY}"
            continue
        note = comments.get(words[0].line - 1, "")
        pins, requires = commands[name]
        if any((match := ASSIGNMENT.fullmatch(word.raw)) and match[1] in all_pins for word in words[at + 1:]):
            yield f"{where}: pin assignment appears outside the environment prefix; {REMEDY}"
        first_arg = words[at + 1] if at + 1 < len(words) else None
        # Only an absent or literal mode can prove a no-pin invocation.
        literal_mode = first_arg is None or first_arg.raw in {
            first_arg.value, f"'{first_arg.value}'", f'"{first_arg.value}"',
        } and re.fullmatch(r"[\w-]+", first_arg.value)
        if literal_mode and not requires(first_arg.value if first_arg else ""):
            if not note.startswith("# No pin needed: "):
                yield f"{where}: mark the read-only example as no pin needed"
            yield from (f"{where}: {problem}; {REMEDY}" for problem in handoff(words[:at], (), all_pins))
            continue
        yield from (f"{where}: {problem}; {REMEDY}" for problem in handoff(words[:at], pins, all_pins))
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


def controls():
    """Exercise the public scanner on whole scratch Markdown files, never execute the examples."""
    note = "# Pin source: deployment record; see [Host identity](#host-identity)."
    no_pin = "# No pin needed: read-only."
    local = "WORKBOX_EXPECT_MACHINE_ID='<machine-id-from-deployment-record>'"
    backup = '"$d/backup.sh" list'
    good = f"sudo env {local} {backup}"
    read_id = 'WORKBOX_EXPECT_MACHINE_ID="$(cat /etc/machine-id)"'
    cases = {
        "missing": (False, f"sudo -n env {backup}"),
        "inline": (False, f"sudo env {read_id} {backup}"),
        "override": (False, f"sudo env {local} {read_id} {backup}"),
        "duplicate-literal": (False, f"sudo env {local} {local} {backup}"),
        "flow": (False, f'RESTORE_MACHINE_ID="$(cat /etc/machine-id)"; sudo env WORKBOX_EXPECT_MACHINE_ID="$RESTORE_MACHINE_ID" {backup}'),
        "export": (False, f"export {local}\n{good}"),
        "env": (False, f"env {read_id} {good}"),
        "env-splitting": (False, f"sudo env {local} HB_TO=$EXTRA {backup}"),
        "env-quoted-many": (False, f'sudo env {local} HB_TO="$@" {backup}'),
        "pipe": (False, f"cat /etc/machine-id | {good}"),
        "read": (False, f"read -r WORKBOX_EXPECT_MACHINE_ID </etc/machine-id\n{good}"),
        "source": (False, f"source ./pin.env && {good}"),
        "dot-source": (False, f". ./pin.env\n{good}"),
        "indirect": (False, f'A="$B"\nB="$C"\nsudo env WORKBOX_EXPECT_MACHINE_ID="$A" {backup}'),
        "undefined": (False, f'sudo env WORKBOX_EXPECT_MACHINE_ID="$UNDEFINED" {backup}'),
        "legacy-substitution": (False, f'sudo env WORKBOX_EXPECT_MACHINE_ID="`cat /etc/machine-id`" {backup}'),
        "arithmetic": (False, f'sudo env WORKBOX_EXPECT_MACHINE_ID="$((1+2))" {backup}'),
        "continued-override": (False, f"sudo env {local} \\\n    {read_id} {backup}"),
        "broken-quote": (False, f"{good} '"),
        "broken-operator": (False, f"{good} |"),
        "split-name-invalid": (False, f"{read_id} ./back\\\nup.sh list"),
        "pin-before-sudo": (False, f"{local} sudo env {backup}"),
        "pin-after-script": (False, f"{good} {local}"),
        "assignment-is-not-command": (False, f"sudo env {local} X=./backup.sh list"),
        "blockquote": (False, f"sudo env {read_id} {backup}"),
        "env-reset": (False, f"sudo env {local} env -i {backup}"),
        "dynamic-mode": (False, 'layout.sh "$MODE"'),
        "valid-root": (True, f"{local} ./backup.sh list"),
        "valid-env": (True, f"env {local} ./backup.sh list"),
        "valid-continuation": (True, f"sudo -n env {local} \\\n   bash {backup}"),
        "valid-quoted-operators": (True, f"sudo env {local} HB_TO='x;&&y|z' {backup}"),
    }
    read_only = ["./layout.sh --dry-run", "./storage.sh check", "./bootstrap.sh --check",
                 "workbox-rift-storage --check", "install-node --check"]
    cases.update({f"no-pin-{i}": (True, command) for i, command in enumerate(read_only)})

    # Exhaust the cross-product independently for both transfer roles. Each
    # choice describes whether its text is valid for that role, not what the
    # scanner returned. Verify each rejected file appears in the diagnostics.
    source = "<source-machine-id-from-deployment-record>"
    dest = "<destination-machine-id-from-deployment-record>"

    def choices(expected, swapped):
        return [(True, f"'{expected}'"), (True, f'"{expected}"'), (False, f"'{swapped}'"),
                (False, '"$EXTERNAL"'), (False, '"$(cat /etc/machine-id)"'),
                (False, "'11112222333344445555666677778888'"), (False, None)]

    for i, ((source_ok, a), (dest_ok, b)) in enumerate(product(choices(source, dest), choices(dest, source))):
        assignments = " ".join(f"{name}={value}" for name, value in [
            ("WORKBOX_EXPECT_MACHINE_ID", a), ("HB_TARGET_MACHINE_ID", b),
        ] if value is not None)
        cases[f"property-{i:02}"] = (source_ok and dest_ok, f"sudo env {assignments} ./sync.sh --dry-run pass 2")

    with TemporaryDirectory(prefix="guarded-docs-") as scratch:
        files = {True: [], False: []}
        for name, (expected, example) in cases.items():
            file = Path(scratch) / f"{name}.md"
            comment = no_pin if name.startswith("no-pin-") else note
            fence = ["~~~sh", comment, *example.splitlines(), "~~~"]
            if name == "blockquote":
                fence = [f"> {line}" for line in fence]
            file.write_text("\n".join(["## Host identity", WARNING, "", *fence, ""]))
            files[expected].append(str(file.resolve()))
        scanner = [sys.executable, str(Path(__file__).resolve())]
        good = subprocess.run([*scanner, *files[True]], capture_output=True, text=True)
        if good.returncode != 0 or good.stdout.strip() != "guarded docs OK" or good.stderr:
            raise AssertionError(f"valid examples failed: {good}")
        bad = subprocess.run([*scanner, *files[False]], capture_output=True, text=True)
        if bad.returncode != 1:
            raise AssertionError(f"invalid examples were not rejected: {bad}")
        for file in files[False]:
            if not any(line.startswith(f"{file}:") and REMEDY in line for line in bad.stderr.splitlines()):
                raise AssertionError(f"{file} was not rejected with a correction: {bad.stderr}")


def main():
    raw = subprocess.check_output(["git", "ls-files", "-z"], cwd=ROOT, env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    paths = sorted({Path(os.fsdecode(part)) for part in raw.split(b"\0") if part})
    commands = dict(entries(paths))
    if not commands:
        raise ValueError("no guarded scripts found")
    if sys.argv[1:] == ["--controls"]:
        controls()
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
