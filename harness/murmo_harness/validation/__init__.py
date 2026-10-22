"""Phase 29 platform validation: packed-product scenarios, oracles, report.

Reruns the round 14 load, security, coexistence, soak and distribution checks
against the signed v1 candidate (`pnpm pack` / `murmo setup` in a throwaway
profile). Live hosts go through the phase 20 harness (fake model, network
blocked, throwaway HOME). A missing host or binary skips with a named reason
and never passes.
"""

from .connect import audit_connects, classify_target
from .matrix import HOSTS, PLUGIN_SETS, ValidationRow, expand_matrix
from .oracles import OracleResult, evaluate
from .product import PackedProduct, locate_packed
from .report import write_report
from .runner import validate
from .scenarios import SECTIONS, Scenario, catalog
from .skips import SKIP_REASONS, Skip, decide_skip

__all__ = [
    'HOSTS',
    'PLUGIN_SETS',
    'PackedProduct',
    'SECTIONS',
    'SKIP_REASONS',
    'Scenario',
    'Skip',
    'OracleResult',
    'ValidationRow',
    'audit_connects',
    'catalog',
    'classify_target',
    'decide_skip',
    'evaluate',
    'expand_matrix',
    'locate_packed',
    'validate',
    'write_report',
]
