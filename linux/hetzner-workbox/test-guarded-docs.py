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
SHELL_TAGS = {"", "sh", "bash", "shell", "console"}
SIMPLE = "documented examples must stay in the simple shell subset"
OUTSIDE = "move this example into the provisioning docs or bring it into the simple shell subset"
PLAIN = re.compile(r"[A-Za-z0-9_./:@%+,=~-]")
VAR = re.compile(r"\$(?:([A-Za-z_][A-Za-z_0-9]*)|\{([A-Za-z_][A-Za-z_0-9]*)\})")
IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z_0-9]*")
PATH = re.compile(r"[A-Za-z0-9_.~/+-]+")
LITERAL_PINS = {LOCAL, SOURCE_MACHINE, DESTINATION}
CONNECTORS = {"&&", "||", "|"}
RESERVED = {
    "!", ".", "case", "coproc", "do", "done", "elif",
    "else", "esac", "fi", "for", "function", "if", "select", "then", "time", "until", "while",
}
# Simple commands may invoke external programs. Shell builtins that run code
# or write shell variables have no generic form here: the only supported
# writers are assignment prefixes, read, unset, and export, checked below.
SHELL_WRAPPERS = {"ash", "bash", "dash", "env", "fish", "ksh", "sh", "sudo", "zsh"}
SHELL_EFFECTS = {
    "alias", "bind", "builtin", "command", "declare", "enable", "eval", "exec",
    "getopts", "let", "local", "mapfile", "readarray", "readonly", "set", "source",
    "trap", "typeset",
}


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
    """Yield the language, literal body, and closure of each Markdown fence."""
    fence, tag, lines, start, depth = "", "", [], 0, 0
    for number, line in enumerate(source.splitlines(), 1):
        nested = 0
        while (not fence or nested < depth) and (prefix := QUOTE_PREFIX.match(line)):
            nested += 1
            line = line[prefix.end():]
        if fence and nested < depth:
            yield start, tag, lines, False
            fence = ""
        marker = FENCE.match(line)
        if not fence:
            if marker:
                fence, lines, start, depth = marker[1], [], number + 1, nested
                tag = (marker[2].strip().split() or [""])[0].lower()
        elif marker and marker[1].startswith(fence) and not marker[2].strip():
            yield start, tag, lines, True
            fence = ""
        else:
            lines.append(line)
    if fence:
        yield start, tag, lines, False


@dataclass(frozen=True)
class Word:
    raw: str
    value: str
    line: int
    refs: tuple


@dataclass(frozen=True)
class Invocation:
    assignments: list[Word]
    name: str | None
    args: list[Word]
    inline: list[Word]
    missing_sudo_env: bool = False


def logical_lines(lines, start):
    """Remove backslash-newlines before recognizing any word or operator.

    Preserve physical line positions for diagnostics and preceding notes.
    Backslash-newlines in a single-quoted literal or a comment stay literal.
    """
    text = "\n".join(lines)
    chars, positions = [], []
    quote, comment, boundary, line = "", False, True, start
    at = 0
    while at < len(text):
        c = text[at]
        if c == "\\" and quote != "'" and not comment:
            if text[at + 1:at + 2] != "\n":
                raise ValueError("unsupported shell escape (only backslash-newline is allowed)")
            line += 1
            at += 2
            continue
        chars.append(c)
        positions.append(line)
        if c == "\n":
            line += 1
        if comment:
            comment = c != "\n"
            boundary = not comment
        elif quote:
            if c == quote:
                quote = ""
        elif c in "'\"":
            quote, boundary = c, False
        elif c == "#" and boundary:
            comment = True
        else:
            boundary = c in " \t\n;&|()<>"
        at += 1
    return "".join(chars), positions


