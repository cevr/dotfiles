#!/usr/bin/env python3
"""Check the shell guard contract against Markdown examples, without running them."""
import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from itertools import product
from pathlib import Path, PurePosixPath
from tempfile import TemporaryDirectory
from typing import Callable

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
TRUST_BOUNDARY = (
    "These commands assume a machine you trust: the check behind this document constrains the commands as written here, "
    "not your shell's startup files, the programs those command names resolve to, this checkout, or the local and remote "
    "configuration of the tools they use (ssh, git, systemd, rsync)."
)
REMEDY = "take the pin from the deployment record; see [Host identity](#host-identity)"
SHELL_TAGS = {"", "sh", "bash", "shell", "console"}
LANGUAGE = "documented examples use the document command language"
TAG = "if this block is not shell, tag it (for example text)"
OUTSIDE = "move this example into the provisioning docs or bring it into the document command language"
PLAIN = re.compile(r"[A-Za-z0-9_./:@%+,=~-]")
VAR = re.compile(r"\$(?:([A-Za-z_][A-Za-z_0-9]*)|\{([A-Za-z_][A-Za-z_0-9]*)\})")
PATH = re.compile(r"[A-Za-z0-9_.~/+-]+")
LITERAL_PINS = {LOCAL, SOURCE_MACHINE, DESTINATION}
CONNECTORS = {"&&", "||", "|"}
DATA_NAMES = {
    "BACKUP_COPY": "data",
    "BACKUP_HOST_LABEL": "data",
    "HB_BACKUP_DIR": "data",
    "HB_BACKUP_MONTH": "data",
    "HB_BACKUP_NAME": "data",
    "HB_CHECK_SKIP": "data",
    "HB_EXTRA_KEYS": "data",
    "HB_RUNS_INCLUDE": "data",
    "HB_STORAGEBOX_HOST": "data",
    "HB_STORAGEBOX_USER": "data",
    "HB_TO": "data",
    "NEW": "data",
    "NEWTS": "data",
    "RESTORE_DIR": "data",
    "RESTORE_MONTH": "data",
    "STORAGEBOX_HOST": "data",
    "STORAGEBOX_USER": "data",
    "TS_AUTHKEY": "data",
    "d": "data",
}
CHECKOUT_PREFIX = "~/Developer/personal/dotfiles/"


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
class Statement:
    words: list[Word]
    assignments: list[Word]
    note: str
    guarded: tuple[str, str] | None = None


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
    if word.refs:
        raise ValueError("command words and script paths must be fully literal")
    name = PurePosixPath(word.value).name
    if not PATH.fullmatch(word.value) or not name or word.value.startswith("-"):
        raise ValueError("expected a literal command name or path")
    return name


def assignment_prefix(words):
    end = next((i for i, word in enumerate(words) if not ASSIGNMENT.fullmatch(word.raw)), len(words))
    return words[:end], words[end:]


@dataclass(frozen=True)
class Script:
    suffix: str
    words: list[Word]


@dataclass(frozen=True)
class Arguments:
    guarded: bool = False
    script: Script | None = None
    text: Word | None = None


@dataclass(frozen=True)
class Command:
    role: str
    arguments: Callable[[list[Word]], Arguments]


def literal(words, role="these arguments"):
    if any(word.refs for word in words):
        raise ValueError(f"{role} must be fully literal; references belong in value positions")
    return [word.value for word in words]


def starts(words, *values):
    return len(words) >= len(values) and all(
        not word.refs and word.value == value for word, value in zip(words, values)
    )


def guarded_arguments(words):
    literal(words, "guarded command modes, options and selectors")
    return Arguments(guarded=True)


def scalar_values(words):
    # Even a mixed literal/reference word beginning with '-' is not a value:
    # it reads as an option. Whole quoted variables occur only in designated
    # positional data slots, never in the generic literal argument grammar.
    if any(word.refs and word.value.startswith("-") for word in words):
        raise ValueError("option words must be fully literal")


def backup_arguments(words):
    # backup.sh takes the restore directory by position, not as a flag.
    if len(words) == 3 and starts(words, "restore"):
        literal(words[:2], "backup mode and subvolume selector")
        scalar_values(words[2:])
        return Arguments(guarded=True)
    return guarded_arguments(words)


def git_arguments(words):
    values = literal(words, "git clone arguments")
    if len(values) != 3 or values[0] != "clone" or any(v.startswith("-") for v in values[1:]):
        raise ValueError("git production is git clone REPOSITORY DIRECTORY")
    return Arguments()


def brew_arguments(words):
    values = literal(words, "brew arguments")
    if values != ["bundle"] and not (len(values) >= 2 and values[0] == "install" and
                                    all(not v.startswith("-") for v in values[1:])):
        raise ValueError("brew productions are bundle and install PACKAGE...")
    return Arguments()


def cd_arguments(words):
    if len(words) != 1 or words[0].refs or words[0].value != CHECKOUT_PREFIX.rstrip("/") or not words[0].raw.startswith("~/"):
        raise ValueError("cd production takes a literal documented checkout directory")
    return Arguments()


