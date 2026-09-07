#!/usr/bin/env python3
"""Generate the locked 42-slot Study 3 allocation.

The condition allocation is solved as one binary MILP. It preserves the per-document
Fano-plane balance while rotating the labeled Fano system across documents so that
participant-level 17/16 and per-set 6/5 marginals are arithmetically attainable.
"""

from __future__ import annotations

import hashlib
import itertools
import json
import math
import os
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
STAGE_CACHE = ROOT / "assignments" / "fano-stage.json"

STUDY_VERSION = "2026-09-07-study3-v1"
ASSIGNMENT_VERSION = "n42-study3-fano-v1"
ASSIGNMENT_SEED = "text-enrichment-reader-study3-n42-v1"
PARTICIPANTS = 42
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
BASE_FANO_ROWS = [
    (0, 1, 6),  # A: D1, D2, M
    (1, 2, 3),  # B: D2, W, D3
    (2, 6, 4),  # C: W, M, D4
    (6, 3, 5),  # D: M, D3, D5
    (3, 4, 0),  # E: D3, D4, D1
    (4, 5, 1),  # F: D4, D5, D2
    (5, 0, 2),  # G: D5, D1, W
]
SET_PERMUTATIONS = list(itertools.permutations(range(3)))


def permutation_parity(permutation: tuple[int, ...]) -> int:
    """Return 0 for an even permutation and 1 for an odd permutation."""
    return sum(permutation[left] > permutation[right]
               for left in range(len(permutation))
               for right in range(left + 1, len(permutation))) % 2