def shell_tokens(lines, start, comments):
    """Lex the closed subset. Single quotes are literal; double quotes allow
    named scalar references. The only escape is a backslash-newline outside
    single quotes. In particular, there are no redirections or substitutions.
    """
    text, positions = logical_lines(lines, start)
    refs = []
    raw, value, quote, first = "", "", "", start
    only_space = True
    i = 0
    while i < len(text):
        c = text[i]
        after = text[i + 1:i + 2]
        line = positions[i]
        if not raw:
            first = line
        if quote != "'" and c == "`":
            raise ValueError("backtick command substitution is not allowed")
        if quote != "'" and c == "$":
            if after == "(":
                detail = "arithmetic expansion" if text[i + 2:i + 3] == "(" else "command substitution"
                raise ValueError(f"{detail} is not allowed")
            if not quote and after in {"'", '"'}:
                detail = "ANSI-C quoting" if after == "'" else "locale quoting"
                raise ValueError(f"{detail} is not allowed")
            match = VAR.match(text, i)
            if quote != '"' or not match:
                raise ValueError("unsupported variable expansion (use a named variable in double quotes)")
            raw += match[0]
            value += match[0]
            refs.append((match[1] or match[2], match[0]))
            i = match.end()
            continue
        if quote:
            raw += c
            if c == quote:
                quote = ""
            else:
                value += c
        elif c in "'\"":
            raw += c
            quote = c
            only_space = False
        elif c == "#" and not raw:
            end = text.find("\n", i)
            if end < 0:
                end = len(text)
            if only_space:
                comments[line] = text[i:end]
            i = end
            continue
        elif c in " \t\n;&|":
            if raw:
                yield Word(raw, value, first, tuple(refs))
                raw, value, refs = "", "", []
            if c not in " \t":
                op = c + after if c in "&|" and after == c else c
                if op == "&":
                    raise ValueError("background operator '&' is not allowed")
                yield op
                i += len(op) - 1
                only_space = c == "\n"
        elif c == "#" or PLAIN.fullmatch(c):
            raw += c
            value += c
            only_space = False
        else:
            if c in "<>" and after == "(":
                detail = "process substitution"
            elif c == "<" and after == "<":
                detail = "here-document or here-string"
            elif c in "<>":
                detail = "redirection"
            elif c in "{}":
                detail = "brace expansion or grouping"
            elif c in "()":
                detail = "subshell, function or grouping"
            elif c in "*?[":
                detail = "pathname expansion or test syntax"
            else:
                detail = f"shell character {c!r}"
            raise ValueError(f"{detail} is not allowed")
        i += 1
    if quote:
        raise ValueError("unclosed shell quote")
    if raw:
        yield Word(raw, value, first, tuple(refs))


def shell_commands(tokens):
    """Parse simple commands separated by newline, ';', '&&', '||', or '|'.

    Binary separators require a command on both sides; linebreaks may follow
    them. Newlines and a trailing semicolon terminate complete commands.
    """
    commands, words, pending = [], [], None
    for token in tokens:
        if isinstance(token, Word):
            words.append(token)
            pending = None
        elif token == "\n" and not words:
            continue
        elif words:
            commands.append(words)
            words, pending = [], token if token in CONNECTORS else None
        else:
            raise ValueError(f"separator {token!r} needs a preceding command")
    if pending:
        raise ValueError(f"separator {pending!r} needs a following command")
    if words:
        commands.append(words)
    return commands


def command_name(word):
    """Allow only a static name or path, with an optional quoted directory
    variable at the front. Its final path component is always visible.
    """
    if word.refs:
        ref = word.refs[0][1]
        if len(word.refs) != 1 or not word.value.startswith(ref + "/"):
            raise ValueError("dynamic command names and paths are not allowed")
        path = word.value[len(ref):]
    else:
        path = word.value
    if not PATH.fullmatch(path) or not PurePosixPath(path).name:
        raise ValueError("expected a literal command name or path")
    return PurePosixPath(path).name


def assignments(words):
    end = next((i for i, word in enumerate(words) if not ASSIGNMENT.fullmatch(word.raw)), len(words))
    return words[:end], words[end:]