def mkdir_arguments(words):
    if not starts(words, "-p") or len(words) != 2 or literal(words[1:], "mkdir directory")[0].startswith("-"):
        raise ValueError("mkdir production is mkdir -p DIRECTORY")
    return Arguments()


def link_arguments(words):
    if not starts(words, "-sf", "--") or len(words) != 4:
        raise ValueError("ln production is ln -sf -- SOURCE DESTINATION with literal options")
    scalar_values(words[2:])
    return Arguments()


def no_arguments(words):
    if words:
        raise ValueError("this command takes no arguments in the document command language")
    return Arguments()


def claude_arguments(words):
    values = literal(words, "claude plugin arguments")
    if len(values) != 3 or values[0] != "plugin" or values[1] not in {"test", "validate"} or values[2].startswith("-"):
        raise ValueError("claude production is claude plugin validate|test DIRECTORY")
    return Arguments()


def python_arguments(words):
    return script_arguments("python", ".py", words)


def script_arguments(interpreter, suffix, words):
    if not words or words[0].value.startswith("-"):
        option = f" (got {words[0].value!r})" if words else ""
        raise ValueError(
            f"{interpreter} needs a literal tracked {suffix} script path; "
            f"interpreter options are not allowed in this production{option}"
        )
    literal(words[:1], f"{interpreter} script path")
    command_name(words[0])
    if not words[0].value.endswith(suffix):
        raise ValueError(f"{interpreter} needs a literal tracked {suffix} script path")
    return Arguments(script=Script(suffix, words))


def shell_arguments(interpreter, words):
    if starts(words, "-c"):
        if len(words) != 2:
            raise ValueError("shell -c takes one literal command string")
        literal(words[1:], "shell text")
        return Arguments(text=words[1])
    return script_arguments(interpreter, ".sh", words)


def ssh_arguments(words):
    # No generic SSH option grammar (e.g. options that take shell text).
    while starts(words, "-p") or starts(words, "-i"):
        if len(words) < 2 or not literal(words[1:2], "SSH option values")[0] or words[1].value.startswith("-"):
            raise ValueError("SSH -p/-i needs a literal value")
        words = words[2:]
    if len(words) != 2 or words[0].value.startswith("-"):
        raise ValueError("SSH production is ssh [-p PORT] [-i KEY] HOST LITERAL_COMMAND_STRING")
    literal(words, "SSH host and shell text")
    return Arguments(text=words[1])


COMMANDS = {
    "backup.sh": Command("guarded; restore destination data slot", backup_arguments),
    "bootstrap.sh": Command("guarded; literal arguments", guarded_arguments),
    "check.sh": Command("guarded; literal arguments", guarded_arguments),
    "layout.sh": Command("guarded; literal arguments", guarded_arguments),
    "provision.sh": Command("guarded; literal arguments", guarded_arguments),
    "sync.sh": Command("guarded; literal arguments", guarded_arguments),
    "bash": Command("tracked shell script path or runs shell text", lambda words: shell_arguments("bash", words)),
    "sh": Command("tracked shell script path or runs shell text", lambda words: shell_arguments("sh", words)),
    "ssh": Command("runs shell text", ssh_arguments),
    "git": Command("external; clone production", git_arguments),
    "brew": Command("external; bundle/install productions", brew_arguments),
    "cd": Command("directory change; one literal checkout directory", cd_arguments),
    "mkdir": Command("external; -p with one literal directory", mkdir_arguments),
    "ln": Command("external; -sf -- and two data slots", link_arguments),
    "workbox-check": Command("read-only external; no arguments", no_arguments),
    "true": Command("success probe; no arguments", no_arguments),
    "claude": Command("external; plugin validate/test productions", claude_arguments),
    "python": Command("tracked Python script path and literal operands", python_arguments),
}


@dataclass(frozen=True)
class Grammar:
    guards: dict
    roles: dict
    tracked: set[Path]

    def script_path(self, word):
        """The operand, not the document's path or cwd, selects one index entry."""
        if not word.raw.startswith(CHECKOUT_PREFIX) or not word.value.startswith(CHECKOUT_PREFIX):
            raise ValueError(f"write the checkout-prefixed path {CHECKOUT_PREFIX}<tracked path>, unquoted at the prefix")
        tail = word.value[len(CHECKOUT_PREFIX):]
        if any(part in {"", ".", ".."} for part in tail.split("/")):
            raise ValueError("write the checkout-prefixed path directly, without empty, '.' or '..' components")
        path = Path(tail)
        file = ROOT / path
        if path not in self.tracked or not file.is_file() or file.resolve() != file:
            raise ValueError(f"interpreter script path {word.value!r} is not a tracked repository file without symlinks")
        return path