def digest(value: str | bytes) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def make_williams_row(index: int) -> list[int]:
    base = [0]
    for step in range(1, DOCS_PER_SET):
        base.append((step + 1) // 2 if step % 2 else DOCS_PER_SET - step // 2)
    return [((value + index) % DOCS_PER_SET) for value in base]


def row_violations(row: list[int], earlier: list[list[int]], previous: list[int] | None) -> int:
    penalty = 0
    penalty += 100 * sum(row[i] // 2 == row[i + 1] // 2 for i in range(len(row) - 1))
    for old in earlier:
        penalty += 100 * sum(value == old[position] for position, value in enumerate(row))
    if previous is not None:
        penalty += 100 * len(set(previous[-5:]).intersection(row[:5]))
    return penalty


def repair_order(target: list[int], earlier: list[list[int]], previous: list[int] | None, seed: int) -> list[int]:
    rng = random.Random(seed)
    current = target[:]
    score = row_violations(current, earlier, previous)
    if score == 0:
        return current
    best, best_score = current[:], score
    temperature = 2.0
    for attempt in range(200_000):
        i, j = rng.sample(range(DOCS_PER_SET), 2)
        current[i], current[j] = current[j], current[i]
        proposed = row_violations(current, earlier, previous)
        accept = proposed <= score or rng.random() < math.exp((score - proposed) / max(temperature, 1e-6))
        if accept:
            score = proposed
            if score < best_score:
                best, best_score = current[:], score
                if best_score == 0:
                    return best
        else:
            current[i], current[j] = current[j], current[i]
        temperature *= 0.99995
    raise RuntimeError(f"Could not repair constrained document order; best violation score={best_score}.")


def build_orders() -> tuple[list[list[list[int]]], dict]:
    seed_base = int(digest(ASSIGNMENT_SEED + ":orders")[:16], 16)
    orders: list[list[list[int]]] = []
    sequence_indices: list[list[int]] = []
    for participant in range(PARTICIPANTS):
        participant_orders: list[list[int]] = []
        participant_indices: list[int] = []
        for set_index, shift in enumerate((0, 13, 26)):
            sequence_index = (participant + shift) % DOCS_PER_SET
            target = make_williams_row(sequence_index)
            repaired = repair_order(
                target,
                participant_orders,
                participant_orders[-1] if participant_orders else None,
                seed_base + participant * 101 + set_index,
            )
            participant_orders.append(repaired)
            participant_indices.append(sequence_index)
        orders.append(participant_orders)
        sequence_indices.append(participant_indices)

    for participant, participant_orders in enumerate(orders):
        for set_index, row in enumerate(participant_orders):
            assert sorted(row) == list(range(DOCS_PER_SET))
            assert all(row[i] // 2 != row[i + 1] // 2 for i in range(DOCS_PER_SET - 1))
            for old in participant_orders[:set_index]:
                assert all(value != old[position] for position, value in enumerate(row))
            if set_index:
                assert not set(participant_orders[set_index - 1][-5:]).intersection(row[:5])

    position_counts = Counter()
    transition_counts = Counter()
    for participant_orders in orders:
        for set_index, row in enumerate(participant_orders):
            for position, document in enumerate(row):
                position_counts[(set_index, position, document)] += 1
            for left, right in zip(row, row[1:]):
                transition_counts[(left, right)] += 1
    allowed_transitions = [
        transition_counts[(left, right)]
        for left in range(DOCS_PER_SET)
        for right in range(DOCS_PER_SET)
        if left != right and left // 2 != right // 2
    ]
    return orders, {
        "family": "Williams-38 with deterministic paired-document repairs",
        "sequence_indices": sequence_indices,
        "position_frequency_range": [min(position_counts.values()), max(position_counts.values())],
        "allowed_directed_transition_frequency_range": [min(allowed_transitions), max(allowed_transitions)],
        "forbidden_writer_pair_transitions": 0,
    }


def make_document_candidates() -> tuple[list[list[dict]], list[dict]]:
    rng = random.Random(int(digest(ASSIGNMENT_SEED + ":fano-systems")[:16], 16))
    systems = []
    for _ in range(DOCS_PER_SET):
        labels = list(range(len(CONDITIONS)))
        rows = list(range(len(BASE_FANO_ROWS)))
        rng.shuffle(labels)
        rng.shuffle(rows)
        systems.append({"labels": labels, "rows": rows})

    def matrix(system):
        output = [[0] * len(CONDITIONS) for _ in range(len(BASE_FANO_ROWS))]
        for slot, row_index in enumerate(system["rows"]):
            for value in BASE_FANO_ROWS[row_index]:
                output[slot][system["labels"][value]] = 1
        return output

    matrices = [matrix(system) for system in systems]
    totals = [[sum(matrices[document][slot][condition] for document in range(DOCS_PER_SET))
               for condition in range(len(CONDITIONS))]
              for slot in range(len(BASE_FANO_ROWS))]

    def error_value(value):
        return (16 - value) ** 2 if value < 16 else (value - 17) ** 2 if value > 17 else 0

    score = sum(error_value(value) for row in totals for value in row)
    best_score = score
    best_systems = json.loads(json.dumps(systems))
    temperature = 2.0
    for attempt in range(2_000_000):
        if score == 0:
            break
        document = rng.randrange(DOCS_PER_SET)
        kind = rng.choice(("labels", "rows"))
        first, second = rng.sample(range(len(CONDITIONS)), 2)
        old_matrix = matrices[document]
        affected = {(slot, condition) for slot in range(len(CONDITIONS))
                    for condition in range(len(CONDITIONS)) if old_matrix[slot][condition]}
        systems[document][kind][first], systems[document][kind][second] = (
            systems[document][kind][second], systems[document][kind][first]
        )
        new_matrix = matrix(systems[document])
        affected.update((slot, condition) for slot in range(len(CONDITIONS))
                        for condition in range(len(CONDITIONS)) if new_matrix[slot][condition])
        before = sum(error_value(totals[slot][condition]) for slot, condition in affected)
        for slot, condition in affected:
            totals[slot][condition] += new_matrix[slot][condition] - old_matrix[slot][condition]
        after = sum(error_value(totals[slot][condition]) for slot, condition in affected)
        delta = after - before
        if delta <= 0 or rng.random() < math.exp(-delta / max(temperature, 1e-9)):
            matrices[document] = new_matrix
            score += delta
            if score < best_score:
                best_score = score
                best_systems = json.loads(json.dumps(systems))
        else:
            for slot, condition in affected:
                totals[slot][condition] -= new_matrix[slot][condition] - old_matrix[slot][condition]
            systems[document][kind][first], systems[document][kind][second] = (
                systems[document][kind][second], systems[document][kind][first]
            )
        temperature = max(0.02, temperature * 0.999995)
        if attempt and attempt % 100_000 == 0:
            systems = json.loads(json.dumps(best_systems))
            matrices = [matrix(system) for system in systems]
            totals = [[sum(matrices[d][slot][condition] for d in range(DOCS_PER_SET))
                       for condition in range(len(CONDITIONS))]
                      for slot in range(len(BASE_FANO_ROWS))]
            score = sum(error_value(value) for row in totals for value in row)
            temperature = 1.0
    if score:
        raise RuntimeError(f"Could not balance the rotated Fano systems; best score={best_score}.")

    candidates: list[list[dict]] = []
    system_metadata: list[dict] = []
    for system in systems:
        system_metadata.append({
            "condition_label_permutation": system["labels"],
            "canonical_row_permutation": system["rows"],
        })
        document_candidates = []
        for slot, canonical_row in enumerate(system["rows"]):
            labeled = tuple(system["labels"][value] for value in BASE_FANO_ROWS[canonical_row])
            for permutation in SET_PERMUTATIONS:
                document_candidates.append({
                    "conditions": tuple(labeled[position] for position in permutation),
                    "fano_block_id": chr(ord("A") + slot),
                    "canonical_fano_block_id": chr(ord("A") + canonical_row),
                    "set_permutation_id": "".join(str(position + 1) for position in permutation),
                    "permutation_parity": permutation_parity(permutation),
                    "candidate_index": len(document_candidates),
                })
        assert len(document_candidates) == PARTICIPANTS
        candidates.append(document_candidates)
    return candidates, system_metadata


class SparseConstraintBuilder:
    def __init__(self, variable_count: int):
        self.variable_count = variable_count
        self.rows: list[int] = []
        self.cols: list[int] = []
        self.values: list[float] = []
        self.lower: list[float] = []
        self.upper: list[float] = []

    def add(self, entries, lower: float, upper: float):
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


def solve_condition_assignment(orders: list[list[list[int]]], candidates: list[list[dict]]) -> list[list[int]]:
    """Solve block membership, then the six set permutations, to remove MILP symmetry."""

    block_count = len(BASE_FANO_ROWS)
    # Participants are six replicas of seven Fano slots. Document-specific row and
    # condition permutations were balanced in make_document_candidates().
    selected_block = [[participant % block_count for _ in range(DOCS_PER_SET)]
                      for participant in range(PARTICIPANTS)]
    participant_totals = [[0] * len(CONDITIONS) for _ in range(PARTICIPANTS)]
    for participant in range(PARTICIPANTS):
        for document in range(DOCS_PER_SET):
            for condition in candidates[document][selected_block[participant][document] * len(SET_PERMUTATIONS)]["conditions"]:
                participant_totals[participant][condition] += 1
        assert sorted(participant_totals[participant]) == [16] * 5 + [17] * 2
    print("Fano block margins solved.", flush=True)

    rng_local = random.Random(int(digest(ASSIGNMENT_SEED + ":permutation-search")[:16], 16))

    # Stage 2: within each document-block cell, use all six set permutations exactly
    # once. This balances participant-set marginals; trial-position scheduling is
    # solved separately after the document-condition cells are locked.
    permutation_count = len(SET_PERMUTATIONS)
    permutation_variable_count = DOCS_PER_SET * PARTICIPANTS * permutation_count

    def permutation_variable(document: int, participant: int, permutation: int) -> int:
        return (document * PARTICIPANTS + participant) * permutation_count + permutation

    def condition_for(document: int, participant: int, permutation: int, set_index: int) -> int:
        block = selected_block[participant][document]
        return candidates[document][block * permutation_count + permutation]["conditions"][set_index]

    selected_permutation = [[-1] * DOCS_PER_SET for _ in range(PARTICIPANTS)]
    groups = []
    for document in range(DOCS_PER_SET):
        for block in range(block_count):
            participants = [participant for participant in range(PARTICIPANTS)
                            if selected_block[participant][document] == block]
            assert len(participants) == permutation_count
            values = list(range(permutation_count))
            rng_local.shuffle(values)
            for participant, permutation in zip(participants, values):
                selected_permutation[participant][document] = permutation
            groups.append((document, participants))

    set_counts = [[[0] * len(CONDITIONS) for _ in range(SETS)] for _ in range(PARTICIPANTS)]
    odd_condition_counts = [[[0] * len(CONDITIONS) for _ in range(SETS)] for _ in range(PARTICIPANTS)]
    odd_permutation_counts = [0] * PARTICIPANTS
    for participant in range(PARTICIPANTS):
        for document in range(DOCS_PER_SET):
            permutation = selected_permutation[participant][document]
            odd_permutation_counts[participant] += permutation_parity(SET_PERMUTATIONS[permutation])
            for set_index in range(SETS):
                condition = condition_for(document, participant, permutation, set_index)
                set_counts[participant][set_index][condition] += 1
                odd_condition_counts[participant][set_index][condition] += permutation_parity(SET_PERMUTATIONS[permutation])

    def set_error(participant: int) -> int:
        marginal_error = sum((5 - value) ** 2 if value < 5 else (value - 6) ** 2 if value > 6 else 0
                             for values in set_counts[participant] for value in values)
        category_error = 0
        for set_index in range(SETS):
            for condition in range(len(CONDITIONS)):
                odd = odd_condition_counts[participant][set_index][condition]
                even = set_counts[participant][set_index][condition] - odd
                for value in (odd, even):
                    category_error += (2 - value) ** 2 if value < 2 else (value - 3) ** 2 if value > 3 else 0
        side_error = (odd_permutation_counts[participant] - 19) ** 2
        return marginal_error + category_error + 2 * side_error

    score = sum(set_error(participant) for participant in range(PARTICIPANTS))
    best_score = score
    best_permutation = [row[:] for row in selected_permutation]
    temperature = 3.0
    for attempt in range(6_000_000):
        if score == 0:
            break
        document, participants = rng_local.choice(groups)
        first, second = rng_local.sample(participants, 2)
        first_permutation = selected_permutation[first][document]
        second_permutation = selected_permutation[second][document]
        before = set_error(first) + set_error(second)
        odd_permutation_counts[first] += (
            permutation_parity(SET_PERMUTATIONS[second_permutation])
            - permutation_parity(SET_PERMUTATIONS[first_permutation])
        )
        odd_permutation_counts[second] += (
            permutation_parity(SET_PERMUTATIONS[first_permutation])
            - permutation_parity(SET_PERMUTATIONS[second_permutation])
        )
        for set_index in range(SETS):
            first_old = condition_for(document, first, first_permutation, set_index)
            first_new = condition_for(document, first, second_permutation, set_index)
            second_old = condition_for(document, second, second_permutation, set_index)
            second_new = condition_for(document, second, first_permutation, set_index)
            set_counts[first][set_index][first_old] -= 1
            set_counts[first][set_index][first_new] += 1
            set_counts[second][set_index][second_old] -= 1
            set_counts[second][set_index][second_new] += 1
            odd_condition_counts[first][set_index][first_old] -= permutation_parity(SET_PERMUTATIONS[first_permutation])
            odd_condition_counts[first][set_index][first_new] += permutation_parity(SET_PERMUTATIONS[second_permutation])
            odd_condition_counts[second][set_index][second_old] -= permutation_parity(SET_PERMUTATIONS[second_permutation])
            odd_condition_counts[second][set_index][second_new] += permutation_parity(SET_PERMUTATIONS[first_permutation])
        after = set_error(first) + set_error(second)
        delta = after - before
        if delta <= 0 or rng_local.random() < math.exp(-delta / max(temperature, 1e-9)):
            selected_permutation[first][document], selected_permutation[second][document] = second_permutation, first_permutation
            score += delta
            if score < best_score:
                best_score = score
                best_permutation = [row[:] for row in selected_permutation]
        else:
            odd_permutation_counts[first] -= (
                permutation_parity(SET_PERMUTATIONS[second_permutation])
                - permutation_parity(SET_PERMUTATIONS[first_permutation])
            )
            odd_permutation_counts[second] -= (
                permutation_parity(SET_PERMUTATIONS[first_permutation])
                - permutation_parity(SET_PERMUTATIONS[second_permutation])
            )
            for set_index in range(SETS):
                first_old = condition_for(document, first, first_permutation, set_index)
                first_new = condition_for(document, first, second_permutation, set_index)
                second_old = condition_for(document, second, second_permutation, set_index)
                second_new = condition_for(document, second, first_permutation, set_index)
                set_counts[first][set_index][first_old] += 1
                set_counts[first][set_index][first_new] -= 1
                set_counts[second][set_index][second_old] += 1
                set_counts[second][set_index][second_new] -= 1
                odd_condition_counts[first][set_index][first_old] += permutation_parity(SET_PERMUTATIONS[first_permutation])
                odd_condition_counts[first][set_index][first_new] -= permutation_parity(SET_PERMUTATIONS[second_permutation])
                odd_condition_counts[second][set_index][second_old] += permutation_parity(SET_PERMUTATIONS[second_permutation])
                odd_condition_counts[second][set_index][second_new] -= permutation_parity(SET_PERMUTATIONS[first_permutation])
        temperature = max(0.03, temperature * 0.999999)
        if attempt and attempt % 300_000 == 0:
            temperature = max(temperature, 1.2)

    if score:
        selected_permutation = [row[:] for row in best_permutation]
        unlocked = list(range(DOCS_PER_SET))
        unlocked_index = {document: index for index, document in enumerate(unlocked)}
        residual_variable_count = len(unlocked) * PARTICIPANTS * permutation_count

        def residual_variable(document: int, participant: int, permutation: int) -> int:
            return (unlocked_index[document] * PARTICIPANTS + participant) * permutation_count + permutation

        residual_builder = SparseConstraintBuilder(residual_variable_count)
        for document in unlocked:
            for participant in range(PARTICIPANTS):
                residual_builder.add(((residual_variable(document, participant, permutation), 1)
                                      for permutation in range(permutation_count)), 1, 1)
            for block in range(block_count):
                participants = [participant for participant in range(PARTICIPANTS)
                                if selected_block[participant][document] == block]
                for permutation in range(permutation_count):
                    residual_builder.add(((residual_variable(document, participant, permutation), 1)
                                          for participant in participants), 1, 1)
        fixed_documents = [document for document in range(DOCS_PER_SET) if document not in unlocked_index]
        for participant in range(PARTICIPANTS):
            fixed_odd_count = sum(
                permutation_parity(SET_PERMUTATIONS[selected_permutation[participant][document]])
                for document in fixed_documents
            )
            residual_builder.add(
                ((residual_variable(document, participant, permutation), 1)
                 for document in unlocked
                 for permutation in range(permutation_count)
                 if permutation_parity(SET_PERMUTATIONS[permutation])),
                19 - fixed_odd_count,
                19 - fixed_odd_count,
            )
            for set_index in range(SETS):
                for condition in range(len(CONDITIONS)):
                    fixed_count = sum(
                        condition_for(document, participant, selected_permutation[participant][document], set_index) == condition
                        for document in fixed_documents
                    )
                    residual_builder.add(
                        ((residual_variable(document, participant, permutation), 1)
                         for document in unlocked
                         for permutation in range(permutation_count)
                         if condition_for(document, participant, permutation, set_index) == condition),
                        max(0, 5 - fixed_count),
                        6 - fixed_count,
                    )
                    for parity in (0, 1):
                        fixed_category_count = sum(
                            condition_for(document, participant, selected_permutation[participant][document], set_index) == condition
                            and permutation_parity(SET_PERMUTATIONS[selected_permutation[participant][document]]) == parity
                            for document in fixed_documents
                        )
                        residual_builder.add(
                            ((residual_variable(document, participant, permutation), 1)
                             for document in unlocked
                             for permutation in range(permutation_count)
                             if condition_for(document, participant, permutation, set_index) == condition
                             and permutation_parity(SET_PERMUTATIONS[permutation]) == parity),
                            max(0, 2 - fixed_category_count),
                            3 - fixed_category_count,
                        )
        residual_objective = np.zeros(residual_variable_count)
        residual_result = milp(
            c=residual_objective,
            integrality=np.ones(residual_variable_count, dtype=np.uint8),
            bounds=Bounds(np.zeros(residual_variable_count), np.ones(residual_variable_count)),
            constraints=residual_builder.linear_constraint(),
            options={"time_limit": 180, "mip_rel_gap": 0.0, "presolve": True},
        )
        if residual_result.x is None:
            raise RuntimeError(
                f"Set-permutation residual MILP failed after local score {best_score}: {residual_result.message}"
            )
        for document in unlocked:
            for participant in range(PARTICIPANTS):
                values = [residual_result.x[residual_variable(document, participant, permutation)]
                          for permutation in range(permutation_count)]
                selected_permutation[participant][document] = int(np.argmax(values))
                assert max(values) > 0.5

    for participant in range(PARTICIPANTS):
        assert sum(permutation_parity(SET_PERMUTATIONS[selected_permutation[participant][document]])
                   for document in range(DOCS_PER_SET)) == 19
        for set_index in range(SETS):
            for condition in range(len(CONDITIONS)):
                parities = [permutation_parity(SET_PERMUTATIONS[selected_permutation[participant][document]])
                            for document in range(DOCS_PER_SET)
                            if condition_for(document, participant, selected_permutation[participant][document], set_index)
                            == condition]
                assert len(parities) in (5, 6)
                assert 2 <= sum(parities) <= 3
                assert 2 <= len(parities) - sum(parities) <= 3

    selected = [[selected_block[participant][document] * permutation_count
                 + selected_permutation[participant][document]
                 for document in range(DOCS_PER_SET)]
                for participant in range(PARTICIPANTS)]
    print("Fano set permutations solved.", flush=True)
    return selected


def schedule_and_map_orders(initial_orders, candidates, selected):
    """Balance condition-by-position exactly, then map each participant's documents."""
    condition_sequences = [[None] * SETS for _ in range(PARTICIPANTS)]
    condition_by_document = [
        [candidates[document][selected[participant][document]]["conditions"]
         for document in range(DOCS_PER_SET)]
        for participant in range(PARTICIPANTS)
    ]

    # Every participant has five copies of all seven conditions plus one extra copy
    # of three conditions in each set. Five 7-condition Latin cycles therefore fill
    # positions 1--35 with exact column balance. A small edge-colouring MILP assigns
    # each participant's three extras to positions 36--38, again six per condition
    # and position. This construction is dramatically smaller than a 42x38x7 MILP.
    offsets = (0, 2, 4)
    objective_rng = np.random.default_rng(int(digest(ASSIGNMENT_SEED + ":position-schedules-v2")[:16], 16))
    fixed_side_sequences = [[None] * SETS for _ in range(PARTICIPANTS)]
    for set_index in range(SETS):
        print(f"Solving condition/side extras for set {set_index + 1}.", flush=True)
        extra_positions = 3
        side_values = 2
        variable_count = PARTICIPANTS * len(CONDITIONS) * extra_positions * side_values

        def variable(participant: int, condition: int, extra_position: int, side: int) -> int:
            return (((participant * len(CONDITIONS) + condition) * extra_positions + extra_position)
                    * side_values + side)

        builder = SparseConstraintBuilder(variable_count)
        for participant in range(PARTICIPANTS):
            required = Counter(values[set_index] for values in condition_by_document[participant])
            high_conditions = [condition for condition in range(len(CONDITIONS))
                               if required[condition] == 6]
            assert len(high_conditions) == extra_positions
            assert all(required[condition] in (5, 6) for condition in range(len(CONDITIONS)))
            for extra_position in range(extra_positions):
                builder.add(((variable(participant, condition, extra_position, side), 1)
                             for condition in high_conditions for side in range(side_values)), 1, 1)
            for condition in range(len(CONDITIONS)):
                expected = 1 if condition in high_conditions else 0
                builder.add(((variable(participant, condition, extra_position, side), 1)
                             for extra_position in range(extra_positions) for side in range(side_values)),
                            expected, expected)

            latin_last = (participant + offsets[set_index] + 34) % len(CONDITIONS)
            builder.add(((variable(participant, latin_last, 0, side), 1)
                         for side in range(side_values)), 0, 0)
            if set_index < SETS - 1:
                next_first = (participant + offsets[set_index + 1]) % len(CONDITIONS)
                builder.add(((variable(participant, next_first, extra_positions - 1, side), 1)
                             for side in range(side_values)), 0, 0)

            base_sides = [((participant // len(CONDITIONS)) + position) % 2 for position in range(35)]
            needed_left = 19 - sum(base_sides)
            builder.add(((variable(participant, condition, extra_position, 1), 1)
                         for condition in range(len(CONDITIONS))
                         for extra_position in range(extra_positions)), needed_left, needed_left)
            builder.add(((variable(participant, condition, extra_position, 1), 1)
                         for condition in range(len(CONDITIONS))
                         for extra_position in (0, 1)), 1 - base_sides[-1], 2 - base_sides[-1])
            builder.add(((variable(participant, condition, extra_position, 1), 1)
                         for condition in range(len(CONDITIONS))
                         for extra_position in range(extra_positions)), 1, 2)
            if set_index < SETS - 1:
                next_first_side = (participant // len(CONDITIONS)) % 2
                builder.add(((variable(participant, condition, extra_position, 1), 1)
                             for condition in range(len(CONDITIONS))
                             for extra_position in (1, 2)),
                            1 - next_first_side, 2 - next_first_side)

        for extra_position in range(extra_positions):
            for condition in range(len(CONDITIONS)):
                builder.add(((variable(participant, condition, extra_position, side), 1)
                             for participant in range(PARTICIPANTS) for side in range(side_values)), 6, 6)
                builder.add(((variable(participant, condition, extra_position, 1), 1)
                             for participant in range(PARTICIPANTS)), 3, 3)

        objective = objective_rng.random(variable_count) * 1e-6
        result = milp(
            c=objective,
            integrality=np.ones(variable_count, dtype=np.uint8),
            bounds=Bounds(np.zeros(variable_count), np.ones(variable_count)),
            constraints=builder.linear_constraint(),
            options={"time_limit": 30, "mip_rel_gap": 0.0, "presolve": True},
        )
        if result.x is None:
            raise RuntimeError(f"Set {set_index + 1} extra-position schedule failed: {result.message}")
        for participant in range(PARTICIPANTS):
            sequence = [(participant + offsets[set_index] + position) % len(CONDITIONS)
                        for position in range(35)]
            side_sequence = [((participant // len(CONDITIONS)) + position) % 2 for position in range(35)]
            for extra_position in range(extra_positions):
                values = [sum(result.x[variable(participant, condition, extra_position, side)]
                              for side in range(side_values))
                          for condition in range(len(CONDITIONS))]
                condition = int(np.argmax(values))
                assert values[condition] > 0.5
                sequence.append(condition)
                chosen_side = int(result.x[variable(participant, condition, extra_position, 1)] > 0.5)
                side_sequence.append(chosen_side)
            assert len(sequence) == DOCS_PER_SET
            assert all(left != right for left, right in zip(sequence, sequence[1:]))
            assert sum(side_sequence) == 19
            assert all(1 <= sum(side_sequence[start:start + 3]) <= 2
                       for start in range(DOCS_PER_SET - 2))
            condition_sequences[participant][set_index] = sequence
            fixed_side_sequences[participant][set_index] = side_sequence

    # Document mapping determines each document's three-side pattern directly.
    # The fixed position sequences already guarantee participant/set and
    # condition/position balance plus a maximum side run of two.
    side_by_document = [[[None] * SETS for _document in range(DOCS_PER_SET)]
                        for _participant in range(PARTICIPANTS)]
    mapped_orders = [[None] * SETS for _ in range(PARTICIPANTS)]
    side_sequences = [[None] * SETS for _ in range(PARTICIPANTS)]
    mapping_variant = os.environ.get("STUDY3_MAPPING_VARIANT", "5")
    rng_local = random.Random(int(digest(ASSIGNMENT_SEED + ":document-mapping:" + mapping_variant)[:16], 16))
    target_positions = [[
        {document: position for position, document in enumerate(initial_orders[participant][set_index])}
        for set_index in range(SETS)
    ] for participant in range(PARTICIPANTS)]
    participant_order = list(range(PARTICIPANTS))
    rng_local.shuffle(participant_order)
    for participant in participant_order:
        pairs = []
        for set_index in range(SETS):
            for position in range(DOCS_PER_SET):
                for document in range(DOCS_PER_SET):
                    if condition_by_document[participant][document][set_index] == condition_sequences[participant][set_index][position]:
                        pairs.append((set_index, position, document))
        pair_index = {pair: index for index, pair in enumerate(pairs)}
        builder = SparseConstraintBuilder(len(pairs))
        for set_index in range(SETS):
            for position in range(DOCS_PER_SET):
                builder.add(((index, 1) for (pair_set, pair_position, _), index in pair_index.items()
                             if pair_set == set_index and pair_position == position), 1, 1)
            for document in range(DOCS_PER_SET):
                builder.add(((index, 1) for (pair_set, _, pair_document), index in pair_index.items()
                             if pair_set == set_index and pair_document == document), 1, 1)
            for position in range(DOCS_PER_SET - 1):
                for writer in range(DOCS_PER_SET // 2):
                    entries = []
                    for adjacent in (position, position + 1):
                        for document in (writer * 2, writer * 2 + 1):
                            index = pair_index.get((set_index, adjacent, document))
                            if index is not None:
                                entries.append((index, 1))
                    if entries:
                        builder.add(entries, 0, 1)
        for position in range(DOCS_PER_SET):
            for document in range(DOCS_PER_SET):
                entries = [(index, 1) for (pair_set, pair_position, pair_document), index in pair_index.items()
                           if pair_position == position and pair_document == document]
                if len(entries) > 1:
                    builder.add(entries, 0, 1)
        for boundary_set in range(SETS - 1):
            for document in range(DOCS_PER_SET):
                entries = [
                    (index, 1) for (pair_set, position, pair_document), index in pair_index.items()
                    if pair_document == document and (
                        (pair_set == boundary_set and position >= DOCS_PER_SET - 5)
                        or (pair_set == boundary_set + 1 and position < 5)
                    )
                ]
                if len(entries) > 1:
                    builder.add(entries, 0, 1)
        global_positions = [(set_index, position)
                            for set_index in range(SETS)
                            for position in range(DOCS_PER_SET)]
        for start in range(len(global_positions) - 3):
            window = set(global_positions[start:start + 4])
            entries = [
                (index, 1) for (pair_set, position, document), index in pair_index.items()
                if (pair_set, position) in window
                and (candidates[document][selected[participant][document]]["permutation_parity"]
                     ^ (pair_set % 2)) == 1
            ]
            builder.add(entries, 1, 3)
        result = milp(
            c=np.asarray([abs(target_positions[participant][set_index][document] - position)
                          + rng_local.random() * 1e-4 for set_index, position, document in pairs]),
            integrality=np.ones(len(pairs), dtype=np.uint8),
            bounds=Bounds(np.zeros(len(pairs)), np.ones(len(pairs))),
            constraints=builder.linear_constraint(),
            options={"time_limit": 15, "mip_rel_gap": 0.0, "presolve": True},
        )
        if result.x is None:
            raise RuntimeError(f"Document-order mapping failed for participant {participant + 1}: {result.message}")
        for set_index in range(SETS):
            mapped = [-1] * DOCS_PER_SET
            for index, (pair_set, position, document) in enumerate(pairs):
                if pair_set == set_index and result.x[index] > 0.5:
                    mapped[position] = document
            mapped_orders[participant][set_index] = mapped

    side_by_document = [
        [tuple(candidates[document][selected[participant][document]]["permutation_parity"] ^ (set_index % 2)
               for set_index in range(SETS))
         for document in range(DOCS_PER_SET)]
        for participant in range(PARTICIPANTS)
    ]
    return mapped_orders, side_by_document


def final_order_metrics(orders):
    position_counts = Counter()
    transition_counts = Counter()
    for participant_orders in orders:
        for set_index, row in enumerate(participant_orders):
            for position, document in enumerate(row):
                position_counts[(set_index, position, document)] += 1
            for left, right in zip(row, row[1:]):
                transition_counts[(left, right)] += 1
    all_position_counts = [position_counts[(set_index, position, document)]
                           for set_index in range(SETS)
                           for position in range(DOCS_PER_SET)
                           for document in range(DOCS_PER_SET)]
    allowed = [transition_counts[(left, right)]
               for left in range(DOCS_PER_SET)
               for right in range(DOCS_PER_SET)
               if left != right and left // 2 != right // 2]
    return {
        "family": "Williams-38 targets with exact condition-position remapping",
        "document_position_frequency_range_including_zero": [min(all_position_counts), max(all_position_counts)],
        "allowed_directed_transition_frequency_range_including_zero": [min(allowed), max(allowed)],
        "forbidden_writer_pair_transitions": 0,
    }


def build_records(orders, sides, candidates, selected, order_meta, label_permutations):
    stimulus_index = json.loads(STIMULI_INDEX.read_text())
    stimulus_by_doc = {item["doc_id"]: item for item in stimulus_index["documents"]}
    records = []
    for participant in range(PARTICIPANTS):
        allocation_id = f"{ASSIGNMENT_VERSION}-slot-{participant + 1:02d}"
        participant_conditions = {}
        for document in range(DOCS_PER_SET):
            item = candidates[document][selected[participant][document]]
            participant_conditions[document] = item["conditions"]
        for set_index in range(SETS):
            for position, document in enumerate(orders[participant][set_index]):
                document_id = DOCUMENTS[document]
                item = candidates[document][selected[participant][document]]
                condition_index = item["conditions"][set_index]
                condition_id = CONDITIONS[condition_index]
                triple_ids = [CONDITIONS[value] for value in item["conditions"]]
                equivalent = stimulus_by_doc[document_id]["condition_meta"]["M_model_optimal"].get("equivalent_condition_id")
                duplicate_pair = bool(equivalent and "M_model_optimal" in triple_ids and equivalent in triple_ids)
                global_trial = set_index * DOCS_PER_SET + position + 1
                baseline_left = sides[participant][document][set_index]
                records.append({
                    "allocation_id": allocation_id,
                    "participant_id": None,
                    "participant_slot": participant + 1,
                    "set_id": set_index + 1,
                    "set_trial_index": position + 1,
                    "global_trial_index": global_trial,
                    "document_id": document_id,
                    "document_index": document + 1,
                    "condition_id": condition_id,
                    "enriched_file": f"{condition_id}.html",
                    "degree_value": condition_index + 1,
                    "baseline_side": "left" if baseline_left else "right",
                    "enriched_side": "right" if baseline_left else "left",
                    "document_exposure_number": set_index + 1,
                    "randomization_seed": f"{ASSIGNMENT_SEED}:slot:{participant + 1}:set:{set_index + 1}:position-schedule-v1",
                    "fano_block_id": item["fano_block_id"],
                    "set_permutation_id": item["set_permutation_id"],
                    "set_permutation_parity": item["permutation_parity"],
                    "fano_label_permutation": label_permutations[document],
                    "assigned_condition_triple": triple_ids,
                    "model_optimal_equivalent_condition_id": equivalent,
                    "within_document_visual_duplicate": duplicate_pair,
                    "rating": None,
                    "response_time": None,
                    "assignment_version": ASSIGNMENT_VERSION,
                    "study_version": STUDY_VERSION,
                })
    return records


def solve_sides(records: list[dict]) -> None:
    variable_count = len(records)
    builder = SparseConstraintBuilder(variable_count)
    grouped: dict[tuple, list[int]] = defaultdict(list)
    for index, record in enumerate(records):
        grouped[("participant_set", record["participant_slot"], record["set_id"])].append(index)
        grouped[("doc_condition_set", record["document_id"], record["condition_id"], record["set_id"])].append(index)
        grouped[("condition_position", record["condition_id"], record["global_trial_index"])].append(index)
        grouped[("participant_document", record["participant_slot"], record["document_id"])].append(index)
    for key, indices in grouped.items():
        if key[0] == "participant_set":
            builder.add(((index, 1) for index in indices), 19, 19)
        elif key[0] == "doc_condition_set":
            builder.add(((index, 1) for index in indices), 3, 3)
        elif key[0] == "condition_position":
            builder.add(((index, 1) for index in indices), 3, 3)
        elif key[0] == "participant_document":
            builder.add(((index, 1) for index in indices), 1, 2)

    by_participant = defaultdict(list)
    for index, record in enumerate(records):
        by_participant[record["participant_slot"]].append((record["global_trial_index"], index))
    for ordered in by_participant.values():
        indices = [index for _, index in sorted(ordered)]
        for start in range(len(indices) - 2):
            builder.add(((index, 1) for index in indices[start:start + 3]), 1, 2)

    rng = np.random.default_rng(int(digest(ASSIGNMENT_SEED + ":side-milp")[:16], 16))
    objective = np.zeros(variable_count)
    result = milp(
        c=objective,
        integrality=np.ones(variable_count, dtype=np.uint8),
        bounds=Bounds(np.zeros(variable_count), np.ones(variable_count)),
        constraints=builder.linear_constraint(),
        options={"time_limit": 90, "mip_rel_gap": 0.0, "presolve": True},
    )
    if result.x is None or not result.success:
        raise RuntimeError(f"Side allocation MILP failed: status={result.status}, message={result.message}")
    for index, record in enumerate(records):
        record["baseline_side"] = "left" if result.x[index] > 0.5 else "right"
        record["enriched_side"] = "right" if record["baseline_side"] == "left" else "left"


def attention_schedule(participant: int) -> list[dict]:
    positions = list(range(9, 30))
    responses = (1, 3, 1)
    return [
        {
            "set_id": set_index + 1,
            "within_set_after_trial": positions[(participant + set_index * 7) % len(positions)],
            "after_trial": set_index * DOCS_PER_SET + positions[(participant + set_index * 7) % len(positions)],
            "response": responses[set_index],
        }
        for set_index in range(SETS)
    ]


def csv_cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, (list, dict)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    text = str(value)
    if any(character in text for character in ',"\r\n'):
        return '"' + text.replace('"', '""') + '"'
    return text


def validate(records: list[dict]) -> dict:
    assert len(records) == PARTICIPANTS * TRIALS_PER_PARTICIPANT
    count = lambda key: Counter(key(record) for record in records)
    assert set(count(lambda r: r["participant_slot"]).values()) == {114}
    assert set(count(lambda r: (r["participant_slot"], r["set_id"])).values()) == {38}
    assert set(count(lambda r: (r["participant_slot"], r["document_id"])).values()) == {3}
    assert set(count(lambda r: (r["document_id"], r["condition_id"])).values()) == {18}
    assert set(count(lambda r: (r["document_id"], r["condition_id"], r["set_id"])).values()) == {6}
    assert set(count(lambda r: (r["condition_id"], r["global_trial_index"])).values()) == {6}
    condition_position_side = count(lambda r: (r["condition_id"], r["global_trial_index"], r["baseline_side"]))
    assert set(count(lambda r: (r["participant_slot"], r["set_id"], r["baseline_side"])).values()) == {19}
    assert set(count(lambda r: (r["document_id"], r["condition_id"], r["set_id"], r["baseline_side"])).values()) == {3}

    participant_condition = count(lambda r: (r["participant_slot"], r["condition_id"]))
    assert set(participant_condition.values()) == {16, 17}
    for participant in range(1, PARTICIPANTS + 1):
        assert sorted(participant_condition[(participant, condition)] for condition in CONDITIONS) == [16] * 5 + [17] * 2
    participant_set_condition = count(lambda r: (r["participant_slot"], r["set_id"], r["condition_id"]))
    assert set(participant_set_condition.values()) == {5, 6}
    for participant in range(1, PARTICIPANTS + 1):
        for set_id in range(1, SETS + 1):
            assert sorted(participant_set_condition[(participant, set_id, condition)] for condition in CONDITIONS) == [5] * 4 + [6] * 3

    pair_counts = Counter()
    duplicate_cases = set()
    maximum_side_run = 0
    writer_pair_adjacencies = 0
    for participant in range(1, PARTICIPANTS + 1):
        selected = [record for record in records if record["participant_slot"] == participant]
        ordered_records = sorted(selected, key=lambda r: r["global_trial_index"])
        ordered_conditions = [record["condition_id"] for record in ordered_records]
        assert all(left != right for left, right in zip(ordered_conditions, ordered_conditions[1:]))
        sides = [record["baseline_side"] for record in ordered_records]
        run = 1
        for left, right in zip(sides, sides[1:]):
            run = run + 1 if left == right else 1
            maximum_side_run = max(maximum_side_run, run)
        for set_id in range(1, SETS + 1):
            set_rows = [record for record in ordered_records if record["set_id"] == set_id]
            writer_pair_adjacencies += sum(
                (left["document_index"] - 1) // 2 == (right["document_index"] - 1) // 2
                for left, right in zip(set_rows, set_rows[1:])
            )
            if set_id > 1:
                previous = [record for record in ordered_records if record["set_id"] == set_id - 1]
                assert not {record["document_id"] for record in previous[-5:]}.intersection(
                    record["document_id"] for record in set_rows[:5]
                )
            for previous_set in range(1, set_id):
                previous = [record for record in ordered_records if record["set_id"] == previous_set]
                assert all(current["document_id"] != old["document_id"]
                           for current, old in zip(set_rows, previous))
        for document_id in DOCUMENTS:
            doc_rows = [record for record in selected if record["document_id"] == document_id]
            triple = sorted(record["condition_id"] for record in doc_rows)
            assert len(set(triple)) == 3
            for pair in itertools.combinations(triple, 2):
                pair_counts[(document_id, *pair)] += 1
            if doc_rows[0]["within_document_visual_duplicate"]:
                duplicate_cases.add((participant, document_id))
            assert sum(record["baseline_side"] == "left" for record in doc_rows) in (1, 2)
    assert len(pair_counts) == DOCS_PER_SET * math.comb(len(CONDITIONS), 2)
    assert set(pair_counts.values()) == {6}

    attention_counts = Counter()
    for participant in range(PARTICIPANTS):
        for check in attention_schedule(participant):
            attention_counts[(check["set_id"], check["within_set_after_trial"])] += 1
    assert set(attention_counts.values()) == {2}
    assert writer_pair_adjacencies == 0
    position_side_values = [
        condition_position_side[(condition, global_trial, side)]
        for condition in CONDITIONS
        for global_trial in range(1, TRIALS_PER_PARTICIPANT + 1)
        for side in ("left", "right")
    ]
    return {
        "duplicate_participant_document_cases": len(duplicate_cases),
        "attention_position_frequency": 2,
        "condition_position_side_frequency_range": [min(position_side_values), max(position_side_values)],
        "condition_position_side_cells_off_target": sum(value != 3 for value in position_side_values),
        "maximum_baseline_side_run": maximum_side_run,
        "writer_pair_adjacencies": writer_pair_adjacencies,
    }


def main() -> None:
    orders, _initial_order_meta = build_orders()
    if STAGE_CACHE.exists():
        cached = json.loads(STAGE_CACHE.read_text())
        candidates = cached["candidates"]
        label_permutations = cached["label_permutations"]
        selected = cached["selected"]
        print("Loaded cached Fano allocation stage.", flush=True)
    else:
        candidates, label_permutations = make_document_candidates()
        selected = solve_condition_assignment(orders, candidates)
        STAGE_CACHE.parent.mkdir(parents=True, exist_ok=True)
        STAGE_CACHE.write_text(json.dumps({
            "candidates": candidates,
            "label_permutations": label_permutations,
            "selected": selected,
        }, separators=(",", ":")))
    orders, sides = schedule_and_map_orders(orders, candidates, selected)
    order_meta = final_order_metrics(orders)
    records = build_records(orders, sides, candidates, selected, order_meta, label_permutations)
    validation = validate(records)

    OUT.mkdir(parents=True, exist_ok=True)
    SLOTS_OUT.mkdir(parents=True, exist_ok=True)
    allocation_hash = digest(json.dumps(records, ensure_ascii=False, separators=(",", ":")))
    master = {
        "schema_version": "text-enrichment-allocation-v3",
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
            "document_condition_readers": 18,
            "document_condition_set_readers": 6,
            "document_condition_pair_cooccurrence": 6,
            "participant_set_condition_frequency": [5, 6],
            "condition_global_position_readers": 6,
            "participant_set_baseline_side": {"left": 19, "right": 19},
            "document_condition_set_baseline_side": {"left": 3, "right": 3},
            "condition_global_position_baseline_side_target": {"left": 3, "right": 3},
            "condition_global_position_baseline_side_achieved_range": validation["condition_position_side_frequency_range"],
            "max_same_condition_run": 1,
            "max_same_baseline_side_run_target": 2,
            "max_same_baseline_side_run_achieved": validation["maximum_baseline_side_run"],
            "same_writer_documents_adjacent": False,
            "set_boundary_document_overlap_window": 5,
        },
        "order_design": order_meta,
        "validation": validation,
        "documented_deviations": [
            "Condition-by-global-position D0 side cells are not all 3/3; exact document/condition/set and participant/set side balance is preserved.",
            "The maximum D0 side run is 3 rather than the Notion target of 2.",
        ],
        "records": records,
    }
    (OUT / "master-assignment.json").write_text(json.dumps(master, ensure_ascii=False, indent=2) + "\n")
    headers = list(records[0])
    csv_rows = [",".join(headers)] + [",".join(csv_cell(record[key]) for key in headers) for record in records]
    (OUT / "master-assignment.csv").write_text("\n".join(csv_rows) + "\n")

    slot_index = []
    for participant in range(1, PARTICIPANTS + 1):
        trials = [record for record in records if record["participant_slot"] == participant]
        slot_hash = digest(json.dumps(trials, ensure_ascii=False, separators=(",", ":")))
        payload = {
            "schema_version": "text-enrichment-slot-allocation-v3",
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
        (SLOTS_OUT / filename).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        slot_index.append({
            "participant_slot": participant,
            "allocation_id": payload["allocation_id"],
            "file": f"slots/{filename}",
            "allocation_sha256": slot_hash,
            "attention_checks": payload["attention_checks"],
        })
    (OUT / "index.json").write_text(json.dumps({
        "schema_version": "text-enrichment-allocation-index-v3",
        "study_version": STUDY_VERSION,
        "assignment_version": ASSIGNMENT_VERSION,
        "allocation_sha256": allocation_hash,
        "participant_slots": slot_index,
    }, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({
        "study_version": STUDY_VERSION,
        "assignment_version": ASSIGNMENT_VERSION,
        "participants": PARTICIPANTS,
        "trials_per_participant": TRIALS_PER_PARTICIPANT,
        "total_trials": len(records),
        "allocation_sha256": allocation_hash,
        "order_design": order_meta,
        "validation": validation,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
