/**
 * Standalone build via the vendored client-bundle preset (browser half +
 * node half). Typert wire artifacts are vendored from a harness-checkout
 * build (see scripts/vendor-typert.sh) because the generator's workspace
 * discovery requires the harness monorepo layout.
 */
import { clientBundle } from '../../scripts/tsdown.client.ts'

export default clientBundle('dsh-devflow', ['lib/types/index.js', 'lib/types/invariant.js'])