def program(lines, start, grammar, inherited_note="", depth=0):
    """Parse the language, then return the flattened statements of one fence."""
    if depth > 64:
        raise ValueError("shell text is nested too deeply")
    comments = {}
    for words in shell_commands(shell_tokens(lines, start, comments)):
        note = comments.get(words[0].line - 1, inherited_note)
        prefix, rest = assignment_prefix(words)
        if not rest:                                      # standalone assignments
            yield Statement(words, prefix, note)
            continue
        sudo = starts(rest, "sudo")
        if sudo:                                          # literal sudo prefix
            rest = rest[1:]
            if starts(rest, "-n"):
                rest = rest[1:]
        env = starts(rest, "env")
        if env:                                           # literal env assignment prefix
            extra, rest = assignment_prefix(rest[1:])
            prefix = [*prefix, *extra]
            if not rest and extra:
                yield Statement(words, prefix, note)
                continue
        if not rest:
            raise ValueError("sudo/env prefix needs an allow-listed command or env assignments")
        if starts(rest, "export"):                         # only export NAME=value
            extra, trailing = assignment_prefix(rest[1:])
            if not extra or trailing or prefix or sudo or env:
                raise ValueError("export is only allowed as export NAME=value")
            yield Statement(words, extra, note)
            continue
        name, args = command_name(rest[0]), rest[1:]
        rule = COMMANDS.get(name)
        if not rule:
            raise ValueError(f"unknown command {name!r}: add it to the table with its role, or rewrite the example")
        if name not in grammar.guards and rest[0].value != name:
            raise ValueError(f"use the bare allow-listed command {name!r}, not an executable path")
        result = rule.arguments(args)
        if result.script:                                 # named tracked script production
            script, *args = result.script.words
            tracked = grammar.script_path(script)
            name = tracked.name
            if result.script.suffix == ".sh" and name in grammar.guards:
                rule = COMMANDS.get(name)
                if not rule:
                    raise ValueError(f"unknown guarded script {name!r}: add it to the table with its role, or rewrite the example")
                result = rule.arguments(args)
                if not result.guarded:
                    raise ValueError(f"{name!r} needs a guarded role in the table")
            else:
                literal(args, "script arguments")
        guard = None
        if result.guarded:
            if name not in grammar.guards:
                raise ValueError(f"guarded command {name!r} has no source contract")
            guard = (name, args[0].value if args else "")
        yield Statement(words, prefix, note, guard)
        if result.text is not None:                        # same grammar on literal shell text
            yield from program(result.text.value.split("\n"), result.text.line, grammar, note, depth + 1)


def pin_value(word):
    """Return the literal placeholder, if the RHS is exactly one of them."""
    assignment = ASSIGNMENT.fullmatch(word.raw)
    if assignment:
        value = assignment[2]
        if value[1:-1] in LITERAL_PINS and value[0] in "'\"" and value[-1] == value[0]:
            return value[1:-1]
    return None


def pin_problems(statements, guards, all_pins, content):
    """Count the named assignments of the whole fence, not execution or scope."""
    assigned, used = {}, set()
    for statement in statements:
        for word in statement.words:
            used.update(ref for ref, _ in word.refs if ref in all_pins)
        for word in statement.assignments:
            field = ASSIGNMENT.fullmatch(word.raw)[1]
            if field not in all_pins:
                continue
            value = pin_value(word)
            if value is None:
                yield word.line, f"assign {field} a deployment-record placeholder literally"
            if field in assigned:
                yield word.line, f"duplicate assignment to {field}"
            assigned[field] = value

    for statement in statements:
        if not statement.guarded:
            continue
        line = statement.words[0].line
        name, mode = statement.guarded
        pins, requires = guards[name]
        if not requires(mode):
            if not statement.note.startswith("# No pin needed: "):
                yield line, f"{name}: mark the read-only example as no pin needed"
            continue
        roles = {1: (LOCAL,), 2: (SOURCE_MACHINE, DESTINATION)}
        if len(pins) not in roles:
            yield line, f"{name}: define a deployment-record placeholder for each pin role"
        else:
            for pin, placeholder in zip(pins, roles[len(pins)]):
                if assigned.get(pin) != placeholder:
                    yield line, f"{name}: assign {pin}='{placeholder}' in this fence"
        if not SOURCE.search(statement.note) or content.count(WARNING) != 1:
            yield line, f"{name}: name the deployment record beside the command and link the document's single Host identity warning"
    for pin in sorted(used - assigned.keys()):
        yield statements[0].words[0].line, f"{pin} was not assigned in this fence"


def check_names(statements, roles):
    for statement in statements:
        for word in statement.assignments:
            name = ASSIGNMENT.fullmatch(word.raw)[1]
            if name not in roles:
                raise ValueError(
                    f"assignment to {name!r} is outside the interpreter environment restriction: "
                    "only pin and data names are assignable; add the name to the table with its role, "
                    "or rewrite the example"
                )


