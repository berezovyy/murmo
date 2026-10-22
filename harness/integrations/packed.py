"""Phase 29 packed-product integration (`murmo setup` in the throwaway profile)."""

from murmo_harness.validation.integration import PackedMurmo
from murmo_harness.validation.product import locate_packed

INTEGRATION = PackedMurmo(locate_packed())
