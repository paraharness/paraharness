#!/usr/bin/env python3
"""Darwinian design loop for the harness-dsl surface.

Stages per generation: mutate -> compile -> critique -> judge -> select.
Each model stage is one JSONL submitted through the batch runner; compile is local.
State lives in state.json; variants in variants/<gen>/<id>/.
"""
from __future__ import annotations

import argparse
import itertools
import json
import math
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import asdict, dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent
PROJECT = ROOT.parent.parent
RUNNER_DIR = Path("./scripts/batch-runner")
RUNNER_PY = RUNNER_DIR / ".venv/bin/python"
RUNNER = RUNNER_DIR / "run.py"
TSC = PROJECT / "node_modules/.bin/tsc"
COMPILE_DIR = Path(os.environ.get("EVOLVE_COMPILE_DIR", Path(tempfile.gettempdir()) / "harness-dsl-evolve"))

MODEL = "claude-opus-5-5"
SURFACE_MAX_TOKENS = 120_000
SCENARIOS_MAX_TOKENS = 128_000
CRITIQUE_MAX_TOKENS = 24_000
JUDGE_MAX_TOKENS = 16_000
BRIEF = "Deliberate briefly; every thinking token is paid for and the files are the deliverable. "
CHILDREN_PER_PARENT = 3
JUDGE_COMPARISONS_PER_VARIANT = 3
FRONT_SIZE = 4
PRIOR_GAMES = 1.0
SCENARIO_FILES = sorted((ROOT / "scenarios").glob("*.md"))
SCENARIO_IDS = [p.stem for p in SCENARIO_FILES]
SCENARIO_HALVES = [SCENARIO_IDS[: len(SCENARIO_IDS) // 2], SCENARIO_IDS[len(SCENARIO_IDS) // 2 :]]
JUDGE_SCENARIOS = ("01-coding-team", "08-hostile-lifecycles")

LENSES = [
    "Kanban (swimlanes, WIP limits, classes of service, expedite lanes)",
    "Erlang/OTP (supervision trees, gen_statem, mailboxes, monitors)",
    "Temporal (durable executions, signals, timers, child workflows, continue-as-new)",
    "Kubernetes controllers (desired state, reconcile loops, conditions, owner references)",
    "Unix (pipes, small tools, text streams, one job per tool)",
    "Rails/Laravel (convention over configuration, service providers, named relations)",
    "Petri nets (places, transitions, tokens; concurrency in lifecycles)",
    "rules engines (facts, conditions, actions; forward chaining for triggers)",
    "GenStage/Broadway (producers, demand, back-pressure, batching)",
    "double-entry accounting (every state change is a balanced, attributable entry)",
]

OPERATORS = [
    "rename: find the pivot or entity whose noun is weakest and give it the right noun; adjust everything that touches it",
    "merge: pick two entities that are 'a kind x a store x a policy' or otherwise rhyme, and make them one; report what honesty it costs",
    "split: pick the entity doing two jobs and split it; report what surface it adds",
    "delete: remove one entity entirely and repair the battery without it",
    "scenario-fix: pick the battery scenario this design handles worst (see the critique) and change the design until it is handled well; keep the other scenarios compiling",
    "lens: redesign the execution model (units, attempts, re-entry, cancellation, time, external events) through the named lens, keeping the owner's vocabulary unless the lens word is clearly better",
    "surface-cut: remove every method the battery never calls and every option with one caller; make the d.ts smaller without losing coverage",
    "inference: find every place a scenario needs a cast or an explicit type argument and change the surface so inference carries it",
]


@dataclass
class Variant:
    id: str
    gen: int
    parent: str | None
    lineage: str
    operator: str
    path: str
    compile_errors: int = -1
    escapes: int = 0
    dts_any: int = 0
    surface: int = 0
    coverage: int = 0
    cannot: list[str] = field(default_factory=list)
    principle_strikes: int = 0
    strikes: list[str] = field(default_factory=list)
    bt: float = 0.0
    critique: str = ""
    alive: bool = True


def load_state() -> dict:
    p = ROOT / "state.json"
    return json.loads(p.read_text()) if p.exists() else {"gen": -1, "variants": {}, "front": [], "judgments": []}


def save_state(state: dict) -> None:
    (ROOT / "state.json").write_text(json.dumps(state, indent=2))


def system_prompt(kind: str) -> list[dict]:
    text = "\n\n".join(
        [
            "# You are designing harness-dsl, a TypeScript DSL for stateful agentic-work harnesses.",
            (ROOT / "principles.md").read_text(),
            "# Scenario battery\n\n" + "\n\n---\n\n".join(p.read_text() for p in SCENARIO_FILES),
            (ROOT / "format.md").read_text() if kind == "mutate" else (ROOT / "rubric.md").read_text(),
            "# Known weaknesses of the owner's own seed\n\n" + (ROOT / "self-critique.md").read_text(),
        ]
    )
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral", "ttl": "1h"}}]


def request(custom_id: str, system: list[dict], user: str, max_tokens: int, effort: str = "medium") -> dict:
    return {
        "custom_id": custom_id,
        "params": {
            "model": MODEL,
            "max_tokens": max_tokens,
            "output_config": {"effort": effort},
            "system": system,
            "messages": [{"role": "user", "content": user}],
        },
    }


def write_requests(path: Path, requests: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for r in requests:
            f.write(json.dumps(r) + "\n")


def run_batch(stage_dir: Path, max_usd: float, dry_run: bool) -> dict[str, str]:
    requests_path = stage_dir / "requests.jsonl"
    if dry_run:
        n = sum(1 for _ in requests_path.open())
        size = requests_path.stat().st_size
        print(f"  dry-run: {n} requests, {size / 1e6:.1f} MB in {requests_path}")
        return {}
    cmd = [str(RUNNER_PY), str(RUNNER), str(requests_path), str(stage_dir / "run"), "--max-usd", f"{max_usd:.2f}", "--max-batch-usd", "12"]
    print("  " + " ".join(cmd[2:]))
    subprocess.run(cmd, check=False)
    out: dict[str, str] = {}
    results = stage_dir / "run" / "results.jsonl"
    if not results.exists():
        return out
    for line in results.open():
        entry = json.loads(line)
        result = entry["result"]
        if result.get("type") != "succeeded":
            continue
        out[entry["custom_id"]] = "".join(b.get("text", "") for b in result["message"]["content"] if b.get("type") == "text")
    return out


FILE_RE = re.compile(r"=== FILE: (.+?) ===\n(.*?)\n=== END ===", re.S)


def materialize(text: str, target: Path, merge: bool = False) -> bool:
    files = FILE_RE.findall(text)
    if not files:
        return False
    if target.exists() and not merge:
        shutil.rmtree(target)
    for name, body in files:
        name = name.strip()
        if ".." in name or name.startswith("/"):
            continue
        dest = target / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(normalize(strip_fences(body)).rstrip("\n") + "\n")
    return (target / "h.d.ts").exists()


FENCE_OPEN_RE = re.compile(r"\A\s*```[\w.+-]*[ \t]*\n")
FENCE_CLOSE_RE = re.compile(r"\n```[ \t]*\s*\Z")


ZOD3_DEF_RE = re.compile(r",\s*z\.ZodTypeDef\b")


def normalize(body: str) -> str:
    """Rewrites idioms that are version drift, not design: zod 3's `z.ZodType<T, z.ZodTypeDef, U>` is zod 4's `z.ZodType<T, U>`."""
    return ZOD3_DEF_RE.sub("", body)


def strip_fences(body: str) -> str:
    opened = FENCE_OPEN_RE.sub("", body, count=1)
    return FENCE_CLOSE_RE.sub("\n", opened, count=1) if opened != body else body


ESCAPE_RE = re.compile(r"\bas\s+(?:any|unknown)\b|:\s*any\b|@ts-(?:ignore|expect-error)|<any>")
NONNULL_RE = re.compile(r"[\w\)\]]!\.|!\s*;|!\)")
VENDOR_RE = re.compile(r"claude|anthropic|openai|gemini|google|sqlite|jsonl|linear|drizzle|mcp|slack", re.I)
PIVOT_VERB_RE = re.compile(r"\b(bind|wire|attach|connect)\s*[<(]", re.I)
MEMBER_RE = re.compile(r"^\s+(?:readonly\s+)?\w+(?:<[^>]*>)?\s*[\(:]", re.M)
EXPORT_RE = re.compile(r"^\s*export\s+(?:declare\s+)?(?:const|function|class|interface|type|namespace)\s+(\w+)", re.M)


def kernel_block(dts: str) -> str:
    m = re.search(r"declare module 'harness-dsl'\s*\{(.*?)\n\}\n", dts, re.S)
    return m.group(1) if m else dts


def compile_variant(v: Variant) -> None:
    path = Path(v.path)
    dts = (path / "h.d.ts").read_text() if (path / "h.d.ts").exists() else ""
    kernel = kernel_block(dts)
    scenarios = sorted((path / "scenarios").glob("*.ts")) if (path / "scenarios").exists() else []
    expressed = []
    cannot = []
    for s in scenarios:
        body = s.read_text()
        if body.lstrip().startswith("// CANNOT EXPRESS"):
            cannot.append(s.stem)
        else:
            expressed.append(s)
    v.cannot = cannot
    v.coverage = len(expressed)
    v.dts_any = len(re.findall(r"\bany\b", dts))
    v.surface = len(MEMBER_RE.findall(kernel)) + len(EXPORT_RE.findall(kernel))
    v.escapes = sum(len(ESCAPE_RE.findall(s.read_text())) for s in expressed) + sum(len(NONNULL_RE.findall(s.read_text())) for s in expressed)
    strikes = []
    if VENDOR_RE.search(kernel):
        strikes.append("P7: vendor/product/format noun inside declare module 'harness-dsl'")
    if PIVOT_VERB_RE.search(kernel):
        strikes.append("P9: unnamed pivot (bind/wire/attach/connect) in the kernel surface")
    if any("process.env" in s.read_text() for s in expressed):
        strikes.append("P11: process.env read in a scenario instead of a reference")
    if re.search(r"from 'harness-dsl/(?!kernel')", kernel):
        strikes.append("P6: kernel block imports an adapter subpath")
    v.strikes = strikes
    v.principle_strikes = len(strikes)
    if not dts:
        v.compile_errors = 999
        return
    build = COMPILE_DIR / v.id
    if build.exists():
        shutil.rmtree(build)
    (build / "scenarios").mkdir(parents=True)
    shutil.copy(path / "h.d.ts", build / "h.d.ts")
    if (path / "kernel.d.ts").exists():
        shutil.copy(path / "kernel.d.ts", build / "kernel.d.ts")
    for s in expressed:
        shutil.copy(s, build / "scenarios" / s.name)
    (build / "node_modules").symlink_to(PROJECT / "node_modules")
    files = ["h.d.ts"] + (["kernel.d.ts"] if (build / "kernel.d.ts").exists() else []) + [f"scenarios/{s.name}" for s in expressed]
    kernel_module = (build / "kernel.d.ts").read_text() if (build / "kernel.d.ts").exists() else ""
    kernel_is_module = bool(re.search(r"^export\s", kernel_module, re.M)) and "declare module 'harness-dsl/kernel'" not in kernel_module
    tsconfig = {
        "compilerOptions": {
            "strict": True,
            "noImplicitAny": True,
            "noEmit": True,
            "target": "es2022",
            "module": "nodenext",
            "moduleResolution": "nodenext",
            "types": ["node"],
            "skipLibCheck": False,
            **({"baseUrl": ".", "paths": {"harness-dsl/kernel": ["./kernel.d.ts"]}} if kernel_is_module else {}),
        },
        "files": files,
    }
    (build / "tsconfig.json").write_text(json.dumps(tsconfig, indent=2))
    proc = subprocess.run([str(TSC), "-p", "tsconfig.json"], capture_output=True, text=True, cwd=build)
    errors = [l for l in proc.stdout.splitlines() if "error TS" in l]
    v.compile_errors = len(errors)
    (path / "tsc.log").write_text(proc.stdout)


def variant_bundle(v: Variant, scenario_ids: tuple[str, ...] | None = None) -> str:
    path = Path(v.path)
    parts = [f"=== FILE: design.md ===\n{(path / 'design.md').read_text() if (path / 'design.md').exists() else ''}\n=== END ===",
             f"=== FILE: h.d.ts ===\n{(path / 'h.d.ts').read_text()}\n=== END ==="]
    if (path / "kernel.d.ts").exists() and scenario_ids is None:
        parts.append(f"=== FILE: kernel.d.ts ===\n{(path / 'kernel.d.ts').read_text()}\n=== END ===")
    for s in sorted((path / "scenarios").glob("*.ts")):
        if scenario_ids is None or s.stem in scenario_ids:
            parts.append(f"=== FILE: scenarios/{s.name} ===\n{s.read_text()}\n=== END ===")
    return "\n\n".join(parts)


def scores_line(v: Variant) -> str:
    return (f"compile errors {v.compile_errors}, escapes {v.escapes}, any-in-dts {v.dts_any}, surface {v.surface}, "
            f"coverage {v.coverage}/{len(SCENARIO_IDS)}, cannot: {', '.join(v.cannot) or 'none'}, strikes: {'; '.join(v.strikes) or 'none'}")


SURFACE_FILES = "h.d.ts first, then kernel.d.ts, then design.md; no scenario files yet"
SCENARIO_TASK = (
    "Now write the scenario files {ids} of the battery against this surface, in the required format. "
    "Each file is a complete harness that compiles with strict settings and no escape hatches. If a scenario exposes a gap in the surface, "
    "fix the surface: emit the updated h.d.ts (and kernel.d.ts if it changes) before the scenario files, and append the change to design.md's "
    "'What changed and why' by emitting the full updated design.md. A scenario you cannot express gets the CANNOT EXPRESS marker. "
)


def surface_bundle(v: Variant) -> str:
    path = Path(v.path)
    parts = []
    for name in ("design.md", "h.d.ts", "kernel.d.ts"):
        if (path / name).exists():
            parts.append(f"=== FILE: {name} ===\n{(path / name).read_text()}\n=== END ===")
    return "\n\n".join(parts)


def stage_mutate(state: dict, gen: int, dry_run: bool, max_usd: float, rng: random.Random) -> list[Variant]:
    system = system_prompt("mutate")
    children: list[Variant] = []
    surface_prompts: dict[str, str] = {}
    imported: list[Variant] = []
    if gen == 0:
        for seed_dir in sorted(p for p in (ROOT / "seeds").iterdir() if (p / "h.d.ts").exists()):
            vid = f"g00-{seed_dir.name}"
            path = ROOT / "variants" / "g00" / vid
            if path.exists():
                shutil.rmtree(path)
            shutil.copytree(seed_dir, path)
            imported.append(Variant(id=vid, gen=0, parent=None, lineage=seed_dir.name, operator="import", path=str(path)))
        for seed in sorted((ROOT / "seeds").glob("*.md")):
            for k in range(2):
                vid = f"g00-{seed.stem}-{k}"
                surface_prompts[vid] = (
                    f"# Seed brief: {seed.stem}\n\n{seed.read_text()}\n\n"
                    f"{BRIEF}Materialize this brief's surface in the required format: {SURFACE_FILES}. "
                    f"Design the surface so that all {len(SCENARIO_IDS)} battery scenarios can be written against it; you will write them in the next step. "
                    + ("Take the brief's choices at face value." if k == 0 else
                       "Where the brief leaves a choice open, take the less obvious option and say so in design.md."))
                children.append(Variant(id=vid, gen=0, parent=None, lineage=seed.stem, operator="materialize", path=str(ROOT / "variants" / f"g{gen:02d}" / vid)))
    else:
        parents = [Variant(**state["variants"][pid]) for pid in state["front"]]
        for p in parents:
            ops = rng.sample(OPERATORS, CHILDREN_PER_PARENT)
            for k, op in enumerate(ops):
                vid = f"g{gen:02d}-{p.lineage}-{p.id[-6:]}-{k}"
                lens = rng.choice(LENSES)
                op_text = op.replace("the named lens", lens)
                surface_prompts[vid] = (
                    f"# Parent variant ({p.id})\n\nMechanical scores: {scores_line(p)}\n\n"
                    f"## Adversary's critique of the parent\n\n{p.critique or '(none yet)'}\n\n"
                    f"## Parent files\n\n{variant_bundle(p)}\n\n"
                    f"# Your operator\n\n{op_text}\n\n"
                    f"principles.md is the current ruling and may have changed since the parent was written: where the parent's design.md lists a principle as broken, "
                    f"read the principle as it stands now and repair the break, unless the parent's reason still holds against the current text, in which case restate it. "
                    f"The adversary's three sharpest critiques of the parent are part of your task whatever your operator: repair each, or argue in design.md why it is wrong; "
                    f"a child that carries its parent's named defects unanswered is judged against them.\n\n"
                    f"{BRIEF}Produce the child's surface in the required format: {SURFACE_FILES}, every file in full. "
                    f"You will write the scenario files against it in the next step.")
                children.append(Variant(id=vid, gen=gen, parent=p.id, lineage=p.lineage, operator=op.split(":")[0], path=str(ROOT / "variants" / f"g{gen:02d}" / vid)))

    stage_a = ROOT / "runs" / f"g{gen:02d}-mutate-surface"
    write_requests(stage_a / "requests.jsonl", [request(c.id, system, surface_prompts[c.id], SURFACE_MAX_TOKENS) for c in children])
    print(f"[g{gen:02d}] mutate/surface: {len(children)} requests")
    outputs = run_batch(stage_a, max_usd * 0.4, dry_run)
    surfaced = []
    for c in children:
        text = outputs.get(c.id)
        if text and materialize(text, Path(c.path)):
            surfaced.append(c)
        else:
            c.alive = False
            c.compile_errors = 999
        state["variants"][c.id] = asdict(c)
    for c in imported:
        state["variants"][c.id] = asdict(c)
    if dry_run or not (surfaced or imported):
        return []

    alive = surfaced + imported
    for i, ids in enumerate(SCENARIO_HALVES):
        stage_b = ROOT / "runs" / f"g{gen:02d}-mutate-scenarios-{i}"
        missing = {c.id: [sid for sid in ids if not (Path(c.path) / "scenarios" / f"{sid}.ts").exists()] for c in alive}
        requests_b = [
            request(c.id, system, f"# Your surface\n\n{surface_bundle(c)}\n\n# Task\n\n{BRIEF}{SCENARIO_TASK.format(ids=', '.join(missing[c.id]))}",
                    SCENARIOS_MAX_TOKENS)
            for c in alive if missing[c.id]
        ]
        write_requests(stage_b / "requests.jsonl", requests_b)
        print(f"[g{gen:02d}] mutate/scenarios {i}: {len(requests_b)} requests ({len(alive) - len(requests_b)} already complete)")
        outputs = run_batch(stage_b, max_usd * 0.3, dry_run) if requests_b else {}
        survivors = []
        for c in alive:
            text = outputs.get(c.id)
            if not missing[c.id] or (text and materialize(text, Path(c.path), merge=True)):
                survivors.append(c)
            else:
                c.alive = False
                c.compile_errors = 999
            state["variants"][c.id] = asdict(c)
        alive = survivors
    return [c for c in alive if (Path(c.path) / "scenarios").exists()]


def stage_compile(state: dict, variants: list[Variant]) -> None:
    for v in variants:
        compile_variant(v)
        state["variants"][v.id] = asdict(v)
        print(f"  {v.id}: {scores_line(v)}")


REPAIR_MAX_TOKENS = 64_000
REPAIR_ERROR_LINES = 120


REPAIR_ROUNDS = 2


def stage_repair(state: dict, gen: int, variants: list[Variant], dry_run: bool, max_usd: float) -> None:
    for rnd in range(REPAIR_ROUNDS):
        broken = [v for v in variants if 0 < v.compile_errors < 999]
        if not broken:
            return
        repair_round(state, gen, broken, dry_run, max_usd / REPAIR_ROUNDS, rnd)


def repair_round(state: dict, gen: int, broken: list[Variant], dry_run: bool, max_usd: float, rnd: int) -> None:
    stage = ROOT / "runs" / (f"g{gen:02d}-repair" if rnd == 0 else f"g{gen:02d}-repair-{rnd}")
    system = system_prompt("mutate")
    requests = []
    for v in broken:
        path = Path(v.path)
        errors = "\n".join(l for l in (path / "tsc.log").read_text().splitlines() if "error TS" in l)[: REPAIR_ERROR_LINES * 200]
        failing = sorted({l.split("(")[0] for l in errors.splitlines() if l.startswith("scenarios/")})
        files = [f"=== FILE: {n} ===\n{(path / n).read_text()}\n=== END ===" for n in ("h.d.ts", "kernel.d.ts") if (path / n).exists()]
        files += [f"=== FILE: {n} ===\n{(path / n).read_text()}\n=== END ===" for n in failing if (path / n).exists()]
        user = (f"# Your variant {v.id} does not compile\n\nMechanical scores: {scores_line(v)}\n\n## tsc errors (strict, noImplicitAny, zod 4, Node types)\n\n"
                f"{errors}\n\n## Files\n\n" + "\n\n".join(files) + "\n\n# Task\n\n"
                f"{BRIEF}Fix the compile errors. Emit only the files you change, in full, in the required format. Fix the surface where the surface is wrong "
                f"and the scenario where the scenario is wrong. No `any`, no casts, no `@ts-` comments, no weakening of types to make errors disappear. "
                f"Do not change what the scenarios express; a scenario that cannot be expressed becomes a CANNOT EXPRESS marker, not a loosened type.")
        requests.append(request(f"repair-{v.id}", system, user, REPAIR_MAX_TOKENS))
    write_requests(stage / "requests.jsonl", requests)
    print(f"[g{gen:02d}] repair round {rnd + 1}: {len(requests)} requests")
    outputs = run_batch(stage, max_usd, dry_run)
    for v in broken:
        text = outputs.get(f"repair-{v.id}")
        if text:
            materialize(text, Path(v.path), merge=True)
            compile_variant(v)
            state["variants"][v.id] = asdict(v)
            print(f"  {v.id} (repaired): {scores_line(v)}")


def stage_critique(state: dict, gen: int, variants: list[Variant], dry_run: bool, max_usd: float) -> None:
    stage = ROOT / "runs" / f"g{gen:02d}-critique"
    system = system_prompt("judge")
    requests = []
    for v in variants:
        user = (f"# Variant {v.id}\n\nMechanical scores: {scores_line(v)}\n\n{variant_bundle(v)}\n\n"
                "# Task\n\nYou are the adversary. (1) Name the battery scenario this variant handles worst and show the exact lines or missing "
                "concepts that make it bad. (2) Write one new scenario, in the battery's style, that this variant cannot express without a lie or an "
                "escape hatch. (3) List the three sharpest concrete critiques of the design: a poorly named pivot, a hidden coupling, a principle "
                "violation, a kind carrying a backend, two words for one thing. Be specific; quote names. No praise. Under 600 words. " + BRIEF)
        requests.append(request(f"crit-{v.id}", system, user, CRITIQUE_MAX_TOKENS))
    write_requests(stage / "requests.jsonl", requests)
    print(f"[g{gen:02d}] critique: {len(requests)} requests")
    outputs = run_batch(stage, max_usd, dry_run)
    for v in variants:
        v.critique = outputs.get(f"crit-{v.id}", v.critique)
        state["variants"][v.id] = asdict(v)


def stage_judge(state: dict, gen: int, pool: list[Variant], dry_run: bool, max_usd: float, rng: random.Random) -> None:
    stage = ROOT / "runs" / f"g{gen:02d}-judge"
    system = system_prompt("judge")
    criteria = ["fidelity", "ergonomics", "expressiveness", "economy", "connectedness"]
    framings = ["laravel", "durable", "newcomer", "owner", "adversary"]
    pairs: list[tuple[Variant, Variant]] = []
    ids = [v for v in pool if v.compile_errors == 0]
    if len(ids) < 2:
        print(f"[g{gen:02d}] judge: fewer than two compiling variants, skipped")
        return
    for v in ids:
        others = rng.sample([o for o in ids if o.id != v.id], min(JUDGE_COMPARISONS_PER_VARIANT, len(ids) - 1))
        pairs.extend((v, o) for o in others)
    requests = []
    meta = {}
    for i, (a, b) in enumerate(pairs):
        crit = criteria[i % len(criteria)]
        framing = framings[(i // len(criteria)) % len(framings)]
        scenario = rng.choice(SCENARIO_IDS)
        for side, (first, second) in enumerate(((a, b), (b, a))):
            user = (f"Criterion: {crit}. Framing: {framing}. Scenario in focus for the newcomer and adversary framings: {scenario}.\n\n"
                    f"# Variant A\n\nMechanical scores: {scores_line(first)}\n\n{variant_bundle(first, JUDGE_SCENARIOS + (scenario,))}\n\n"
                    f"# Variant B\n\nMechanical scores: {scores_line(second)}\n\n{variant_bundle(second, JUDGE_SCENARIOS + (scenario,))}\n\n"
                    "Decide per the rubric. Output only the JSON object. " + BRIEF)
            cid = f"judge-{gen:02d}-{i:04d}-{side}"
            requests.append(request(cid, system, user, JUDGE_MAX_TOKENS))
            meta[cid] = {"pair": i, "a": first.id, "b": second.id, "criterion": crit, "framing": framing}
    write_requests(stage / "requests.jsonl", requests)
    (stage / "meta.json").write_text(json.dumps(meta, indent=2))
    print(f"[g{gen:02d}] judge: {len(pairs)} pairs, {len(requests)} comparisons (both positions)")
    outputs = run_batch(stage, max_usd, dry_run)
    unparsed = record_verdicts(state, gen, meta, outputs)
    if unparsed and not dry_run:
        by_cid = {r["custom_id"]: r for r in requests}
        retry = stage / "retry"
        write_requests(retry / "requests.jsonl", [by_cid[cid] for cid in unparsed])
        print(f"[g{gen:02d}] judge: {len(unparsed)} malformed verdicts, retrying once")
        record_verdicts(state, gen, meta, run_batch(retry, max_usd * 0.1, dry_run))
    settle_pairs(state, gen, meta)
    bradley_terry(state)


def record_verdicts(state: dict, gen: int, meta: dict, outputs: dict[str, str]) -> list[str]:
    unparsed = []
    verdicts = state.setdefault("verdicts", {})
    for cid, text in outputs.items():
        m = re.search(r"\{.*\}", text, re.S)
        try:
            verdict = json.loads(m.group(0)) if m else None
        except json.JSONDecodeError:
            verdict = None
        if not verdict or verdict.get("winner") not in ("A", "B"):
            unparsed.append(cid)
            continue
        info = meta[cid]
        verdicts[cid] = {"winner": info["a"] if verdict["winner"] == "A" else info["b"], "position": verdict["winner"],
                         "confidence": verdict.get("confidence", 0.5), "reasons": verdict.get("reasons", [])}
    return unparsed


def settle_pairs(state: dict, gen: int, meta: dict) -> None:
    """A pair counts only when both positions name the same winner; judges favour position A, and a split verdict is position, not design."""
    verdicts = state["verdicts"]
    sides: dict[int, list[tuple[str, dict]]] = {}
    for cid, info in meta.items():
        if cid in verdicts:
            sides.setdefault(info["pair"], []).append((cid, info))
    agreed = split = 0
    for pair in sorted(sides):
        if len(sides[pair]) < 2:
            continue
        (c0, i0), (c1, _) = sides[pair]
        if verdicts[c0]["winner"] != verdicts[c1]["winner"]:
            split += 1
            continue
        winner = verdicts[c0]["winner"]
        loser = i0["b"] if winner == i0["a"] else i0["a"]
        state["judgments"].append({"id": f"{c0}+{c1}", "gen": gen, "winner": winner, "loser": loser, "position": "both", "criterion": i0["criterion"],
                                   "framing": i0["framing"], "confidence": min(verdicts[c0]["confidence"], verdicts[c1]["confidence"]),
                                   "reasons": verdicts[c0]["reasons"]})
        agreed += 1
    print(f"[g{gen:02d}] judge: {agreed} pairs agreed in both positions, {split} split and discarded")


def bradley_terry(state: dict, iterations: int = 200) -> None:
    """Every variant also plays PRIOR_GAMES pseudo-games, half won, against an average opponent (strength 1): an undefeated
    variant's strength then stays finite and two 6-0 variants rank by whom they beat, instead of diverging with the iteration count."""
    ids = {j["winner"] for j in state["judgments"]} | {j["loser"] for j in state["judgments"]}
    strength = {i: 1.0 for i in ids}
    wins = {i: PRIOR_GAMES / 2 for i in ids}
    for j in state["judgments"]:
        wins[j["winner"]] += 1
    for _ in range(iterations):
        new = {}
        for i in ids:
            denom = PRIOR_GAMES / (strength[i] + 1.0)
            for j in state["judgments"]:
                if i in (j["winner"], j["loser"]):
                    other = j["loser"] if j["winner"] == i else j["winner"]
                    denom += 1.0 / (strength[i] + strength[other])
            new[i] = wins[i] / denom if denom else strength[i]
        total = sum(new.values()) or 1.0
        strength = {i: s * len(ids) / total for i, s in new.items()}
    for i, s in strength.items():
        if i in state["variants"]:
            state["variants"][i]["bt"] = round(math.log(max(s, 1e-9)), 4)


def dominates(a: Variant, b: Variant) -> bool:
    better = (a.escapes <= b.escapes and a.dts_any <= b.dts_any and a.surface <= b.surface and a.coverage >= b.coverage
              and a.principle_strikes <= b.principle_strikes and a.bt >= b.bt)
    strictly = (a.escapes < b.escapes or a.dts_any < b.dts_any or a.surface < b.surface or a.coverage > b.coverage
                or a.principle_strikes < b.principle_strikes or a.bt > b.bt)
    return better and strictly


def root_of(state: dict, v: Variant) -> str:
    cur = v
    while cur.parent:
        cur = Variant(**state["variants"][cur.parent])
    return cur.id


def stage_select(state: dict, gen: int) -> None:
    """Coverage is a gate, not a trade-off: a variant that skips scenarios is unfinished, not smaller. The Pareto front comes first,
    then the best of the rest by Bradley-Terry up to FRONT_SIZE, because with escapes, any and strikes all at zero the front
    degenerates to the best-judged variant plus the smallest surface; generation 2 collapsed to two parents that way."""
    compiling = [Variant(**d) for d in state["variants"].values() if d["alive"] and d["compile_errors"] == 0]
    full = max(v.coverage for v in compiling)
    pool = [v for v in compiling if v.coverage == full]
    front_ids = {v.id for v in pool if not any(dominates(o, v) for o in pool if o.id != v.id)}
    ranked = sorted(pool, key=lambda v: (v.id not in front_ids, v.principle_strikes, -v.bt, v.escapes, v.surface))
    chosen: list[Variant] = []
    per_lineage: dict[str, int] = {}
    for v in ranked:
        root = root_of(state, v)
        if per_lineage.get(root, 0) >= 2:
            continue
        chosen.append(v)
        per_lineage[root] = per_lineage.get(root, 0) + 1
        if len(chosen) >= FRONT_SIZE:
            break
    state["front"] = [v.id for v in chosen]
    state["gen"] = gen
    lines = [f"# Generation {gen} front", ""]
    for v in chosen:
        lines.append(f"- {v.id} ({v.lineage}, {v.operator}, {'pareto' if v.id in front_ids else 'by rank'}): bt {v.bt}, {scores_line(v)}")
    lines += ["", "## Critiques", ""]
    for v in chosen:
        lines += [f"### {v.id}", "", v.critique or "(none)", ""]
    (ROOT / "runs" / f"g{gen:02d}-front.md").write_text("\n".join(lines))
    print(f"[g{gen:02d}] front: {', '.join(v.id for v in chosen)}")


def run_generation(gen: int, dry_run: bool, max_usd: float, seed: int) -> bool:
    rng = random.Random(seed * 1000 + gen)
    state = load_state()
    children = stage_mutate(state, gen, dry_run, max_usd * 0.5, rng)
    save_state(state)
    if dry_run:
        return True
    if not children:
        print(f"[g{gen:02d}] no variant materialized; stopping. Inspect runs/g{gen:02d}-mutate-*/run/results.jsonl")
        return False
    stage_compile(state, children)
    save_state(state)
    stage_repair(state, gen, children, dry_run, max_usd * 0.15)
    save_state(state)
    compiling = [c for c in children if c.compile_errors == 0]
    if not compiling and not state["front"]:
        print(f"[g{gen:02d}] no variant compiles and there is no front; stopping")
        return False
    stage_critique(state, gen, compiling, dry_run, max_usd * 0.1)
    save_state(state)
    pool = compiling + [Variant(**state["variants"][pid]) for pid in state["front"] if pid not in {c.id for c in compiling}]
    stage_judge(state, gen, pool, dry_run, max_usd * 0.3, rng)
    save_state(state)
    stage_select(state, gen)
    save_state(state)
    return bool(state["front"])


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["run", "compile", "report", "reset"])
    parser.add_argument("--generations", type=int, default=1)
    parser.add_argument("--max-usd-per-generation", type=float, default=36.0)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--variant", help="compile one variant directory")
    args = parser.parse_args(argv)
    if args.command == "reset":
        for p in ["state.json"]:
            (ROOT / p).unlink(missing_ok=True)
        shutil.rmtree(ROOT / "variants", ignore_errors=True)
        shutil.rmtree(ROOT / "runs", ignore_errors=True)
        (ROOT / "variants").mkdir()
        (ROOT / "runs").mkdir()
        return 0
    if args.command == "compile":
        v = Variant(id=Path(args.variant).name, gen=-1, parent=None, lineage="manual", operator="manual", path=str(Path(args.variant).resolve()))
        compile_variant(v)
        print(scores_line(v))
        return 0
    if args.command == "report":
        state = load_state()
        for pid in state["front"]:
            print(scores_line(Variant(**state["variants"][pid])))
        return 0
    state = load_state()
    start = state["gen"] + 1
    for gen in range(start, start + args.generations):
        if not run_generation(gen, args.dry_run, args.max_usd_per_generation, args.seed):
            return 1
        if args.dry_run:
            break
        if gen % 5 == 4:
            print(f"checkpoint after generation {gen}: review runs/g{gen:02d}-front.md before continuing")
            break
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