def violations(path, content, grammar, strict):
    fences = list(blocks(content))
    # The boundary is prose, not a string a fence can satisfy by printing.
    if strict_path(path):
        prose = any(
            line == TRUST_BOUNDARY and not any(start <= number < start + len(body) for start, _, body, _ in fences)
            for number, line in enumerate(content.splitlines(), 1)
        )
        if content.count(TRUST_BOUNDARY) != 1 or not prose:
            yield f"{path}:1: include this trust boundary verbatim once as a prose line: {TRUST_BOUNDARY}"
    all_pins = {name for name, role in grammar.roles.items() if role == "pin"}
    registered = all_pins | grammar.guards.keys()
    for start, tag, lines, closed in fences:
        raw = "\n".join(lines)
        if strict:
            if tag not in SHELL_TAGS:
                continue
        else:
            # This is only the repository-wide tripwire outside the strict
            # path set, not a condition on parsing any strict shell fence.
            if not any(name in raw for name in registered):
                continue
        outside = "" if strict else f"; {OUTSIDE}"
        try:
            if not closed:
                raise ValueError("unclosed fenced block")
            statements = list(program(lines, start, grammar))
            check_names(statements, grammar.roles)
        except ValueError as error:
            tag_fix = f"; {TAG}" if not tag else ""
            pin_fix = f"; {REMEDY}" if any(name in raw for name in registered) else ""
            yield f"{path}:{start}: {error}; {LANGUAGE}{tag_fix}{pin_fix}{outside}"
            continue
        for line, problem in pin_problems(statements, grammar.guards, all_pins, content):
            yield f"{path}:{line}: {problem}; {REMEDY}{outside}"


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
    if path.is_absolute() and path.is_relative_to(ROOT):
        path = path.relative_to(ROOT)
    return path == Path("README.md") or path.is_relative_to("workbox") or path.is_relative_to("linux/hetzner-workbox")


