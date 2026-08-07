import { useLegacyStore } from '@warp-drive/legacy';
import { JSONAPICache } from '@warp-drive/json-api';

// Never called anywhere — must show as uncovered in the coverage report.
// Deliberately NOT exported: the bundler tree-shakes it out of the build, so
// no compiled code maps back to these lines (issue #22, second report).
// oxlint-disable-next-line no-unused-vars
function unusedTestFunction() {
  var four = 2 + 2;
  var eight = four * 2;
  return `wat: ${eight}`;
}

const Store = useLegacyStore({
  linksMode: false,
  cache: JSONAPICache,
  handlers: [
    // -- your handlers here
  ],
  schemas: [
    // -- your schemas here
  ],
});

export default Store;
