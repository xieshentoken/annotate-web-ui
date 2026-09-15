/* The entry `index.html` points at.
 *
 * Free of bare imports on purpose: the fixture is copied to a temporary
 * directory with no node_modules, so anything unresolvable would fail the
 * production build for reasons that have nothing to do with anchors.
 */

import { App } from "./App";

export const root = App;