def controls(roles):
    """Exercise the public scanner on whole scratch Markdown files, never execute the examples."""
    # A tripwire on the positive table, never the implementation's acceptance rule.
    interpreter_env = re.compile(
        r"(BASH_ENV|ENV|PATH|IFS|PS4|PROMPT_COMMAND|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|"
        r"LD_.*|DYLD_.*|PYTHON.*|NODE_OPTIONS|BUN_.*|GIT_.*)"
    )
    hooks = [name for name in roles if interpreter_env.fullmatch(name)]
    if hooks:
        raise AssertionError(f"assignable-name table includes interpreter environment selectors: {hooks}")
    note = "# Pin source: recovery deployment record; see [Host identity](#host-identity)."
    no_pin = "# No pin needed: read-only."
    local = "WORKBOX_EXPECT_MACHINE_ID='<machine-id-from-deployment-record>'"
    backup = "linux/hetzner-workbox/backup.sh list"
    checkout = "~/Developer/personal/dotfiles/"
    call = f"sudo env {local} {backup}"
    read_id = 'WORKBOX_EXPECT_MACHINE_ID="$(cat /etc/machine-id)"'
    nested = f"sudo -n sh -c {shlex.quote(call)}"
    startup = (
        'BASH_ENV=./startup-fixture.sh bash -c '
        f'"{local} ./backup.sh list"'
    )
    cases = {
        "r4-missing": (False, f"sudo env {backup}"),
        "r4-inline": (False, f"sudo env {read_id} {backup}"),
        "r4-inline-override": (False, f'sudo env WORKBOX_EXPECT_MACHINE_ID="$RESTORE_MACHINE_ID" \\\n  {read_id} {backup}'),
        "r4-inline-flow": (False, f'RESTORE_MACHINE_ID="$(cat /etc/machine-id)"; sudo env WORKBOX_EXPECT_MACHINE_ID="$RESTORE_MACHINE_ID" {backup}'),
        "r5-ansi-quote": (False, f"sudo env {read_id} " + r"$'./back\x75p.sh' list"),
        "r5-env": (False, "env WORKBOX_EXPECT_MACHINE_ID='22222222222222222222222222222222' \\\n  bash ./backup.sh list"),
        "r5-env-tracked": (False, f"env WORKBOX_EXPECT_MACHINE_ID='22222222222222222222222222222222' \\\n  bash {checkout}{backup}"),
        "r5-export": (False, f'''export RESTORE_PIN='22222222222222222222222222222222'
{note}
sudo env WORKBOX_EXPECT_MACHINE_ID="$RESTORE_PIN" ./backup.sh list'''),
        "r5-prior-fence": (False, f'''RECOVERY_PIN='22222222222222222222222222222222'
~~~
Run the preflight:
~~~bash
{note}
sudo env WORKBOX_EXPECT_MACHINE_ID="${{RECOVERY_PIN}}" ./backup.sh list'''),
        "r5-unfinished": (False, 'sudo env WORKBOX_EXPECT_MACHINE_ID="$RECOVERY_PIN" ./backup.sh list "'),
        "r6-printf": (False, "OPTION=-v\nprintf \"$OPTION\" WORKBOX_EXPECT_MACHINE_ID '%s' unrecorded"),
        "r6-diagram": (False, "start --> done"),
        "r6-here-string": (False, "read -r DATA <<< 'ordinary text'"),
        "r6-parameter": (False, 'echo "${VALUE:=ordinary text}"'),
        "r7-startup": (False, startup),
        "unknown-assignment": (False, "EXAMPLE_UNKNOWN=value"),
        "unknown-env": (False, "env EXAMPLE_UNKNOWN=value true"),
        "nested-export-env": (False, "sh -c 'export ENV=./startup-fixture.sh; true'"),
        "path-sudo-env": (False, "sudo env PATH=/unknown true"),
        "relative-script": (False, f"bash {backup}"),
        "untracked-script": (False, f"bash {checkout}untracked-script.sh"),
        "same-basename-outside": (False, "bash /different/checkout/backup.sh list"),
        "old-root-prefix": (False, f"sh /root/dotfiles/{backup}"),
        "parent-escape": (False, f"bash {checkout}../dotfiles/{backup}"),
        "off-checkout-cwd": (False, "cd /tmp; bash linux/hetzner-workbox/backup.sh list"),
        "quoted-home-script": (False, "bash '~/Developer/personal/dotfiles/linux/hetzner-workbox/backup.sh' list"),
        "bash-rcfile": (False, "bash --rcfile linux/hetzner-workbox/backup.sh -c 'true'"),
        "bash-init-file": (False, "bash --init-file linux/hetzner-workbox/backup.sh -c 'true'"),
        "bash-login": (False, "bash -l linux/hetzner-workbox/backup.sh"),
        "bash-interactive": (False, "bash -i linux/hetzner-workbox/backup.sh"),
        "bash-shell-option": (False, "bash -O extglob -c 'true'"),
        "sh-stdin": (False, "sh -s < input.sh"),
        "sh-pipe-stdin": (False, "true | sh -s"),
        "python-inline": (False, "python -c 'print(1)'"),
        "python-module": (False, "python -m code"),
        "python-untracked": (False, "python ./not-tracked.py"),
        "fake-interpreter": (False, "/other/bash -c 'true'"),
        "duplicate-literal": (False, f"sudo env {local} {local} {backup}"),
        "env-splitting": (False, f"sudo env {local} HB_TO=$EXTRA {backup}"),
        "env-quoted-many": (False, f'sudo env {local} HB_TO="$@" {backup}'),
        "pipe": (False, f"true | read -r WORKBOX_EXPECT_MACHINE_ID\n{call}"),
        "read": (False, "read -r WORKBOX_EXPECT_MACHINE_ID"),
        "source": (False, "source ./pin.env"),
        "dot-source": (False, ". ./pin.env"),
        "bare-export": (False, "export WORKBOX_EXPECT_MACHINE_ID"),
        "unset": (False, "unset WORKBOX_EXPECT_MACHINE_ID"),
        "indirect": (False, f'A="$B"\nB="$C"\nsudo env WORKBOX_EXPECT_MACHINE_ID="$A" {backup}'),
        "undefined": (False, f'sudo env WORKBOX_EXPECT_MACHINE_ID="$UNDEFINED" {backup}'),
        "legacy-substitution": (False, f'sudo env WORKBOX_EXPECT_MACHINE_ID="`cat /etc/machine-id`" {backup}'),
        "arithmetic": (False, f'sudo env WORKBOX_EXPECT_MACHINE_ID="$((1+2))" {backup}'),
        "continued-override": (False, f"sudo env {local} \\\n    {read_id} {backup}"),
        "broken-operator": (False, f"{call} |"),
        "not-an-assignment": (False, f"sudo env {backup} {local}"),
        "blockquote": (False, f"sudo env {read_id} {backup}"),
        "env-reset": (False, f"sudo env {local} env -i {backup}"),
        "dynamic-mode": (False, 'layout.sh "$MODE"'),
        "dynamic-option": (False, 'ln "$OPTION" -- "$SOURCE" "$DESTINATION"'),
        "partial-option": (False, 'ln -sf -- "-$OPT" "$DESTINATION"'),
        "dynamic-tail": (False, 'ln -sf -- "$SOURCE" "-$OPTION"'),
        "literal-text": (True, nested),
        "text-from-reference": (False, 'bash -c "$TEXT"'),
        "ssh-text-from-reference": (False, 'ssh host "$COMMAND"'),
        "text-unknown": (False, "sh -c 'eval true'"),
        "invalid-text-pin": (False, f"ssh -p 2222 host {shlex.quote('WORKBOX_EXPECT_MACHINE_ID=unrecorded')}"),
        "ssh-multiple-words": (False, "ssh host sudo true"),
        "text-missing-pin": (False, f"bash -c {shlex.quote(backup)}"),
        "text-duplicate-pin": (False, f"export {local};\n{note}\n{nested}"),
        "text-parent-pin": (True, f"sudo env {local} bash -c {shlex.quote(backup)}"),
        "text-child-pin": (True, f"sh -c {shlex.quote(local)};\n{note}\n{backup}"),
        "text-multilevel": (True, f"ssh host {shlex.quote(nested)}"),
        "valid-root": (True, f"{local} {backup}"),
        "valid-env": (True, f"env {local} {backup}"),
        "valid-assignment-value": (True, f'sudo env {local} HB_BACKUP_DIR="$BACKUP_COPY" {backup}'),
        "valid-restore-value": (True, f'{local} ./backup.sh restore runs "$RESTORE_DIR"'),
        "valid-export": (True, f"export {local}\n{note}\n{backup}"),
        "valid-continuation": (True, f"sudo -n env {local} \\\n   bash {checkout}{backup}"),
        "valid-checkout-prefix": (True, f"sudo -n env {local} sh {checkout}{backup}"),
        "valid-python-script": (True, f"python {checkout}skills/ios-simulator-skill/scripts/app_launcher.py --launch com.example"),
        "valid-quoted-operators": (True, f"sudo env {local} HB_TO='x;&&y|z' {backup}"),
        "valid-compound": (True, f"true | true; true || true &\\\n&\n{note}\n{call};"),
        "valid-concat-target": (True, f"sudo env {local} ./b'ac'k\"up\".sh list"),
        "concat-target-needs-pin": (False, "./b'ac'k\"up\".sh list"),
        "continued-target-needs-pin": (False, "./ba\\\nckup.sh list"),
        "pin-only-literal": (True, local),
        "pin-only-raw": (False, "WORKBOX_EXPECT_MACHINE_ID=from-target"),
        "pin-only-peer": (False, 'HB_TARGET_MACHINE_ID="$PEER"'),
        "pin-only-export": (False, "export WORKBOX_EXPECT_MACHINE_ID=unrecorded"),
        "pin-only-env": (False, "env HB_TARGET_MACHINE_ID=unrecorded true"),
        "pin-only-indirect": (False, "A=other\nB=\"$A\"\nWORKBOX_EXPECT_MACHINE_ID=\"$B\""),
        "pin-read-unassigned": (False, 'BACKUP_COPY="$WORKBOX_EXPE\\\nCT_MACHINE_ID"'),
    }
    read_only = ["./layout.sh --dry-run", "./bootstrap.sh --check"]
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
        "shell-string": ("bash -c 'echo hi'", "unknown command 'echo'"),
        "wrapper-eval": ("builtin eval 'echo hi'", "builtin"),
        "escape": (r"echo a\q", "shell escape"),
        "redir": ("cat <input", "redirection"),
        "glob": ("echo *.sh", "pathname expansion"),
        "dynamic-executable": ('"$COMMAND" foo', "command words and script paths"),
        "dynamic-directory": ('"$d/sync.sh" --dry-run pass 2', "command words and script paths"),
        "background": ("echo text &", "background operator"),
        "group": ("(echo text)", "grouping"),
        "bad-list": ("true &&\n| false", "preceding command"),
        "unfinished": ("WORKBOX_EXPECT_MACHINE_ID='unclosed", "unclosed shell quote"),
    }
    cases.update({name: (False, command) for name, (command, _) in rejected.items()})
    diagnostics_expected = {name: detail for name, (_, detail) in rejected.items()}
    diagnostics_expected.update({
        "r6-printf": "unknown command 'printf': add it to the table with its role",
        "r6-diagram": TAG,
        "r6-here-string": "here-string",
        "r6-parameter": "unsupported variable expansion",
        "r5-ansi-quote": "command substitution",
        "dynamic-option": "literal option",
        "partial-option": "option words must be fully literal",
        "text-from-reference": "shell text must be fully literal",
        "text-unknown": "unknown command 'eval'",
        "r7-startup": "assignment to 'BASH_ENV' is outside the interpreter environment restriction",
        "unknown-assignment": "add the name to the table with its role",
        "unknown-env": "add the name to the table with its role",
        "nested-export-env": "assignment to 'ENV' is outside the interpreter environment restriction",
        "path-sudo-env": "assignment to 'PATH' is outside the interpreter environment restriction",
        "relative-script": "write the checkout-prefixed path",
        "same-basename-outside": "write the checkout-prefixed path",
        "old-root-prefix": "write the checkout-prefixed path",
        "parent-escape": "without empty, '.' or '..' components",
        "quoted-home-script": "write the checkout-prefixed path",
        "untracked-script": "not a tracked repository file",
        "bash-rcfile": "interpreter options are not allowed",
        "sh-stdin": "redirection is not allowed",
        "sh-pipe-stdin": "interpreter options are not allowed",
        "python-inline": "interpreter options are not allowed",
    })

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
        (True, lambda pins: f"sudo env {pins} ./sync.sh --dry-run pass 2"),
        (True, lambda pins: f"true | true;\n{note}\nenv {pins} ./'sync'.sh pass 2"),
        (True, lambda pins: f"true ||\n{note}\n{pins} ./sy\\\nnc.sh --dry-run runs && true"),
        (True, lambda pins: "sudo -n bash -c " + shlex.quote(f"env {pins} ./sync.sh rest")),
        (True, lambda pins: "ssh host " + shlex.quote(f"{pins} ./sync.sh pass 2")),
        (True, lambda pins: f"export {pins}\n{note}\n./sync.sh pass 2"),
        (True, lambda pins: f'HB_TO="$NEWTS" sudo env {pins} bash {checkout}linux/hetzner-workbox/sync.sh rest'),
        (False, lambda pins: f"OPTION=-v; printf \"$OPTION\" PIN '%s' bad;\n{note}\nenv {pins} ./sync.sh rest"),
        (False, lambda pins: f"sudo env {pins} ./sync.sh rest |"),
        (False, lambda pins: "bash -c " + shlex.quote(f'{pins} "$d/sync.sh" rest')),
        (False, lambda pins: "ssh host " + shlex.quote(f"{pins} ./sync.sh rest; true >output")),
        (False, lambda pins: f"BASH_ENV=./startup-fixture.sh bash -c {shlex.quote(f'{pins} ./sync.sh rest')}"),
        (False, lambda pins: "sh -c " + shlex.quote(f"export EXAMPLE_UNKNOWN=value; env {pins} ./sync.sh rest")),
        (False, lambda pins: f"sudo env {pins} bash {checkout}untracked-script.sh"),
        (False, lambda pins: f"sudo env {pins} bash --rcfile ./startup-fixture.sh -c 'true'"),
        (False, lambda pins: f"sudo env {pins} bash linux/hetzner-workbox/sync.sh rest"),
        (False, lambda pins: f"sudo env {pins} bash {checkout}../dotfiles/linux/hetzner-workbox/sync.sh rest"),
    ]
    for i, ((grammar_ok, render), (source_ok, a), (dest_ok, b)) in enumerate(
        product(productions, choices(source, dest), choices(dest, source))
    ):
        pin_args = " ".join(f"{name}={value}" for name, value in [
            ("WORKBOX_EXPECT_MACHINE_ID", a), ("HB_TARGET_MACHINE_ID", b),
        ] if value is not None)
        cases[f"property-{i:03}"] = (grammar_ok and source_ok and dest_ok, render(pin_args))

    with TemporaryDirectory(prefix="guarded-docs-") as scratch:
        files = {True: [], False: []}
        for name, (expected, example) in cases.items():
            file = Path(scratch) / f"{name}.md"
            comment = no_pin if name.startswith("no-pin-") else note
            tag = "" if name in {"unfinished", "r6-diagram"} else "bash" if name.startswith(("r5-", "r6-printf")) else "sh"
            source_note = [] if name in rejected or name in {"r6-diagram", "r6-printf", "r5-ansi-quote",
                                                            "r5-unfinished", "r5-export", "r5-prior-fence"} else [comment]
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
            if not any(REMEDY in message or LANGUAGE in message for message in messages):
                raise AssertionError(f"{file} was not rejected with a correction: {messages}")
            expected = diagnostics_expected.get(Path(file).stem)
            if expected and not any(expected in message and LANGUAGE in message for message in messages):
                raise AssertionError(f"{file} did not name the unsupported language: {messages}")
            if Path(file).stem == "r5-env-tracked" and not any(
                "assign WORKBOX_EXPECT_MACHINE_ID a deployment-record placeholder literally" in message
                for message in messages
            ):
                raise AssertionError(f"{file} did not check the pin with a tracked script operand: {messages}")
        census_control(Path(scratch) / "census")