def invocation(words):
    """Locate the actual executable after shell, env and sudo env prefixes."""
    prefix, rest = assignments(words)
    if not rest:
        return Invocation(prefix, None, [], [])
    privileged = command_name(rest[0]) == "sudo"
    has_env = False
    if privileged:
        rest = rest[1:]
        if rest and not rest[0].refs and rest[0].value == "-n":
            rest = rest[1:]
    if rest and not rest[0].refs and PurePosixPath(rest[0].value).name == "env":
        has_env = True
        env_prefix, rest = assignments(rest[1:])
        prefix = [*prefix, *env_prefix]
    if not rest:
        if has_env and not privileged:
            return Invocation(prefix, None, [], [])
        raise ValueError("missing command after sudo")
    name = command_name(rest[0])
    if name.startswith("-"):
        raise ValueError("unsupported launcher options")
    if name in {"bash", "sh"}:
        rest = rest[1:]
        if not rest or rest[0].value.startswith("-"):
            raise ValueError("shell launchers need a script path (not a shell string)")
        name = command_name(rest[0])
    if name in RESERVED or name in SHELL_EFFECTS or name in SHELL_WRAPPERS:
        raise ValueError(f"shell construct or launcher {name!r} is not allowed here")
    args = rest[1:]
    if name == "export" and any(
        not (ASSIGNMENT.fullmatch(arg.raw) or IDENTIFIER.fullmatch(arg.raw)) for arg in args
    ):
        raise ValueError("export needs literal variable names or assignments")
    if name in {"read", "unset"}:
        fields = args[1:] if name == "read" and args and re.fullmatch(r"-[rs]+", args[0].raw) else args
        if not fields or any(not IDENTIFIER.fullmatch(arg.raw) for arg in fields):
            raise ValueError(f"{name} needs literal variable names")
    if name == "printf" and args and args[0].value == "-v":
        raise ValueError("printf variable assignment is not allowed")
    # sudo's inherited shell prefix does not reliably cross privilege.
    inline = env_prefix if privileged and has_env else ([] if privileged else prefix)
    return Invocation(prefix, name, args, inline, privileged and not has_env)


def pin_value(word):
    """Return the literal placeholder, if the RHS is exactly one of them."""
    assignment = ASSIGNMENT.fullmatch(word.raw)
    if assignment:
        value = assignment[2]
        if value[1:-1] in LITERAL_PINS and value[0] in "'\"" and value[-1] == value[0]:
            return value[1:-1]
    return None


def handoff(prefix, pins):
    assigned = {ASSIGNMENT.fullmatch(word.raw)[1]: pin_value(word) for word in prefix}
    roles = {0: (), 1: (LOCAL,), 2: (SOURCE_MACHINE, DESTINATION)}
    if len(pins) not in roles:
        return ["define a distinct deployment-record placeholder for each pin role"]
    return [
        f"assign {pin}='{placeholder}' directly once (no variable or substitution)"
        for pin, placeholder in zip(pins, roles[len(pins)])
        if assigned.get(pin) != placeholder
    ]


