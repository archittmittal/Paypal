import type { Scenario } from '../scenario.js';
import { DEV_ATTACKS, HELDOUT_ATTACKS } from './attacks.js';
import { BENIGN_SCENARIOS } from './benign.js';
import { withIdealFakes } from './ideal.js';

/** Every suite, with faithful-cart fake scripts attached for fake mode. Live runs ignore the scripts. */
export const ALL_SCENARIOS: readonly Scenario[] = withIdealFakes([...BENIGN_SCENARIOS, ...DEV_ATTACKS, ...HELDOUT_ATTACKS]);