def census_control(scratch):
    """New tracked paths and tag selection are observable at the CLI."""
    scanner = Path(__file__).relative_to(ROOT)
    guard = Path("linux/hetzner-workbox/backup.sh")
    plants = {
        "README.md": "~~~\necho $'hi'\n~~~\n",
        "workbox/new/operator.md": "~~~console\necho $'hi'\n~~~\n",
        "linux/hetzner-workbox/new/recovery.txt": "~~~shell\necho $'hi'\n~~~\n",
        "workbox/diagram.md": "~~~text\nstart --> done\n~~~\n",
        "workbox/untagged-diagram.md": "~~~\nstart --> done\n~~~\n",
        "workbox/new-entry.md": "~~~sh\n./workbox/bin/fresh-probe\n~~~\n",
        "workbox/relative.md": "```sh\nbash ./tracked-probe.sh\n```\n",
        "linux/hetzner-workbox/checkout-ok.md": f"~~~sh\n# No pin needed: read-only.\nsh {CHECKOUT_PREFIX}linux/hetzner-workbox/layout.sh --dry-run\n~~~\n",
        "linux/hetzner-workbox/untracked.md": f"~~~sh\nbash {CHECKOUT_PREFIX}linux/hetzner-workbox/untracked.sh\n~~~\n",
        "linux/hetzner-workbox/symlink.md": f"~~~sh\nbash {CHECKOUT_PREFIX}linux/hetzner-workbox/indexed-link.sh\n~~~\n",
        "linux/hetzner-workbox/working-link.md": f"~~~sh\nbash {CHECKOUT_PREFIX}linux/hetzner-workbox/working-link.sh\n~~~\n",
        "workbox/missing-boundary.md": "~~~sh\ntrue\n~~~\n",
        "workbox/changed-boundary.md": TRUST_BOUNDARY.replace("local and remote", "local") + "\n",
        "workbox/duplicate-boundary.md": f"{TRUST_BOUNDARY}\n\n{TRUST_BOUNDARY}\n",
        "workbox/fenced-boundary.md": f"~~~text\n{TRUST_BOUNDARY}\n~~~\n",
        "skills/elsewhere/unrelated.md": "~~~sh\nstart --> done\n~~~\n",
        "skills/elsewhere/new-guard.md": "~~~text\n./workbox/bin/fresh-probe\n~~~\n",
        "skills/elsewhere/mentioned.md": "~~~text\nbackup.sh <diagram>\n~~~\n",
        "skills/elsewhere/pin.md": "~~~text\nWORKBOX_EXPECT_MACHINE_ID --> destination\n~~~\n",
        "skills/elsewhere/pin-substring.md": "~~~text\nenv NOT_A_WORKBOX_EXPECT_MACHINE_ID=something <diagram>\n~~~\n",
    }
    scratch.mkdir()
    layout = Path("linux/hetzner-workbox/layout.sh")
    for path in [scanner, guard, layout]:
        target = scratch / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((ROOT / path).read_bytes())
    fresh = "workbox/bin/fresh-probe"
    (scratch / fresh).parent.mkdir(parents=True)
    (scratch / fresh).write_text("#!/bin/sh\nworkbox_require_host\n")
    decoy = "workbox/tracked-probe.sh"
    (scratch / decoy).write_text("#!/bin/sh\nprintf 'tracked decoy\\n'\n")
    (scratch / "tracked-probe.sh").write_text("#!/bin/sh\nprintf 'ran the untracked checkout-root file\\n'\n")
    untracked = "linux/hetzner-workbox/untracked.sh"
    link = "linux/hetzner-workbox/indexed-link.sh"
    working_link = "linux/hetzner-workbox/working-link.sh"
    outside = scratch.parent / "outside-checkout.sh"
    outside.write_text("#!/bin/sh\ntrue\n")
    (scratch / untracked).write_text("#!/bin/sh\ntrue\n")
    (scratch / link).symlink_to(outside)
    (scratch / working_link).write_text("#!/bin/sh\ntrue\n")
    for path, text in plants.items():
        target = scratch / path
        target.parent.mkdir(parents=True, exist_ok=True)
        if strict_path(Path(path)) and not path.endswith("-boundary.md"):
            text = f"{TRUST_BOUNDARY}\n\n{text}"
        target.write_text(text)
    subprocess.run(["git", "init", "-q"], cwd=scratch, check=True)
    subprocess.run(["git", "add", "--", str(scanner), str(guard), str(layout), fresh, link, working_link, decoy, *plants],
                   cwd=scratch, check=True)
    (scratch / working_link).unlink()
    (scratch / working_link).symlink_to(outside)
    run = [sys.executable, str(scanner)]
    census = subprocess.run(run, cwd=scratch, capture_output=True, text=True)
    expected = set(plants) - {"workbox/diagram.md", "skills/elsewhere/unrelated.md", "linux/hetzner-workbox/checkout-ok.md"}
    diagnosed = {line.split(":", 1)[0] for line in census.stderr.splitlines()}
    if census.returncode != 1 or diagnosed != expected:
        raise AssertionError(f"wrong tracked document census: {census}")
    if any(OUTSIDE not in line for line in census.stderr.splitlines() if line.startswith("skills/")):
        raise AssertionError(f"outside census did not explain how to fix the fence: {census}")
    if "unknown command 'fresh-probe': add it to the table with its role" not in census.stderr:
        raise AssertionError(f"new shell guard did not require a table entry: {census}")
    if not any("workbox/untagged-diagram.md:" in line and TAG in line for line in census.stderr.splitlines()):
        raise AssertionError(f"untagged diagram did not explain how to opt out: {census}")
    for case in ("untracked", "symlink", "working-link"):
        if not any(f"linux/hetzner-workbox/{case}.md:" in line and "not a tracked repository file" in line
                   for line in census.stderr.splitlines()):
            raise AssertionError(f"{case} was not rejected by the indexed-file check: {census}")
    if not any(line.startswith("workbox/relative.md:") and "write the checkout-prefixed path" in line
               for line in census.stderr.splitlines()):
        raise AssertionError(f"tracked decoy masked a relative operand: {census}")
    for case in ("missing", "changed", "duplicate", "fenced"):
        boundary = subprocess.run([*run, f"workbox/{case}-boundary.md"], cwd=scratch, capture_output=True, text=True)
        if boundary.returncode != 1 or f"include this trust boundary verbatim once as a prose line: {TRUST_BOUNDARY}" not in boundary.stderr:
            raise AssertionError(f"{case} trust boundary was not rejected: {boundary}")
    explicit = subprocess.run([*run, "skills/elsewhere/unrelated.md"], cwd=scratch, capture_output=True, text=True)
    if explicit.returncode != 1 or "redirection" not in explicit.stderr:
        raise AssertionError(f"explicit files were not checked strictly: {explicit}")