def violations(path, content, commands, strict):
    all_pins = {pin for pins, _ in commands.values() for pin in pins}
    registered = all_pins | commands.keys()
    for start, tag, lines, closed in blocks(content):
        if strict:
            if tag not in SHELL_TAGS:
                continue
        else:
            # This is only the repository-wide tripwire outside the strict
            # path set, not a condition on parsing any strict shell fence.
            raw = "\n".join(lines)
            if not any(name in raw for name in registered):
                continue
        outside = "" if strict else f"; {OUTSIDE}"
        comments = {}
        try:
            if not closed:
                raise ValueError("unclosed fenced block")
            shell = shell_commands(shell_tokens(lines, start, comments))
            parsed = [invocation(words) for words in shell]
        except ValueError as error:
            yield f"{path}:{start}: {error}; {SIMPLE}; {REMEDY}{outside}"
            continue
        seen, used = set(), set()
        for words, call in zip(shell, parsed):
            name, args = call.name, call.args
            where = f"{path}:{words[0].line}: {name or 'pin assignment'}"
            for word in words:
                used.update(ref for ref, _ in word.refs if ref in all_pins)
            for word in [*call.assignments, *(args if name == "export" else [])]:
                field = word.value.split("=", 1)[0].removesuffix("+")
                if field not in all_pins:
                    continue
                if pin_value(word) is None:
                    yield f"{where}: assign {field} a deployment-record placeholder directly, not via a variable; {REMEDY}{outside}"
                if field in seen:
                    yield f"{where}: duplicate assignment to {field}; {REMEDY}{outside}"
                seen.add(field)
            if name in {"read", "unset"} and any(arg.value in all_pins for arg in args):
                yield f"{where}: cannot write a pin with {name}; {REMEDY}{outside}"
            if name not in commands:
                # Neither wrapper operands nor quoted shell snippets can stand
                # in for a direct invocation in provisioning examples.
                if any(PurePosixPath(arg.value).name in commands for arg in args):
                    yield f"{where}: use the guarded command directly; {REMEDY}{outside}"
                continue
            pins, requires = commands[name]
            if any(arg.value.partition("=")[1] and arg.value.split("=", 1)[0] in all_pins for arg in args):
                yield f"{where}: put pin assignments in the environment prefix; {REMEDY}{outside}"
            first = args[0] if args else None
            note = comments.get(words[0].line - 1, "")
            if (first is None or not first.refs) and not requires(first.value if first else ""):
                if not note.startswith("# No pin needed: "):
                    yield f"{where}: mark the read-only example as no pin needed{outside}"
                continue
            if call.missing_sudo_env:
                yield f"{where}: pass the pin through sudo env; {REMEDY}{outside}"
            yield from (f"{where}: {problem}; {REMEDY}{outside}" for problem in handoff(call.inline, pins))
            if not SOURCE.search(note) or content.count(WARNING) != 1:
                yield f"{where}: name the deployment record beside the command and link the document's single Host identity warning{outside}"
        for pin in sorted(used - seen):
            yield f"{path}:{start}: {pin} was not assigned in this block; {REMEDY}{outside}"


def entries(paths):
    for path in paths:
        if path.suffix != ".sh" and not (
            str(path).startswith(("workbox/bin/", "linux/hetzner-workbox/")) and not path.suffix
        ):
            continue
        source = (ROOT / path).read_text()
        if source.startswith("#!") and (entry := contract(path, source)):
            yield path.name, entry


