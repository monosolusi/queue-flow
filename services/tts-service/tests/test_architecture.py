"""Static architecture gate -- this service's equivalent of core-api's dep-cruiser.

NFR-MNT-01 and DoD-1 require *static analysis* to prove the Domain layer is
dependency-free. core-api gets that from `npm run arch:check`, which "must stay
clean". Without something equivalent here, this service would ship four Clean
Architecture layers and a DIP seam that nothing enforces: adding `import requests`
to `app/domain/announcement.py`, or an infrastructure import to an interface
adapter, would pass every other gate silently.

An `ast` walk rather than `import-linter` on purpose: it adds no dependency (the
same reasoning that kept Identity on `node:crypto`), it needs no import to succeed
so it runs on a machine with neither Piper nor ffmpeg, and it runs inside the
pytest step `scripts/run-verify.mjs` already invokes.

The rings, outermost first, are the ones CLAUDE.md declares:

    Infrastructure -> Interface Adapters -> Application -> Domain

Imports may point inward or sideways within a ring, never outward.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parent.parent / "app"

#: Inner to outer. A layer may import itself and anything to its left.
RINGS = ("domain", "application", "interface_adapters", "infrastructure")

#: Stdlib modules that compute but never touch the outside world. An allowlist,
#: not a blocklist of `os`/`socket`/...: a blocklist silently permits every module
#: nobody thought of, which is exactly how an IO import lands in a pure layer.
PURE_STDLIB = frozenset(
    {
        "__future__",
        "abc",
        "collections",
        "dataclasses",
        "decimal",
        "enum",
        "fractions",
        "functools",
        "itertools",
        "math",
        "operator",
        "re",
        "string",
        "types",
        "typing",
        "unicodedata",
    }
)

#: The application layer additionally may hash (cache keys are its policy) and log.
#: Still no IO, no HTTP, no filesystem -- those arrive through `domain/ports.py`.
APPLICATION_STDLIB = PURE_STDLIB | {"hashlib", "logging"}

#: What each pure layer is allowed to import from the standard library.
PURE_LAYERS = {"domain": PURE_STDLIB, "application": APPLICATION_STDLIB}

#: Libraries that already have a port, so only `infrastructure` may name them.
#: The allowlists above stop these reaching domain/application; this stops an
#: interface adapter shelling out to ffmpeg or importing Piper directly, which is
#: the same leak with the infrastructure module skipped. A denylist rather than an
#: allowlist here because adapters legitimately need FastAPI and much of stdlib.
PORTED_LIBRARIES = frozenset({"onnxruntime", "piper", "subprocess", "urllib"})

#: `main.py` is the composition root: wiring concrete infrastructure into ports is
#: the one place that is *supposed* to see every layer. Same exemption core-api's
#: dep-cruiser grants its Nest modules.
COMPOSITION_ROOT = "app.main"


def _module_name(path: Path) -> str:
    parts = path.relative_to(APP.parent).with_suffix("").parts
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def _layer_of(module: str) -> str | None:
    parts = module.split(".")
    return parts[1] if len(parts) > 1 and parts[1] in RINGS else None


def _resolve(module: str, is_package: bool, node: ast.ImportFrom) -> str:
    """Turn a possibly-relative `from ... import x` into an absolute module name.

    Level 1 anchors on the module's own package, each further dot walks one package
    up -- so from `app.application.x`, `..infrastructure` is `app.infrastructure`.
    A package's `__init__` is its own anchor, which is why `is_package` is passed in
    rather than guessed from the name.
    """
    if not node.level:
        return node.module or ""
    parts = module.split(".")
    package = parts if is_package else parts[:-1]
    anchor = package[: len(package) - (node.level - 1)]
    return ".".join([*anchor, node.module]) if node.module else ".".join(anchor)


def _imports(module: str, is_package: bool, tree: ast.AST) -> list[tuple[str, int]]:
    """Every module this file pulls in, as absolute names.

    `from X import Y` contributes BOTH `X` and `X.Y`, because `Y` may itself be a
    submodule: `from .. import infrastructure` names the same dependency as
    `from ..infrastructure import audio_cache`, and checking only `node.module`
    would see the second and wave the first through. That is the round-1 Major
    written in a different but perfectly legal style.
    """
    found: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            found.extend((alias.name, node.lineno) for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = _resolve(module, is_package, node)
            found.append((base, node.lineno))
            found.extend(
                (f"{base}.{alias.name}" if base else alias.name, node.lineno)
                for alias in node.names
                if alias.name != "*"
            )
    return found


def _source_files() -> list[Path]:
    return sorted(p for p in APP.rglob("*.py") if p.stat().st_size)


def violations_in(module: str, tree: ast.AST, *, is_package: bool = False) -> list[str]:
    """Every layering or purity breach in one parsed module."""
    if module == COMPOSITION_ROOT:
        return []
    layer = _layer_of(module)
    problems: list[str] = []

    for target, line in _imports(module, is_package, tree):
        target_layer = _layer_of(target)
        if target.split(".")[0] == "app":
            if layer is None or target_layer is None:
                continue
            if RINGS.index(target_layer) > RINGS.index(layer):
                problems.append(
                    f"{module}:{line} imports {target} -- "
                    f"{layer} may not depend on the outer ring {target_layer}"
                )
            continue

        top_level = target.split(".")[0]
        allowed = PURE_LAYERS.get(layer or "")
        if allowed is not None and top_level not in allowed:
            problems.append(
                f"{module}:{line} imports {target} -- the {layer} layer is pure; "
                "reach the outside world through a port in domain/ports.py"
            )
        elif layer != "infrastructure" and top_level in PORTED_LIBRARIES:
            problems.append(
                f"{module}:{line} imports {target} -- {top_level} already has a "
                f"port; only the infrastructure ring may name it, not {layer}"
            )
    return problems


def test_no_layer_depends_on_a_ring_outside_itself() -> None:
    problems: list[str] = []
    for path in _source_files():
        problems.extend(
            violations_in(
                _module_name(path),
                ast.parse(path.read_text()),
                is_package=path.name == "__init__.py",
            )
        )

    assert not problems, "Clean Architecture violations:\n  " + "\n  ".join(problems)


def test_every_source_file_is_actually_covered() -> None:
    """A gate that walks an empty list passes vacuously."""
    modules = {_module_name(p) for p in _source_files()}

    assert {_layer_of(m) for m in modules} >= set(RINGS), "a layer went unscanned"
    assert len(modules) >= 10


def test_no_module_lives_outside_the_rings() -> None:
    """An unringed module is unchecked AND a laundering channel.

    `violations_in` can only reason about a module it can place in a ring, so a
    hypothetical `app/helpers.py` would be free to import infrastructure *and* free
    to be imported by the domain -- `domain -> app.helpers -> app.infrastructure`
    with the gate silent. `app/config.py` / `app/dependencies.py` is standard
    FastAPI layout, so this is the likeliest way the hole opens.

    Everything belongs to a ring; `app/main.py` is the one deliberate exception.
    """
    stray = sorted(
        m
        for m in (_module_name(p) for p in _source_files())
        if _layer_of(m) is None and m != COMPOSITION_ROOT
    )

    assert not stray, (
        "these modules sit outside every ring, so nothing constrains what they "
        f"import or who imports them: {stray}"
    )


@pytest.mark.parametrize(
    ("module", "source", "expected"),
    [
        pytest.param(
            "app.domain.announcement",
            "import requests",
            "pure",
            id="third-party in domain",
        ),
        pytest.param(
            "app.domain.announcement",
            "import subprocess",
            "pure",
            id="io stdlib in domain",
        ),
        pytest.param(
            "app.application.synthesize_announcement",
            "from pathlib import Path",
            "pure",
            id="filesystem in application",
        ),
        pytest.param(
            "app.application.synthesize_announcement",
            "from ..infrastructure.audio_cache import AudioCache",
            "outer ring",
            id="application reaching into infrastructure",
        ),
        pytest.param(
            "app.interface_adapters.http_api",
            "from ..infrastructure.audio_post_processor import AudioProcessingError",
            "outer ring",
            id="adapter reaching into infrastructure",
        ),
        pytest.param(
            "app.domain.ports",
            "from ..application.synthesize_announcement import Announcement",
            "outer ring",
            id="domain reaching into application",
        ),
        pytest.param(
            "app.interface_adapters.http_api",
            "from .. import infrastructure",
            "outer ring",
            id="outer ring named as a submodule rather than a dotted path",
        ),
        pytest.param(
            "app.domain.announcement",
            "from app import infrastructure",
            "outer ring",
            id="the same, spelled absolutely",
        ),
        pytest.param(
            "app.interface_adapters.http_api",
            "import subprocess",
            "already has a port",
            id="adapter shelling out instead of going through the finisher port",
        ),
        pytest.param(
            "app.interface_adapters.http_api",
            "import piper",
            "already has a port",
            id="adapter importing the engine instead of the TtsEngine port",
        ),
    ],
)
def test_the_gate_actually_rejects_the_violations_it_claims_to(
    module: str, source: str, expected: str
) -> None:
    """Mutation test.

    Every assertion above is negative -- it passes when nothing is found -- so it
    would keep passing if the checker silently stopped discriminating. These are the
    counter-examples that prove it still bites, including the exact adapter->
    infrastructure import this gate was written after.
    """
    problems = violations_in(module, ast.parse(source))

    assert problems, f"gate missed: {module} / {source}"
    assert expected in problems[0]


def test_the_gate_does_not_reject_the_imports_the_layers_legitimately_need() -> None:
    """The other half of the mutation test: a gate that rejects everything is useless."""
    assert not violations_in("app.domain.announcement", ast.parse("import re"))
    assert not violations_in(
        "app.application.synthesize_announcement",
        ast.parse("from ..domain.ports import AudioCachePort\nimport hashlib"),
    )
    assert not violations_in(
        "app.infrastructure.piper_engine",
        ast.parse("import subprocess\nfrom ..domain.tts_engine import TtsEngine"),
    )
    # The composition root is exempt by design, not by accident.
    assert not violations_in(
        COMPOSITION_ROOT, ast.parse("from .infrastructure.audio_cache import AudioCache")
    )
    # Infrastructure is the ring that is SUPPOSED to name the ported libraries.
    assert not violations_in(
        "app.infrastructure.piper_engine", ast.parse("import piper\nimport urllib")
    )


def test_a_package_init_anchors_relative_imports_on_itself() -> None:
    """`__init__` is its own package, so `..x` from it is one level shallower.

    Every `__init__.py` here is empty today, which means this branch is unreached by
    the scan and would go live silently the moment someone re-exports from
    `app/domain/__init__.py` -- exactly when a laundering import would matter most.
    """
    assert violations_in(
        "app.domain",
        ast.parse("from ..infrastructure.audio_cache import AudioCache"),
        is_package=True,
    )
    # And it must not mis-resolve a legitimate sibling into a false positive.
    assert not violations_in(
        "app.domain", ast.parse("from .tts_engine import TtsSettings"), is_package=True
    )
    # Read as a module (the default), the same source anchors one level deeper --
    # which is why `is_package` is passed in rather than guessed from the name.
    assert _resolve(
        "app.domain", True, ast.parse("from ..infrastructure import x").body[0]
    ) == "app.infrastructure"
    assert _resolve(
        "app.domain", False, ast.parse("from ..infrastructure import x").body[0]
    ) == "infrastructure"