def main():
    raw = subprocess.check_output(["git", "ls-files", "--stage", "-z"], cwd=ROOT,
                                  env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"})
    index = [(metadata.split(), Path(os.fsdecode(file))) for part in raw.split(b"\0") if part
             for metadata, file in [part.split(b"\t", 1)]]
    paths = sorted({path for _, path in index})
    tracked = {path for (mode, _, stage), path in index if mode in {b"100644", b"100755"} and stage == b"0"}
    commands = dict(entries(sorted(tracked)))
    if not commands:
        raise ValueError("no guarded scripts found")
    roles = {**DATA_NAMES, **{pin: "pin" for pins, _ in commands.values() for pin in pins}}
    if sys.argv[1:] == ["--controls"]:
        controls(roles)
        print("guarded docs controls OK")
        return 0
    docs = [path for path in paths if path.suffix in DOC_SUFFIXES or (strict_path(path) and path.suffix == ".txt")]
    # Optional file arguments run freshly extracted historical examples against the same guards.
    explicit = bool(sys.argv[1:])
    if explicit:
        docs = [Path(path).resolve() for path in sys.argv[1:]]
    failures = [
        problem for path in docs
        for problem in violations(
            path, (ROOT / path).read_text(),
            Grammar(commands, roles, tracked),
            explicit or strict_path(path),
        )
    ]
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("guarded docs OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