def strict_path(path):
    return path == Path("README.md") or path.is_relative_to("workbox") or path.is_relative_to("linux/hetzner-workbox")


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
        "pipe": (False, f"cat /etc/machine-id | read -r WORKBOX_EXPECT_MACHINE_ID\n{good}"),
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
        "blockquote": (False, f"sudo env {read_id} {backup}"),
        "env-reset": (False, f"sudo env {local} env -i {backup}"),
        "dynamic-mode": (False, 'layout.sh "$MODE"'),
        "valid-root": (True, f"{local} ./backup.sh list"),
        "valid-env": (True, f"env {local} ./backup.sh list"),
        "valid-continuation": (True, f"sudo -n env {local} \\\n   bash {backup}"),
        "valid-quoted-operators": (True, f"sudo env {local} HB_TO='x;&&y|z' {backup}"),
        "valid-compound": (True, f"printf '%s' ok | cat; false || true &\\\n&\n{note}\n{good};"),
        "valid-concat-target": (True, f"sudo env {local} ./b'ac'k\"up\".sh list"),
        "concat-target-needs-pin": (False, "./b'ac'k\"up\".sh list"),
        "continued-target-needs-pin": (False, "./ba\\\nckup.sh list"),
        "pin-only-literal": (True, local),
        "pin-only-raw": (False, "WORKBOX_EXPECT_MACHINE_ID=from-target"),
        "pin-only-peer": (False, 'HB_TARGET_MACHINE_ID="$PEER"'),
        "pin-only-export": (False, "export WORKBOX_EXPECT_MACHINE_ID=unrecorded"),
        "pin-only-env": (False, "env HB_TARGET_MACHINE_ID=unrecorded printf '%s' text"),
        "pin-only-indirect": (False, "A=other\nB=\"$A\"\nWORKBOX_EXPECT_MACHINE_ID=\"$B\""),
        "pin-only-dynamic-read": (False, 'read -r "$NAME"'),
        "pin-read-unassigned": (False, 'echo "$WORKBOX_EXPE\\\nCT_MACHINE_ID"'),
    }
    read_only = ["./layout.sh --dry-run", "./storage.sh check", "./bootstrap.sh --check",
                 "workbox-rift-storage --check", "install-node --check"]
    cases.update({f"no-pin-{i}": (True, command) for i, command in enumerate(read_only)})
    rejected = {
        "ansi": (r"echo $'a\x75'", "ANSI-C quoting"),
        "locale": ('echo $"hi"', "locale quoting"),
        "brace": ("echo a{b,c}", "brace expansion"),
        "arithmetic-only": ('echo "$((1 + 2))"', "arithmetic expansion"),
        "arithmetic-command": ("let 'WORKBOX_EXPECT_MACHINE_ID=4'", "let"),
        "process": ("cat <(echo ok)", "process substitution"),
        "here-document": ("cat <<END\nhello\nEND", "here-document"),
        "here-string": ("cat <<<hello", "here-string"),
        "backticks": ('echo "`pwd`"', "backtick command substitution"),
        "substitution": ('echo "$(pwd)"', "command substitution"),
        "parameter": ('echo "${VALUE:-default}"', "unsupported variable expansion"),
        "eval": ("eval 'echo hi'", "eval"),
        "shell-string": ("bash -c 'echo hi'", "script path"),
        "wrapper-eval": ("builtin eval 'echo hi'", "builtin"),
        "escape": (r"echo a\q", "shell escape"),
        "redir": ("cat <input", "redirection"),
        "glob": ("echo *.sh", "pathname expansion"),
        "dynamic-executable": ('"$COMMAND" foo', "dynamic command"),
        "background": ("echo text &", "background operator"),
        "group": ("(echo text)", "grouping"),
        "bad-list": ("true &&\n| false", "preceding command"),
        "unfinished": ("WORKBOX_EXPECT_MACHINE_ID='unclosed", "unclosed shell quote"),
    }
    cases.update({name: (False, command) for name, (command, _) in rejected.items()})

    # Exhaust the cross-product independently for both transfer roles. Each
    # choice describes whether its text is valid for that role, not what the
    # scanner returned. Verify each rejected file appears in the diagnostics.
    source = "<source-machine-id-from-deployment-record>"
    dest = "<destination-machine-id-from-deployment-record>"

    def choices(expected, swapped):
        return [(True, f"'{expected}'"), (True, f'"{expected}"'), (False, f"'{swapped}'"),
                (False, '"$EXTERNAL"'), (False, '"$(cat /etc/machine-id)"'),
                (False, "'11112222333344445555666677778888'"), (False, None)]

    productions = [
        (True, "", "", "sudo env", "./sync.sh"),
        (True, "printf '%s' ready | cat;\n", "", "env", "./'sync'.sh"),
        (True, "false ||\n", " && true", "", "./sy\\\nnc.sh"),
        (True, "true &&\n", "\n# end", "sudo -n env", '"${d}/sync.sh"'),
        (False, "echo $'hi';\n", "", "sudo env", "./sync.sh"),
        (False, "", " |", "sudo env", "./sync.sh"),
        (False, "echo \"$(pwd)\";\n", "", "env", "./sync.sh"),
    ]
    for i, ((grammar_ok, before, after, launch, target), (source_ok, a), (dest_ok, b)) in enumerate(
        product(productions, choices(source, dest), choices(dest, source))
    ):
        pin_args = " ".join(f"{name}={value}" for name, value in [
            ("WORKBOX_EXPECT_MACHINE_ID", a), ("HB_TARGET_MACHINE_ID", b),
        ] if value is not None)
        example = f"{before}{note}\n{launch} {pin_args} {target} --dry-run pass 2{after}"
        cases[f"property-{i:03}"] = (grammar_ok and source_ok and dest_ok, example)

    with TemporaryDirectory(prefix="guarded-docs-") as scratch:
        files = {True: [], False: []}
        for name, (expected, example) in cases.items():
            file = Path(scratch) / f"{name}.md"
            comment = no_pin if name.startswith("no-pin-") else note
            tag = "" if name == "unfinished" else "sh"
            source_note = [] if name in rejected or name.startswith("property-") else [comment]
            fence = [f"~~~{tag}", *source_note, *example.splitlines(), "~~~"]
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
        diagnostics = {}
        for line in bad.stderr.splitlines():
            file, _, message = line.partition(":")
            diagnostics.setdefault(file, []).append(message)
        for file in files[False]:
            messages = diagnostics.get(file, [])
            if not any(REMEDY in message for message in messages):
                raise AssertionError(f"{file} was not rejected with a correction: {messages}")
            expected = rejected.get(Path(file).stem)
            if expected and not any(expected[1] in message and SIMPLE in message for message in messages):
                raise AssertionError(f"{file} did not name the unsupported grammar: {messages}")
        census_control(Path(scratch) / "census")


