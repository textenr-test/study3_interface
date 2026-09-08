#!/usr/bin/env python3
"""Generate the locked 35-slot Study 3 allocation.

The allocation is built in five deterministic stages:

1. Five replicated seven-condition rotation groups provide exact condition-by-
   position balance and first-order carryover counts of 94 or 95 for every
   ordered pair across the complete 114-trial sequence.
2. Document-specific triple multisets give every condition 15 readers. When M
   is visually equivalent to a D condition, that pair is forbidden.
3. Deterministic within-document swaps assign triples to participants while
   preserving participant condition totals of 16/17.
4. Deterministic within-triple swaps map the three conditions to the three sets
   so every document-condition-set cell has five readers and every participant-
   set-condition count is 5/6.
5. Per-participant document matching and a final side MILP preserve the order,
   boundary, writer-pair, position, and left/right constraints.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import random
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import coo_matrix

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "assignments"
SLOTS_OUT = OUT / "slots"
STIMULI_INDEX = ROOT / "stimuli" / "index.json"

STUDY_VERSION = "2026-09-08-study3-v2"
ASSIGNMENT_VERSION = "n35-study3-carryover-v2"
ASSIGNMENT_SEED = "text-enrichment-reader-study3-n35-v2"
PARTICIPANTS = 35
SETS = 3
DOCS_PER_SET = 38
TRIALS_PER_PARTICIPANT = SETS * DOCS_PER_SET
CONDITIONS = [
    "D1_derived",
    "D2_derived",
    "W_writer_optimal",
    "D3_derived",
    "D4_derived",
    "D5_maximal",
    "M_model_optimal",
]
DOCUMENTS = [f"P{i}_DOC_{suffix}" for i in range(1, 20) for suffix in ("A", "B")]
CONDITION_COUNT = len(CONDITIONS)
MODEL_INDEX = CONDITIONS.index("M_model_optimal")
TRIPLES = list(itertools.combinations(range(CONDITION_COUNT), 3))
PAIRS = list(itertools.combinations(range(CONDITION_COUNT), 2))


def digest(value: str | bytes) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def seeded_random(label: str) -> random.Random:
    return random.Random(int(digest(f"{ASSIGNMENT_SEED}:{label}")[:16], 16))


def permutation_parity(permutation: tuple[int, ...]) -> int:
    return sum(
        permutation[left] > permutation[right]
        for left in range(len(permutation))
        for right in range(left + 1, len(permutation))
    ) % 2


class SparseConstraintBuilder:
    def __init__(self, variable_count: int):
        self.variable_count = variable_count
        self.rows: list[int] = []
        self.cols: list[int] = []
        self.values: list[float] = []
        self.lower: list[float] = []
        self.upper: list[float] = []

    def add(self, entries, lower: float, upper: float) -> None:
        row = len(self.lower)
        for column, value in entries:
            self.rows.append(row)
            self.cols.append(column)
            self.values.append(value)
        self.lower.append(lower)
        self.upper.append(upper)

    def linear_constraint(self) -> LinearConstraint:
        matrix = coo_matrix(
            (self.values, (self.rows, self.cols)),
            shape=(len(self.lower), self.variable_count),
        ).tocsr()
        return LinearConstraint(matrix, np.asarray(self.lower), np.asarray(self.upper))


def make_williams_row(index: int) -> list[int]:
    base = [0]
    for step in range(1, DOCS_PER_SET):
        base.append((step + 1) // 2 if step % 2 else DOCS_PER_SET - step // 2)
    return [((value + index) % DOCS_PER_SET) for value in base]


def order_violations(row: list[int], earlier: list[list[int]], previous: list[int] | None) -> int:
    penalty = 100 * sum(row[i] // 2 == row[i + 1] // 2 for i in range(len(row) - 1))
    for old in earlier:
        penalty += 100 * sum(value == old[position] for position, value in enumerate(row))
    if previous is not None:
        penalty += 100 * len(set(previous[-5:]).intersection(row[:5]))
    return penalty


def repair_order(
    target: list[int],
    earlier: list[list[int]],
    previous: list[int] | None,
    seed: int,
) -> list[int]:
    rng = random.Random(seed)
    current = target[:]
    score = order_violations(current, earlier, previous)
    if score == 0:
        return current
    best, best_score = current[:], score
    temperature = 2.0
    for _attempt in range(200_000):
        left, right = rng.sample(range(DOCS_PER_SET), 2)
        current[left], current[right] = current[right], current[left]
        proposed = order_violations(current, earlier, previous)
        if proposed <= score or rng.random() < math.exp((score - proposed) / max(temperature, 1e-6)):
            score = proposed
            if score < best_score:
                best, best_score = current[:], score
                if best_score == 0:
                    return best
        else:
            current[left], current[right] = current[right], current[left]
        temperature *= 0.99995
    raise RuntimeError(f"Could not repair document-order target; best={best_score}.")


def build_order_targets() -> list[list[list[int]]]:
    seed_base = int(digest(f"{ASSIGNMENT_SEED}:document-order-targets")[:16], 16)
    orders = []
    for participant in range(PARTICIPANTS):
        participant_orders = []
        for set_index, shift in enumerate((0, 13, 26)):
            target = make_williams_row((participant + shift) % DOCS_PER_SET)
            participant_orders.append(repair_order(
                target,
                participant_orders,
                participant_orders[-1] if participant_orders else None,
                seed_base + participant * 101 + set_index,
            ))
        orders.append(participant_orders)
    return orders


def carryover_step_counts(base_sequences):
    global_counts = [0] * (CONDITION_COUNT - 1)
    set_counts = [[0] * (CONDITION_COUNT - 1) for _ in range(SETS)]
    for group in range(len(base_sequences)):
        flattened = list(itertools.chain.from_iterable(base_sequences[group]))
        for left, right in zip(flattened, flattened[1:]):
            difference = (right - left) % CONDITION_COUNT
            if difference == 0:
                return None
            global_counts[difference - 1] += 1
        for set_index in range(SETS):
            row = base_sequences[group][set_index]
            for left, right in zip(row, row[1:]):
                difference = (right - left) % CONDITION_COUNT
                if difference == 0:
                    return None
                set_counts[set_index][difference - 1] += 1
    return global_counts, set_counts


def carryover_score(base_sequences) -> float:
    counts = carryover_step_counts(base_sequences)
    if counts is None:
        return float("inf")
    global_counts, set_counts = counts
    return (
        10 * sum((value - 565 / 6) ** 2 for value in global_counts)
        + sum((value - 185 / 6) ** 2 for row in set_counts for value in row)
    )


def build_carryover_sequences() -> tuple[list[list[list[int]]], dict]:
    """Build exact-position, optimally first-order-balanced condition sequences."""

    group_count = PARTICIPANTS // CONDITION_COUNT
    high_template = ({0, 1, 2}, {2, 3, 4}, {4, 5, 6})
    rng = seeded_random("carryover-sequence-search")
    best_sequences = None

    for _restart in range(5):
        sequences = []
        for group in range(group_count):
            group_rows = []
            for set_index in range(SETS):
                high = {(value + 2 * group) % CONDITION_COUNT for value in high_template[set_index]}
                bag = list(itertools.chain.from_iterable(
                    [condition] * (6 if condition in high else 5)
                    for condition in range(CONDITION_COUNT)
                ))
                for _attempt in range(100_000):
                    rng.shuffle(bag)
                    if all(left != right for left, right in zip(bag, bag[1:])) and (
                        not group_rows or group_rows[-1][-1] != bag[0]
                    ):
                        break
                else:
                    raise RuntimeError("Could not initialize carryover sequence.")
                group_rows.append(bag[:])
            sequences.append(group_rows)

        current_score = carryover_score(sequences)
        best_score = current_score
        local_best = [[row[:] for row in group] for group in sequences]
        temperature = 4.0
        for _attempt in range(450_000):
            group = rng.randrange(group_count)
            set_index = rng.randrange(SETS)
            first, second = rng.sample(range(DOCS_PER_SET), 2)
            if sequences[group][set_index][first] == sequences[group][set_index][second]:
                continue
            sequences[group][set_index][first], sequences[group][set_index][second] = (
                sequences[group][set_index][second],
                sequences[group][set_index][first],
            )
            flattened = list(itertools.chain.from_iterable(sequences[group]))
            if any(left == right for left, right in zip(flattened, flattened[1:])):
                sequences[group][set_index][first], sequences[group][set_index][second] = (
                    sequences[group][set_index][second],
                    sequences[group][set_index][first],
                )
                continue
            proposed = carryover_score(sequences)
            delta = proposed - current_score
            if delta <= 0 or rng.random() < math.exp(-delta / max(temperature, 1e-9)):
                current_score = proposed
                if proposed < best_score:
                    best_score = proposed
                    local_best = [[row[:] for row in item] for item in sequences]
            else:
                sequences[group][set_index][first], sequences[group][set_index][second] = (
                    sequences[group][set_index][second],
                    sequences[group][set_index][first],
                )
            temperature = max(0.001, temperature * 0.99998)

            global_counts, set_counts = carryover_step_counts(local_best)
            if sorted(global_counts) == [94, 94, 94, 94, 94, 95] and all(
                sorted(row) == [30, 31, 31, 31, 31, 31] for row in set_counts
            ):
                break

        global_counts, set_counts = carryover_step_counts(local_best)
        if sorted(global_counts) == [94, 94, 94, 94, 94, 95] and all(
            sorted(row) == [30, 31, 31, 31, 31, 31] for row in set_counts
        ):
            best_sequences = local_best
            break

    if best_sequences is None:
        raise RuntimeError("Could not obtain the optimal carryover schedule.")

    participant_sequences = [[None] * SETS for _ in range(PARTICIPANTS)]
    for participant in range(PARTICIPANTS):
        group, rotation = divmod(participant, CONDITION_COUNT)
        for set_index in range(SETS):
            participant_sequences[participant][set_index] = [
                (condition + rotation) % CONDITION_COUNT
                for condition in best_sequences[group][set_index]
            ]

    global_counts, set_counts = carryover_step_counts(best_sequences)
    position_counts = Counter(
        (set_index, position, participant_sequences[participant][set_index][position])
        for participant in range(PARTICIPANTS)
        for set_index in range(SETS)
        for position in range(DOCS_PER_SET)
    )
    assert set(position_counts.values()) == {5}
    return participant_sequences, {
        "family": "five replicated seven-condition rotation groups",
        "ordered_transition_frequency": [min(global_counts), max(global_counts)],
        "within_set_ordered_transition_frequency": [
            min(value for row in set_counts for value in row),
            max(value for row in set_counts for value in row),
        ],
        "condition_global_position_readers": 5,
    }


def document_block_multiset(document_id: str, equivalent_index: int | None) -> tuple[Counter, dict]:
    if equivalent_index is None:
        return Counter({triple: 1 for triple in TRIPLES}), {
            "forbidden_pair": None,
            "pair_frequency_range": [5, 5],
        }

    allowed = [
        triple for triple in TRIPLES
        if not (MODEL_INDEX in triple and equivalent_index in triple)
    ]
    others = [
        condition for condition in range(CONDITION_COUNT)
        if condition not in (MODEL_INDEX, equivalent_index)
    ]
    rng = seeded_random(f"{document_id}:pair-cycle")
    rng.shuffle(others)
    low_cycle = {
        tuple(sorted((others[index], others[(index + 1) % len(others)])))
        for index in range(len(others))
    }
    pair_targets = {}
    for pair in PAIRS:
        if set(pair) == {MODEL_INDEX, equivalent_index}:
            pair_targets[pair] = 0
        elif MODEL_INDEX in pair or equivalent_index in pair:
            pair_targets[pair] = 6
        else:
            pair_targets[pair] = 4 if pair in low_cycle else 5

    builder = SparseConstraintBuilder(len(allowed))
    builder.add(((index, 1) for index in range(len(allowed))), PARTICIPANTS, PARTICIPANTS)
    for condition in range(CONDITION_COUNT):
        builder.add(
            ((index, 1) for index, triple in enumerate(allowed) if condition in triple),
            15,
            15,
        )
    for pair in PAIRS:
        builder.add(
            ((index, 1) for index, triple in enumerate(allowed) if set(pair) <= set(triple)),
            pair_targets[pair],
            pair_targets[pair],
        )
    objective_rng = np.random.default_rng(
        int(digest(f"{ASSIGNMENT_SEED}:{document_id}:block-multiset")[:16], 16)
    )
    result = milp(
        c=objective_rng.random(len(allowed)) * 1e-6,
        integrality=np.ones(len(allowed), dtype=np.uint8),
        bounds=Bounds(np.zeros(len(allowed)), np.full(len(allowed), 2)),
        constraints=builder.linear_constraint(),
        options={"time_limit": 30, "mip_rel_gap": 0.0, "presolve": True},
    )
    if result.x is None or not result.success:
        raise RuntimeError(f"Block multiset failed for {document_id}: {result.message}")
    counts = Counter({
        triple: int(round(result.x[index]))
        for index, triple in enumerate(allowed)
        if result.x[index] > 0.5
    })
    assert sum(counts.values()) == PARTICIPANTS
    return counts, {
        "forbidden_pair": [CONDITIONS[MODEL_INDEX], CONDITIONS[equivalent_index]],
        "pair_frequency_range": [0, 6],
        "allowed_pair_frequency_range": [4, 6],
        "pair_targets": {
            f"{CONDITIONS[left]}|{CONDITIONS[right]}": value
            for (left, right), value in pair_targets.items()
        },
    }


def build_document_blocks(stimulus_by_doc) -> tuple[list[Counter], list[dict]]:
    multisets = []
    metadata = []
    for document_id in DOCUMENTS:
        equivalent = stimulus_by_doc[document_id]["condition_meta"]["M_model_optimal"].get(
            "equivalent_condition_id"
        )
        equivalent_index = CONDITIONS.index(equivalent) if equivalent else None
        counts, item_metadata = document_block_multiset(document_id, equivalent_index)
        multisets.append(counts)
        metadata.append(item_metadata)
    return multisets, metadata


def solve_participant_triples(
    block_multisets: list[Counter],
    participant_sequences,
) -> list[list[tuple[int, int, int]]]:
    targets = np.asarray([
        [
            Counter(itertools.chain.from_iterable(participant_sequences[participant]))[
                condition
            ]
            for condition in range(CONDITION_COUNT)
        ]
        for participant in range(PARTICIPANTS)
    ], dtype=np.int16)
    rng = seeded_random("participant-triple-balancing")
    best_score = math.inf

    # A swap only exchanges two participants' triples within one document, so
    # every document's exact triple multiset (including its forbidden pair and
    # pair-frequency targets) remains invariant throughout the search.
    for restart in range(24):
        assigned = [[None] * DOCS_PER_SET for _ in range(PARTICIPANTS)]
        counts = np.zeros((PARTICIPANTS, CONDITION_COUNT), dtype=np.int16)
        for document, multiset in enumerate(block_multisets):
            expanded = list(itertools.chain.from_iterable(
                [triple] * multiplicity for triple, multiplicity in multiset.items()
            ))
            rng.shuffle(expanded)
            for participant, triple in enumerate(expanded):
                assigned[participant][document] = triple
                counts[participant, list(triple)] += 1

        error = counts - targets
        score = int(np.square(error, dtype=np.int32).sum())
        temperature = 2.0

        for attempt in range(1_500_000):
            if score == 0:
                return assigned

            # Usually target a currently over-represented condition and a
            # participant who needs it. A small random fraction keeps the
            # search mobile when the remaining correction needs a neutral move.
            targeted = rng.random() < 0.92
            if targeted:
                for _pick in range(100):
                    participant = rng.randrange(PARTICIPANTS)
                    condition = rng.randrange(CONDITION_COUNT)
                    if error[participant, condition] > 0:
                        break
                else:
                    targeted = False

            candidates = []
            proposal_count = 48 if targeted else 16
            for _proposal in range(proposal_count):
                if targeted:
                    document = rng.randrange(DOCS_PER_SET)
                    first = assigned[participant][document]
                    if condition not in first:
                        continue
                    other = rng.randrange(PARTICIPANTS)
                    second = assigned[other][document]
                    if (
                        other == participant
                        or condition in second
                        or error[other, condition] >= 0
                        or first == second
                    ):
                        continue
                else:
                    document = rng.randrange(DOCS_PER_SET)
                    participant, other = rng.sample(range(PARTICIPANTS), 2)
                    first = assigned[participant][document]
                    second = assigned[other][document]
                    if first == second:
                        continue

                delta = 0
                first_set, second_set = set(first), set(second)
                for changed in first_set.symmetric_difference(second_set):
                    change = (changed in second_set) - (changed in first_set)
                    before_first = int(error[participant, changed])
                    before_other = int(error[other, changed])
                    delta += (before_first + change) ** 2 - before_first ** 2
                    delta += (before_other - change) ** 2 - before_other ** 2
                candidates.append((delta, document, participant, other, first, second))

            if not candidates:
                continue
            delta, document, participant, other, first, second = min(candidates)
            if delta > 0 and rng.random() >= math.exp(-delta / max(temperature, 1e-9)):
                temperature = max(0.03, temperature * 0.999995)
                continue

            assigned[participant][document], assigned[other][document] = second, first
            for changed in set(first).symmetric_difference(second):
                change = (changed in second) - (changed in first)
                error[participant, changed] += change
                error[other, changed] -= change
            score += delta
            temperature = max(0.03, temperature * 0.999995)

        best_score = min(best_score, score)
        print(
            f"Participant-triple restart {restart + 1}: residual score={score}",
            flush=True,
        )

    raise RuntimeError(
        f"Could not balance participant condition totals; best residual score={best_score}."
    )


def solve_set_permutations(assigned_triples, participant_sequences):
    participant_targets = np.asarray([
        [
            [
                Counter(participant_sequences[participant][set_index])[condition]
                for condition in range(CONDITION_COUNT)
            ]
            for set_index in range(SETS)
        ]
        for participant in range(PARTICIPANTS)
    ], dtype=np.int16)
    rng = seeded_random("set-permutation-balancing")
    best_score = math.inf

    for restart in range(30):
        assigned = [[None] * DOCS_PER_SET for _ in range(PARTICIPANTS)]
        participant_counts = np.zeros(
            (PARTICIPANTS, SETS, CONDITION_COUNT), dtype=np.int16
        )
        document_counts = np.zeros(
            (DOCS_PER_SET, SETS, CONDITION_COUNT), dtype=np.int16
        )
        for participant in range(PARTICIPANTS):
            for document in range(DOCS_PER_SET):
                permutation = list(assigned_triples[participant][document])
                rng.shuffle(permutation)
                assigned[participant][document] = permutation
                for set_index, condition in enumerate(permutation):
                    participant_counts[participant, set_index, condition] += 1
                    document_counts[document, set_index, condition] += 1

        participant_error = participant_counts - participant_targets
        document_error = document_counts - 5
        score = int(
            np.square(participant_error, dtype=np.int32).sum()
            + np.square(document_error, dtype=np.int32).sum()
        )
        temperature = 2.5

        for attempt in range(2_000_000):
            if score == 0:
                return [[tuple(value) for value in row] for row in assigned]

            target_participant = rng.random() < 0.55
            found_target = False
            for _pick in range(120):
                if target_participant:
                    participant = rng.randrange(PARTICIPANTS)
                    set_index = rng.randrange(SETS)
                    condition = rng.randrange(CONDITION_COUNT)
                    if participant_error[participant, set_index, condition] > 0:
                        found_target = True
                        break
                else:
                    document = rng.randrange(DOCS_PER_SET)
                    set_index = rng.randrange(SETS)
                    condition = rng.randrange(CONDITION_COUNT)
                    if document_error[document, set_index, condition] > 0:
                        found_target = True
                        break
            if not found_target:
                continue

            candidates = []
            for _proposal in range(64):
                if target_participant:
                    document = rng.randrange(DOCS_PER_SET)
                    if assigned[participant][document][set_index] != condition:
                        continue
                else:
                    participant = rng.randrange(PARTICIPANTS)
                    if assigned[participant][document][set_index] != condition:
                        continue
                other_set = rng.choice([value for value in range(SETS) if value != set_index])
                first_condition = assigned[participant][document][set_index]
                second_condition = assigned[participant][document][other_set]
                adjustments = (
                    (participant_error, (participant, set_index, first_condition), -1),
                    (participant_error, (participant, set_index, second_condition), 1),
                    (participant_error, (participant, other_set, second_condition), -1),
                    (participant_error, (participant, other_set, first_condition), 1),
                    (document_error, (document, set_index, first_condition), -1),
                    (document_error, (document, set_index, second_condition), 1),
                    (document_error, (document, other_set, second_condition), -1),
                    (document_error, (document, other_set, first_condition), 1),
                )
                delta = sum(
                    (int(array[index]) + change) ** 2 - int(array[index]) ** 2
                    for array, index, change in adjustments
                )
                candidates.append((
                    delta,
                    participant,
                    document,
                    set_index,
                    other_set,
                    adjustments,
                ))

            if not candidates:
                continue
            delta, participant, document, set_index, other_set, adjustments = min(
                candidates, key=lambda item: item[0]
            )
            if delta > 0 and rng.random() >= math.exp(-delta / max(temperature, 1e-9)):
                temperature = max(0.03, temperature * 0.999995)
                continue

            assigned[participant][document][set_index], assigned[participant][document][other_set] = (
                assigned[participant][document][other_set],
                assigned[participant][document][set_index],
            )
            for array, index, change in adjustments:
                array[index] += change
            score += delta
            temperature = max(0.03, temperature * 0.999995)

        best_score = min(best_score, score)
        print(
            f"Set-permutation restart {restart + 1}: residual score={score}",
            flush=True,
        )

    raise RuntimeError(
        f"Could not balance set permutations; best residual score={best_score}."
    )


def map_documents_to_positions(set_conditions, participant_sequences, order_targets):
    mapped_orders = [[None] * SETS for _ in range(PARTICIPANTS)]
    rng = seeded_random("document-position-mapping")
    participant_order = list(range(PARTICIPANTS))
    rng.shuffle(participant_order)

    for participant in participant_order:
        variable_meta = []
        variable_index = {}
        for set_index in range(SETS):
            for position in range(DOCS_PER_SET):
                required_condition = participant_sequences[participant][set_index][position]
                for document in range(DOCS_PER_SET):
                    if set_conditions[participant][document][set_index] == required_condition:
                        variable_index[(set_index, position, document)] = len(variable_meta)
                        variable_meta.append((set_index, position, document))

        builder = SparseConstraintBuilder(len(variable_meta))
        for set_index in range(SETS):
            for position in range(DOCS_PER_SET):
                builder.add((
                    (index, 1)
                    for (item_set, item_position, _document), index in variable_index.items()
                    if item_set == set_index and item_position == position
                ), 1, 1)
            for document in range(DOCS_PER_SET):
                builder.add((
                    (index, 1)
                    for (item_set, _position, item_document), index in variable_index.items()
                    if item_set == set_index and item_document == document
                ), 1, 1)
            for position in range(DOCS_PER_SET - 1):
                for writer in range(DOCS_PER_SET // 2):
                    entries = []
                    for adjacent_position in (position, position + 1):
                        for document in (writer * 2, writer * 2 + 1):
                            index = variable_index.get((set_index, adjacent_position, document))
                            if index is not None:
                                entries.append((index, 1))
                    if entries:
                        builder.add(entries, 0, 1)

        for position in range(DOCS_PER_SET):
            for document in range(DOCS_PER_SET):
                entries = [
                    (index, 1)
                    for (set_index, item_position, item_document), index in variable_index.items()
                    if item_position == position and item_document == document
                ]
                if len(entries) > 1:
                    builder.add(entries, 0, 1)

        for boundary_set in range(SETS - 1):
            for document in range(DOCS_PER_SET):
                entries = [
                    (index, 1)
                    for (set_index, position, item_document), index in variable_index.items()
                    if item_document == document and (
                        (set_index == boundary_set and position >= DOCS_PER_SET - 5)
                        or (set_index == boundary_set + 1 and position < 5)
                    )
                ]
                if len(entries) > 1:
                    builder.add(entries, 0, 1)

        result = milp(
            c=np.asarray([
                abs(order_targets[participant][set_index].index(document) - position)
                + rng.random() * 1e-4
                for set_index, position, document in variable_meta
            ]),
            integrality=np.ones(len(variable_meta), dtype=np.uint8),
            bounds=Bounds(np.zeros(len(variable_meta)), np.ones(len(variable_meta))),
            constraints=builder.linear_constraint(),
            options={"time_limit": 30, "mip_rel_gap": 0.0, "presolve": True},
        )
        if result.x is None or not result.success:
            raise RuntimeError(
                f"Document position mapping failed for slot {participant + 1}: {result.message}"
            )
        for set_index in range(SETS):
            row = [-1] * DOCS_PER_SET
            for index, (item_set, position, document) in enumerate(variable_meta):
                if item_set == set_index and result.x[index] > 0.5:
                    row[position] = document
            mapped_orders[participant][set_index] = row
    return mapped_orders


def build_records(orders, set_conditions, assigned_triples, stimulus_by_doc):
    records = []
    for participant in range(PARTICIPANTS):
        allocation_id = f"{ASSIGNMENT_VERSION}-slot-{participant + 1:02d}"
        for set_index in range(SETS):
            for position, document in enumerate(orders[participant][set_index]):
                document_id = DOCUMENTS[document]
                condition = set_conditions[participant][document][set_index]
                condition_id = CONDITIONS[condition]
                triple = assigned_triples[participant][document]
                triple_ids = [CONDITIONS[value] for value in triple]
                set_order = set_conditions[participant][document]
                permutation = tuple(triple.index(value) for value in set_order)
                equivalent = stimulus_by_doc[document_id]["condition_meta"]["M_model_optimal"].get(
                    "equivalent_condition_id"
                )
                duplicate_pair = bool(
                    equivalent
                    and "M_model_optimal" in triple_ids
                    and equivalent in triple_ids
                )
                assert not duplicate_pair
                records.append({
                    "allocation_id": allocation_id,
                    "participant_id": None,
                    "participant_slot": participant + 1,
                    "set_id": set_index + 1,
                    "set_trial_index": position + 1,
                    "global_trial_index": set_index * DOCS_PER_SET + position + 1,
                    "document_id": document_id,
                    "document_index": document + 1,
                    "condition_id": condition_id,
                    "enriched_file": f"{condition_id}.html",
                    "degree_value": condition + 1,
                    "baseline_side": None,
                    "enriched_side": None,
                    "document_exposure_number": set_index + 1,
                    "randomization_seed": (
                        f"{ASSIGNMENT_SEED}:slot:{participant + 1}:set:{set_index + 1}:"
                        "carryover-balanced-v2"
                    ),
                    "fano_block_id": chr(ord("A") + participant % CONDITION_COUNT),
                    "set_permutation_id": "".join(str(value + 1) for value in permutation),
                    "set_permutation_parity": permutation_parity(permutation),
                    "assigned_condition_triple": triple_ids,
                    "model_optimal_equivalent_condition_id": equivalent,
                    "within_document_visual_duplicate": False,
                    "rating": None,
                    "response_time": None,
                    "assignment_version": ASSIGNMENT_VERSION,
                    "study_version": STUDY_VERSION,
                })
    return records


def solve_sides(records: list[dict]) -> None:
    builder = SparseConstraintBuilder(len(records))
    grouped = defaultdict(list)
    for index, record in enumerate(records):
        grouped[("participant_set", record["participant_slot"], record["set_id"])].append(index)
        grouped[("document_condition_set", record["document_id"], record["condition_id"], record["set_id"])].append(index)
        grouped[("condition_position", record["condition_id"], record["global_trial_index"])].append(index)
        grouped[("global_position", record["global_trial_index"])].append(index)

    for key, indices in grouped.items():
        if key[0] == "participant_set":
            lower = upper = 19
        elif key[0] == "document_condition_set":
            lower, upper = 2, 3
        elif key[0] == "condition_position":
            lower, upper = 2, 3
        elif key[0] == "global_position":
            lower, upper = 17, 18
        else:
            continue
        builder.add(((index, 1) for index in indices), lower, upper)

    by_participant = defaultdict(list)
    for index, record in enumerate(records):
        by_participant[record["participant_slot"]].append(
            (record["global_trial_index"], index)
        )
    for ordered in by_participant.values():
        indices = [index for _position, index in sorted(ordered)]
        for start in range(len(indices) - 3):
            builder.add(((index, 1) for index in indices[start:start + 4]), 1, 3)

    result = milp(
        c=np.zeros(len(records)),
        integrality=np.ones(len(records), dtype=np.uint8),
        bounds=Bounds(np.zeros(len(records)), np.ones(len(records))),
        constraints=builder.linear_constraint(),
        options={"time_limit": 180, "mip_rel_gap": 0.0, "presolve": True},
    )
    if result.x is None or not result.success:
        raise RuntimeError(f"Side allocation failed: {result.message}")
    for index, record in enumerate(records):
        record["baseline_side"] = "left" if result.x[index] > 0.5 else "right"
        record["enriched_side"] = "right" if record["baseline_side"] == "left" else "left"


def attention_schedule(participant: int) -> list[dict]:
    positions = list(range(9, 30))
    responses = (1, 3, 1)
    return [
        {
            "set_id": set_index + 1,
            "within_set_after_trial": positions[
                (participant + set_index * 7) % len(positions)
            ],
            "after_trial": (
                set_index * DOCS_PER_SET
                + positions[(participant + set_index * 7) % len(positions)]
            ),
            "response": responses[set_index],
        }
        for set_index in range(SETS)
    ]


def count_range(counter: Counter) -> list[int]:
    return [min(counter.values()), max(counter.values())]


def validate(records: list[dict], block_metadata: list[dict]) -> dict:
    assert len(records) == PARTICIPANTS * TRIALS_PER_PARTICIPANT
    count = lambda key: Counter(key(record) for record in records)
    assert set(count(lambda row: row["participant_slot"]).values()) == {114}
    assert set(count(lambda row: (row["participant_slot"], row["set_id"])).values()) == {38}
    assert set(count(lambda row: (row["participant_slot"], row["document_id"])).values()) == {3}
    assert set(count(lambda row: (row["document_id"], row["condition_id"])).values()) == {15}
    assert set(count(lambda row: (row["document_id"], row["condition_id"], row["set_id"])).values()) == {5}
    assert set(count(lambda row: (row["condition_id"], row["global_trial_index"])).values()) == {5}

    participant_condition = count(lambda row: (row["participant_slot"], row["condition_id"]))
    participant_set_condition = count(
        lambda row: (row["participant_slot"], row["set_id"], row["condition_id"])
    )
    for participant in range(1, PARTICIPANTS + 1):
        assert sorted(
            participant_condition[(participant, condition)] for condition in CONDITIONS
        ) == [16] * 5 + [17] * 2
        for set_id in range(1, SETS + 1):
            assert sorted(
                participant_set_condition[(participant, set_id, condition)]
                for condition in CONDITIONS
            ) == [5] * 4 + [6] * 3

    pair_counts = Counter()
    participant_pair_counts = Counter()
    duplicate_cases = []
    writer_pair_adjacencies = 0
    boundary_overlaps = 0
    repeated_positions = 0
    ordered_condition_transitions = Counter()
    within_set_transitions = Counter()
    maximum_side_run = 0
    unique_orders = set()

    for participant in range(1, PARTICIPANTS + 1):
        selected = sorted(
            (row for row in records if row["participant_slot"] == participant),
            key=lambda row: row["global_trial_index"],
        )
        condition_order = [row["condition_id"] for row in selected]
        assert all(left != right for left, right in zip(condition_order, condition_order[1:]))
        ordered_condition_transitions.update(zip(condition_order, condition_order[1:]))
        side_order = [row["baseline_side"] for row in selected]
        run = 1
        for left, right in zip(side_order, side_order[1:]):
            run = run + 1 if left == right else 1
            maximum_side_run = max(maximum_side_run, run)

        set_rows = []
        for set_id in range(1, SETS + 1):
            current = [row for row in selected if row["set_id"] == set_id]
            set_rows.append(current)
            unique_orders.add(tuple(row["document_id"] for row in current))
            within_set_transitions.update(zip(
                [row["condition_id"] for row in current[:-1]],
                [row["condition_id"] for row in current[1:]],
            ))
            writer_pair_adjacencies += sum(
                (left["document_index"] - 1) // 2 == (right["document_index"] - 1) // 2
                for left, right in zip(current, current[1:])
            )
            if set_id > 1:
                boundary_overlaps += len(
                    {row["document_id"] for row in set_rows[-2][-5:]}
                    .intersection(row["document_id"] for row in current[:5])
                )

        for document_id in DOCUMENTS:
            document_rows = [row for row in selected if row["document_id"] == document_id]
            assert len({row["condition_id"] for row in document_rows}) == 3
            if len({row["set_trial_index"] for row in document_rows}) != 3:
                repeated_positions += 1
            triple = tuple(sorted(row["condition_id"] for row in document_rows))
            for pair in itertools.combinations(triple, 2):
                pair_counts[(document_id, *pair)] += 1
                participant_pair_counts[(participant, *pair)] += 1
            equivalent = document_rows[0]["model_optimal_equivalent_condition_id"]
            if equivalent and "M_model_optimal" in triple and equivalent in triple:
                duplicate_cases.append((participant, document_id))
            assert not any(row["within_document_visual_duplicate"] for row in document_rows)

    assert not duplicate_cases
    for document_index, document_id in enumerate(DOCUMENTS):
        metadata = block_metadata[document_index]
        for left, right in PAIRS:
            pair_names = tuple(sorted((CONDITIONS[left], CONDITIONS[right])))
            actual = pair_counts[(document_id, *pair_names)]
            if metadata["forbidden_pair"] is None:
                assert actual == 5
            else:
                target = metadata["pair_targets"][f"{CONDITIONS[left]}|{CONDITIONS[right]}"]
                assert actual == target

    allowed_ordered_pairs = [
        (left, right) for left in CONDITIONS for right in CONDITIONS if left != right
    ]
    transition_values = [ordered_condition_transitions[pair] for pair in allowed_ordered_pairs]
    within_set_values = [within_set_transitions[pair] for pair in allowed_ordered_pairs]
    assert set(transition_values) == {94, 95}
    assert set(within_set_values) == {92, 93}

    participant_set_side = count(
        lambda row: (row["participant_slot"], row["set_id"], row["baseline_side"])
    )
    assert set(participant_set_side.values()) == {19}
    left_records = [row for row in records if row["baseline_side"] == "left"]
    left_count = lambda key: Counter(key(row) for row in left_records)
    document_condition_set_side = left_count(
        lambda row: (row["document_id"], row["condition_id"], row["set_id"])
    )
    assert set(document_condition_set_side.values()) == {2, 3}
    condition_position_side = left_count(
        lambda row: (row["condition_id"], row["global_trial_index"])
    )
    assert set(condition_position_side.values()) == {2, 3}
    global_position_side = left_count(lambda row: row["global_trial_index"])
    assert set(global_position_side.values()) == {17, 18}
    assert maximum_side_run <= 3
    assert writer_pair_adjacencies == 0
    assert boundary_overlaps == 0
    assert repeated_positions == 0
    assert len(unique_orders) == PARTICIPANTS * SETS

    attention_counts = Counter()
    for participant in range(PARTICIPANTS):
        for check in attention_schedule(participant):
            attention_counts[(check["set_id"], check["within_set_after_trial"])] += 1
    assert set(attention_counts.values()) == {1, 2}
    attention_across_sets = Counter(
        check["within_set_after_trial"]
        for participant in range(PARTICIPANTS)
        for check in attention_schedule(participant)
    )
    assert set(attention_across_sets.values()) == {5}

    return {
        "duplicate_participant_document_cases": 0,
        "ordered_condition_transition_frequency": [
            min(transition_values),
            max(transition_values),
        ],
        "within_set_ordered_transition_frequency": [
            min(within_set_values),
            max(within_set_values),
        ],
        "participant_pair_frequency": count_range(participant_pair_counts),
        "condition_position_side_frequency": [
            min(
                condition_position_side[(condition, position)]
                for condition in CONDITIONS
                for position in range(1, TRIALS_PER_PARTICIPANT + 1)
            ),
            max(
                condition_position_side[(condition, position)]
                for condition in CONDITIONS
                for position in range(1, TRIALS_PER_PARTICIPANT + 1)
            ),
        ],
        "global_position_side_frequency": [
            min(global_position_side[position] for position in range(1, TRIALS_PER_PARTICIPANT + 1)),
            max(global_position_side[position] for position in range(1, TRIALS_PER_PARTICIPANT + 1)),
        ],
        "maximum_baseline_side_run": maximum_side_run,
        "writer_pair_adjacencies": writer_pair_adjacencies,
        "unique_document_orders": len(unique_orders),
        "attention_position_frequency_per_set": [1, 2],
        "attention_position_frequency_across_sets": 5,
    }


def csv_cell(value) -> str:
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if value is None:
        value = ""
    text = str(value)
    if any(character in text for character in ('"', ",", "\n")):
        return '"' + text.replace('"', '""') + '"'
    return text


def main() -> None:
    stimulus_index = json.loads(STIMULI_INDEX.read_text())
    stimulus_by_doc = {item["doc_id"]: item for item in stimulus_index["documents"]}
    assert set(stimulus_by_doc) == set(DOCUMENTS)

    participant_sequences, carryover_metadata = build_carryover_sequences()
    print("Carryover-balanced condition sequences solved.", flush=True)
    block_multisets, block_metadata = build_document_blocks(stimulus_by_doc)
    print("Document-specific no-duplicate block designs solved.", flush=True)
    assigned_triples = solve_participant_triples(block_multisets, participant_sequences)
    print("Participant triples solved.", flush=True)
    set_conditions = solve_set_permutations(assigned_triples, participant_sequences)
    print("Set permutations solved.", flush=True)
    order_targets = build_order_targets()
    orders = map_documents_to_positions(set_conditions, participant_sequences, order_targets)
    print("Document positions solved.", flush=True)
    records = build_records(orders, set_conditions, assigned_triples, stimulus_by_doc)
    solve_sides(records)
    print("Left/right allocation solved.", flush=True)
    validation = validate(records, block_metadata)

    OUT.mkdir(parents=True, exist_ok=True)
    SLOTS_OUT.mkdir(parents=True, exist_ok=True)
    for path in SLOTS_OUT.glob("slot-*.json"):
        path.unlink()

    allocation_hash = digest(json.dumps(records, ensure_ascii=False, separators=(",", ":")))
    master = {
        "schema_version": "text-enrichment-allocation-v4",
        "study_version": STUDY_VERSION,
        "assignment_version": ASSIGNMENT_VERSION,
        "assignment_seed": ASSIGNMENT_SEED,
        "participant_slots": PARTICIPANTS,
        "sets_per_participant": SETS,
        "trials_per_set": DOCS_PER_SET,
        "trials_per_participant": TRIALS_PER_PARTICIPANT,
        "total_trials": len(records),
        "allocation_sha256": allocation_hash,
        "constraints": {
            "participant_document_distinct_conditions": 3,
            "participant_condition_total": [16, 17],
            "document_condition_readers": 15,
            "document_condition_set_readers": 5,
            "participant_set_condition_frequency": [5, 6],
            "condition_global_position_readers": 5,
            "model_equivalent_pair_cooccurrence": 0,
            "novel_document_pair_cooccurrence": 5,
            "equivalence_document_allowed_pair_frequency": [4, 6],
            "ordered_condition_transition_frequency": [94, 95],
            "participant_set_baseline_side": {"left": 19, "right": 19},
            "document_condition_set_baseline_side": [2, 3],
            "condition_global_position_baseline_side": [2, 3],
            "global_position_baseline_side": [17, 18],
            "max_same_condition_run": 1,
            "max_same_baseline_side_run": 3,
            "same_writer_documents_adjacent": False,
            "set_boundary_document_overlap_window": 5,
        },
        "carryover_design": carryover_metadata,
        "document_block_designs": {
            DOCUMENTS[index]: metadata for index, metadata in enumerate(block_metadata)
        },
        "validation": validation,
        "records": records,
    }
    (OUT / "master-assignment.json").write_text(
        json.dumps(master, ensure_ascii=False, indent=2) + "\n"
    )
    headers = list(records[0])
    csv_rows = [",".join(headers)] + [
        ",".join(csv_cell(record[key]) for key in headers)
        for record in records
    ]
    (OUT / "master-assignment.csv").write_text("\n".join(csv_rows) + "\n")

    slot_index = []
    for participant in range(1, PARTICIPANTS + 1):
        trials = [row for row in records if row["participant_slot"] == participant]
        slot_hash = digest(json.dumps(trials, ensure_ascii=False, separators=(",", ":")))
        payload = {
            "schema_version": "text-enrichment-slot-allocation-v4",
            "study_version": STUDY_VERSION,
            "assignment_version": ASSIGNMENT_VERSION,
            "assignment_seed": ASSIGNMENT_SEED,
            "allocation_id": trials[0]["allocation_id"],
            "participant_slot": participant,
            "trial_count": len(trials),
            "allocation_sha256": slot_hash,
            "attention_checks": attention_schedule(participant - 1),
            "trials": trials,
        }
        filename = f"slot-{participant:02d}.json"
        (SLOTS_OUT / filename).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        )
        slot_index.append({
            "participant_slot": participant,
            "allocation_id": payload["allocation_id"],
            "file": f"slots/{filename}",
            "allocation_sha256": slot_hash,
            "attention_checks": payload["attention_checks"],
        })
    (OUT / "index.json").write_text(json.dumps({
        "schema_version": "text-enrichment-allocation-index-v4",
        "study_version": STUDY_VERSION,
        "assignment_version": ASSIGNMENT_VERSION,
        "allocation_sha256": allocation_hash,
        "participant_slots": slot_index,
        "validation": validation,
    }, ensure_ascii=False, indent=2) + "\n")

    print(json.dumps({
        "study_version": STUDY_VERSION,
        "assignment_version": ASSIGNMENT_VERSION,
        "participants": PARTICIPANTS,
        "trials_per_participant": TRIALS_PER_PARTICIPANT,
        "total_trials": len(records),
        "allocation_sha256": allocation_hash,
        "validation": validation,
    }, indent=2))


if __name__ == "__main__":
    main()