def census_control(scratch):
    """New tracked paths and tag selection are observable at the CLI."""
    scanner = Path(__file__).relative_to(ROOT)
    guard = Path("linux/hetzner-workbox/backup.sh")
    plants = {
        "README.md": "~~~\necho $'hi'\n~~~\n",
        "workbox/new/operator.md": "~~~console\necho $'hi'\n~~~\n",
        "linux/hetzner-workbox/new/recovery.txt": "~~~shell\necho $'hi'\n~~~\n",
        "workbox/diagram.md": "~~~text\nbackup.sh <diagram>\n~~~\n",
        "workbox/new-entry.md": "~~~sh\n./workbox/bin/fresh-probe\n~~~\n",
        "skills/elsewhere/unrelated.md": "~~~bash\necho $'hi'\n~~~\n",
        "skills/elsewhere/mentioned.md": "~~~text\nbackup.sh <diagram>\n~~~\n",
        "skills/elsewhere/pin.md": "~~~text\nenv NOT_A_WORKBOX_EXPECT_MACHINE_ID=something <diagram>\n~~~\n",
    }
    scratch.mkdir()
    for path in [scanner, guard]:
        target = scratch / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / path).read_bytes())
    fresh = "workbox/bin/fresh-probe"
    (scratch / fresh).parent.mkdir(parents=True)
    (scratch / fresh).write_text("#!/bin/sh\nworkbox_require_host\n")
    for path, text in plants.items():
        target = scratch / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    subprocess.run(["git", "init", "-q"], cwd=scratch, check=True)
    subprocess.run(["git", "add", "--", str(scanner), str(guard), fresh, *plants], cwd=scratch, check=True)
    run = [sys.executable, str(scanner)]
    census = subprocess.run(run, cwd=scratch, capture_output=True, text=True)
    expected = {path for path in plants if path not in {"workbox/diagram.md", "skills/elsewhere/unrelated.md"}}
    diagnosed = {line.split(":", 1)[0] for line in census.stderr.splitlines()}
    if census.returncode != 1 or diagnosed != expected:
        raise AssertionError(f"wrong tracked document census: {census}")
    if any(OUTSIDE not in line for line in census.stderr.splitlines() if line.startswith("skills/")):
        raise AssertionError(f"outside census did not explain how to fix the fence: {census}")
    if "fresh-probe: assign WORKBOX_EXPECT_MACHINE_ID" not in census.stderr:
        raise AssertionError(f"new shell guard was not included automatically: {census}")
    explicit = subprocess.run([*run, "skills/elsewhere/unrelated.md"], cwd=scratch, capture_output=True, text=True)
    if explicit.returncode != 1 or "ANSI-C quoting" not in explicit.stderr:
        raise AssertionError(f"explicit files were not checked strictly: {explicit}")


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
    docs = [path for path in paths if path.suffix in DOC_SUFFIXES or (strict_path(path) and path.suffix == ".txt")]
    # Optional file arguments run freshly extracted historical examples against the same guards.
    explicit = bool(sys.argv[1:])
    if explicit:
        docs = [Path(path).resolve() for path in sys.argv[1:]]
    failures = [
        problem for path in docs
        for problem in violations(path, (ROOT / path).read_text(), commands, explicit or strict_path(path))
    ]
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("guarded docs OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
